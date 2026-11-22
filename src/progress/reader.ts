import { readFileSync } from 'node:fs';
import { kill } from 'node:process';
import type {
  PageAttempt,
  ProgressSnapshot,
  VenueProgress,
} from './types';

export type ProcessState = 'running' | 'exited' | 'killed';

export interface AttemptDiagnosis {
  attempt: PageAttempt;
  /** 若当前正在限流等待，距恢复还剩多少毫秒；否则为 null。 */
  remainingWaitMs: number | null;
}

export interface VenueDiagnosis {
  venue: VenueProgress;
  processState: ProcessState;
  lastAttempt: AttemptDiagnosis | null;
}

export interface ProgressDiagnosis {
  snapshot: ProgressSnapshot;
  processState: ProcessState;
  currentVenue: VenueDiagnosis | null;
  venues: VenueDiagnosis[];
  readAt: string;
}

/**
 * 进程是否仍存活。信号 0 不实际发信号，只做存在性检查。
 * 仅作为辅助信息：是否“被强制结束”以快照里的结束标记为准，
 * 因为 PID 可能被复用，采集进程正常退出后信号检查也会失败。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权发信号，仍算存活。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function diagnoseAttempt(
  attempt: PageAttempt,
  now: number,
): AttemptDiagnosis {
  let remainingWaitMs: number | null = null;
  if (attempt.phase === 'rate_limited' && attempt.rateLimit) {
    remainingWaitMs = Math.max(
      0,
      Date.parse(attempt.rateLimit.resumeAt) - now,
    );
  }
  return { attempt, remainingWaitMs };
}

function diagnoseVenue(
  venue: VenueProgress,
  processState: ProcessState,
  now: number,
): VenueDiagnosis {
  return {
    venue,
    processState,
    lastAttempt: venue.lastAttempt
      ? diagnoseAttempt(venue.lastAttempt, now)
      : null,
  };
}

/**
 * 诊断侧只读入口：读取采集进程落盘的运行态，
 * 并结合当前时间与进程存活情况给出可直接展示的结论。
 */
export class ProgressReader {
  static read(filePath: string): ProgressDiagnosis {
    const raw = readFileSync(filePath, 'utf8');
    const snapshot = JSON.parse(raw) as ProgressSnapshot;
    const now = Date.now();
    // 结束标记是采集进程在最后一次落盘时主动写入的，权威可靠；
    // 没有结束标记时才结合 PID 存活判断是仍在运行还是被强制结束。
    const finished = snapshot.finishedAt !== null;
    const alive = isProcessAlive(snapshot.pid);
    const processState: ProcessState = finished
      ? 'exited'
      : alive
        ? 'running'
        : 'killed';
    const venues = Object.values(snapshot.venues)
      .sort((a, b) => a.venueId.localeCompare(b.venueId))
      .map((venue) => diagnoseVenue(venue, processState, now));
    const currentVenue = snapshot.currentVenueId
      ? (venues.find((item) => item.venue.venueId === snapshot.currentVenueId) ??
        null)
      : null;
    return {
      snapshot,
      processState,
      currentVenue,
      venues,
      readAt: new Date(now).toISOString(),
    };
  }
}
