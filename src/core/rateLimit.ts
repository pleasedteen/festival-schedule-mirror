import { formatDuration } from './time';
import type { Store, SiteRateLimitRecord } from '../db/store';

/** 超过单次等待上限时抛出：保留站点给出的恢复时刻，交给持久化与后续运行使用。 */
export class SiteRateLimitError extends Error {
  constructor(
    readonly siteBaseUrl: string,
    readonly resumeAt: string,
    readonly requestedMs: number,
    readonly maxMs: number,
  ) {
    super(
      `站点 ${siteBaseUrl} 限流恢复需等待 ${formatDuration(requestedMs)}，超过单次上限 ${formatDuration(maxMs)}`,
    );
    this.name = 'SiteRateLimitError';
  }
}

interface PendingLimit {
  /** 站点给出的恢复时刻（ISO 字符串，绝对时间，跨重启仍可比较）。 */
  resumeAt: string;
  requestedMs: number;
}

export interface RateLimitGateOptions {
  store: Store;
  maxWaitMs: number;
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => Date;
}

/**
 * 站点级限流闸门：
 * - 同站所有剧场共享一个恢复时刻，一站 429 后同站剧场一并等待，其他站点照常；
 * - 等待未超单次上限时按 Retry-After 睡够后继续；
 * - 超过上限时把站点给出的恢复时刻持久化，本次跳过同站剧场，
 *   重启后再次运行 collect / repair 仍会遵守该时刻。
 */
export class RateLimitGate {
  private readonly store: Store;
  private readonly maxWaitMs: number;
  private readonly log: (message: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => Date;
  private readonly active = new Map<string, PendingLimit>();

  constructor(options: RateLimitGateOptions) {
    this.store = options.store;
    this.maxWaitMs = options.maxWaitMs;
    this.log = options.log ?? (() => undefined);
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  /** 打开数据库后读入此前持久化的站点恢复时刻。 */
  async hydrate(): Promise<void> {
    const records = await this.store.siteRateLimits();
    for (const record of records) {
      if (Date.parse(record.resumeAt) > this.nowFn().getTime()) {
        this.active.set(record.siteBaseUrl, {
          resumeAt: record.resumeAt,
          requestedMs: record.requestedMs,
        });
      } else {
        await this.store.deleteSiteRateLimit(record.siteBaseUrl);
      }
    }
  }

  /** 站点是否仍处于限流窗口内；窗口过期时顺带清除内存与持久化记录。 */
  async isActive(siteBaseUrl: string): Promise<boolean> {
    return (await this.activePending(siteBaseUrl)) !== null;
  }

  /**
   * 返回站点当前的限流状态；窗口已过期时清除内存与持久化记录并返回 null。
   */
  async activePending(siteBaseUrl: string): Promise<PendingLimit | null> {
    const pending = this.active.get(siteBaseUrl);
    if (!pending) return null;
    if (Date.parse(pending.resumeAt) <= this.nowFn().getTime()) {
      this.active.delete(siteBaseUrl);
      await this.store.deleteSiteRateLimit(siteBaseUrl);
      return null;
    }
    return pending;
  }

  private remainingMs(siteBaseUrl: string): number {
    const pending = this.active.get(siteBaseUrl);
    if (!pending) return 0;
    return Math.max(0, Date.parse(pending.resumeAt) - this.nowFn().getTime());
  }

  /**
   * 请求前检查：站点还在限流窗口内时，等到恢复时刻再放行；
   * 剩余等待超过单次上限时抛出 SiteRateLimitError，由调用方跳过该站点。
   */
  async awaitRecovery(siteBaseUrl: string): Promise<void> {
    const pending = await this.activePending(siteBaseUrl);
    if (!pending) return;
    const remaining = this.remainingMs(siteBaseUrl);
    if (remaining > this.maxWaitMs) {
      throw new SiteRateLimitError(
        siteBaseUrl,
        pending.resumeAt,
        pending.requestedMs,
        this.maxWaitMs,
      );
    }
    this.log(
      `  站点 ${siteBaseUrl} 仍在限流窗口：等待 ${formatDuration(remaining)} 后恢复采集`,
    );
    await this.sleepFn(remaining);
  }

  /**
   * 记录一次 429。未超上限：持久化恢复时刻并按 Retry-After 等待；
   * 超过上限：持久化恢复时刻并抛出，本次不再请求该站点。
   */
  async noteRateLimit(
    siteBaseUrl: string,
    retryAfterMs: number,
    nowIso: string,
  ): Promise<void> {
    const resumeAt = new Date(this.nowFn().getTime() + retryAfterMs).toISOString();
    this.active.set(siteBaseUrl, { resumeAt, requestedMs: retryAfterMs });
    const record: SiteRateLimitRecord = {
      siteBaseUrl,
      resumeAt,
      requestedMs: retryAfterMs,
      updatedAt: nowIso,
    };
    await this.store.upsertSiteRateLimit(record);

    if (retryAfterMs > this.maxWaitMs) {
      throw new SiteRateLimitError(siteBaseUrl, resumeAt, retryAfterMs, this.maxWaitMs);
    }
    this.log(
      `  站点 ${siteBaseUrl} 返回 429：按 Retry-After 等待 ${formatDuration(retryAfterMs)}（同站剧场一并等待）`,
    );
    await this.sleepFn(retryAfterMs);
  }

  /** 站点恢复正常访问后清除其限流状态与持久化记录。 */
  async clear(siteBaseUrl: string): Promise<void> {
    if (this.active.delete(siteBaseUrl)) {
      await this.store.deleteSiteRateLimit(siteBaseUrl);
    }
  }
}
