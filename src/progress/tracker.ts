import {
  renameSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  PageAttempt,
  PageCommitInput,
  ProgressSnapshot,
  RateLimitWaitInput,
  RunPhase,
  VenueProgress,
} from './types';

/** 诊断状态文件默认位置：与数据库同目录、同名加 .progress.json。 */
export function defaultProgressPath(dbPath: string): string {
  return `${dbPath}.progress.json`;
}

function emptyVenue(venueId: string, now: string): VenueProgress {
  return {
    venueId,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    committedPages: [],
    committedAnnouncements: 0,
    lastCommittedAt: null,
    lastAttempt: null,
    reReads: 0,
    recoveries: 0,
    rateLimitWaits: 0,
    error: null,
  };
}

/**
 * 采集进程侧的运行态记录器。
 * 每次状态变化都快照整个 JSON，经“临时文件 + rename”原子落盘，
 * 因此采集进程被 SIGKILL 后，诊断侧读到的永远是最后一次完整写入。
 */
export class ProgressTracker {
  private readonly snapshot: ProgressSnapshot;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly filePath: string,
    dbPath: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.now = now;
    this.snapshot = {
      schemaVersion: 1,
      dbPath,
      pid: process.pid,
      startedAt: now(),
      updatedAt: now(),
      phase: 'starting',
      finishedAt: null,
      currentVenueId: null,
      venues: {},
      error: null,
    };
  }

  private readonly now: () => string;

  private venue(venueId: string): VenueProgress {
    const existing = this.snapshot.venues[venueId];
    if (existing) return existing;
    const created = emptyVenue(venueId, this.now());
    this.snapshot.venues[venueId] = created;
    return created;
  }

  /** 串行化落盘：状态变化可能在异步边界连续发生，写文件顺序不能乱。 */
  private persist(): void {
    if (this.closed) return;
    this.snapshot.updatedAt = this.now();
    const payload = JSON.stringify(this.snapshot, null, 2);
    this.writeChain = this.writeChain.then(() => {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, payload, 'utf8');
        renameSync(tmp, this.filePath);
      } catch {
        // 诊断信息不能反过来打断采集；落盘失败时静默保留内存态。
      }
    });
  }

  setPhase(phase: RunPhase): void {
    this.snapshot.phase = phase;
    if (phase === 'finished' || phase === 'failed') {
      this.snapshot.finishedAt = this.now();
    }
    this.persist();
  }

  setError(error: string | null): void {
    this.snapshot.error = error;
    this.persist();
  }

  venueStarted(venueId: string): void {
    const venue = this.venue(venueId);
    venue.status = 'running';
    venue.startedAt ??= this.now();
    venue.updatedAt = this.now();
    venue.error = null;
    this.snapshot.currentVenueId = venueId;
    this.snapshot.phase = 'collecting';
    this.persist();
  }

  /** 页面尝试开始（含会话轮换后对旧页的重读）。 */
  pageAttempt(
    venueId: string,
    page: number,
    url: string,
    reread: boolean,
  ): void {
    const venue = this.venue(venueId);
    const attempt: PageAttempt = {
      page,
      url,
      reread,
      phase: 'fetching',
      startedAt: this.now(),
      updatedAt: this.now(),
      finishedAt: null,
      rateLimit: null,
      error: null,
    };
    venue.lastAttempt = attempt;
    if (reread) venue.reReads += 1;
    venue.updatedAt = this.now();
    this.persist();
  }

  /** 429：记录本次实际等待与预计恢复时刻。 */
  rateLimitWait(venueId: string, input: RateLimitWaitInput): void {
    const venue = this.venue(venueId);
    const now = this.now();
    if (venue.lastAttempt) {
      venue.lastAttempt.phase = 'rate_limited';
      venue.lastAttempt.updatedAt = now;
      venue.lastAttempt.rateLimit = {
        retryAfterMs: input.retryAfterMs,
        cumulativeMs: input.cumulativeMs,
        waitNumber: input.waitNumber,
        startedAt: now,
        resumeAt: new Date(Date.now() + input.retryAfterMs).toISOString(),
      };
    }
    venue.rateLimitWaits += 1;
    venue.updatedAt = now;
    this.persist();
  }

  /** 翻页签名失效（409），本页将回到入口重新取得。 */
  recovery(venueId: string, error: string | null): void {
    const venue = this.venue(venueId);
    venue.recoveries += 1;
    if (venue.lastAttempt) {
      venue.lastAttempt.phase = 'recovering';
      venue.lastAttempt.updatedAt = this.now();
      venue.lastAttempt.error = error;
    }
    venue.updatedAt = this.now();
    this.persist();
  }

  pagePhase(
    venueId: string,
    page: number,
    phase: PageAttempt['phase'],
  ): void {
    const venue = this.venue(venueId);
    if (venue.lastAttempt && venue.lastAttempt.page === page) {
      venue.lastAttempt.phase = phase;
      venue.lastAttempt.updatedAt = this.now();
      venue.updatedAt = this.now();
      this.persist();
    }
  }

  /** 一页的 upsertPage 事务已提交：提交边界在这里推进。 */
  pageCommitted(venueId: string, input: PageCommitInput): void {
    const venue = this.venue(venueId);
    const now = this.now();
    if (!venue.committedPages.includes(input.page)) {
      venue.committedPages.push(input.page);
      venue.committedPages.sort((a, b) => a - b);
    }
    venue.committedAnnouncements = input.totalVenueAnnouncements;
    venue.lastCommittedAt = now;
    if (venue.lastAttempt) {
      venue.lastAttempt.phase = 'done';
      venue.lastAttempt.updatedAt = now;
      venue.lastAttempt.finishedAt = now;
      venue.lastAttempt.error = null;
    }
    venue.updatedAt = now;
    this.persist();
  }

  /** 单次页面尝试失败（解析错误、连接中断等，不含 409 恢复）。 */
  pageFailed(venueId: string, page: number, error: string): void {
    const venue = this.venue(venueId);
    if (venue.lastAttempt && venue.lastAttempt.page === page) {
      venue.lastAttempt.phase = 'failed';
      venue.lastAttempt.updatedAt = this.now();
      venue.lastAttempt.finishedAt = this.now();
      venue.lastAttempt.error = error;
    }
    venue.updatedAt = this.now();
    this.persist();
  }

  venueFinished(
    venueId: string,
    status: VenueProgress['status'],
    error: string | null,
  ): void {
    const venue = this.venue(venueId);
    venue.status = status;
    venue.error = error;
    venue.updatedAt = this.now();
    this.persist();
  }

  /** 等待队列落盘完成，确保进程退出前最后状态已写入。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}
