/**
 * 采集运行态诊断数据结构。
 * 状态以 JSON 文件落盘，与 DuckDB 完全独立：采集进程持有数据库时，
 * 另一个 CLI 进程仍可只读该文件回答“采到哪了 / 在等什么 / 停在哪”。
 */

export type RunPhase =
  | 'starting'
  | 'collecting'
  | 'refreshing'
  | 'finished'
  | 'failed';

export type VenueRunStatus = 'running' | 'ok' | 'failed';

/** 一次页面尝试所处的阶段；被强制结束时最后一次尝试会停在其中之一。 */
export type AttemptPhase =
  | 'fetching'
  | 'rate_limited'
  | 'parsing'
  | 'committing'
  | 'recovering'
  | 'done'
  | 'failed';

export interface RateLimitInfo {
  /** 本次 429 实际对应的等待时长（毫秒，来自 Retry-After）。 */
  retryAfterMs: number;
  /** 同一页面尝试内多次 429 的累计等待。 */
  cumulativeMs: number;
  /** 第几次等待（同一页面尝试内从 1 开始）。 */
  waitNumber: number;
  startedAt: string;
  /** 本次等待的预计恢复时刻。 */
  resumeAt: string;
}

export interface PageAttempt {
  page: number;
  url: string;
  /** 会话轮换后重新取得旧页时为 true，单独计入重读，不增进度。 */
  reread: boolean;
  phase: AttemptPhase;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  rateLimit: RateLimitInfo | null;
  error: string | null;
}

export interface VenueProgress {
  venueId: string;
  status: VenueRunStatus;
  startedAt: string | null;
  updatedAt: string | null;
  /** 已完成入库提交的页号（提交边界）。 */
  committedPages: number[];
  /** 该剧场当前实际在库公告数（每次提交后按数据库实况刷新，重读不会虚增）。 */
  committedAnnouncements: number;
  lastCommittedAt: string | null;
  /** 最后一次页面尝试；进程被杀后它就停在当时的阶段。 */
  lastAttempt: PageAttempt | null;
  /** 会话轮换后重读旧页的次数。 */
  reReads: number;
  recoveries: number;
  rateLimitWaits: number;
  error: string | null;
}

export interface ProgressSnapshot {
  schemaVersion: 1;
  dbPath: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  phase: RunPhase;
  finishedAt: string | null;
  currentVenueId: string | null;
  venues: Record<string, VenueProgress>;
  error: string | null;
}

export interface RateLimitWaitInput {
  page: number;
  url: string;
  reread: boolean;
  retryAfterMs: number;
  cumulativeMs: number;
  waitNumber: number;
}

export interface PageCommitInput {
  page: number;
  url: string;
  reread: boolean;
  inserted: number;
  changed: number;
  /** 提交后该剧场在库公告总数。 */
  totalVenueAnnouncements: number;
}
