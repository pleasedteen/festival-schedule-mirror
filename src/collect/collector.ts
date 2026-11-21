import { VENUE_IDS } from '../venues';
import { parsePage } from '../parse/parse';
import { formatDuration, parseRetryAfter, sleep } from '../core/time';
import type { Store } from '../db/store';
import type { AnnouncementInput } from '../core/types';

export interface CollectorOptions {
  baseUrl: string;
  store: Store;
  maxPages?: number;
  maxRateLimitWaitMs?: number;
  /** 注入日志，测试里可静默。 */
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface VenueCollectResult {
  venueId: string;
  pages: number;
  announcements: number;
  layout: string | null;
  recoveries: number;
  rateLimitWaits: number;
  inserted: number;
  changed: number;
  pending: number;
  /** 本轮取回并入库的详情正文数（摘要列表版式）。 */
  detailsFetched: number;
  /** 本轮仍欠的详情正文数（额度用完或拉取失败）。 */
  detailsPending: number;
  /** 编号/修订与列表不符被驳回的详情数。 */
  detailMismatches: number;
  /** 站点详情请求额度是否已在本轮用完。 */
  quotaExhausted: boolean;
  ok: boolean;
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
  error: string | null;
}

/** 摘要列表中待拉取正文的条目。 */
interface StubTarget {
  annKey: string;
  eventId: string;
  revision: number;
  detailUrl: string;
  sourcePage: number;
  item: AnnouncementInput;
}

const MAX_PASSES = 5;

/**
 * 单剧场采集：从入口页开始翻页；遇到 429 按 Retry-After 等待；
 * 遇到翻页签名失效（409）则重新取得入口页并回到可用的翻页位置。
 * 摘要列表版式在翻完列表后按“修订号优先”逐条拉取详情正文；
 * 详情额度用完（403）时保留剩余存根下轮续采，详情链接失效（409）
 * 时重新翻列表取得当前会话的签名链接。
 */
export class Collector {
  private readonly baseUrl: string;
  private readonly store: Store;
  private readonly maxPages: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly log: (message: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: CollectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.store = options.store;
    this.maxPages = options.maxPages ?? 30;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? sleep;
  }

  private async fetchPage(
    url: string,
    jar: CookieJar,
  ): Promise<FetchOutcome> {
    let retriedAfterMs: number | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
            error: `限流等待 ${formatDuration(delay)} 超过上限`,
          };
        }
        retriedAfterMs = (retriedAfterMs ?? 0) + delay;
        this.log(`  限流：${url} 返回 429，按 Retry-After 等待 ${formatDuration(delay)}`);
        await this.sleepFn(delay);
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
      error: '多次限流后仍未恢复',
    };
  }

  /**
   * 采集一个剧场；详情链接随会话轮换失效时整轮重翻列表再续，
   * 最多重试若干次后如实报告失败。
   */
  async collectVenue(venueId: string): Promise<VenueCollectResult> {
    const jar = createCookieJar();
    let carriedRecoveries = 0;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const result = await this.collectVenuePass(venueId, jar, carriedRecoveries);
      if (result !== 'recovery') return result;
      carriedRecoveries += 1;
      this.log('  详情链接随会话失效（409）：重新翻列表取得当前会话的详情入口');
    }
    return this.failure(venueId, 0, null, carriedRecoveries, 0, '翻页位置多次失效');
  }

  /**
   * 一轮采集：翻完列表页（存根幂等入库），再拉取欠缺的详情正文。
   * 返回 'recovery' 表示详情链接失效，需要整轮重翻列表。
   */
  private async collectVenuePass(
    venueId: string,
    jar: CookieJar,
    carriedRecoveries: number,
  ): Promise<VenueCollectResult | 'recovery'> {
    const entryUrl = `${this.baseUrl}/venue/${encodeURIComponent(venueId)}`;
    let pages = 0;
    let recoveries = 0;
    let rateLimitWaits = 0;
    let inserted = 0;
    let changed = 0;
    let layout: string | null = null;
    let detailsFetched = 0;
    let detailsPending = 0;
    let detailMismatches = 0;
    let quotaExhausted = false;

    let nextUrl: string | null = entryUrl;
    let pageNo = 1;
    let failures = 0;
    const stubTargets = new Map<string, StubTarget>();

    while (nextUrl && pages < this.maxPages) {
      const outcome = await this.fetchPage(nextUrl, jar);
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 翻页签名失效：丢弃旧链接、回到入口页重新取得可用的翻页位置。
        recoveries += 1;
        failures += 1;
        if (failures > 4) {
          return this.failure(venueId, pages, layout, recoveries + carriedRecoveries, rateLimitWaits, '翻页位置多次失效');
        }
        this.log(`  翻页凭据失效（409）：${nextUrl} → 重新取得入口页`);
        nextUrl = entryUrl;
        pageNo = 1;
        continue;
      }

      if (!outcome.ok) {
        return this.failure(
          venueId,
          pages,
          layout,
          recoveries + carriedRecoveries,
          rateLimitWaits,
          outcome.rateLimited
            ? `限流等待超过上限（${outcome.status}）`
            : (outcome.error ?? `请求失败：HTTP ${outcome.status}`),
        );
      }

      let parsed;
      try {
        parsed = parsePage(outcome.html, outcome.url, pageNo, venueId);
      } catch (error) {
        return this.failure(
          venueId,
          pages,
          layout,
          recoveries + carriedRecoveries,
          rateLimitWaits,
          (error as Error).message,
        );
      }

      layout ??= parsed.layout;
      const items: AnnouncementInput[] = parsed.announcements.map((item) => ({
        ...item,
      }));
      const outcomeWrite = await this.store.upsertPage(items, new Date().toISOString());
      inserted += outcomeWrite.inserted;
      changed += outcomeWrite.changed;
      pages += 1;
      failures = 0;

      // 摘要列表：登记详情入口，翻完列表后统一拉取正文。
      for (const item of items) {
        if (item.detailUrl && item.eventId && item.revision !== null) {
          stubTargets.set(item.annKey, {
            annKey: item.annKey,
            eventId: item.eventId,
            revision: item.revision,
            detailUrl: item.detailUrl,
            sourcePage: item.sourcePage,
            item,
          });
        }
      }

      this.log(
        `  ${venueId} 第 ${pageNo} 页（${parsed.layout}）：${items.length} 条` +
          (outcomeWrite.inserted || outcomeWrite.changed
            ? `，新增 ${outcomeWrite.inserted} / 更新 ${outcomeWrite.changed}`
            : '，无变化'),
      );

      if (parsed.nextUrl) {
        pageNo += 1;
        nextUrl = parsed.nextUrl;
      } else {
        nextUrl = null;
      }
    }

    if (nextUrl && pages >= this.maxPages) {
      this.log(`  已达单次采集页数上限 ${this.maxPages}，剩余页面下次继续`);
    }

    if (stubTargets.size > 0) {
      const detailPhase = await this.fetchDetails(venueId, jar, stubTargets);
      rateLimitWaits += detailPhase.rateLimitWaits;
      if (detailPhase.needRecovery) return 'recovery';
      detailsFetched += detailPhase.fetched;
      detailsPending += detailPhase.pending;
      detailMismatches += detailPhase.mismatches;
      quotaExhausted = detailPhase.quotaExhausted;
    }

    const totalItems = await this.store.allAnnouncements();
    const venueItems = totalItems.filter((item) => item.venueId === venueId);
    const pendingRows = await this.store.pendingAnnouncements();
    const pending = pendingRows.filter((row) => row.venueId === venueId).length;
    await this.store.recordVenueSync({
      venueId,
      runAt: new Date().toISOString(),
      pages,
      recoveries: recoveries + carriedRecoveries,
      rateLimitWaits,
      status: 'ok',
      lastError: null,
      announcements: venueItems.length,
    });

    return {
      venueId,
      pages,
      announcements: venueItems.length,
      layout,
      recoveries: recoveries + carriedRecoveries,
      rateLimitWaits,
      inserted,
      changed,
      pending,
      detailsFetched,
      detailsPending,
      detailMismatches,
      quotaExhausted,
      ok: true,
      error: null,
    };
  }

  /**
   * 拉取摘要列表欠缺的详情正文。
   * 同一公告的新旧修订分布在不同列表页时，按修订号从大到小拉取（优先最新修订）；
   * 只有编号与修订都和列表一致的正文才入库，错配正文驳回并保留待补采；
   * 额度用完（403）即停，剩余存根留到下一轮续采。
   */
  private async fetchDetails(
    venueId: string,
    jar: CookieJar,
    stubTargets: Map<string, StubTarget>,
  ): Promise<{
    fetched: number;
    pending: number;
    mismatches: number;
    quotaExhausted: boolean;
    rateLimitWaits: number;
    needRecovery: boolean;
  }> {
    let fetched = 0;
    let pending = 0;
    let mismatches = 0;
    let quotaExhausted = false;
    let rateLimitWaits = 0;

    const pendingRows = (await this.store.pendingAnnouncements()).filter(
      (row) => row.venueId === venueId && stubTargets.has(row.annKey),
    );
    const targets = pendingRows
      .map((row) => stubTargets.get(row.annKey)!)
      .sort(
        (a, b) =>
          b.revision - a.revision ||
          a.eventId.localeCompare(b.eventId) ||
          a.annKey.localeCompare(b.annKey),
      );

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (quotaExhausted) {
        pending += targets.length - index;
        break;
      }
      const outcome = await this.fetchPage(target.detailUrl, jar);
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 会话已轮换：列表里的签名详情链接全部失效，需重翻列表。
        return { fetched, pending, mismatches, quotaExhausted, rateLimitWaits, needRecovery: true };
      }
      if (outcome.status === 403) {
        quotaExhausted = true;
        this.log(
          `  详情请求额度已用完：${target.eventId} 修订 ${target.revision} 起 ${targets.length - index} 条正文留待下轮补采`,
        );
        pending += targets.length - index;
        break;
      }
      if (!outcome.ok) {
        pending += 1;
        this.log(
          `  详情拉取失败（${outcome.error ?? `HTTP ${outcome.status}`}）：` +
            `${target.eventId} 修订 ${target.revision}，留待下轮补采`,
        );
        continue;
      }

      let body: AnnouncementInput;
      try {
        const detailPage = parsePage(outcome.html, outcome.url, target.sourcePage, venueId);
        if (detailPage.announcements.length !== 1) {
          throw new Error('详情页正文不唯一');
        }
        body = detailPage.announcements[0];
      } catch (error) {
        pending += 1;
        this.log(`  详情页解析失败（${(error as Error).message}）：${target.eventId} 修订 ${target.revision}`);
        continue;
      }

      // 只有编号和修订都匹配的正文才能更新排期；错配正文驳回，保留已确认排期。
      if (body.eventId !== target.eventId || body.revision !== target.revision) {
        mismatches += 1;
        pending += 1;
        const note =
          `详情与列表不符（列表 ${target.eventId} 修订 ${target.revision}，` +
          `正文 ${body.eventId ?? '未知'} 修订 ${body.revision ?? '未知'}）`;
        await this.store.upsertPage(
          [{ ...target.item, parseStatus: 'pending', parseError: note, detailUrl: undefined }],
          new Date().toISOString(),
        );
        this.log(`  详情错配：${note}，正文未入库`);
        continue;
      }

      await this.store.upsertPage(
        [
          {
            ...body,
            annKey: target.annKey,
            sourcePage: target.sourcePage,
            detailUrl: undefined,
          },
        ],
        new Date().toISOString(),
      );
      if (body.parseStatus === 'parsed') {
        fetched += 1;
        this.log(`  详情正文已入库：${target.eventId} 修订 ${target.revision}`);
      } else {
        // 正文本身不可靠（缺时间等）：以正文解析结果替换存根，仍待补采。
        pending += 1;
        this.log(
          `  详情正文仍待补采：${target.eventId} 修订 ${target.revision}（${body.parseError ?? '解析失败'}）`,
        );
      }
    }

    return { fetched, pending, mismatches, quotaExhausted, rateLimitWaits, needRecovery: false };
  }

  private async failure(
    venueId: string,
    pages: number,
    layout: string | null,
    recoveries: number,
    rateLimitWaits: number,
    error: string,
  ): Promise<VenueCollectResult> {
    this.log(`  ${venueId} 采集未完成：${error}`);
    await this.store.recordVenueSync({
      venueId,
      runAt: new Date().toISOString(),
      pages,
      recoveries,
      rateLimitWaits,
      status: 'failed',
      lastError: error,
      announcements: 0,
    });
    return {
      venueId,
      pages,
      announcements: 0,
      layout,
      recoveries,
      rateLimitWaits,
      inserted: 0,
      changed: 0,
      pending: 0,
      detailsFetched: 0,
      detailsPending: 0,
      detailMismatches: 0,
      quotaExhausted: false,
      ok: false,
      error,
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
        venues.push(
          await this.failure(venueId, 0, null, 0, 0, (error as Error).message),
        );
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
}
