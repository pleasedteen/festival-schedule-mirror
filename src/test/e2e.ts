import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSite } from '../mock/server';
import { Store } from '../db/store';
import { Collector } from '../collect/collector';
import { FestivalDesk } from '../query/desk';
import { formatConfirmation, formatEventLine } from '../query/view';
import { runUnitChecks } from './unit';
import { venueName } from '../venues';
import type { EventState } from '../core/types';

const TOTAL_BUDGET_MS = 80_000;

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
    try {
      await site.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(workdir, { recursive: true, force: true });
  }
}
