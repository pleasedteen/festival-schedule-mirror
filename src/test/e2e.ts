import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MockSite } from '../mock/server';
import { Store } from '../db/store';
import { Collector } from '../collect/collector';
import { FestivalDesk } from '../query/desk';
import { formatConfirmation, formatEventLine } from '../query/view';
import { runUnitChecks } from './unit';
import { venueName } from '../venues';
import { ProgressReader } from '../progress/reader';
import { formatProgress } from '../progress/view';
import type { ProgressDiagnosis } from '../progress/reader';
import type { EventState } from '../core/types';

const TOTAL_BUDGET_MS = 80_000;
const CLI_PATH = join(__dirname, '..', 'cli.js');

interface CheckResult {
  passed: number;
  failed: number;
}

class Harness {
  readonly checks: CheckResult = { passed: 0, failed: 0 };

  section(title: string): void {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
  }

  check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
      this.checks.passed += 1;
      console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
    } else {
      this.checks.failed += 1;
      console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
    }
  }

  equal<T>(name: string, actual: T, expected: T): void {
    this.check(
      name,
      Object.is(actual, expected),
      `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}

async function control(
  site: MockSite,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = await fetch(`${site.baseUrl}/_control/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as Record<string, any>;
}

function describe(event: EventState | null): string {
  if (!event) return '（未找到）';
  if (event.status === 'scheduled') {
    return `${venueName(event.venueId)} ${event.showTime} 入场 ${event.doorsTime}（修订 ${event.revision}）`;
  }
  return `${event.status}`;
}

async function collect(
  store: Store,
  site: MockSite,
  venues?: string[],
): Promise<Awaited<ReturnType<Collector['collectAll']>>> {
  const collector = new Collector({
    baseUrl: site.baseUrl,
    store,
    maxRateLimitWaitMs: 5000,
    log: (message) => console.log(`    · ${message.trim()}`),
  });
  return collector.collectAll(venues);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 以独立进程运行真实 CLI，模拟操作员另开终端执行命令。 */
function runCli(args: string[]): {
  child: ReturnType<typeof spawn>;
  done: Promise<CliResult>;
} {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<CliResult>((resolve) => {
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  return { child, done };
}

function progressQuery(dbPath: string, progressPath: string): ProgressDiagnosis {
  return ProgressReader.read(progressPath);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

export async function runE2E(): Promise<number> {
  const started = Date.now();
  const harness = new Harness();
  const site = new MockSite({ contentVersion: 1 });
  await site.listen(0);
  const workdir = mkdtempSync(join(tmpdir(), 'festival-desk-e2e-'));
  const dbPath = join(workdir, 'festival.duckdb');
  const diagDir = mkdtempSync(join(tmpdir(), 'festival-desk-diag-'));

  console.log('戏剧节服务台 · 本地端到端验证');
  console.log(`模拟公告站 ${site.baseUrl}`);
  console.log(`临时数据库 ${dbPath}`);
  const children = new Set<ReturnType<typeof spawn>>();

  try {
    /* ---------- 1. 翻页恢复 ---------- */
    harness.section('1. 翻页恢复（会话轮换后重新取得翻页位置）');
    await control(site, 'reset', { contentVersion: 1 });
    // 大剧院第 2 页请求时轮换会话，旧翻页签名立即失效。
    await control(site, 'rotate-after', { count: 2 });
    let store = await Store.open(dbPath);
    let result = await collect(store, site, ['grand']);
    const grand = result.venues[0];
    harness.check('采集完成且没有中断', grand.ok, `错误：${grand.error ?? '无'}`);
    harness.check('检测到翻页凭据失效并恢复', grand.recoveries >= 1, `恢复 ${grand.recoveries} 次`);
    harness.equal('大剧院两页公告全部入库', grand.announcements, 4);
    const grandRows = (await store.allAnnouncements()).filter((row) => row.venueId === 'grand');
    harness.equal('两页来源都被记录', new Set(grandRows.map((row) => row.sourcePage)).size, 2);
    const statsAfterRecovery = await control(site, 'stats');
    harness.check(
      '站点确实轮换过会话',
      Number(statsAfterRecovery.sessionRotations) >= 1,
      `轮换 ${statsAfterRecovery.sessionRotations} 次`,
    );

    /* ---------- 2. 限流 + 其余剧场采集 ---------- */
    harness.section('2. 临时限流（按站点给出的 Retry-After 恢复）与跨版式采集');
    await control(site, 'rate-limit', { seconds: 1, remaining: 1 });
    result = await collect(store, site, ['studio', 'harbor']);
    const studio = result.venues.find((venue) => venue.venueId === 'studio')!;
    const harbor = result.venues.find((venue) => venue.venueId === 'harbor')!;
    harness.check('实验剧场（旧版式）采集完成', studio.ok && studio.layout === 'legacy', `版式 ${studio.layout}，${studio.pages} 页`);
    harness.check('海港剧场（新版式）采集完成', harbor.ok && harbor.layout === 'v2', `版式 ${harbor.layout}，${harbor.pages} 页`);
    const waited = studio.rateLimitWaits + harbor.rateLimitWaits;
    harness.check('限流后按 Retry-After 等待并继续', waited >= 1, `等待 ${waited} 次`);

    /* ---------- 3. 改场前查询 ---------- */
    harness.section('3. 改场前：已确认排期与待补采并存');
    let desk = new FestivalDesk(store);
    const before = await desk.findEvent('E-1005');
    harness.check('E-1005 展示最近一次已确认排期（实验剧场）', before?.venueId === 'studio' && before?.revision === 2, describe(before));
    harness.check('E-1005 标记“改场待确认”', before?.hasPendingChange === true, before?.pendingNote ?? '');
    const beforeStudio = await desk.venueSchedule('studio');
    harness.check(
      '按剧场查询仍把 E-1005 列在实验剧场',
      beforeStudio.some((event) => event.eventId === 'E-1005'),
      beforeStudio.map((event) => event.eventId).join(', '),
    );
    const e1003 = await desk.findEvent('E-1003');
    const e1010 = await desk.findEvent('E-1010');
    harness.equal('E-1003 因缺少入场时间进入待补采', e1003?.status, 'pending_reparse');
    harness.equal('E-1010 因档期“待定”进入待补采', e1010?.status, 'pending_reparse');
    const pendingBefore = await desk.pendingReparse();
    harness.equal('待补采公告数量', pendingBefore.length, 2);
    const unaffected = await desk.findEvent('E-1007');
    harness.check(
      '其他剧场的可解析公告不受影响',
      unaffected?.status === 'scheduled' && unaffected?.venueId === 'harbor',
      describe(unaffected),
    );
    const cancelled = await desk.findEvent('E-1002');
    harness.equal('取消公告独立生效', cancelled?.status, 'cancelled');

    /* ---------- 4. 重启持久化 + 中断后续采 ---------- */
    harness.section('4. 采集中断、重启与续采');
    await store.close();
    store = await Store.open(dbPath);
    desk = new FestivalDesk(store);
    const afterRestart = await desk.findEvent('E-1005');
    harness.check(
      '重启后已确认排期仍可查询',
      afterRestart?.venueId === 'studio' && afterRestart?.revision === 2,
      describe(afterRestart),
    );
    harness.check(
      '重启后未确认的改场仍在等待另一端',
      afterRestart?.hasPendingChange === true && afterRestart?.pendingRevision === 3,
      afterRestart?.pendingNote ?? '',
    );

    // 让海港剧场在翻到第 2 页时连接被中断，模拟采集中断。
    const stats = await control(site, 'stats');
    await control(site, 'abort-after', { count: Number(stats.venuePagesServed) + 1 });
    const interrupted = await collect(store, site, ['harbor']);
    harness.check('中断被如实记录', interrupted.venues[0].ok === false, interrupted.venues[0].error ?? '');
    const stillQueryable = await new FestivalDesk(store).findEvent('E-1005');
    harness.check(
      '中断期间查询不受影响',
      stillQueryable?.venueId === 'studio',
      describe(stillQueryable),
    );
    await control(site, 'abort-after', { count: null });
    const resumed = await collect(store, site, ['harbor']);
    harness.check('清除故障后续采成功', resumed.venues[0].ok === true, `已采 ${resumed.venues[0].pages} 页`);

    /* ---------- 5. 待补采修正 ---------- */
    harness.section('5. 待补采公告修正后重新采入');
    await control(site, 'content', { version: 2 });
    const repaired = await collect(store, site, ['studio', 'harbor']);
    harness.check('修正后重新采集成功', repaired.venues.every((venue) => venue.ok));
    desk = new FestivalDesk(store);
    const e1003After = await desk.findEvent('E-1003');
    const e1010After = await desk.findEvent('E-1010');
    harness.check(
      'E-1003 补采后进入有效排期',
      e1003After?.status === 'scheduled' && e1003After?.venueId === 'harbor' && e1003After?.doorsTime === '2026-12-25 18:45',
      describe(e1003After),
    );
    harness.check(
      'E-1010 补采后进入有效排期',
      e1010After?.status === 'scheduled' && e1010After?.venueId === 'studio',
      describe(e1010After),
    );
    harness.equal('待补采公告已清空', (await desk.pendingReparse()).length, 0);
    const e1001 = await desk.findEvent('E-1001');
    harness.check(
      '补采不影响其他剧场已确认改场',
      e1001?.venueId === 'studio' && e1001?.revision === 2,
      describe(e1001),
    );

    /* ---------- 6. 改场另一端的到达 ---------- */
    harness.section('6. 改场：两端确认后才切换剧场与时间');
    const pendingChange = await desk.findEvent('E-1005');
    harness.check(
      '仅一端确认时仍展示实验剧场旧排期',
      pendingChange?.venueId === 'studio' && pendingChange?.hasPendingChange === true,
      describe(pendingChange),
    );
    await control(site, 'content', { version: 3 });
    const harborOnly = await collect(store, site, ['harbor']);
    harness.check('新剧场端公告采入成功', harborOnly.venues[0].ok === true);
    desk = new FestivalDesk(store);
    const e1005After = await desk.findEvent('E-1005');
    harness.check(
      '两端确认后切换到海港剧场与新时间',
      e1005After?.status === 'scheduled' &&
        e1005After?.venueId === 'harbor' &&
        e1005After?.showTime === '2026-12-23 18:30' &&
        e1005After?.doorsTime === '2026-12-23 17:45' &&
        e1005After?.revision === 3 &&
        e1005After?.hasPendingChange === false,
      describe(e1005After),
    );
    const studioAfter = await desk.venueSchedule('studio');
    const harborAfter = await desk.venueSchedule('harbor');
    harness.check(
      '实验剧场有效排期已移除 E-1005',
      !studioAfter.some((event) => event.eventId === 'E-1005'),
      studioAfter.map((event) => event.eventId).join(', '),
    );
    harness.check(
      '海港剧场有效排期已加入 E-1005',
      harborAfter.some((event) => event.eventId === 'E-1005'),
      harborAfter.map((event) => `${event.eventId}@${event.showTime}`).join(', '),
    );
    const byEvent = await desk.findEvent('E-1005');
    const byVenue = harborAfter.find((event) => event.eventId === 'E-1005');
    harness.check(
      '按编号与按剧场查询使用同一份确认结果',
      byEvent?.venueId === byVenue?.venueId &&
        byEvent?.showTime === byVenue?.showTime &&
        byEvent?.doorsTime === byVenue?.doorsTime,
      `编号：${byEvent?.venueId} ${byEvent?.showTime}；剧场：${byVenue?.venueId} ${byVenue?.showTime}`,
    );

    /* ---------- 7. 输出最终排期 ---------- */
    harness.section('7. 最终对外排期');
    const events = await desk.effectiveEvents();
    for (const event of events) console.log(`  ${formatEventLine(event)}`);
    console.log('  改场记录：');
    for (const confirmation of await desk.confirmations()) {
      console.log(`    ${formatConfirmation(confirmation)}`);
    }

    /* ---------- 8. 单元级边界检查 ---------- */
    harness.section('8. 解析与折叠边界');
    runUnitChecks((name, condition, detail) =>
      harness.check(name, condition, detail),
    );

    /* ---------- 9. 限流等待期间的独立 CLI 诊断 ---------- */
    harness.section('9. 独立诊断查询：限流等待时返回最后已提交页与预计恢复时间');
    const diagDb = join(diagDir, 'diag.duckdb');
    const diagProgress = join(diagDir, 'diag.progress.json');
    const spawnCli = (args: string[]) => {
      const handle = runCli(args);
      children.add(handle.child);
      handle.child.on('exit', () => children.delete(handle.child));
      return handle;
    };
    const collectArgs = (extra: string[] = []) => [
      'collect',
      '--site',
      site.baseUrl,
      '--db',
      diagDb,
      '--progress',
      diagProgress,
      ...extra,
    ];
    const progressArgs = ['progress', '--db', diagDb, '--progress', diagProgress];

    // 没有任何采集记录时，诊断查询明确报错而不是编造进度。
    const noProgress = spawnCli(progressArgs);
    const noProgressResult = await noProgress.done;
    harness.equal('无进度文件时诊断查询返回非零退出码', noProgressResult.code, 1);

    await control(site, 'reset', { contentVersion: 1 });
    await control(site, 'delay', { ms: 250 });
    const waiting = spawnCli(collectArgs(['--venue', 'grand']));
    try {
      // 先等第 1 页越过提交边界，再注入一次限流：第 2 页一上来就遇到 429（等待 1 秒）。
      const gotFirstPage = await waitFor(() => {
        try {
          const d = progressQuery(diagDb, diagProgress);
          const g = d.venues.find((item) => item.venue.venueId === 'grand');
          return (g?.venue.committedPages ?? []).includes(1);
        } catch {
          return false;
        }
      }, 4000);
      harness.check('第 1 页已先提交', gotFirstPage);
      await control(site, 'rate-limit', { seconds: 1, remaining: 1 });
      // 等待期间：诊断查询在另一个进程里即时返回。
      const gotWaiting = await waitFor(() => {
        try {
          const d = progressQuery(diagDb, diagProgress);
          const grand2 = d.venues.find((item) => item.venue.venueId === 'grand');
          return (
            grand2?.lastAttempt?.attempt.phase === 'rate_limited' &&
            grand2.lastAttempt.attempt.page === 2
          );
        } catch {
          return false;
        }
      }, 4000);
      harness.check('另一个 CLI 进程能查到正在限流等待', gotWaiting);
      const waitingDiag = progressQuery(diagDb, diagProgress);
      harness.equal('诊断侧确认采集进程仍在运行', waitingDiag.processState, 'running');
      const waitingVenue = waitingDiag.venues.find(
        (item) => item.venue.venueId === 'grand',
      )!;
      harness.equal(
        '等待恢复前最后已提交页是第 1 页',
        waitingVenue.venue.committedPages.at(-1),
        1,
      );
      harness.check(
        '等待中的第 2 页未越过提交边界',
        !waitingVenue.venue.committedPages.includes(2) &&
          waitingVenue.venue.lastAttempt?.phase === 'rate_limited',
      );
      if (gotWaiting) {
        const rl = waitingVenue.lastAttempt!.attempt.rateLimit!;
        harness.equal('记录的是本次实际等待时长（Retry-After）', rl.retryAfterMs, 1000);
        const remaining = waitingVenue.lastAttempt!.remainingWaitMs!;
        harness.check(
          '给出预计恢复时间与剩余等待',
          Date.parse(rl.resumeAt) > Date.now() && remaining > 0 && remaining <= 1000,
          `剩余 ${remaining}ms`,
        );
        console.log('  —— 独立诊断输出（等待期间）——');
        for (const line of formatProgress(waitingDiag).split('\n')) console.log(`     ${line}`);
        const jsonProbe = spawnCli([...progressArgs, '--json']);
        const jsonResult = await jsonProbe.done;
        harness.equal('诊断查询支持 --json 结构化输出', jsonResult.code, 0);
        const parsedJson = JSON.parse(jsonResult.stdout);
        harness.equal(
          'JSON 中保留预计恢复时刻',
          parsedJson.venues[0].lastAttempt.attempt.rateLimit.resumeAt,
          rl.resumeAt,
        );
      }
    } finally {
      const waitedResult = await waiting.done;
      harness.equal('限流等待结束后采集正常完成', waitedResult.code, 0);
    }
    const doneDiag = progressQuery(diagDb, diagProgress);
    const doneVenue = doneDiag.venues.find((item) => item.venue.venueId === 'grand')!;
    harness.equal(
      '完成后两页均已提交、在库 4 条公告',
      doneVenue.venue.committedAnnouncements,
      4,
    );
    harness.equal('完成后进程状态为正常结束', doneDiag.processState, 'exited');
    harness.equal('限流等待计数为 1', doneVenue.venue.rateLimitWaits, 1);

    /* ---------- 10. 会话轮换重读不虚增进度 ---------- */
    harness.section('10. 独立诊断查询：会话轮换重读旧页单独显示，不虚增已入库进度');
    await control(site, 'reset', { contentVersion: 1 });
    await control(site, 'delay', { ms: 250 });
    // 第 2 个剧场页面请求（即 grand 第 2 页）时轮换会话，旧签名 409，随后回到入口重读第 1 页。
    await control(site, 'rotate-after', { count: 2 });
    const rotating = spawnCli(collectArgs(['--venue', 'grand']));
    // 记录轮换前第 1 页已提交的在库基数，用于证明重读不会虚增。
    let baselineAnnouncements: number | null = null;
    try {
      const gotFirstCommit = await waitFor(() => {
        try {
          const d = progressQuery(diagDb, diagProgress);
          const g = d.venues.find((item) => item.venue.venueId === 'grand');
          return (g?.venue.committedPages ?? []).includes(1);
        } catch {
          return false;
        }
      }, 4000);
      harness.check('轮换前第 1 页已先提交', gotFirstCommit);
      baselineAnnouncements =
        progressQuery(diagDb, diagProgress).venues.find(
          (item) => item.venue.venueId === 'grand',
        )?.venue.committedAnnouncements ?? null;
      const gotReread = await waitFor(() => {
        try {
          const d = progressQuery(diagDb, diagProgress);
          const g = d.venues.find((item) => item.venue.venueId === 'grand');
          return (g?.venue.reReads ?? 0) > 0;
        } catch {
          return false;
        }
      }, 4000);
      harness.check('诊断查询抓到会话轮换后的重读', gotReread);
      const rereadDiag = progressQuery(diagDb, diagProgress);
      const rereadVenue = rereadDiag.venues.find(
        (item) => item.venue.venueId === 'grand',
      )!;
      harness.check(
        '重读被单独标记（reread）且与新页区分',
        rereadVenue.venue.lastAttempt?.reread === true,
      );
      harness.check(
        '重读期间已提交页不回退也不虚增',
        rereadVenue.venue.committedPages.length === 1 &&
          rereadVenue.venue.committedPages[0] === 1 &&
          rereadVenue.venue.committedAnnouncements === baselineAnnouncements,
        `已提交页 ${JSON.stringify(rereadVenue.venue.committedPages)}，在库 ${rereadVenue.venue.committedAnnouncements} 条（重读前 ${baselineAnnouncements} 条）`,
      );
      console.log('  —— 独立诊断输出（重读期间）——');
      for (const line of formatProgress(rereadDiag).split('\n')) console.log(`     ${line}`);
    } finally {
      const rotatedResult = await rotating.done;
      harness.equal('会话轮换后采集仍成功完成', rotatedResult.code, 0);
    }
    const afterReread = progressQuery(diagDb, diagProgress).venues.find(
      (item) => item.venue.venueId === 'grand',
    )!;
    harness.check(
      '恢复后翻页恢复与重读都被计数',
      afterReread.venue.recoveries >= 1 && afterReread.venue.reReads >= 1,
      `恢复 ${afterReread.venue.recoveries} 次，重读 ${afterReread.venue.reReads} 次`,
    );
    harness.equal(
      '重读不产生重复入库：仍为 2 页 4 条',
      afterReread.venue.committedAnnouncements,
      4,
    );
    harness.equal(
      '已提交页号去重后仍是 1、2',
      JSON.stringify(afterReread.venue.committedPages),
      '[1,2]',
    );

    /* ---------- 11. 强制结束后的提交边界诊断 ---------- */
    harness.section('11. 采集进程被强制结束：按提交边界区分已提交页与最后尝试落点');
    await control(site, 'reset', { contentVersion: 1 });
    await control(site, 'delay', { ms: 200 });
    await control(site, 'rate-limit', { seconds: 1, remaining: 1 });
    const killedBeforeCommit = spawnCli(collectArgs(['--venue', 'harbor']));
    try {
      const gotWait = await waitFor(() => {
        try {
          const d = progressQuery(diagDb, diagProgress);
          const h = d.venues.find((item) => item.venue.venueId === 'harbor');
          return h?.lastAttempt?.attempt.phase === 'rate_limited';
        } catch {
          return false;
        }
      }, 4000);
      harness.check('海港剧场第 1 页进入限流等待', gotWait);
      killedBeforeCommit.child.kill('SIGKILL');
    } finally {
      await killedBeforeCommit.done;
    }
    await waitFor(
      () => progressQuery(diagDb, diagProgress).processState === 'killed',
      2000,
    );
    const killedDiag = progressQuery(diagDb, diagProgress);
    harness.equal('诊断侧识别进程已被强制结束', killedDiag.processState, 'killed');
    const killedVenue = killedDiag.venues.find(
      (item) => item.venue.venueId === 'harbor',
    )!;
    harness.equal(
      '被杀前没有任何页越过提交边界',
      killedVenue.venue.committedPages.length,
      0,
    );
    harness.equal(
      '最后一次尝试停在限流等待的第 1 页',
      `${killedVenue.venue.lastAttempt?.page}:${killedVenue.venue.lastAttempt?.phase}`,
      '1:rate_limited',
    );
    console.log('  —— 独立诊断输出（提交前被杀）——');
    for (const line of formatProgress(killedDiag).split('\n')) console.log(`     ${line}`);

    // 页面已提交之后再杀：已提交页保留，最后尝试停在尚未提交的第 2 页。
    await control(site, 'reset', { contentVersion: 1 });
    await control(site, 'delay', { ms: 300 });
    const killedAfterCommit = spawnCli(collectArgs(['--venue', 'harbor']));
    try {
      // 同时满足：第 1 页已提交，且第 2 页尝试已经开始（此时它还在请求中，尚未提交）。
      const gotSecondAttempt = await waitFor(() => {
        try {
          const d = progressQuery(diagDb, diagProgress);
          const h = d.venues.find((item) => item.venue.venueId === 'harbor');
          return (
            (h?.venue.committedPages ?? []).includes(1) &&
            h?.venue.lastAttempt?.page === 2 &&
            h.venue.lastAttempt.phase !== 'done'
          );
        } catch {
          return false;
        }
      }, 4000);
      harness.check('第 1 页已提交、第 2 页尝试已开始后再强制结束进程', gotSecondAttempt);
      killedAfterCommit.child.kill('SIGKILL');
    } finally {
      await killedAfterCommit.done;
    }
    await waitFor(
      () => progressQuery(diagDb, diagProgress).processState === 'killed',
      2000,
    );
    const afterKillDiag = progressQuery(diagDb, diagProgress);
    const afterKillVenue = afterKillDiag.venues.find(
      (item) => item.venue.venueId === 'harbor',
    )!;
    harness.equal(
      '已提交的第 1 页保留在提交边界内',
      JSON.stringify(afterKillVenue.venue.committedPages),
      '[1]',
    );
    harness.equal(
      '最后一次尝试停在未提交的第 2 页',
      afterKillVenue.venue.lastAttempt?.page,
      2,
    );
    harness.check(
      '第 2 页阶段不是已完成（未提交）',
      afterKillVenue.venue.lastAttempt?.phase !== 'done',
      afterKillVenue.venue.lastAttempt?.phase,
    );
    harness.equal(
      '在库公告数停留在第 1 页的 2 条',
      afterKillVenue.venue.committedAnnouncements,
      2,
    );
    console.log('  —— 独立诊断输出（提交后被杀）——');
    for (const line of formatProgress(afterKillDiag).split('\n')) console.log(`     ${line}`);

    // 已确认排期仍可通过原有编号 / 剧场查询访问（重新打开独立诊断库验证）。
    await control(site, 'reset', { contentVersion: 1 });
    {
      const diagStore = await Store.open(diagDb);
      try {
        const diagDesk = new FestivalDesk(diagStore);
        const e1007 = await diagDesk.findEvent('E-1007');
        harness.check(
          '中断库仍可按编号查询已确认排期',
          e1007?.status === 'scheduled' && e1007.venueId === 'harbor',
          describe(e1007),
        );
        const harborSchedule = await diagDesk.venueSchedule('harbor');
        harness.check(
          '中断库仍可按剧场查询同一份结果',
          harborSchedule.some((event) => event.eventId === 'E-1007'),
          harborSchedule.map((event) => event.eventId).join(', '),
        );
      } finally {
        await diagStore.close();
      }
    }

    // 续采：清除故障后重新采集，进度文件走到正常结束。
    const resumedCli = spawnCli(collectArgs(['--venue', 'harbor']));
    const resumedCliResult = await resumedCli.done;
    harness.equal('强制结束后续采成功', resumedCliResult.code, 0);
    const resumedDiag = progressQuery(diagDb, diagProgress);
    harness.equal('续采后进度文件标记为正常结束', resumedDiag.processState, 'exited');
    harness.equal(
      '续采后海港两页全部提交',
      JSON.stringify(
        resumedDiag.venues.find((item) => item.venue.venueId === 'harbor')!.venue
          .committedPages,
      ),
      '[1,2]',
    );

    const elapsed = Date.now() - started;
    const ok = harness.checks.failed === 0 && elapsed <= TOTAL_BUDGET_MS;
    console.log(
      `\n结果：${harness.checks.passed} 项通过，${harness.checks.failed} 项失败，` +
        `耗时 ${(elapsed / 1000).toFixed(1)}s（上限 ${TOTAL_BUDGET_MS / 1000}s）`,
    );
    console.log(ok ? 'E2E PASS' : 'E2E FAIL');
    await store.close();
    return ok ? 0 : 1;
  } finally {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    try {
      await site.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(workdir, { recursive: true, force: true });
    rmSync(diagDir, { recursive: true, force: true });
  }
}
