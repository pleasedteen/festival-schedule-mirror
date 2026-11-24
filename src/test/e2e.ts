import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSite } from '../mock/server';
import { Store } from '../db/store';
import { Collector } from '../collect/collector';
import { OfflineRepair } from '../collect/offline-repair';
import { FestivalDesk } from '../query/desk';
import { formatConfirmation, formatEventLine } from '../query/view';
import { runUnitChecks } from './unit';
import { venueName } from '../venues';
import type { AnnouncementRow, ChangeConfirmation, EventState, Layout } from '../core/types';

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
  layouts?: Layout[],
): Promise<Awaited<ReturnType<Collector['collectAll']>>> {
  const collector = new Collector({
    baseUrl: site.baseUrl,
    store,
    maxRateLimitWaitMs: 5000,
    // 指定受限版式即代表“修复前的旧解析器”：不认识新版式，也不容忍容器缺失。
    layouts,
    tolerateMissingContainer: layouts ? false : true,
    log: (message) => console.log(`    · ${message.trim()}`),
  });
  return collector.collectAll(venues);
}

/** 语义字段：受损页用 compact 渲染，故排除 layout / rawHtml / 来源定位字段。 */
const ANN_FIELDS: (keyof AnnouncementRow)[] = [
  'annKey', 'venueId', 'siteId', 'kind', 'eventId', 'revision', 'title',
  'showTime', 'doorsTime', 'fromVenue', 'toVenue', 'parseStatus', 'parseError',
];

function signature(row: AnnouncementRow): string {
  return JSON.stringify(ANN_FIELDS.map((field) => row[field]));
}

function compareAnnouncements(
  harness: Harness,
  golden: AnnouncementRow[],
  repaired: AnnouncementRow[],
): void {
  harness.equal('补采后公告条数与顺序采集一致', repaired.length, golden.length);
  const goldenMap = new Map(golden.map((row) => [row.annKey, row]));
  let matched = 0;
  for (const row of repaired) {
    const other = goldenMap.get(row.annKey);
    if (other && signature(other) === signature(row)) matched += 1;
  }
  harness.equal('每条公告的语义内容与顺序采集逐条一致', matched, golden.length);
}

function compareEvents(
  harness: Harness,
  golden: EventState[],
  repaired: EventState[],
): void {
  harness.equal('已确认排期条数一致', repaired.length, golden.length);
  const goldenMap = new Map(golden.map((event) => [event.eventId, event]));
  let matched = 0;
  for (const event of repaired) {
    const other = goldenMap.get(event.eventId);
    if (!other) continue;
    const same =
      other.status === event.status &&
      other.venueId === event.venueId &&
      other.showTime === event.showTime &&
      other.doorsTime === event.doorsTime &&
      other.revision === event.revision &&
      other.lastChangeKind === event.lastChangeKind &&
      other.hasPendingChange === event.hasPendingChange &&
      other.pendingRevision === event.pendingRevision &&
      other.pendingReparseCount === event.pendingReparseCount;
    if (same) matched += 1;
  }
  harness.equal('每个演出的折叠排期与顺序采集一致', matched, golden.length);
}

function compareConfirmations(
  harness: Harness,
  golden: ChangeConfirmation[],
  repaired: ChangeConfirmation[],
): void {
  harness.equal('改场记录条数一致', repaired.length, golden.length);
  const key = (item: ChangeConfirmation) => `${item.eventId}#${item.revision}`;
  const goldenMap = new Map(golden.map((item) => [key(item), item]));
  let matched = 0;
  for (const item of repaired) {
    const other = goldenMap.get(key(item));
    if (!other) continue;
    const same =
      other.fromVenue === item.fromVenue &&
      other.toVenue === item.toVenue &&
      other.showTime === item.showTime &&
      other.doorsTime === item.doorsTime &&
      other.confirmed === item.confirmed &&
      other.receivedFrom === item.receivedFrom &&
      other.receivedTo === item.receivedTo;
    if (same) matched += 1;
  }
  harness.equal('每条改场的两端确认状态与顺序采集一致', matched, golden.length);
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

    /* ---------- 7. 整页受损：留存原文、继续翻页、断网离线补采 ---------- */
    harness.section('7. 整页受损采集 vs 顺序采集（断网补采对齐）');
    await control(site, 'reset', { contentVersion: 1 });

    // 7.1 顺序采集（金色基准）：解析器全版式可用，站点完全健康。
    const goldenDir = mkdtempSync(join(tmpdir(), 'festival-golden-'));
    const goldenPath = join(goldenDir, 'golden.duckdb');
    const goldenStore = await Store.open(goldenPath);
    const goldenResult = await collect(goldenStore, site);
    harness.check(
      '顺序采集三个剧场全部完成',
      goldenResult.venues.every((venue) => venue.ok && venue.damagedPages === 0),
    );
    const goldenRows = await goldenStore.allAnnouncements();
    const goldenEvents = await goldenStore.effectiveEvents();
    const goldenConfs = await goldenStore.changeConfirmations();

    // 7.2 受损采集：旧解析器不认识 compact；两种整页故障 + 同页坏两次。
    // 故障规则持续生效，两轮采集都命中同一坏页，模拟“同一页先后坏两次”。
    await control(site, 'damage', {
      venue: 'studio', page: 2, mode: 'unknown-layout',
    });
    await control(site, 'damage', {
      venue: 'harbor', page: 1, mode: 'missing-container',
    });
    const damagedDir = mkdtempSync(join(tmpdir(), 'festival-damaged-'));
    const damagedPath = join(damagedDir, 'damaged.duckdb');
    const damagedStore = await Store.open(damagedPath);
    // 第一轮采集：两个坏页各留存一次，其余页面正常入库。
    const damagedFirst = await collect(damagedStore, site, undefined, ['v2', 'legacy']);
    const firstVenues = Object.fromEntries(damagedFirst.venues.map((venue) => [venue.venueId, venue]));
    harness.check(
      '首轮采集受损页不拖垮采集：三个剧场仍全部完成',
      damagedFirst.venues.every((venue) => venue.ok),
    );
    harness.equal('首轮实验剧场坏页留存', firstVenues.studio?.damagedPages ?? 0, 1);
    harness.equal('首轮海港剧场坏页留存', firstVenues.harbor?.damagedPages ?? 0, 1);
    // 第二轮采集（解析仍未修复）：同样的页面再次坏掉，再各留存一次。
    const damagedSecond = await collect(damagedStore, site, ['studio', 'harbor'], ['v2', 'legacy']);
    const secondVenues = Object.fromEntries(damagedSecond.venues.map((venue) => [venue.venueId, venue]));
    harness.check(
      '二轮采集同样不中断',
      damagedSecond.venues.every((venue) => venue.ok),
    );
    harness.equal('二轮实验剧场同一页再次留存', secondVenues.studio?.damagedPages ?? 0, 1);
    harness.equal('二轮海港容器缺失再次留存', secondVenues.harbor?.damagedPages ?? 0, 1);

    const secondTotals = Object.fromEntries(
      damagedSecond.venues.map((venue) => [venue.venueId, venue.damagedPages]),
    );
    const dVenues = Object.fromEntries(
      damagedFirst.venues.map((venue) => [
        venue.venueId,
        { ...venue, damagedPages: venue.damagedPages + (secondTotals[venue.venueId] ?? 0) },
      ]),
    );
    harness.equal('实验剧场同一页先后坏两次均被留存', dVenues.studio?.damagedPages ?? 0, 2);
    harness.equal('海港剧场容器缺失两次均被留存', dVenues.harbor?.damagedPages ?? 0, 2);
    harness.equal('大剧院没有受损页', dVenues.grand?.damagedPages ?? 0, 0);
    const damagedBeforeRepair = await damagedStore.pendingDamagedPages();
    harness.equal('受损页原文共留存 4 个', damagedBeforeRepair.length, 4);
    harness.equal(
      '受损页按采集顺序编号（seq 单调）',
      damagedBeforeRepair.map((capture) => capture.seq).join(','),
      '1,2,3,4',
    );
    // 坏页之后的健康页面仍被采到：实验剧场共 4 页，第 2 页坏但 3/4 页入库。
    const studioRowsDamaged = (await damagedStore.allAnnouncements()).filter(
      (row) => row.venueId === 'studio',
    );
    const studioPages = new Set(studioRowsDamaged.map((row) => row.sourcePage));
    harness.check(
      '坏页之后仍继续翻页，后续页面正常入库',
      studioPages.has(3) && studioPages.has(4) && !studioPages.has(2),
      `已采页：${[...studioPages].sort().join(', ')}`,
    );
    const damageStats = await control(site, 'stats');
    harness.equal(
      '站点确实下发了 4 个受损页',
      Number(damageStats.damagedPagesServed),
      4,
    );

    // 7.3 解析器未修复时离线补采：一个受损页都补不了，但数据保持原样、可重试。
    const premature = new OfflineRepair(damagedStore, {
      layouts: ['v2', 'legacy'],
      tolerateMissingContainer: false,
      log: () => undefined,
    });
    const prematureResult = await premature.run();
    harness.equal(
      '解析修复前离线补采全部保留为待补采',
      prematureResult.stillFailing,
      4,
    );
    harness.equal('未修复时受损页一个都不被标记', prematureResult.replayed, 0);

    // 7.4 模拟“原页下线”：关闭站点后补采必须完全离线可用。
    await site.close();
    // 网络守卫：离线补采期间任何 fetch 都视为失败（站点已关，请求也会报错）。
    const realFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error('离线补采不允许发起网络请求');
    }) as typeof fetch;
    const offlineRepair = new OfflineRepair(damagedStore, {
      log: (message) => console.log(`    · ${message.trim()}`),
    });
    let offlineThrew = false;
    let offlineResult: Awaited<ReturnType<OfflineRepair['run']>>;
    try {
      offlineResult = await offlineRepair.run();
    } catch (error) {
      offlineThrew = true;
      throw error;
    } finally {
      globalThis.fetch = realFetch;
    }
    harness.equal('离线补采期间零网络请求', networkCalls, 0);
    harness.check('离线补采不依赖站点在线', !offlineThrew);
    harness.equal('断网离线补采回放全部 4 个受损页', offlineResult.replayed, 4);
    harness.equal('断网离线补采后无剩余受损页', offlineResult.remaining, 0);
    harness.check('离线补采成功', offlineResult.ok);
    const repairedRows = await damagedStore.allAnnouncements();
    compareAnnouncements(harness, goldenRows, repairedRows);
    compareEvents(harness, goldenEvents, await damagedStore.effectiveEvents());
    compareConfirmations(harness, goldenConfs, await damagedStore.changeConfirmations());

    /* ---------- 7b. 补采中断重启：接着未完成的受损页补完 ---------- */
    harness.section('7b. 离线补采中断后重启，仍能补完且结果一致');
    const interruptDir = mkdtempSync(join(tmpdir(), 'festival-interrupt-'));
    const interruptPath = join(interruptDir, 'interrupt.duckdb');
    const interruptStore = await Store.open(interruptPath);
    const site2 = new MockSite({ contentVersion: 1 });
    await site2.listen(0);
    await control(site2, 'reset', { contentVersion: 1 });
    await control(site2, 'damage', {
      venue: 'harbor', page: 1, mode: 'unknown-layout',
    });
    // 两轮采集命中同一个持续故障页，模拟同一页先后坏两次。
    const firstCollect = await collect(interruptStore, site2, ['harbor'], ['v2', 'legacy']);
    const secondCollect = await collect(interruptStore, site2, ['harbor'], ['v2', 'legacy']);
    const damagedTotal =
      firstCollect.venues[0].damagedPages + secondCollect.venues[0].damagedPages;
    harness.equal('中断场景：两个受损页已留存', damagedTotal, 2);
    const firstRun = new OfflineRepair(interruptStore, { maxCaptures: 1, log: () => undefined });
    const firstResult = await firstRun.run();
    harness.equal('补采中断：本次只回放 1 个受损页', firstResult.replayed, 1);
    harness.check('中断状态被如实标记', firstResult.interrupted);
    harness.equal('中断后剩余 1 个受损页', firstResult.remaining, 1);
    // 关闭并重新打开数据库，模拟进程重启。
    await interruptStore.close();
    const reopened = await Store.open(interruptPath);
    const secondRun = new OfflineRepair(reopened, { log: () => undefined });
    const secondResult = await secondRun.run();
    harness.equal('重启后续采只处理剩余 1 个受损页', secondResult.replayed, 1);
    harness.equal('重启续采后受损页清空', secondResult.remaining, 0);
    const goldenHarbor = goldenRows.filter((row) => row.venueId === 'harbor');
    const reopenedHarbor = (await reopened.allAnnouncements()).filter(
      (row) => row.venueId === 'harbor',
    );
    compareAnnouncements(harness, goldenHarbor, reopenedHarbor);
    await site2.close();
    rmSync(interruptDir, { recursive: true, force: true });

    /* ---------- 7c. 同页坏两次 + 公告回到旧内容：按顺序回放对齐 ---------- */
    harness.section('7c. 同页坏两次与内容回退，最终排期按采集顺序对齐');
    const revertDir = mkdtempSync(join(tmpdir(), 'festival-revert-'));
    const revertPath = join(revertDir, 'revert.duckdb');
    const revertStore = await Store.open(revertPath);
    const site3 = new MockSite({ contentVersion: 1 });
    await site3.listen(0);
    await control(site3, 'reset', { contentVersion: 1 });
    // studio 第 2 页持续故障：两轮采集各留存一次 v1 原文（同页坏两次）。
    await control(site3, 'damage', {
      venue: 'studio', page: 2, mode: 'unknown-layout',
    });
    await collect(revertStore, site3, undefined, ['v2', 'legacy']);
    await collect(revertStore, site3, ['studio'], ['v2', 'legacy']);
    // 站点随后整体升级到 v2（公告修正），但实验剧场被单独回退到 v1（公告回到旧内容）。
    await control(site3, 'content', { version: 2 });
    await control(site3, 'venue-version', { venue: 'studio', version: 1 });
    await collect(revertStore, site3, ['harbor'], ['v2', 'legacy']);
    const revertRepair = new OfflineRepair(revertStore, { log: () => undefined });
    const revertResult = await revertRepair.run();
    harness.equal('回退场景：两个受损页按顺序回放完成', revertResult.replayed, 2);
    harness.equal('回退场景：无剩余受损页', revertResult.remaining, 0);

    // 金色基准：完全相同的站点操作序列，但页面始终健康（无故障注入）。
    const revertGoldenDir = mkdtempSync(join(tmpdir(), 'festival-revert-golden-'));
    const revertGoldenPath = join(revertGoldenDir, 'revert-golden.duckdb');
    const revertGoldenStore = await Store.open(revertGoldenPath);
    const site4 = new MockSite({ contentVersion: 1 });
    await site4.listen(0);
    await control(site4, 'reset', { contentVersion: 1 });
    await collect(revertGoldenStore, site4);
    await collect(revertGoldenStore, site4, ['studio']);
    await control(site4, 'content', { version: 2 });
    await control(site4, 'venue-version', { venue: 'studio', version: 1 });
    await collect(revertGoldenStore, site4, ['harbor']);
    compareAnnouncements(
      harness,
      await revertGoldenStore.allAnnouncements(),
      await revertStore.allAnnouncements(),
    );
    compareEvents(
      harness,
      await revertGoldenStore.effectiveEvents(),
      await revertStore.effectiveEvents(),
    );
    compareConfirmations(
      harness,
      await revertGoldenStore.changeConfirmations(),
      await revertStore.changeConfirmations(),
    );
    await site3.close();
    await site4.close();
    rmSync(revertDir, { recursive: true, force: true });
    rmSync(revertGoldenDir, { recursive: true, force: true });
    rmSync(goldenDir, { recursive: true, force: true });
    rmSync(damagedDir, { recursive: true, force: true });
    await goldenStore.close();

    /* ---------- 8. 输出最终排期 ---------- */
    harness.section('8. 最终对外排期');
    const events = await desk.effectiveEvents();
    for (const event of events) console.log(`  ${formatEventLine(event)}`);
    console.log('  改场记录：');
    for (const confirmation of await desk.confirmations()) {
      console.log(`    ${formatConfirmation(confirmation)}`);
    }

    /* ---------- 9. 单元级边界检查 ---------- */
    harness.section('9. 解析与折叠边界');
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
