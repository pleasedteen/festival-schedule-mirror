import { VENUE_IDS } from '../venues';
import { parsePage } from '../parse/parse';
import { formatDuration, parseRetryAfter, sleep } from '../core/time';
import type { Store } from '../db/store';
import type { AnnouncementInput } from '../core/types';
import type { ProgressTracker } from '../progress/tracker';

export interface CollectorOptions {
  baseUrl: string;
  store: Store;
  maxPages?: number;
  maxRateLimitWaitMs?: number;
  /** 注入日志，测试里可静默。 */
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  /** 可选的运行态记录器，供独立 CLI 诊断查询读取。 */
  progress?: ProgressTracker;
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

interface PageContext {
  venueId: string;
  page: number;
  reread: boolean;
}

/**
 * 单剧场采集：从入口页开始翻页；遇到 429 按 Retry-After 等待；
 * 遇到翻页签名失效（409）则重新取得入口页并回到可用的翻页位置。
 */
export class Collector {
  private readonly baseUrl: string;
  private readonly store: Store;
  private readonly maxPages: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly log: (message: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly progress: ProgressTracker | null;

  constructor(options: CollectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.store = options.store;
    this.maxPages = options.maxPages ?? 30;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? sleep;
    this.progress = options.progress ?? null;
  }

  private async fetchPage(
    url: string,
    jar: CookieJar,
    ctx: PageContext,
  ): Promise<FetchOutcome> {
    let retriedAfterMs: number | null = null;
    let waitNumber = 0;
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
        waitNumber += 1;
        retriedAfterMs = (retriedAfterMs ?? 0) + delay;
        this.log(`  限流：${url} 返回 429，按 Retry-After 等待 ${formatDuration(delay)}`);
        this.progress?.rateLimitWait(ctx.venueId, {
          page: ctx.page,
          url,
          reread: ctx.reread,
          retryAfterMs: delay,
          cumulativeMs: retriedAfterMs,
          waitNumber,
        });
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

  async collectVenue(venueId: string): Promise<VenueCollectResult> {
    this.progress?.venueStarted(venueId);
    const jar = createCookieJar();
    const entryUrl = `${this.baseUrl}/venue/${encodeURIComponent(venueId)}`;
    let pages = 0;
    let recoveries = 0;
    let rateLimitWaits = 0;
    let inserted = 0;
    let changed = 0;
    let pending = 0;
    let layout: string | null = null;
    // 本次运行已经成功提交过的页号：会话轮换重读这些页时单独标记，不重复计进度。
    const seenPages = new Set<number>();

    let nextUrl: string | null = entryUrl;
    let pageNo = 1;
    let failures = 0;

    while (nextUrl && pages < this.maxPages) {
      const reread = seenPages.has(pageNo);
      this.progress?.pageAttempt(venueId, pageNo, nextUrl, reread);
      const outcome = await this.fetchPage(nextUrl, jar, {
        venueId,
        page: pageNo,
        reread,
      });
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 翻页签名失效：丢弃旧链接、回到入口页重新取得可用的翻页位置。
        recoveries += 1;
        failures += 1;
        this.progress?.recovery(venueId, null);
        if (failures > 4) {
          return this.failure(venueId, pages, layout, recoveries, rateLimitWaits, '翻页位置多次失效');
        }
        this.log(`  翻页凭据失效（409）：${nextUrl} → 重新取得入口页`);
        nextUrl = entryUrl;
        pageNo = 1;
        continue;
      }

      if (!outcome.ok) {
        const message = outcome.rateLimited
          ? `限流等待超过上限（${outcome.status}）`
          : (outcome.error ?? `请求失败：HTTP ${outcome.status}`);
        this.progress?.pageFailed(venueId, pageNo, message);
        return this.failure(
          venueId,
          pages,
          layout,
          recoveries,
          rateLimitWaits,
          message,
        );
      }

      let parsed;
      try {
        this.progress?.pagePhase(venueId, pageNo, 'parsing');
        parsed = parsePage(outcome.html, outcome.url, pageNo, venueId);
      } catch (error) {
        const message = (error as Error).message;
        this.progress?.pageFailed(venueId, pageNo, message);
        return this.failure(
          venueId,
          pages,
          layout,
          recoveries,
          rateLimitWaits,
          message,
        );
      }

      layout ??= parsed.layout;
      const items: AnnouncementInput[] = parsed.announcements.map((item) => ({
        ...item,
      }));
      this.progress?.pagePhase(venueId, pageNo, 'committing');
      const outcomeWrite = await this.store.upsertPage(items, new Date().toISOString());
      inserted += outcomeWrite.inserted;
      changed += outcomeWrite.changed;
      pending += items.filter((item) => item.parseStatus === 'pending').length;
      pages += 1;
      seenPages.add(pageNo);
      failures = 0;

      // 提交边界：upsertPage 事务成功后才推进，并按数据库实况统计在库公告，
      // 这样会话轮换后的重读不会虚增已入库进度。
      const allRows = await this.store.allAnnouncements();
      const venueCount = allRows.filter((item) => item.venueId === venueId).length;
      this.progress?.pageCommitted(venueId, {
        page: pageNo,
        url: outcome.url,
        reread,
        inserted: outcomeWrite.inserted,
        changed: outcomeWrite.changed,
        totalVenueAnnouncements: venueCount,
      });

      this.log(
        `  ${venueId} 第 ${pageNo} 页（${parsed.layout}）：${items.length} 条` +
          (outcomeWrite.inserted || outcomeWrite.changed
            ? `，新增 ${outcomeWrite.inserted} / 更新 ${outcomeWrite.changed}`
            : '，无变化') +
          (reread ? '（会话轮换重读，不重复计进度）' : ''),
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

    const totalItems = await this.store.allAnnouncements();
    const venueItems = totalItems.filter((item) => item.venueId === venueId);
    await this.store.recordVenueSync({
      venueId,
      runAt: new Date().toISOString(),
      pages,
      recoveries,
      rateLimitWaits,
      status: 'ok',
      lastError: null,
      announcements: venueItems.length,
    });
    this.progress?.venueFinished(venueId, 'ok', null);

    return {
      venueId,
      pages,
      announcements: venueItems.length,
      layout,
      recoveries,
      rateLimitWaits,
      inserted,
      changed,
      pending,
      ok: true,
      error: null,
    };
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
    this.progress?.venueFinished(venueId, 'failed', error);
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
      ok: false,
      error,
    };
  }

  /** 依次采集各剧场；单剧场失败不影响其他剧场。 */
  async collectAll(venueIds: string[] = VENUE_IDS): Promise<CollectResult> {
    this.progress?.setPhase('collecting');
    const venues: VenueCollectResult[] = [];
    let runFailed = false;
    try {
      for (const venueId of venueIds) {
        this.log(`采集 ${venueId}`);
        try {
          venues.push(await this.collectVenue(venueId));
        } catch (error) {
          runFailed = true;
          const message = (error as Error).message;
          this.progress?.venueFinished(venueId, 'failed', message);
          venues.push(
            await this.failure(venueId, 0, null, 0, 0, message),
          );
        }
      }
      // 每轮采集（含单剧场）后统一刷新派生排期；中断时这里仍会执行，
      // 保证已入库的公告与已确认的改场立即可查。
      this.progress?.setPhase('refreshing');
      await this.store.refreshEffective();
      const rows = await this.store.allAnnouncements();
      this.progress?.setPhase(runFailed ? 'failed' : 'finished');
      this.progress?.setError(runFailed ? '部分剧场采集失败' : null);
      return {
        venues,
        announcements: rows.length,
        pending: rows.filter((row) => row.parseStatus === 'pending').length,
      };
    } catch (error) {
      this.progress?.setPhase('failed');
      this.progress?.setError((error as Error).message);
      throw error;
    } finally {
      await this.progress?.flush();
    }
  }
}
