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
import type { AnnouncementRow, EventState } from '../core/types';

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
  options: {
    beforePersistPage?: (venueId: string, page: number) => void;
  } = {},
): Promise<Awaited<ReturnType<Collector['collectAll']>>> {
  const collector = new Collector({
    baseUrl: site.baseUrl,
    store,
    maxRateLimitWaitMs: 5000,
    log: (message) => console.log(`    · ${message.trim()}`),
    beforePersistPage: options.beforePersistPage,
  });
  return collector.collectAll(venues);
}

interface SiteTransferStats {
  bodyTransferred: number;
  notModified: number;
  venuePagesServed: number;
}

async function transferStats(site: MockSite): Promise<SiteTransferStats> {
  const stats = await control(site, 'stats');
  return {
    bodyTransferred: Number(stats.bodyTransferred ?? 0),
    notModified: Number(stats.notModified ?? 0),
    venuePagesServed: Number(stats.venuePagesServed ?? 0),
  };
}

/** 可跨数据库比较的公告/排期快照，用于验证续采结果与全量采集完全一致。 */
function snapshotRows(rows: AnnouncementRow[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        annKey: row.annKey,
        venueId: row.venueId,
        kind: row.kind,
        eventId: row.eventId,
        revision: row.revision,
        title: row.title,
        showTime: row.showTime,
        doorsTime: row.doorsTime,
        fromVenue: row.fromVenue,
        toVenue: row.toVenue,
        sourcePage: row.sourcePage,
        layout: row.layout,
        parseStatus: row.parseStatus,
        parseError: row.parseError,
      }))
      .sort((a, b) => a.annKey.localeCompare(b.annKey)),
  );
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

    /* ---------- 7. 条件采集：未变页面不再回传正文 ---------- */
    harness.section('7. 条件采集（ETag/304：未变公告不回传正文）');

    // 7.1 再跑一轮全量：所有页面内容未变，正文传输次数应为 0。
    const beforeRepeat = await transferStats(site);
    const repeat = await collect(store, site);
    const afterRepeat = await transferStats(site);
    const repeatBodies = afterRepeat.bodyTransferred - beforeRepeat.bodyTransferred;
    const repeat304 = afterRepeat.notModified - beforeRepeat.notModified;
    harness.equal('重复采集正文传输页数为 0', repeat.bodyTransferred, 0);
    harness.equal('站点侧也确认没有正文传输', repeatBodies, 0);
    harness.check(
      '每个未变页面都以 304 跳过',
      repeat.notModified > 0 && repeat304 === repeat.notModified,
      `采集器 304 ${repeat.notModified} 页，站点 304 ${repeat304} 页`,
    );
    const pagesPerVenue = repeat.venues.map((venue) => `${venue.venueId} ${venue.pages}页`).join('，');
    harness.check(
      '正常翻页仍覆盖全部页面（每页至多请求一次）',
      repeat.venues.every((venue) => venue.notModified === venue.pages),
      pagesPerVenue,
    );

    // 7.2 会话轮换：未变页面依旧全部 304、零正文传输（ETag 与签名无关）。
    await control(site, 'session/rotate', {});
    const beforeRotate = await transferStats(site);
    const rotated = await collect(store, site, ['grand']);
    const afterRotate = await transferStats(site);
    harness.check('轮换后采集正常完成', rotated.venues[0].ok, rotated.venues[0].error ?? '');
    harness.equal('会话轮换后正文传输页数为 0', rotated.venues[0].bodyTransferred, 0);
    harness.equal(
      '站点侧确认轮换轮次零正文传输',
      afterRotate.bodyTransferred - beforeRotate.bodyTransferred,
      0,
    );
    harness.equal(
      '轮换后每个未变页面仍以 304 跳过',
      rotated.venues[0].notModified,
      rotated.venues[0].pages,
    );

    // 7.3 重启采集进程（重开数据库）：ETag 持久化在 page_states，续采仍然零正文。
    await store.close();
    store = await Store.open(dbPath);
    const beforeCollectorRestart = await transferStats(site);
    const restarted = await collect(store, site, ['harbor']);
    const afterCollectorRestart = await transferStats(site);
    harness.equal('重启后续采正文传输页数为 0', restarted.venues[0].bodyTransferred, 0);
    harness.equal(
      '站点侧确认重启轮次零正文传输',
      afterCollectorRestart.bodyTransferred - beforeCollectorRestart.bodyTransferred,
      0,
    );

    // 7.4 重启模拟站点本身：ETag 只取决于页面内容，换一个全新站点实例仍然有效。
    const restartedSite = new MockSite({ contentVersion: 3 });
    await restartedSite.listen(0);
    const beforeSiteRestart = await transferStats(restartedSite);
    const siteRestartRun = await collect(store, restartedSite, ['harbor']);
    const afterSiteRestart = await transferStats(restartedSite);
    harness.equal(
      '模拟站重启后未变页面仍零正文传输',
      siteRestartRun.venues[0].bodyTransferred,
      0,
    );
    harness.equal(
      '站点侧确认重启后全部命中 304',
      afterSiteRestart.bodyTransferred - beforeSiteRestart.bodyTransferred,
      0,
    );

    // 7.5 旧末页新增下一页：旧页保持 304，只有新页回传正文并被采入。
    const append = await control(restartedSite, 'append-item', {
      venue: 'grand',
      siteId: 'g-extra-e9001',
      kind: 'schedule',
      eventId: 'E-9001',
      revision: 1,
      title: '追加公告',
      showTime: '2026-12-30 20:00',
      doorsTime: '2026-12-30 19:15',
    });
    harness.equal('追加后大剧院由 2 页变为 3 页', Number(append.pages), 3);
    const beforeAppend = await transferStats(restartedSite);
    const appendedRun = await collect(store, restartedSite, ['grand']);
    const afterAppend = await transferStats(restartedSite);
    harness.check(
      '只有新增的第 3 页回传正文',
      appendedRun.venues[0].bodyTransferred === 1,
      `传输 ${appendedRun.venues[0].bodyTransferred} 页`,
    );
    harness.equal(
      '前两页依旧 304 跳过',
      appendedRun.venues[0].notModified,
      2,
    );
    harness.equal(
      '站点侧正文传输同样只有 1 页',
      afterAppend.bodyTransferred - beforeAppend.bodyTransferred,
      1,
    );
    desk = new FestivalDesk(store);
    const extraEvent = await desk.findEvent('E-9001');
    harness.check(
      '新页公告正常入库并进入排期',
      extraEvent?.status === 'scheduled' && extraEvent.venueId === 'grand',
      describe(extraEvent),
    );

    // 7.6 再追加两条：一条挤进旧末页（第 2 页内容变化 → ETag 变 → 必须回传），
    // 另一条落到新第 4 页；未受影响的第 1、3 页继续 304。
    const append2 = await control(restartedSite, 'append-item', {
      venue: 'grand',
      siteId: 'g-extra-e9002',
      kind: 'schedule',
      eventId: 'E-9002',
      revision: 1,
      title: '追加公告二',
      showTime: '2026-12-31 20:00',
      doorsTime: '2026-12-31 19:15',
    });
    const append3 = await control(restartedSite, 'append-item', {
      venue: 'grand',
      siteId: 'g-extra-e9003',
      kind: 'schedule',
      eventId: 'E-9003',
      revision: 1,
      title: '追加公告三',
      showTime: '2027-01-02 20:00',
      doorsTime: '2027-01-02 19:15',
    });
    harness.equal('再次追加后大剧院变为 4 页', Number(append3.pages ?? append2.pages), 4);
    const shiftedRun = await collect(store, restartedSite, ['grand']);
    harness.check(
      '内容变化的旧末页与新页回传正文（共 2 页）',
      shiftedRun.venues[0].bodyTransferred === 2,
      `传输 ${shiftedRun.venues[0].bodyTransferred} 页`,
    );
    harness.equal(
      '未变化的第 1、3 页仍以 304 跳过',
      shiftedRun.venues[0].notModified,
      2,
    );
    const shiftedDesk = new FestivalDesk(store);
    harness.check(
      '挤进旧末页的公告同样入库',
      (await shiftedDesk.findEvent('E-9002'))?.status === 'scheduled' &&
        (await shiftedDesk.findEvent('E-9003'))?.status === 'scheduled',
      'E-9002 / E-9003',
    );

    /* ---------- 8. 下载后未入库即中断：续采补回且结果与全量一致 ---------- */
    harness.section('8. 中断补采（正文下载后未入库，续采结果与全量采集一致）');

    // 用一个全新数据库做“中断后续采”，另一个全新数据库做“全量采集”参照。
    const crashDb = join(workdir, 'crash.duckdb');
    const referenceDb = join(workdir, 'reference.duckdb');
    rmSync(crashDb, { force: true });
    rmSync(referenceDb, { force: true });

    // 8.1 首采大剧院：第 2 页正文下载、解析成功后、入库前模拟进程崩溃。
    let crashStore = await Store.open(crashDb);
    const crashedRun = await collect(crashStore, restartedSite, ['grand'], {
      beforePersistPage: (_venueId, page) => {
        if (page === 2) {
          throw new Error('模拟进程中断：正文已下载但尚未入库');
        }
      },
    });
    harness.check(
      '入库前中断被如实记录为采集失败',
      crashedRun.venues[0].ok === false &&
        /模拟进程中断/.test(crashedRun.venues[0].error ?? ''),
      crashedRun.venues[0].error ?? '',
    );
    await crashStore.close();

    // 崩溃后重开数据库：第 2 页没有 ETag、也没有公告。
    crashStore = await Store.open(crashDb);
    const statesAfterCrash = await crashStore.pageStates('grand');
    harness.equal(
      '中断页没有留下条件采集状态',
      statesAfterCrash.some((state) => state.sourcePage === 2),
      false,
    );
    const partialRows = (await crashStore.allAnnouncements()).filter(
      (row) => row.venueId === 'grand',
    );
    const partialPages = [...new Set(partialRows.map((row) => row.sourcePage))].sort(
      (a, b) => a - b,
    );
    harness.check(
      '中断页公告未入库，仅保留第 1 页',
      partialPages.length === 1 && partialPages[0] === 1,
      `实际页码 ${JSON.stringify(partialPages)}`,
    );

    // 8.2 不注入故障续采：第 1 页已入库且未变，仍命中 304；
    // 其余所有页面（含中断的第 2 页）正文都要重新传输。
    const beforeResume = await transferStats(restartedSite);
    const resumedCrash = await collect(crashStore, restartedSite, ['grand']);
    const afterResume = await transferStats(restartedSite);
    const totalGrandPages = resumedCrash.venues[0].pages;
    harness.check('续采成功', resumedCrash.venues[0].ok, resumedCrash.venues[0].error ?? '');
    harness.check(
      '中断页及之后各页正文被重新拉回（仅第 1 页 304）',
      resumedCrash.venues[0].bodyTransferred === totalGrandPages - 1,
      `传输 ${resumedCrash.venues[0].bodyTransferred} / ${totalGrandPages} 页`,
    );
    harness.equal('第 1 页续采时仍命中 304', resumedCrash.venues[0].notModified, 1);
    harness.equal(
      '站点侧确认续采正文传输页数与采集器一致',
      afterResume.bodyTransferred - beforeResume.bodyTransferred,
      totalGrandPages - 1,
    );

    // 8.3 参照：另一个空库对同样内容做一次不中断的全量采集。
    const referenceStore = await Store.open(referenceDb);
    const referenceRun = await collect(referenceStore, restartedSite, ['grand']);
    harness.check('参照全量采集成功', referenceRun.venues[0].ok);

    // 8.4 两者的公告、待补采状态与折叠后的排期/改场结果必须完全一致。
    const crashAnnouncements = snapshotRows(
      (await crashStore.allAnnouncements()).filter((row) => row.venueId === 'grand'),
    );
    const referenceAnnouncements = snapshotRows(
      (await referenceStore.allAnnouncements()).filter((row) => row.venueId === 'grand'),
    );
    harness.equal(
      '续采与全量采集的公告（含待补采标记）完全一致',
      crashAnnouncements,
      referenceAnnouncements,
    );
    const crashEvents = JSON.stringify(await new FestivalDesk(crashStore).effectiveEvents());
    const referenceEvents = JSON.stringify(
      await new FestivalDesk(referenceStore).effectiveEvents(),
    );
    harness.equal('折叠后的已确认排期完全一致', crashEvents, referenceEvents);
    const normalizeConfirms = (list: Awaited<ReturnType<FestivalDesk['confirmations']>>) =>
      JSON.stringify(
        list.map((item) => ({
          eventId: item.eventId,
          revision: item.revision,
          fromVenue: item.fromVenue,
          toVenue: item.toVenue,
          showTime: item.showTime,
          doorsTime: item.doorsTime,
          confirmed: item.confirmed,
          receivedFrom: item.receivedFrom,
          receivedTo: item.receivedTo,
          note: item.note,
        })),
      );
    const crashConfirms = normalizeConfirms(
      await new FestivalDesk(crashStore).confirmations(),
    );
    const referenceConfirms = normalizeConfirms(
      await new FestivalDesk(referenceStore).confirmations(),
    );
    harness.equal('改场确认结果完全一致', crashConfirms, referenceConfirms);
    harness.equal(
      '续采库待补采数量与全量库一致',
      (await new FestivalDesk(crashStore).pendingReparse()).length,
      (await new FestivalDesk(referenceStore).pendingReparse()).length,
    );
    await referenceStore.close();
    await crashStore.close();

    // 回到主库与主站点，完成最后的对外排期输出。
    store = await Store.open(dbPath);
    desk = new FestivalDesk(store);
    const finalSiteStats = await transferStats(restartedSite);
    try {
      await restartedSite.close();
    } catch {
      /* 已关闭 */
    }

    /* ---------- 9. 输出最终排期 ---------- */
    harness.section('9. 最终对外排期');
    const events = await desk.effectiveEvents();
    for (const event of events) console.log(`  ${formatEventLine(event)}`);
    console.log('  改场记录：');
    for (const confirmation of await desk.confirmations()) {
      console.log(`    ${formatConfirmation(confirmation)}`);
    }

    /* ---------- 10. 单元级边界检查 ---------- */
    harness.section('10. 解析与折叠边界');
    runUnitChecks((name, condition, detail) =>
      harness.check(name, condition, detail),
    );

    const elapsed = Date.now() - started;
    const ok = harness.checks.failed === 0 && elapsed <= TOTAL_BUDGET_MS;
    console.log(
      `\n正文传输统计（站点侧累计）：传输正文 ${finalSiteStats.bodyTransferred} 次，` +
        `条件命中 304 共 ${finalSiteStats.notModified} 次，` +
        `服务页面 ${finalSiteStats.venuePagesServed} 次`,
    );
    console.log(
      `结果：${harness.checks.passed} 项通过，${harness.checks.failed} 项失败，` +
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
