import { VENUE_IDS } from '../venues';
import { parsePage } from '../parse/parse';
import { formatDuration, parseRetryAfter, sleep } from '../core/time';
import { RateLimitGate, SiteRateLimitError } from '../core/rateLimit';
import type { VenueTarget } from './config';
import type { Store } from '../db/store';
import type { AnnouncementInput } from '../core/types';

export interface CollectorOptions {
  /** 单站用法：所有剧场都从该站点采集（保留原 --site 行为）。 */
  baseUrl?: string;
  /** 多站用法：按剧场配置各自的站点；与 baseUrl 二选一。 */
  targets?: VenueTarget[];
  store: Store;
  maxPages?: number;
  maxRateLimitWaitMs?: number;
  /** 注入日志，测试里可静默。 */
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  /** 复用已有闸门（repair 与 collect 共享同一份限流状态时注入）。 */
  gate?: RateLimitGate;
}

export interface VenueCollectResult {
  venueId: string;
  siteBaseUrl: string;
  pages: number;
  announcements: number;
  layout: string | null;
  recoveries: number;
  rateLimitWaits: number;
  inserted: number;
  changed: number;
  pending: number;
  /** 未到站点恢复时刻、本轮跳过采集时为 true。 */
  skipped: boolean;
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
    absorb(response) {
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
 * 多剧场采集：按“剧场 → 站点”配置分组，同一站点的剧场共享会话与限流闸门，
 * 一站 429 后同站剧场一并等到恢复时刻，其他站点照常采集。
 */
export class Collector {
  private readonly store: Store;
  private readonly maxPages: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly log: (message: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly gate: RateLimitGate;
  private readonly singleSite: string | null;
  private readonly initialTargets: VenueTarget[] | null;
  private readonly jars = new Map<string, CookieJar>();

  constructor(options: CollectorOptions) {
    this.store = options.store;
    this.maxPages = options.maxPages ?? 30;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? sleep;
    this.singleSite = options.baseUrl ? options.baseUrl.replace(/\/$/, '') : null;
    this.initialTargets = options.targets ? options.targets.map((target) => ({ ...target })) : null;
    if (!this.singleSite && !this.initialTargets) {
      throw new Error('Collector 需要 baseUrl（单站）或 targets（多站）配置');
    }
    this.gate =
      options.gate ??
      new RateLimitGate({
        store: this.store,
        maxWaitMs: this.maxRateLimitWaitMs,
        log: this.log,
        sleepFn: this.sleepFn,
      });
  }

  /** 当前生效的“剧场 → 站点”清单；collectAll 可只选其中部分剧场。 */
  private targetsFor(venueIds: string[] | undefined): VenueTarget[] {
    if (this.initialTargets) {
      const wanted = venueIds ? new Set(venueIds) : null;
      const targets = wanted
        ? this.initialTargets.filter((target) => wanted.has(target.venueId))
        : this.initialTargets;
      const known = new Set(targets.map((target) => target.venueId));
      const unresolved = venueIds?.filter((id) => !known.has(id)) ?? [];
      if (unresolved.length > 0) {
        throw new Error(`剧场 ${unresolved.join(', ')} 未配置采集站点`);
      }
      return targets;
    }
    const ids = venueIds && venueIds.length > 0 ? venueIds : VENUE_IDS;
    return ids.map((venueId) => ({
      venueId,
      siteBaseUrl: this.singleSite as string,
    }));
  }

  private jarFor(siteBaseUrl: string): CookieJar {
    let jar = this.jars.get(siteBaseUrl);
    if (!jar) {
      jar = createCookieJar();
      this.jars.set(siteBaseUrl, jar);
    }
    return jar;
  }

  private async fetchPage(
    siteBaseUrl: string,
    url: string,
    jar: CookieJar,
  ): Promise<FetchOutcome> {
    let retriedAfterMs: number | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // 请求前先过站点闸门：同站另一个剧场刚被限流时，这里直接等到恢复时刻。
      await this.gate.awaitRecovery(siteBaseUrl);

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
        retriedAfterMs = (retriedAfterMs ?? 0) + delay;
        // 超过单次上限时抛出，由 collectVenue 记录为站点限流失败并跳过同站后续剧场。
        await this.gate.noteRateLimit(siteBaseUrl, delay, new Date().toISOString());
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
      // 成功拿到页面：站点已恢复，清除可能残留的限流记录。
      if (await this.gate.isActive(siteBaseUrl)) await this.gate.clear(siteBaseUrl);
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

  async collectVenue(
    venueId: string,
    siteBaseUrl?: string,
  ): Promise<VenueCollectResult> {
    const site = (siteBaseUrl ?? this.singleSite)?.replace(/\/$/, '');
    if (!site) throw new Error(`剧场 ${venueId} 未配置采集站点`);
    const jar = this.jarFor(site);
    const entryUrl = `${site}/venue/${encodeURIComponent(venueId)}`;
    let pages = 0;
    let recoveries = 0;
    let rateLimitWaits = 0;
    let inserted = 0;
    let changed = 0;
    let pending = 0;
    let layout: string | null = null;

    // 重启 / repair 场景：站点给出的恢复时刻未到且超出单次上限，直接跳过，不发起请求。
    const pendingLimit = await this.gate.activePending(site);
    if (pendingLimit) {
      const remaining = Date.parse(pendingLimit.resumeAt) - Date.now();
      if (remaining > this.maxRateLimitWaitMs) {
        const message =
          `站点限流恢复时刻 ${pendingLimit.resumeAt} 未到（还需 ${formatDuration(remaining)}），本轮跳过 ${venueId}`;
        this.log(`  ${message}`);
        await this.store.recordVenueSync({
          venueId,
          siteBaseUrl: site,
          runAt: new Date().toISOString(),
          pages: 0,
          recoveries: 0,
          rateLimitWaits: 0,
          status: 'rate_limited',
          lastError: message,
          announcements: 0,
        });
        return {
          venueId,
          siteBaseUrl: site,
          pages: 0,
          announcements: 0,
          layout: null,
          recoveries: 0,
          rateLimitWaits: 0,
          inserted: 0,
          changed: 0,
          pending: 0,
          skipped: true,
          ok: false,
          error: message,
        };
      }
    }

    let nextUrl: string | null = entryUrl;
    let pageNo = 1;
    let failures = 0;

    while (nextUrl && pages < this.maxPages) {
      let outcome: FetchOutcome;
      try {
        outcome = await this.fetchPage(site, nextUrl, jar);
      } catch (error) {
        if (error instanceof SiteRateLimitError) {
          return this.failure(
            venueId,
            site,
            pages,
            layout,
            recoveries,
            rateLimitWaits,
            `限流等待超过上限：站点恢复时刻 ${error.resumeAt}`,
            true,
          );
        }
        throw error;
      }
      if (outcome.retriedAfterMs !== null) rateLimitWaits += 1;

      if (outcome.recovery) {
        // 翻页签名失效：丢弃旧链接、回到入口页重新取得可用的翻页位置。
        recoveries += 1;
        failures += 1;
        if (failures > 4) {
          return this.failure(
            venueId,
            site,
            pages,
            layout,
            recoveries,
            rateLimitWaits,
            '翻页位置多次失效',
            false,
          );
        }
        this.log(`  翻页凭据失效（409）：${nextUrl} → 重新取得入口页`);
        nextUrl = entryUrl;
        pageNo = 1;
        continue;
      }

      if (!outcome.ok) {
        return this.failure(
          venueId,
          site,
          pages,
          layout,
          recoveries,
          rateLimitWaits,
          outcome.rateLimited
            ? `限流等待超过上限（${outcome.status}）`
            : (outcome.error ?? `请求失败：HTTP ${outcome.status}`),
          outcome.rateLimited,
        );
      }

      let parsed;
      try {
        parsed = parsePage(outcome.html, outcome.url, pageNo, venueId);
      } catch (error) {
        return this.failure(
          venueId,
          site,
          pages,
          layout,
          recoveries,
          rateLimitWaits,
          (error as Error).message,
          false,
        );
      }

      layout ??= parsed.layout;
      const items: AnnouncementInput[] = parsed.announcements.map((item) => ({
        ...item,
      }));
      const outcomeWrite = await this.store.upsertPage(items, new Date().toISOString());
      inserted += outcomeWrite.inserted;
      changed += outcomeWrite.changed;
      pending += items.filter((item) => item.parseStatus === 'pending').length;
      pages += 1;
      failures = 0;

      this.log(
        `  ${venueId}@${site} 第 ${pageNo} 页（${parsed.layout}）：${items.length} 条` +
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

    const totalItems = await this.store.allAnnouncements();
    const venueItems = totalItems.filter((item) => item.venueId === venueId);
    await this.store.recordVenueSync({
      venueId,
      siteBaseUrl: site,
      runAt: new Date().toISOString(),
      pages,
      recoveries,
      rateLimitWaits,
      status: 'ok',
      lastError: null,
      announcements: venueItems.length,
    });

    return {
      venueId,
      siteBaseUrl: site,
      pages,
      announcements: venueItems.length,
      layout,
      recoveries,
      rateLimitWaits,
      inserted,
      changed,
      pending,
      skipped: false,
      ok: true,
      error: null,
    };
  }

  private async failure(
    venueId: string,
    siteBaseUrl: string,
    pages: number,
    layout: string | null,
    recoveries: number,
    rateLimitWaits: number,
    error: string,
    rateLimited: boolean,
  ): Promise<VenueCollectResult> {
    this.log(`  ${venueId}@${siteBaseUrl} 采集未完成：${error}`);
    await this.store.recordVenueSync({
      venueId,
      siteBaseUrl,
      runAt: new Date().toISOString(),
      pages,
      recoveries,
      rateLimitWaits,
      status: rateLimited ? 'rate_limited' : 'failed',
      lastError: error,
      announcements: 0,
    });
    return {
      venueId,
      siteBaseUrl,
      pages,
      announcements: 0,
      layout,
      recoveries,
      rateLimitWaits,
      inserted: 0,
      changed: 0,
      pending: 0,
      skipped: rateLimited,
      ok: false,
      error,
    };
  }

  /**
   * 按站点分组依次采集各剧场；同站剧场共享会话与限流闸门，
   * 单剧场失败不影响其他剧场，其他站点始终照常采集。
   */
  async collectAll(venueIds?: string[]): Promise<CollectResult> {
    const targets = this.targetsFor(venueIds);
    await this.gate.hydrate();

    const grouped = new Map<string, VenueTarget[]>();
    for (const target of targets) {
      const group = grouped.get(target.siteBaseUrl) ?? [];
      group.push(target);
      grouped.set(target.siteBaseUrl, group);
    }

    const venues: VenueCollectResult[] = [];
    for (const [siteBaseUrl, group] of grouped) {
      this.log(`站点 ${siteBaseUrl}：剧场 ${group.map((target) => target.venueId).join('、')}`);
      for (const target of group) {
        this.log(`采集 ${target.venueId}（站点 ${siteBaseUrl}）`);
        try {
          venues.push(await this.collectVenue(target.venueId, siteBaseUrl));
        } catch (error) {
          venues.push(
            await this.failure(
              target.venueId,
              siteBaseUrl,
              0,
              null,
              0,
              0,
              (error as Error).message,
              false,
            ),
          );
        }
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
