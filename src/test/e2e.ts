import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MockSite } from '../mock/server';
import { Store } from '../db/store';
import { Collector } from '../collect/collector';
import { FestivalDesk } from '../query/desk';
import { formatConfirmation, formatEventLine } from '../query/view';
import { runUnitChecks } from './unit';
import { venueName } from '../venues';
import type { EventState } from '../core/types';

const TOTAL_BUDGET_MS = 80_000;
const execFileAsync = promisify(execFile);
/** 编译后的 CLI 入口（dist/cli.js），用于模拟“另一个进程”的只读查询。 */
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

/** 采集器：写库短开短关，翻页等待期间不占用数据库。 */
function makeCollector(site: MockSite, dbPath: string): Collector {
  return new Collector({
    baseUrl: site.baseUrl,
    openStore: () => Store.open(dbPath),
    maxRateLimitWaitMs: 10_000,
    log: (message) => console.log(`    · ${message.trim()}`),
  });
}

async function collect(
  site: MockSite,
  dbPath: string,
  venues?: string[],
): Promise<Awaited<ReturnType<Collector['collectAll']>>> {
  return makeCollector(site, dbPath).collectAll(venues);
}

/** 服务台式访问：每次用完即关，模拟独立进程重启后的查询。 */
async function withDesk<T>(
  dbPath: string,
  fn: (desk: FestivalDesk, store: Store) => Promise<T>,
): Promise<T> {
  const store = await Store.open(dbPath);
  try {
    return await fn(new FestivalDesk(store), store);
  } finally {
    await store.close();
  }
}

interface CliResult {
  code: number;
  output: string;
}

/** 用 CLI 子进程做只读查询，验证采集进行时不影响其他进程。 */
async function queryViaCli(dbPath: string, ...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'query', ...args, '--db', dbPath],
      { timeout: 20_000 },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? 1,
      output: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    };
  }
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function runE2E(): Promise<number> {
  const started = Date.now();
  const harness = new Harness();
  const site = new MockSite({ contentVersion: 1 });
  await site.listen(0);
  const workdir = mkdtempSync(join(tmpdir(), 'festival-desk-e2e-'));
  const dbPath = join(workdir, 'festival.duckdb');

  console.log('戏剧节服务台 · 本地端到端验证');
  console.log(`模拟公告站 ${site.baseUrl}`);
  console.log(`临时数据库 ${dbPath}`);

  try {
    /* ---------- 1. 翻页恢复 ---------- */
    harness.section('1. 翻页恢复（会话轮换后重新取得翻页位置）');
    await control(site, 'reset', { contentVersion: 1 });
    // 大剧院第 2 页请求时轮换会话，旧翻页签名立即失效。
    await control(site, 'rotate-after', { count: 2 });
    let result = await collect(site, dbPath, ['grand']);
    const grand = result.venues[0];
    harness.check('采集完成且没有中断', grand.ok, `错误：${grand.error ?? '无'}`);
    harness.check('翻到末页并发布', grand.published, `页数 ${grand.pages}`);
    harness.check('检测到翻页凭据失效并恢复', grand.recoveries >= 1, `恢复 ${grand.recoveries} 次`);
    harness.equal('大剧院两页公告全部入库', grand.announcements, 4);
    const grandRows = await withDesk(dbPath, (_desk, store) => store.allAnnouncements());
    harness.equal(
      '两页来源都被记录',
      new Set(grandRows.filter((row) => row.venueId === 'grand').map((row) => row.sourcePage)).size,
      2,
    );
    const statsAfterRecovery = await control(site, 'stats');
    harness.check(
      '站点确实轮换过会话',
      Number(statsAfterRecovery.sessionRotations) >= 1,
      `轮换 ${statsAfterRecovery.sessionRotations} 次`,
    );

    /* ---------- 2. 限流 + 其余剧场采集 ---------- */
    harness.section('2. 临时限流（按站点给出的 Retry-After 恢复）与跨版式采集');
    await control(site, 'rate-limit', { seconds: 1, remaining: 1 });
    result = await collect(site, dbPath, ['studio', 'harbor']);
    const studio = result.venues.find((venue) => venue.venueId === 'studio')!;
    const harbor = result.venues.find((venue) => venue.venueId === 'harbor')!;
    harness.check('实验剧场（旧版式）采集完成并发布', studio.ok && studio.published && studio.layout === 'legacy', `版式 ${studio.layout}，${studio.pages} 页`);
    harness.check('海港剧场（新版式）采集完成并发布', harbor.ok && harbor.published && harbor.layout === 'v2', `版式 ${harbor.layout}，${harbor.pages} 页`);
    const waited = studio.rateLimitWaits + harbor.rateLimitWaits;
    harness.check('限流后按 Retry-After 等待并继续', waited >= 1, `等待 ${waited} 次`);

    /* ---------- 3. 改场前查询 ---------- */
    harness.section('3. 改场前：已确认排期与待补采并存');
    const snapshot = await withDesk(dbPath, async (desk) => ({
      e1005: await desk.findEvent('E-1005'),
      studioSchedule: await desk.venueSchedule('studio'),
      e1003: await desk.findEvent('E-1003'),
      e1010: await desk.findEvent('E-1010'),
      pending: await desk.pendingReparse(),
      e1007: await desk.findEvent('E-1007'),
      e1002: await desk.findEvent('E-1002'),
    }));
    harness.check('E-1005 展示最近一次已确认排期（实验剧场）', snapshot.e1005?.venueId === 'studio' && snapshot.e1005?.revision === 2, describe(snapshot.e1005));
    harness.check('E-1005 标记“改场待确认”', snapshot.e1005?.hasPendingChange === true, snapshot.e1005?.pendingNote ?? '');
    harness.check(
      '按剧场查询仍把 E-1005 列在实验剧场',
      snapshot.studioSchedule.some((event) => event.eventId === 'E-1005'),
      snapshot.studioSchedule.map((event) => event.eventId).join(', '),
    );
    harness.equal('E-1003 因缺少入场时间进入待补采', snapshot.e1003?.status, 'pending_reparse');
    harness.equal('E-1010 因档期“待定”进入待补采', snapshot.e1010?.status, 'pending_reparse');
    harness.equal('待补采公告数量', snapshot.pending.length, 2);
    harness.check(
      '其他剧场的可解析公告不受影响',
      snapshot.e1007?.status === 'scheduled' && snapshot.e1007?.venueId === 'harbor',
      describe(snapshot.e1007),
    );
    harness.equal('取消公告独立生效', snapshot.e1002?.status, 'cancelled');

    /* ---------- 4. 暂停等下一页：另一进程只读查询已发布数据 ---------- */
    harness.section('4. 暂停等下一页时，另一进程只读查询（沿用已发布数据）');
    await control(site, 'content', { version: 2 });
    // 海港剧场第 1 页正常采入，请求第 2 页时被限流等待 6 秒
    // （留足窗口，让另一进程的多次只读查询都在暂停期内完成）。
    const statsBeforePause = await control(site, 'stats');
    await control(site, 'rate-limit', {
      seconds: 6,
      remaining: 1,
      after: Number(statsBeforePause.venuePagesServed) + 1,
    });
    const collecting = collect(site, dbPath, ['harbor']);
    // 限流生效时，第 1 页（含修正后的 E-1003）已写入工作区，采集器正在等下一页。
    await waitFor(async () => {
      const stats = await control(site, 'stats');
      return Number(stats.rateLimited) >= 1;
    }, '站点限流生效');
    const pausedEvent = await queryViaCli(dbPath, 'event', 'E-1003');
    harness.check(
      '暂停期间另一进程可只读打开数据库',
      pausedEvent.code === 0,
      pausedEvent.output.trim().split('\n')[0] ?? '',
    );
    harness.check(
      '按编号查询沿用上次已发布的数据（E-1003 仍待补采）',
      pausedEvent.output.includes('状态 待补采'),
      pausedEvent.output.trim().split('\n').slice(0, 2).join(' / '),
    );
    const pausedVenue = await queryViaCli(dbPath, 'venue', 'harbor');
    harness.check(
      '按剧场查询同样使用已发布数据',
      pausedVenue.output.includes('E-1007') && !pausedVenue.output.includes('E-1003'),
      pausedVenue.output.trim().split('\n')[0] ?? '',
    );
    const pausedPending = await queryViaCli(dbPath, 'pending');
    harness.check(
      '待补采查询也使用已发布数据（工作区新采的修正不计入）',
      pausedPending.output.includes('待补采公告 2 条'),
      pausedPending.output.trim().split('\n')[0] ?? '',
    );
    const pausedLocal = await withDesk(dbPath, (desk) => desk.findEvent('E-1003'));
    harness.check(
      '同进程重开数据库查询也不受半截数据污染',
      pausedLocal?.status === 'pending_reparse',
      describe(pausedLocal),
    );
    const pausedResult = await collecting;
    harness.check(
      '限流结束后采集完成并发布',
      pausedResult.venues[0].ok && pausedResult.venues[0].published,
      `页数 ${pausedResult.venues[0].pages}`,
    );
    const afterPause = await withDesk(dbPath, (desk) => desk.findEvent('E-1003'));
    harness.check(
      '发布后 E-1003 以修正后的入场时间进入有效排期',
      afterPause?.status === 'scheduled' && afterPause?.doorsTime === '2026-12-25 18:45',
      describe(afterPause),
    );
    const republished = await queryViaCli(dbPath, 'event', 'E-1003');
    harness.check(
      '另一进程随后也能查到新发布的排期',
      republished.output.includes('海港剧场 2026-12-25 19:30'),
      republished.output.trim().split('\n').slice(0, 2).join(' / '),
    );

    /* ---------- 5. 待补采修正 ---------- */
    harness.section('5. 待补采公告修正后重新采入');
    const repaired = await collect(site, dbPath, ['studio', 'harbor']);
    harness.check('修正后重新采集成功', repaired.venues.every((venue) => venue.ok && venue.published));
    const afterRepair = await withDesk(dbPath, async (desk) => ({
      e1003: await desk.findEvent('E-1003'),
      e1010: await desk.findEvent('E-1010'),
      pending: await desk.pendingReparse(),
      e1001: await desk.findEvent('E-1001'),
    }));
    harness.check(
      'E-1003 补采后进入有效排期',
      afterRepair.e1003?.status === 'scheduled' && afterRepair.e1003?.venueId === 'harbor' && afterRepair.e1003?.doorsTime === '2026-12-25 18:45',
      describe(afterRepair.e1003),
    );
    harness.check(
      'E-1010 补采后进入有效排期',
      afterRepair.e1010?.status === 'scheduled' && afterRepair.e1010?.venueId === 'studio',
      describe(afterRepair.e1010),
    );
    harness.equal('待补采公告已清空', afterRepair.pending.length, 0);
    harness.check(
      '补采不影响其他剧场已确认改场',
      afterRepair.e1001?.venueId === 'studio' && afterRepair.e1001?.revision === 2,
      describe(afterRepair.e1001),
    );

    /* ---------- 6. 中断、重启与续采（改场两端确认） ---------- */
    harness.section('6. 采集中断、重启与续采（中断前入库的公告参与改场确认）');
    await control(site, 'content', { version: 3 });
    const pendingChange = await withDesk(dbPath, (desk) => desk.findEvent('E-1005'));
    harness.check(
      '仅一端确认时仍展示实验剧场旧排期',
      pendingChange?.venueId === 'studio' && pendingChange?.hasPendingChange === true,
      describe(pendingChange),
    );
    // 海港剧场第 1 页（含改场新剧场端公告）入库后，第 2 页请求时连接中断。
    const statsBeforeAbort = await control(site, 'stats');
    await control(site, 'abort-after', { count: Number(statsBeforeAbort.venuePagesServed) + 1 });
    const interrupted = await collect(site, dbPath, ['harbor']);
    harness.check('中断被如实记录', interrupted.venues[0].ok === false, interrupted.venues[0].error ?? '');
    harness.check('采到一半的剧场本次未发布', interrupted.venues[0].published === false);
    const workspace = await withDesk(dbPath, (_desk, store) => store.allAnnouncements());
    const preAbortRow = workspace.find((row) => row.annKey === 'harbor:h-1005-c3');
    harness.check(
      '中断前已入库的改场公告仍在工作区',
      preAbortRow?.parseStatus === 'parsed',
      preAbortRow ? `${preAbortRow.annKey}（第 ${preAbortRow.sourcePage} 页）` : '未找到',
    );
    const syncRows = await withDesk(dbPath, (_desk, store) => store.venueSyncState());
    const harborSync = syncRows.find((row) => row.venueId === 'harbor');
    harness.check(
      '中断状态被记录',
      harborSync?.status === 'failed',
      harborSync?.lastError ?? '',
    );
    const duringAbort = await queryViaCli(dbPath, 'event', 'E-1005');
    harness.check(
      '中断后另一进程查询仍沿用上次已发布的排期',
      duringAbort.code === 0 && duringAbort.output.includes('实验剧场 2026-12-22 19:00'),
      duringAbort.output.trim().split('\n').slice(0, 2).join(' / '),
    );
    const localDuringAbort = await withDesk(dbPath, (desk) => desk.findEvent('E-1005'));
    harness.check(
      '中断后同进程查询不受影响',
      localDuringAbort?.venueId === 'studio' && localDuringAbort?.hasPendingChange === true,
      describe(localDuringAbort),
    );

    // 模拟进程重启：重新打开数据库，自愈不应发布采到一半的剧场。
    const restarted = await Store.open(dbPath);
    await restarted.close();
    const afterRestart = await withDesk(dbPath, async (desk) => ({
      e1005: await desk.findEvent('E-1005'),
      e1003: await desk.findEvent('E-1003'),
    }));
    harness.check(
      '重启后已确认排期仍可查询',
      afterRestart.e1005?.venueId === 'studio' && afterRestart.e1005?.revision === 2,
      describe(afterRestart.e1005),
    );
    harness.check(
      '重启后未确认的改场仍在等待另一端',
      afterRestart.e1005?.hasPendingChange === true && afterRestart.e1005?.pendingRevision === 3,
      afterRestart.e1005?.pendingNote ?? '',
    );
    harness.check(
      '重启后采到一半的剧场仍沿用上次发布',
      afterRestart.e1003?.status === 'scheduled' && afterRestart.e1003?.doorsTime === '2026-12-25 18:45',
      describe(afterRestart.e1003),
    );

    await control(site, 'abort-after', { count: null });
    const resumed = await collect(site, dbPath, ['harbor']);
    harness.check(
      '清除故障后续采成功并发布',
      resumed.venues[0].ok === true && resumed.venues[0].published === true,
      `已采 ${resumed.venues[0].pages} 页`,
    );
    const afterResume = await withDesk(dbPath, async (desk) => ({
      e1005: await desk.findEvent('E-1005'),
      confirmations: await desk.confirmations('E-1005'),
      studioSchedule: await desk.venueSchedule('studio'),
      harborSchedule: await desk.venueSchedule('harbor'),
    }));
    harness.check(
      '两端确认后切换到海港剧场与新时间',
      afterResume.e1005?.status === 'scheduled' &&
        afterResume.e1005?.venueId === 'harbor' &&
        afterResume.e1005?.showTime === '2026-12-23 18:30' &&
        afterResume.e1005?.doorsTime === '2026-12-23 17:45' &&
        afterResume.e1005?.revision === 3 &&
        afterResume.e1005?.hasPendingChange === false,
      describe(afterResume.e1005),
    );
    const rev3 = afterResume.confirmations.find((item) => item.revision === 3);
    harness.check(
      '中断前已入库的公告在重启续采后参与改场确认',
      rev3?.confirmed === true && rev3?.toAnnKey === 'harbor:h-1005-c3',
      `新剧场端 ${rev3?.toAnnKey ?? '-'}（${rev3?.note ?? ''}）`,
    );
    harness.check(
      '实验剧场有效排期已移除 E-1005',
      !afterResume.studioSchedule.some((event) => event.eventId === 'E-1005'),
      afterResume.studioSchedule.map((event) => event.eventId).join(', '),
    );
    harness.check(
      '海港剧场有效排期已加入 E-1005',
      afterResume.harborSchedule.some((event) => event.eventId === 'E-1005'),
      afterResume.harborSchedule.map((event) => `${event.eventId}@${event.showTime}`).join(', '),
    );
    const byVenue = afterResume.harborSchedule.find((event) => event.eventId === 'E-1005');
    harness.check(
      '按编号与按剧场查询使用同一份确认结果',
      afterResume.e1005?.venueId === byVenue?.venueId &&
        afterResume.e1005?.showTime === byVenue?.showTime &&
        afterResume.e1005?.doorsTime === byVenue?.doorsTime,
      `编号：${afterResume.e1005?.venueId} ${afterResume.e1005?.showTime}；剧场：${byVenue?.venueId} ${byVenue?.showTime}`,
    );
    const finalCli = await queryViaCli(dbPath, 'event', 'E-1005');
    harness.check(
      '另一进程查到切换后的排期',
      finalCli.output.includes('海港剧场 2026-12-23 18:30'),
      finalCli.output.trim().split('\n').slice(0, 2).join(' / '),
    );

    /* ---------- 7. 输出最终排期 ---------- */
    harness.section('7. 最终对外排期');
    await withDesk(dbPath, async (desk) => {
      const events = await desk.effectiveEvents();
      for (const event of events) console.log(`  ${formatEventLine(event)}`);
      console.log('  改场记录：');
      for (const confirmation of await desk.confirmations()) {
        console.log(`    ${formatConfirmation(confirmation)}`);
      }
    });

    /* ---------- 8. 单元级边界检查 ---------- */
    harness.section('8. 解析与折叠边界');
    runUnitChecks((name, condition, detail) =>
      harness.check(name, condition, detail),
    );

    const elapsed = Date.now() - started;
    const ok = harness.checks.failed === 0 && elapsed <= TOTAL_BUDGET_MS;
    console.log(
      `\n结果：${harness.checks.passed} 项通过，${harness.checks.failed} 项失败，` +
        `耗时 ${(elapsed / 1000).toFixed(1)}s（上限 ${TOTAL_BUDGET_MS / 1000}s）`,
    );
    console.log(ok ? 'E2E PASS' : 'E2E FAIL');
    return ok ? 0 : 1;
  } finally {
    try {
      await site.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(workdir, { recursive: true, force: true });
  }
}
