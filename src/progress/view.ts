import type { AttemptPhase, RunPhase } from './types';
import type { ProgressDiagnosis, VenueDiagnosis } from './reader';
import { formatDuration } from '../core/time';
import { venueName } from '../venues';

const PHASE_LABEL: Record<RunPhase, string> = {
  starting: '启动中',
  collecting: '采集中',
  refreshing: '刷新已确认排期',
  finished: '已结束',
  failed: '失败',
};

const PROCESS_LABEL = {
  running: '运行中',
  exited: '已正常结束',
  killed: '已被强制结束（未写结束标记）',
} as const;

const ATTEMPT_PHASE_LABEL: Record<AttemptPhase, string> = {
  fetching: '请求页面',
  rate_limited: '限流等待',
  parsing: '解析页面',
  committing: '提交入库',
  recovering: '翻页凭据失效，回入口恢复',
  done: '已完成',
  failed: '尝试失败',
};

function shortTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url.split('?')[0];
  }
}

function formatVenue(item: VenueDiagnosis): string[] {
  const { venue, lastAttempt } = item;
  const lines: string[] = [];
  const status =
    venue.status === 'ok'
      ? '完成'
      : venue.status === 'failed'
        ? `未完成（${venue.error ?? '未知错误'}）`
        : '进行中';
  const lastPage = venue.committedPages.at(-1);
  lines.push(
    `${venue.venueId}（${venueName(venue.venueId)}） ${status}` +
      `｜最后已提交页 ${lastPage ? `第 ${lastPage} 页` : '尚无'}` +
      `（已提交 ${venue.committedPages.length} 页、在库公告 ${venue.committedAnnouncements} 条）`,
  );
  if (venue.committedPages.length > 0) {
    lines.push(`    已提交页号：${venue.committedPages.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (venue.reReads > 0) {
    lines.push(
      `    会话轮换重读旧页 ${venue.reReads} 次（单独计为重读，不计入已提交进度）`,
    );
  }
  if (lastAttempt) {
    const { attempt, remainingWaitMs } = lastAttempt;
    const reread = attempt.reread ? '（重读）' : '';
    lines.push(
      `    最后一次尝试：第 ${attempt.page} 页${reread} ${withoutQuery(attempt.url)}` +
        ` → ${ATTEMPT_PHASE_LABEL[attempt.phase]}（开始 ${shortTime(attempt.startedAt)}）`,
    );
    if (attempt.phase === 'rate_limited' && attempt.rateLimit) {
      const rl = attempt.rateLimit;
      lines.push(
        `      本次限流等待 ${formatDuration(rl.retryAfterMs)}` +
          `（本页第 ${rl.waitNumber} 次，累计 ${formatDuration(rl.cumulativeMs)}）` +
          `，预计恢复 ${shortTime(rl.resumeAt)}` +
          (remainingWaitMs !== null
            ? `，距恢复还有 ${formatDuration(remainingWaitMs)}`
            : ''),
      );
    }
    if (attempt.phase === 'failed' && attempt.error) {
      lines.push(`      失败原因：${attempt.error}`);
    }
    if (
      item.processState === 'killed' &&
      attempt.phase !== 'done' &&
      venue.status === 'running'
    ) {
      lines.push('      采集进程在此阶段被强制结束，该页未越过提交边界');
    }
  }
  lines.push(
    `    累计：翻页恢复 ${venue.recoveries} 次，限流等待 ${venue.rateLimitWaits} 次`,
  );
  return lines;
}

export function formatProgress(diagnosis: ProgressDiagnosis): string {
  const { snapshot, processState } = diagnosis;
  const lines: string[] = [];
  lines.push(`采集诊断  PID ${snapshot.pid}  ${PROCESS_LABEL[processState]}`);
  lines.push(
    `阶段 ${PHASE_LABEL[snapshot.phase]}｜开始 ${shortTime(snapshot.startedAt)}` +
      `｜最近更新 ${shortTime(snapshot.updatedAt)}`,
  );
  lines.push(`数据库 ${snapshot.dbPath}`);
  if (snapshot.error) lines.push(`运行错误：${snapshot.error}`);
  lines.push('');
  if (diagnosis.venues.length === 0) {
    lines.push('（尚无剧场采集记录）');
  } else {
    for (const item of diagnosis.venues) {
      lines.push(...formatVenue(item));
    }
  }
  return lines.join('\n');
}
