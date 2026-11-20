import { randomUUID } from 'node:crypto';
import { VENUE_IDS } from '../venues';
import { parsePage } from '../parse/parse';
import { formatDuration, parseRetryAfter, sleep } from '../core/time';
import type { Store, CollectCursor } from '../db/store';
import type { AnnouncementInput } from '../core/types';

export interface CollectorOptions {
  baseUrl: string;
  store: Store;
  /** 每个剧场在单个进程内最多发出的列表请求次数（含限流重试与恢复请求）。 */
  maxRequests?: number;
  maxRateLimitWaitMs?: number;
  /** 注入日志，测试里可静默。 */
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

/** 单剧场采集状态：失败 / 未完成（到达请求上限，可续采）/ 完成（拿到一份完整列表）。 */
export type VenueCollectStatus = 'failed' | 'incomplete' | 'complete';

export interface VenueCollectResult {
  venueId: string;
  status: VenueCollectStatus;
  /** 兼容旧字段：失败以外都按 ok 处理，失败与“未完成”用 status 区分。 */
  ok: boolean;
  pages: number;
  /** 本进程内实际发出的列表请求次数。 */
  requests: number;
  /** 本进程的请求预算（每剧场每进程上限）。 */
  requestBudget: number;
  announcements: number;
  layout: string | null;
  recoveries: number;
  rateLimitWaits: number;
  inserted: number;
  changed: number;
  pruned: number;
  pending: number;
  nextPage: number | null;
  listToken: string | null;
  error: string | null;
}

export interface CollectResult {
  venues: VenueCollectResult[];
  announcements: number;
  pending: number;
}

interface CookieJar {
  cookies: Map<string, string>;
  header(): string | undefined;
  absorb(response: Response): void;
}

function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    cookies,
    header() {
      if (cookies.size === 0) return undefined;
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(response: Response) {
      const setCookie = response.headers.getSetCookie?.() ?? [];
      for (const line of setCookie) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value || /deleted/i.test(value) || /max-age=0/i.test(line)) {
          cookies.delete(name);
        } else {
          cookies.set(name, value);
        }
      }
    },
  };
}

interface FetchOutcome {
  ok: boolean;
  status: number;
  html: string;
  url: string;
  rateLimited: boolean;
  retriedAfterMs: number | null;
  recovery: boolean;
  /** 本进程请求预算耗尽：不是站点故障，采集应标记为“未完成、可续采”。 */
  budgetExhausted: boolean;
  error: string | null;
}

/**
 * 单剧场采集：
 * - 每剧场每进程最多 maxRequests 次列表请求，到达上限只记“未完成”，续采游标落库；
 * - 游标（下一页页码 + 列表指纹）持久化在 DuckDB，新进程凭入口 ?page=N 深翻续采，
 *   会话轮换导致旧翻页签名 409 时同样从入口重新取得当前页；
 * - 列表指纹变化（公告增删/重排/修订）使游标失效，本轮从头重走；
 * - 只有完整走到底的一轮才标记完成，并把该剧场公告收敛成本轮采到的完整列表。
 */
export class Collector {
  private readonly baseUrl: string;
  private readonly store: Store;
  private readonly maxRequests: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly log: (message: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: CollectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.store = options.store;
    this.maxRequests = options.maxRequests ?? 30;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? sleep;
  }

  private entryUrl(venueId: string, page: number): string {
    const url = new URL(`${this.baseUrl}/venue/${encodeURIComponent(venueId)}`);
    if (page > 1) url.searchParams.set('page', String(page));
    return url.toString();
  }

  /**
   * 拉取一页。每发出一次列表请求（含 429 重试、409 恢复请求）都消耗一次预算，
   * 预算耗尽立即停止，保证“每剧场每进程最多 N 次请求”是硬上限。
   */
  private async fetchPage(
    url: string,
    jar: CookieJar,
    budget: { used: number },
  ): Promise<FetchOutcome> {
    let retriedAfterMs: number | null = null;
    while (budget.used < this.maxRequests) {
      budget.used += 1;
      const headers: Record<string, string> = {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'theatre-festival-desk/1.0 (+local collector)',
      };
      const cookie = jar.header();
      if (cookie) headers.cookie = cookie;
      let response: Response;
      try {
        response = await fetch(url, { headers, redirect: 'follow' });
      } catch (error) {
        return {
          ok: false,
          status: 0,
          html: '',
          url,
          rateLimited: false,
          retriedAfterMs,
          recovery: false,
          budgetExhausted: false,
          error: `连接中断：${(error as Error).message}`,
        };
      }
      jar.absorb(response);

      if (response.status === 429) {
        const delay = parseRetryAfter(response.headers.get('retry-after')) ?? 1000;
        if (delay > this.maxRateLimitWaitMs) {
          return {
            ok: false,
            status: 429,
            html: '',
            url,
            rateLimited: true,
            retriedAfterMs: null,
            recovery: false,
            budgetExhausted: false,
            error: `限流等待 ${formatDuration(delay)} 超过上限`,
          };
        }
        retriedAfterMs = (retriedAfterMs ?? 0) + delay;
        this.log(`  限流：${url} 返回 429，按 Retry-After 等待 ${formatDuration(delay)}`);
        await this.sleepFn(delay);
        if (budget.used >= this.maxRequests) break;
        continue;
      }

      const html = await response.text();
      if (response.status === 409) {
        return {
          ok: false,
          status: 409,
          html,
          url,
          rateLimited: false,
          retriedAfterMs,
          recovery: true,
          budgetExhausted: false,
          error: null,
        };
      }
      return {
        ok: response.ok,
        status: response.status,
        html,
        url: response.url || url,
        rateLimited: false,
        retriedAfterMs,
        recovery: false,
        budgetExhausted: false,
        error: response.ok ? null : `HTTP ${response.status}`,
      };
    }
    return {
      ok: false,
      status: 429,
      html: '',
      url,
      rateLimited: true,
      retriedAfterMs,
      recovery: false,
      budgetExhausted: true,
      error: '请求预算耗尽，剩余页面下次继续',
    };
  }

  private async recordSync(
    venueId: string,
    pages: number,
    recoveries: number,
    rateLimitWaits: number,
    status: VenueCollectStatus,
    lastError: string | null,
    announcements: number,
  ): Promise<void> {
    await this.store.recordVenueSync({
      venueId,
      runAt: new Date().toISOString(),
      pages,
      recoveries,
      rateLimitWaits,
      status,
      lastError,
      announcements,
    });
  }

  private async fail(
    venueId: string,
    snapshot: Omit<VenueCollectResult, 'venueId' | 'status' | 'ok' | 'error' | 'announcements'>,
    cursor: CollectCursor | null,
    error: string,
  ): Promise<VenueCollectResult> {
    this.log(`  ${venueId} 采集未完成（失败）：${error}`);
    if (cursor) await this.store.saveCollectCursor(cursor);
    await this.recordSync(
      venueId,
      snapshot.pages,
      snapshot.recoveries,
      snapshot.rateLimitWaits,
      'failed',
      error,
      0,
    );
    return {
      venueId,
      status: 'failed',
      ok: false,
      pages: snapshot.pages,
      requests: snapshot.requests,
      requestBudget: this.maxRequests,
      announcements: 0,
      layout: snapshot.layout,
      recoveries: snapshot.recoveries,
      rateLimitWaits: snapshot.rateLimitWaits,
      inserted: snapshot.inserted,
      changed: snapshot.changed,
      pruned: snapshot.pruned,
      pending: snapshot.pending,
      nextPage: snapshot.nextPage,
      listToken: snapshot.listToken,
      error,
    };
  }

  async collectVenue(venueId: string): Promise<VenueCollectResult> {
    const jar = createCookieJar();
    const budget = { used: 0 };
    let pages = 0;
    let recoveries = 0;
    let rateLimitWaits = 0;
    let inserted = 0;
    let changed = 0;
    let pruned = 0;
    let pending = 0;
    let layout: string | null = null;
    let consecutiveRecoveries = 0;
    let listToken: string | null = null;
    let totalPages: number | null = null;

    const snapshot = (nextPage: number | null): Omit<
      VenueCollectResult,
      'venueId' | 'status' | 'ok' | 'error' | 'announcements'
    > => ({
      pages,
      requests: budget.used,
      requestBudget: this.maxRequests,
      layout,
      recoveries,
      rateLimitWaits,
      inserted,
      changed,
      pruned,
      pending,
      nextPage,
      listToken,
    });

    // 读取上一轮（可能来自已结束的另一个进程）的续采游标。
    const stored = await this.store.getCollectCursor(venueId);
    let pageNo = 1;
    let passKey: string = randomUUID();
    let observedKeys = new Set<string>();
    let coveredPages = new Set<number>();
    // 上次已采齐：本轮只请求入口第 1 页核对指纹；指纹未变即可直接完成，不再逐页重走。
    let recheckOnly = false;
    if (stored && !stored.complete && stored.listToken) {
      pageNo = Math.max(1, stored.nextPage);
      passKey = stored.passKey;
      listToken = stored.listToken;
      totalPages = stored.totalPages;
      coveredPages = new Set(stored.coveredPages);
      observedKeys = new Set(stored.observedKeys);
      this.log(`  ${venueId} 续采：从第 ${pageNo} 页继续（列表指纹 ${listToken}）`);
    } else if (stored?.complete && stored.listToken) {
      listToken = stored.listToken;
      totalPages = stored.totalPages;
      coveredPages = new Set(stored.coveredPages);
      observedKeys = new Set(stored.observedKeys);
      recheckOnly = true;
      this.log(`  ${venueId} 上次已采齐，先核对列表指纹`);
    }

    let cursor: CollectCursor | null = stored
      ? { ...stored, updatedAt: new Date().toISOString() }
      : null;
    let nextUrl: string = this.entryUrl(venueId, pageNo);

    while (budget.used < this.maxRequests) {
      const outcome = await this.fetchPage(nextUrl, jar, budget);
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 翻页签名失效（会话轮换）：旧链接作废，凭入口 ?page=N 重新取得当前页。
        recoveries += 1;
        consecutiveRecoveries += 1;
        if (consecutiveRecoveries > 4) {
          const error = '翻页位置多次失效';
          cursor = this.buildCursor(venueId, listToken, pageNo, totalPages, passKey, [...coveredPages], [...observedKeys], false);
          return this.fail(venueId, snapshot(pageNo), cursor, error);
        }
        this.log(`  翻页凭据失效（409）：${nextUrl} → 从入口重新取得第 ${pageNo} 页`);
        nextUrl = this.entryUrl(venueId, pageNo);
        continue;
      }

      if (!outcome.ok) {
        if (outcome.budgetExhausted) break;
        const error = outcome.rateLimited
          ? `限流等待超过上限（${outcome.status}）`
          : (outcome.error ?? `请求失败：HTTP ${outcome.status}`);
        cursor = this.buildCursor(venueId, listToken, pageNo, totalPages, passKey, [...coveredPages], [...observedKeys], false);
        return this.fail(venueId, snapshot(pageNo), cursor, error);
      }

      let parsed;
      try {
        parsed = parsePage(outcome.html, outcome.url, pageNo, venueId);
      } catch (error) {
        cursor = this.buildCursor(venueId, listToken, pageNo, totalPages, passKey, [...coveredPages], [...observedKeys], false);
        return this.fail(
          venueId,
          snapshot(pageNo),
          cursor,
          (error as Error).message,
        );
      }

      // 列表指纹变化：站点在采集期间增删/重排了公告，旧游标作废，从头重走一轮。
      if (parsed.listToken && listToken && parsed.listToken !== listToken) {
        this.log(
          `  ${venueId} 列表已变化（${listToken} → ${parsed.listToken}），放弃旧位置，从第 1 页重走`,
        );
        listToken = parsed.listToken;
        totalPages = parsed.pageCount;
        passKey = randomUUID();
        observedKeys = new Set();
        coveredPages = new Set();
        pages = 0;
        pageNo = 1;
        consecutiveRecoveries = 0;
        recheckOnly = false;
        nextUrl = this.entryUrl(venueId, 1);
        continue;
      }
      if (parsed.listToken) listToken = parsed.listToken;
      if (parsed.pageCount) totalPages = parsed.pageCount;
      consecutiveRecoveries = 0;
      layout ??= parsed.layout;
      const items: AnnouncementInput[] = parsed.announcements.map((item) => ({ ...item }));

      // 上次已采齐且指纹未变：只核对这一页即可确认整份列表仍有效，直接完成。
      if (recheckOnly) {
        const allCovered =
          totalPages === null ||
          (coveredPages.size >= totalPages &&
            Array.from({ length: totalPages }, (_, index) => index + 1).every((value) =>
              coveredPages.has(value),
            ));
        if (allCovered) {
          this.log(`  ${venueId} 列表指纹未变，沿用已采齐的完整列表（本轮仅核对 1 次请求）`);
          cursor = this.buildCursor(
            venueId,
            listToken,
            totalPages ?? 1,
            totalPages,
            passKey,
            [...coveredPages, ...(parsed.pageNo ? [parsed.pageNo] : [])],
            [...observedKeys, ...items.map((item) => item.annKey)],
            true,
          );
          await this.store.saveCollectCursor(cursor);
          const venueItems = (await this.store.allAnnouncements()).filter(
            (item) => item.venueId === venueId,
          );
          await this.recordSync(venueId, 1, recoveries, rateLimitWaits, 'complete', null, venueItems.length);
          return {
            venueId,
            status: 'complete',
            ok: true,
            pages: 1,
            requests: budget.used,
            requestBudget: this.maxRequests,
            announcements: venueItems.length,
            layout,
            recoveries,
            rateLimitWaits,
            inserted,
            changed,
            pruned,
            pending,
            nextPage: null,
            listToken,
            error: null,
          };
        }
        // 覆盖记录不完整（旧游标等）：回退为从头完整重走。
        this.log(`  ${venueId} 历史覆盖不完整，转为从头重走`);
        recheckOnly = false;
        passKey = randomUUID();
        coveredPages = new Set();
        observedKeys = new Set();
        pages = 0;
        pageNo = 1;
        nextUrl = this.entryUrl(venueId, 1);
        continue;
      }

      // 站点把入口深翻页规整回第 1 页（例如页码越界），跟随站点位置。
      if (parsed.pageNo && parsed.pageNo !== pageNo) {
        this.log(`  站点返回第 ${parsed.pageNo} 页（请求第 ${pageNo} 页），按站点位置继续`);
        pageNo = parsed.pageNo;
      }

      const write = await this.store.upsertPage(items, new Date().toISOString());
      inserted += write.inserted;
      changed += write.changed;
      pending += items.filter((item) => item.parseStatus === 'pending').length;
      pages += 1;
      coveredPages.add(pageNo);
      for (const item of items) observedKeys.add(item.annKey);

      this.log(
        `  ${venueId} 第 ${pageNo}/${totalPages ?? '?'} 页（${parsed.layout}）：${items.length} 条` +
          (write.inserted || write.changed
            ? `，新增 ${write.inserted} / 更新 ${write.changed}`
            : '，无变化'),
      );

      if (parsed.nextUrl) {
        pageNo += 1;
        nextUrl = parsed.nextUrl;
      } else {
        // 走到底：只有本轮（可跨进程）覆盖了 1..totalPages 全部页码，
        // 才算拿到一份完整列表；覆盖不完整时不收敛，留给下轮从头重走。
        const fullCoverage =
          totalPages === null ||
          (coveredPages.size >= totalPages &&
            Array.from({ length: totalPages }, (_, index) => index + 1).every((value) =>
              coveredPages.has(value),
            ));
        if (!fullCoverage) {
          this.log(
            `  ${venueId} 到达末页但页码覆盖不完整（${coveredPages.size}/${totalPages}），下轮从第 1 页重走`,
          );
          cursor = this.buildCursor(venueId, listToken, 1, totalPages, passKey, [...coveredPages], [...observedKeys], false);
          await this.store.saveCollectCursor(cursor);
          const partial = (await this.store.allAnnouncements()).filter(
            (item) => item.venueId === venueId,
          );
          await this.recordSync(
            venueId,
            pages,
            recoveries,
            rateLimitWaits,
            'incomplete',
            '页码覆盖不完整，下轮从第 1 页重走',
            partial.length,
          );
          return {
            venueId,
            status: 'incomplete',
            ok: true,
            pages,
            requests: budget.used,
            requestBudget: this.maxRequests,
            announcements: partial.length,
            layout,
            recoveries,
            rateLimitWaits,
            inserted,
            changed,
            pruned,
            pending,
            nextPage: 1,
            listToken,
            error: null,
          };
        }
        // 完整覆盖（含此前进程已采的页码）：本轮实际见到的公告键集合就是站点当前完整列表，
        // 据此把站点已撤下/重排产生的陈旧数据一次性收敛。
        const keepKeys = [...observedKeys];
        pruned = await this.store.pruneVenueAnnouncements(venueId, keepKeys);
        if (pruned > 0) this.log(`  ${venueId} 完整列表收敛：移除 ${pruned} 条已撤下/重排的旧公告`);
        cursor = this.buildCursor(venueId, listToken, pageNo + 1, totalPages, passKey, [...coveredPages], [...observedKeys], true);
        await this.store.saveCollectCursor(cursor);
        const venueItems = (await this.store.allAnnouncements()).filter(
          (item) => item.venueId === venueId,
        );
        await this.recordSync(venueId, pages, recoveries, rateLimitWaits, 'complete', null, venueItems.length);
        return {
          venueId,
          status: 'complete',
          ok: true,
          pages,
          requests: budget.used,
          requestBudget: this.maxRequests,
          announcements: venueItems.length,
          layout,
          recoveries,
          rateLimitWaits,
          inserted,
          changed,
          pruned,
          pending,
          nextPage: null,
          listToken,
          error: null,
        };
      }

      // 每采完一页就落一次游标，进程被杀也能从下一页续上。
      cursor = this.buildCursor(venueId, listToken, pageNo, totalPages, passKey, [...coveredPages], [...observedKeys], false);
      await this.store.saveCollectCursor(cursor);
    }

    // 到达每进程请求上限：如实标记“未完成”，下次（含新进程）从游标继续。
    this.log(
      `  ${venueId} 已达单次进程请求上限 ${this.maxRequests} 次（已采 ${pages} 页），第 ${pageNo} 页起下次继续`,
    );
    cursor = this.buildCursor(venueId, listToken, pageNo, totalPages, passKey, [...coveredPages], [...observedKeys], false);
    await this.store.saveCollectCursor(cursor);
    const venueItems = (await this.store.allAnnouncements()).filter(
      (item) => item.venueId === venueId,
    );
    await this.recordSync(
      venueId,
      pages,
      recoveries,
      rateLimitWaits,
      'incomplete',
      `请求上限 ${this.maxRequests} 次，续采于第 ${pageNo} 页`,
      venueItems.length,
    );
    return {
      venueId,
      status: 'incomplete',
      ok: true,
      pages,
      requests: budget.used,
      requestBudget: this.maxRequests,
      announcements: venueItems.length,
      layout,
      recoveries,
      rateLimitWaits,
      inserted,
      changed,
      pruned,
      pending,
      nextPage: pageNo,
      listToken,
      error: null,
    };
  }

  private buildCursor(
    venueId: string,
    listToken: string | null,
    nextPage: number,
    totalPages: number | null,
    passKey: string,
    coveredPages: number[],
    observedKeys: string[],
    complete: boolean,
  ): CollectCursor {
    return {
      venueId,
      listToken,
      nextPage,
      totalPages,
      passKey,
      coveredPages,
      observedKeys,
      complete,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 依次采集各剧场；单剧场失败不影响其他剧场。 */
  async collectAll(venueIds: string[] = VENUE_IDS): Promise<CollectResult> {
    const venues: VenueCollectResult[] = [];
    for (const venueId of venueIds) {
      this.log(`采集 ${venueId}`);
      try {
        venues.push(await this.collectVenue(venueId));
      } catch (error) {
        venues.push(await this.uncaughtFailure(venueId, (error as Error).message));
      }
    }
    // 每轮采集（含单剧场）后统一刷新派生排期；中断时这里仍会执行，
    // 保证已入库的公告与已确认的改场立即可查。
    await this.store.refreshEffective();
    const rows = await this.store.allAnnouncements();
    return {
      venues,
      announcements: rows.length,
      pending: rows.filter((row) => row.parseStatus === 'pending').length,
    };
  }

  private async uncaughtFailure(venueId: string, error: string): Promise<VenueCollectResult> {
    await this.recordSync(venueId, 0, 0, 0, 'failed', error, 0);
    return {
      venueId,
      status: 'failed',
      ok: false,
      pages: 0,
      requests: 0,
      requestBudget: this.maxRequests,
      announcements: 0,
      layout: null,
      recoveries: 0,
      rateLimitWaits: 0,
      inserted: 0,
      changed: 0,
      pruned: 0,
      pending: 0,
      nextPage: null,
      listToken: null,
      error,
    };
  }
}
