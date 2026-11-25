import { VENUE_IDS } from '../venues';
import { parsePage } from '../parse/parse';
import { formatDuration, parseRetryAfter, sleep } from '../core/time';
import type { Store } from '../db/store';
import type { AnnouncementInput } from '../core/types';

export interface CollectorOptions {
  baseUrl: string;
  /**
   * 每次写库都新开一个 Store、用完即关：翻页、限流等待期间不持有
   * 数据库句柄，其他进程因此可以随时只读查询已发布的数据。
   */
  openStore: () => Promise<Store>;
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
  /** 翻到末页并发布为 true；采到一半（失败/页数上限）为 false，沿用上次发布。 */
  published: boolean;
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

/**
 * 单剧场采集：从入口页开始翻页；遇到 429 按 Retry-After 等待；
 * 遇到翻页签名失效（409）则重新取得入口页并回到可用的翻页位置。
 * 写库与发布分离：每页公告幂等写入工作区（短开短关）；只有翻到末页
 * 才把该剧场公告发布出去并刷新派生排期；采到一半不发布。
 */
export class Collector {
  private readonly baseUrl: string;
  private readonly openStore: () => Promise<Store>;
  private readonly maxPages: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly log: (message: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: CollectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.openStore = options.openStore;
    this.maxPages = options.maxPages ?? 30;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? sleep;
  }

  /** 短开短关地访问数据库。 */
  private async withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    const store = await this.openStore();
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
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

  async collectVenue(venueId: string): Promise<VenueCollectResult> {
    const jar = createCookieJar();
    const entryUrl = `${this.baseUrl}/venue/${encodeURIComponent(venueId)}`;
    let pages = 0;
    let recoveries = 0;
    let rateLimitWaits = 0;
    let inserted = 0;
    let changed = 0;
    let pending = 0;
    let layout: string | null = null;

    // 进入采集状态：在完成前不发布，查询继续沿用上次已发布的公告。
    await this.withStore((store) =>
      store.markVenueCollecting(venueId, new Date().toISOString()),
    );

    let nextUrl: string | null = entryUrl;
    let pageNo = 1;
    let failures = 0;

    while (nextUrl && pages < this.maxPages) {
      const outcome = await this.fetchPage(nextUrl, jar);
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 翻页签名失效：丢弃旧链接、回到入口页重新取得可用的翻页位置。
        recoveries += 1;
        failures += 1;
        if (failures > 4) {
          return this.failure(venueId, pages, layout, recoveries, rateLimitWaits, '翻页位置多次失效');
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
          recoveries,
          rateLimitWaits,
          (error as Error).message,
        );
      }

      layout ??= parsed.layout;
      const items: AnnouncementInput[] = parsed.announcements.map((item) => ({
        ...item,
      }));
      // 单页写入是一个短事务，写完立即释放数据库句柄。
      const outcomeWrite = await this.withStore((store) =>
        store.upsertPage(items, new Date().toISOString()),
      );
      inserted += outcomeWrite.inserted;
      changed += outcomeWrite.changed;
      pending += items.filter((item) => item.parseStatus === 'pending').length;
      pages += 1;
      failures = 0;

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
      // 未翻到末页：不发布，服务台继续沿用上次已发布的公告。
      this.log(`  ${venueId} 已达单次采集页数上限 ${this.maxPages}，本次不发布，剩余页面下次继续`);
      await this.withStore((store) =>
        store.recordVenueSync({
          venueId,
          runAt: new Date().toISOString(),
          pages,
          recoveries,
          rateLimitWaits,
          status: 'incomplete',
          lastError: null,
          announcements: 0,
        }),
      );
      return {
        venueId,
        pages,
        announcements: 0,
        layout,
        recoveries,
        rateLimitWaits,
        inserted,
        changed,
        pending,
        published: false,
        ok: true,
        error: null,
      };
    }

    // 翻到末页：发布该剧场（快照 + 折叠同一事务），服务台立即可查。
    const announcements = await this.withStore(async (store) => {
      const now = new Date().toISOString();
      const count = await store.countVenueAnnouncements(venueId);
      await store.publishVenue(venueId, now);
      await store.recordVenueSync({
        venueId,
        runAt: now,
        pages,
        recoveries,
        rateLimitWaits,
        status: 'ok',
        lastError: null,
        announcements: count,
      });
      return count;
    });
    this.log(`  ${venueId} 翻到末页，已发布 ${announcements} 条公告`);

    return {
      venueId,
      pages,
      announcements,
      layout,
      recoveries,
      rateLimitWaits,
      inserted,
      changed,
      pending,
      published: true,
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
    this.log(`  ${venueId} 采集未完成：${error}（本次不发布，沿用上次已发布的公告）`);
    await this.withStore((store) =>
      store.recordVenueSync({
        venueId,
        runAt: new Date().toISOString(),
        pages,
        recoveries,
        rateLimitWaits,
        status: 'failed',
        lastError: error,
        announcements: 0,
      }),
    );
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
      published: false,
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
    // 汇总以“已发布”为准：采到一半的剧场不计入。
    const summary = await this.withStore(async (store) => {
      const published = await store.publishedAnnouncements();
      return {
        announcements: published.length,
        pending: published.filter((row) => row.parseStatus === 'pending').length,
      };
    });
    return {
      venues,
      announcements: summary.announcements,
      pending: summary.pending,
    };
  }
}
