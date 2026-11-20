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
  /**
   * 测试钩子：某页正文下载、解析成功之后、入库之前回调。
   * 抛错即模拟“正文已下载但尚未入库就中断”，此时 ETag 不会落库。
   */
  beforePersistPage?: (venueId: string, page: number) => void;
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
  /** 本站点本轮回传正文的页数（HTTP 200，实际传输了 HTML）。 */
  bodyTransferred: number;
  /** 条件命中、未回传正文的页数（HTTP 304）。 */
  notModified: number;
  ok: boolean;
  error: string | null;
}

export interface CollectResult {
  venues: VenueCollectResult[];
  announcements: number;
  pending: number;
  bodyTransferred: number;
  notModified: number;
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
  /** 条件命中：站点确认页面未变，不回传正文。 */
  notModified: boolean;
  /** 站点为当前页面给出的 ETag（200/304 都可能携带）。 */
  etag: string | null;
  /** 304 无正文时，下一页链接通过响应头下发。 */
  headerNextUrl: string | null;
  headerNextPage: number | null;
  error: string | null;
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
  private readonly beforePersistPage?: (venueId: string, page: number) => void;

  constructor(options: CollectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.store = options.store;
    this.maxPages = options.maxPages ?? 30;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? sleep;
    this.beforePersistPage = options.beforePersistPage;
  }

  private async fetchPage(
    url: string,
    jar: CookieJar,
    etag: string | null,
  ): Promise<FetchOutcome> {
    let retriedAfterMs: number | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const headers: Record<string, string> = {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'theatre-festival-desk/1.0 (+local collector)',
      };
      if (etag) headers['if-none-match'] = etag;
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
          notModified: false,
          etag: null,
          headerNextUrl: null,
          headerNextPage: null,
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
            notModified: false,
            etag: null,
            headerNextUrl: null,
            headerNextPage: null,
            error: `限流等待 ${formatDuration(delay)} 超过上限`,
          };
        }
        retriedAfterMs = (retriedAfterMs ?? 0) + delay;
        this.log(`  限流：${url} 返回 429，按 Retry-After 等待 ${formatDuration(delay)}`);
        await this.sleepFn(delay);
        continue;
      }

      const headerNextHref = response.headers.get('x-next-href');
      const headerNextPageRaw = response.headers.get('x-next-page');
      const headerNextUrl = headerNextHref
        ? new URL(headerNextHref, this.baseUrl).toString()
        : null;
      const headerNextPage =
        headerNextPageRaw && /^\d+$/.test(headerNextPageRaw)
          ? Number(headerNextPageRaw)
          : null;
      const responseEtag = response.headers.get('etag');

      if (response.status === 304) {
        // 条件命中：没有正文，直接消费响应头里的翻页位置。
        return {
          ok: true,
          status: 304,
          html: '',
          url: response.url || url,
          rateLimited: false,
          retriedAfterMs,
          recovery: false,
          notModified: true,
          etag: responseEtag ?? etag,
          headerNextUrl,
          headerNextPage,
          error: null,
        };
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
          notModified: false,
          etag: null,
          headerNextUrl: null,
          headerNextPage: null,
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
        notModified: false,
        etag: responseEtag,
        headerNextUrl,
        headerNextPage,
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
      notModified: false,
      etag: null,
      headerNextUrl: null,
      headerNextPage: null,
      error: '多次限流后仍未恢复',
    };
  }

  async collectVenue(venueId: string): Promise<VenueCollectResult> {
    const jar = createCookieJar();
    const entryUrl = `${this.baseUrl}/venue/${encodeURIComponent(venueId)}`;
    let pages = 0;
    let recoveries = 0;
    let rateLimitWaits = 0;
    let inserted = 0;
    let changed = 0;
    let pending = 0;
    let bodyTransferred = 0;
    let notModified = 0;
    let layout: string | null = null;

    // 上一轮已入库页面的 ETag：重启后续采仍可直接发条件请求。
    const etagByPage = new Map(
      (await this.store.pageStates(venueId)).map((state) => [
        state.sourcePage,
        state.etag,
      ]),
    );
    // 全部 304 的轮次没有页面可解析，沿用上一轮记录的版式。
    const previousSync = (await this.store.venueSyncState()).find(
      (record) => record.venueId === venueId,
    );
    if (previousSync?.layout) layout = previousSync.layout;

    let nextUrl: string | null = entryUrl;
    let pageNo = 1;
    let failures = 0;

    while (nextUrl && pages < this.maxPages) {
      const outcome = await this.fetchPage(nextUrl, jar, etagByPage.get(pageNo) ?? null);
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 翻页签名失效：丢弃旧链接、回到入口页重新取得可用的翻页位置。
        recoveries += 1;
        failures += 1;
        if (failures > 4) {
          return this.failure(venueId, pages, layout, recoveries, rateLimitWaits, bodyTransferred, notModified, '翻页位置多次失效');
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
          recoveries,
          rateLimitWaits,
          bodyTransferred,
          notModified,
          outcome.rateLimited
            ? `限流等待超过上限（${outcome.status}）`
            : (outcome.error ?? `请求失败：HTTP ${outcome.status}`),
        );
      }

      pages += 1;
      failures = 0;

      if (outcome.notModified) {
        // 公告未变：不解析、不回传正文、不重复入库，仅沿响应头继续翻页。
        notModified += 1;
        this.log(`  ${venueId} 第 ${pageNo} 页：内容未变（304，无正文传输）`);
        if (outcome.headerNextUrl) {
          pageNo = outcome.headerNextPage ?? pageNo + 1;
          nextUrl = outcome.headerNextUrl;
        } else {
          nextUrl = null;
        }
        continue;
      }

      let parsed;
      try {
        parsed = parsePage(outcome.html, outcome.url, pageNo, venueId);
      } catch (error) {
        return this.failure(
          venueId,
          pages,
          layout,
          recoveries,
          rateLimitWaits,
          bodyTransferred,
          notModified,
          (error as Error).message,
        );
      }

      layout ??= parsed.layout;
      const items: AnnouncementInput[] = parsed.announcements.map((item) => ({
        ...item,
      }));

      // 测试钩子：正文已下载、解析成功，但入库前中断。
      // 此时不写 ETag，下次续采必须重新拉取这一页正文。
      this.beforePersistPage?.(venueId, pageNo);

      const outcomeWrite = outcome.etag
        ? await this.store.upsertPageWithState(
            items,
            venueId,
            pageNo,
            outcome.etag,
            new Date().toISOString(),
          )
        : await this.store.upsertPage(items, new Date().toISOString());
      if (outcome.etag) etagByPage.set(pageNo, outcome.etag);
      inserted += outcomeWrite.inserted;
      changed += outcomeWrite.changed;
      pending += items.filter((item) => item.parseStatus === 'pending').length;
      bodyTransferred += 1;

      this.log(
        `  ${venueId} 第 ${pageNo} 页（${parsed.layout}）：${items.length} 条` +
          (outcomeWrite.inserted || outcomeWrite.changed
            ? `，新增 ${outcomeWrite.inserted} / 更新 ${outcomeWrite.changed}`
            : '，无变化'),
      );

      // 优先用 HTML 里的下一页链接，304 场景才依赖响应头。
      const nextHref = parsed.nextUrl ?? outcome.headerNextUrl;
      if (nextHref) {
        pageNo = outcome.headerNextPage ?? pageNo + 1;
        nextUrl = nextHref;
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
      layout,
    });

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
      bodyTransferred,
      notModified,
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
    bodyTransferred: number,
    notModified: number,
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
      layout,
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
      bodyTransferred,
      notModified,
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
          await this.failure(venueId, 0, null, 0, 0, 0, 0, (error as Error).message),
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
      bodyTransferred: venues.reduce((sum, venue) => sum + venue.bodyTransferred, 0),
      notModified: venues.reduce((sum, venue) => sum + venue.notModified, 0),
    };
  }
}
