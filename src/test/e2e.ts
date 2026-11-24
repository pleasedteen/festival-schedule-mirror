import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSite } from '../mock/server';
import { Store } from '../db/store';
import { Collector } from '../collect/collector';
import { resolveVenueTargets } from '../collect/config';
import { FestivalDesk } from '../query/desk';
import { formatConfirmation, formatEventLine } from '../query/view';
import { runUnitChecks, runRateLimitGateChecks } from './unit';
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
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);
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

interface CollectEnv {
  store: Store;
  siteA: MockSite;
  siteB: MockSite;
  /** 采集过程中的关键事件，用于核对采集顺序。 */
  order: string[];
}

/** 剧场迁站后的配置：grand/studio 在站点 A，harbor 在站点 B。 */
function targetsFor(env: CollectEnv) {
  return resolveVenueTargets({
    venueSiteArgs: [
      `grand=${env.siteA.baseUrl}`,
      `studio=${env.siteA.baseUrl}`,
      `harbor=${env.siteB.baseUrl}`,
    ],
  });
}

function makeCollector(env: CollectEnv, maxRateLimitWaitMs: number, echo = true): Collector {
  return new Collector({
    targets: targetsFor(env),
    store: env.store,
    maxRateLimitWaitMs,
    log: (message) => {
      const trimmed = message.trim();
      env.order.push(trimmed);
      if (echo) console.log(`    · ${trimmed}`);
    },
  });
}

async function collect(
  env: CollectEnv,
  venues?: string[],
  maxRateLimitWaitMs = 5000,
): Promise<Awaited<ReturnType<Collector['collectAll']>>> {
  const collector = makeCollector(env, maxRateLimitWaitMs);
  return collector.collectAll(venues);
}

export async function runE2E(): Promise<number> {
  const started = Date.now();
  const harness = new Harness();
  // 两个本地模拟站：公告迁站后，grand/studio 在 A 站，harbor 在 B 站。
  const siteA = new MockSite({ contentVersion: 1 });
  const siteB = new MockSite({ contentVersion: 1 });
  await Promise.all([siteA.listen(0), siteB.listen(0)]);
  const workdir = mkdtempSync(join(tmpdir(), 'festival-desk-e2e-'));
  const dbPath = join(workdir, 'festival.duckdb');
  const configPath = join(workdir, 'venue-sites.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        grand: siteA.baseUrl,
        studio: siteA.baseUrl,
        harbor: siteB.baseUrl,
      },
      null,
      2,
    ),
  );

  const env: CollectEnv = { store: await Store.open(dbPath), siteA, siteB, order: [] };

  console.log('戏剧节服务台 · 双站点端到端验证');
  console.log(`模拟公告站 A（grand/studio）${siteA.baseUrl}`);
  console.log(`模拟公告站 B（harbor）       ${siteB.baseUrl}`);
  console.log(`临时数据库 ${dbPath}`);

  try {
    /* ---------- 0. 配置解析 ---------- */
    harness.section('0. 剧场站点配置（单站用法保留，多站按剧场分别配置）');
    const fromConfig = resolveVenueTargets({
      site: 'http://127.0.0.1:9999',
      configPath,
      onlyVenues: ['grand', 'studio', 'harbor'],
    });
    harness.equal('配置文件按剧场解析出两个站点', new Set(fromConfig.map((t) => t.siteBaseUrl)).size, 2);
    const overridden = resolveVenueTargets({
      configPath,
      venueSiteArgs: [`harbor=${siteA.baseUrl}`],
      onlyVenues: ['harbor'],
    });
    harness.equal('--venue-site 可覆盖配置文件', overridden[0].siteBaseUrl, siteA.baseUrl);
    const single = resolveVenueTargets({
      site: siteA.baseUrl,
      onlyVenues: ['grand', 'harbor'],
    });
    harness.check(
      '保留原单站用法：未配置多站时所有剧场走同一站点',
      single.every((target) => target.siteBaseUrl === siteA.baseUrl),
    );

    /* ---------- 1. 多站采集顺序 + 翻页恢复 ---------- */
    harness.section('1. 多站采集顺序与翻页恢复（按站点分组、同站共享会话）');
    await control(siteA, 'reset', { contentVersion: 1 });
    await control(siteB, 'reset', { contentVersion: 1 });
    // A 站大剧院第 2 页请求时轮换会话，旧翻页签名立即失效。
    await control(siteA, 'rotate-after', { count: 2 });
    let result = await collect(env);
    const byVenue = new Map(result.venues.map((venue) => [venue.venueId, venue]));
    const grand = byVenue.get('grand')!;
    const studio = byVenue.get('studio')!;
    const harbor = byVenue.get('harbor')!;
    harness.check('A 站大剧院采集完成且从 409 恢复', grand.ok && grand.recoveries >= 1, `恢复 ${grand.recoveries} 次`);
    harness.check('A 站实验剧场（旧版式）采集完成', studio.ok && studio.layout === 'legacy');
    harness.check('B 站海港剧场（新版式）采集完成', harbor.ok && harbor.layout === 'v2');
    harness.equal('A 站两个剧场记录的站点一致', studio.siteBaseUrl, grand.siteBaseUrl);
    harness.equal('海港剧场确实来自 B 站', harbor.siteBaseUrl, siteB.baseUrl);

    const firstVenue = env.order.findIndex((line) => line.startsWith('采集 grand'));
    const secondVenue = env.order.findIndex((line) => line.startsWith('采集 studio'));
    const thirdVenue = env.order.findIndex((line) => line.startsWith('采集 harbor'));
    harness.check(
      '同站剧场连续采集（grand → studio），再采另一站 harbor',
      firstVenue >= 0 && firstVenue < secondVenue && secondVenue < thirdVenue,
      `顺序下标 ${firstVenue}, ${secondVenue}, ${thirdVenue}`,
    );
    const siteAHeader = env.order.findIndex((line) => line.startsWith('站点 ') && line.includes(siteA.baseUrl));
    const siteBHeader = env.order.findIndex((line) => line.startsWith('站点 ') && line.includes(siteB.baseUrl));
    harness.check('采集日志按站点分组输出', siteAHeader >= 0 && siteAHeader < siteBHeader);
    const statsA = await control(siteA, 'stats');
    harness.check('A 站确实轮换过会话', Number(statsA.sessionRotations) >= 1);

    /* ---------- 2. 同站 429 共享等待，他站照常 ---------- */
    harness.section('2. 同站 429：同站剧场一并等待，其他站点照常采集');
    await control(siteA, 'rate-limit', { seconds: 1, remaining: 1 });
    env.order.length = 0;
    const waited = await collect(env);
    const waitedA = waited.venues.filter((venue) => venue.siteBaseUrl === siteA.baseUrl);
    const waitedB = waited.venues.filter((venue) => venue.siteBaseUrl === siteB.baseUrl);
    const totalWaits = waited.venues.reduce((sum, venue) => sum + venue.rateLimitWaits, 0);
    harness.check('A 站按 Retry-After 等待后恢复', totalWaits >= 1, `等待 ${totalWaits} 次`);
    harness.check('A 站全部剧场最终成功', waitedA.every((venue) => venue.ok));
    harness.check(
      'B 站不受 A 站限流影响、照常采集',
      waitedB.every((venue) => venue.ok && venue.rateLimitWaits === 0),
    );
    const statsB = await control(siteB, 'stats');
    harness.equal('B 站从未返回过 429', Number(statsB.rateLimited), 0);
    const statsAAfter = await control(siteA, 'stats');
    harness.equal(
      'A 站只发出过一次 429：同站第二个剧场由闸门拦下等待、未再触发限流',
      Number(statsAAfter.rateLimited),
      1,
    );
    harness.equal(
      '实验剧场复用同站闸门、自身没有新的限流计数',
      waitedA.find((venue) => venue.venueId === 'studio')?.rateLimitWaits,
      0,
    );
    const waitLog = env.order.find((line) => line.includes('429'));
    harness.check('日志说明同站剧场一并等待', Boolean(waitLog?.includes('同站剧场一并等待')), waitLog ?? '');

    /* ---------- 3. 等待超上限：持久化恢复时刻，他站照常 ---------- */
    harness.section('3. 等待超过单次上限：跳过同站、持久化恢复时刻，他站照常');
    await control(siteA, 'rate-limit', { seconds: 3, remaining: 5 });
    const overCap = await collect(env, undefined, 800);
    const capA = overCap.venues.filter((venue) => venue.siteBaseUrl === siteA.baseUrl);
    const capB = overCap.venues.filter((venue) => venue.siteBaseUrl === siteB.baseUrl);
    harness.check(
      'A 站首个剧场因超过单次上限失败',
      capA[0]?.ok === false && capA[0]?.skipped === true,
      capA[0]?.error ?? '',
    );
    harness.check(
      'A 站其余剧场复用闸门、未再打站点就被跳过',
      capA.slice(1).every((venue) => venue.skipped && venue.pages === 0),
    );
    harness.check(
      'B 站在 A 站限流期间照常采集成功',
      capB.every((venue) => venue.ok),
    );
    const statsBAgain = await control(siteB, 'stats');
    harness.equal('B 站请求计数正常增长、未被牵连', Number(statsBAgain.rateLimited), 0);
    const persisted = await env.store.siteRateLimits();
    const persistedA = persisted.find((record) => record.siteBaseUrl === siteA.baseUrl);
    harness.check(
      'A 站恢复时刻已持久化（绝对时间）',
      Boolean(persistedA && Date.parse(persistedA.resumeAt) > Date.now()),
      persistedA?.resumeAt ?? '缺失',
    );

    /* ---------- 4. 重启后 collect / repair 遵守站点时间 ---------- */
    harness.section('4. 重启后续跑：未到恢复时刻继续跳过，到点自动恢复');
    await env.store.close();
    env.store = await Store.open(dbPath);
    let desk = new FestivalDesk(env.store);
    const before = await desk.findEvent('E-1005');
    harness.check(
      '重启后已确认排期仍可查询',
      before?.venueId === 'studio' && before?.revision === 2,
      describe(before),
    );
    // 立即重跑：持久化的恢复时刻未到且超出上限，A 站剧场不发请求直接跳过。
    // venuePagesServed 只统计真正的公告页请求（控制接口不增加它），
    // 用来精确度量“跳过窗口”内有没有向 A 站发起采集请求。
    const pagesBeforeSkip = Number((await control(siteA, 'stats')).venuePagesServed);
    const restarted = await collect(env, ['grand', 'studio', 'harbor'], 800);
    const restartedA = restarted.venues.filter((venue) => venue.siteBaseUrl === siteA.baseUrl);
    const restartedB = restarted.venues.filter((venue) => venue.siteBaseUrl === siteB.baseUrl);
    harness.check(
      '重启后 A 站仍遵守站点恢复时刻、跳过采集',
      restartedA.every((venue) => venue.skipped) &&
        restartedA.every((venue) => venue.error?.includes('恢复时刻')),
    );
    harness.check('重启后 B 站采集不受影响', restartedB.every((venue) => venue.ok));
    const pagesAfterSkip = Number((await control(siteA, 'stats')).venuePagesServed);
    harness.equal('跳过期间没有向 A 站发起公告页请求', pagesAfterSkip, pagesBeforeSkip);

    // 清掉模拟站尚未消费完的 429 故障，再等到站点给出的恢复时刻过去：
    // 此时重跑应自动清掉限流记录并成功，而不是被新一轮 429 再次拦回。
    await control(siteA, 'rate-limit', { remaining: 0 });
    const resumeAt = Date.parse(persistedA!.resumeAt);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, resumeAt - Date.now()) + 150));
    const recovered = await collect(env, ['grand', 'studio', 'harbor'], 800);
    harness.check(
      '恢复时刻过后 A 站重新采集成功',
      recovered.venues
        .filter((venue) => venue.siteBaseUrl === siteA.baseUrl)
        .every((venue) => venue.ok),
    );
    harness.equal(
      '恢复后限流持久化记录被清除',
      (await env.store.siteRateLimits()).length,
      0,
    );

    /* ---------- 5. 待补采修正与 repair 路径 ---------- */
    harness.section('5. 公告修正与 repair（按剧场各自站点补采）');
    await Promise.all([
      control(siteA, 'content', { version: 2 }),
      control(siteB, 'content', { version: 2 }),
    ]);
    desk = new FestivalDesk(env.store);
    const pendingBefore = await desk.pendingReparse();
    harness.equal('修正前存在两条待补采公告', pendingBefore.length, 2);
    const repair = new Collector({
      targets: targetsFor(env).filter((target) =>
        pendingBefore.some((row) => row.venueId === target.venueId),
      ),
      store: env.store,
      maxRateLimitWaitMs: 5000,
      log: (message) => console.log(`    · ${message.trim()}`),
    });
    const repairResult = await repair.collectAll();
    harness.check('repair 按各自站点补采成功', repairResult.venues.every((venue) => venue.ok));
    desk = new FestivalDesk(env.store);
    const e1003 = await desk.findEvent('E-1003');
    const e1010 = await desk.findEvent('E-1010');
    harness.check(
      'B 站《暴风雨》补采后进入有效排期',
      e1003?.status === 'scheduled' && e1003.venueId === 'harbor' && e1003.doorsTime === '2026-12-25 18:45',
      describe(e1003),
    );
    harness.check(
      'A 站《等待戈多》补采后进入有效排期',
      e1010?.status === 'scheduled' && e1010.venueId === 'studio',
      describe(e1010),
    );
    harness.equal('待补采公告已清空', (await desk.pendingReparse()).length, 0);

    /* ---------- 6. 跨站改场仍按两端确认 ---------- */
    harness.section('6. 跨站改场：一端在 A 站、一端在 B 站，两端到齐才切换');
    const pendingChange = await desk.findEvent('E-1005');
    harness.check(
      '仅 A 站一端时仍展示实验剧场旧排期并标记待确认',
      pendingChange?.venueId === 'studio' && pendingChange?.hasPendingChange === true,
      describe(pendingChange),
    );
    await Promise.all([
      control(siteA, 'content', { version: 3 }),
      control(siteB, 'content', { version: 3 }),
    ]);
    const cross = await collect(env);
    harness.check('跨站采集全部成功', cross.venues.every((venue) => venue.ok));
    desk = new FestivalDesk(env.store);
    const e1005 = await desk.findEvent('E-1005');
    harness.check(
      '两端到齐后切换到 B 站海港剧场与新时间',
      e1005?.status === 'scheduled' &&
        e1005.venueId === 'harbor' &&
        e1005.showTime === '2026-12-23 18:30' &&
        e1005.doorsTime === '2026-12-23 17:45' &&
        e1005.revision === 3 &&
        e1005.hasPendingChange === false,
      describe(e1005),
    );
    const studioSchedule = await desk.venueSchedule('studio');
    const harborSchedule = await desk.venueSchedule('harbor');
    harness.check(
      'A 站实验剧场有效排期已移除 E-1005',
      !studioSchedule.some((event) => event.eventId === 'E-1005'),
    );
    harness.check(
      'B 站海港剧场有效排期已加入 E-1005',
      harborSchedule.some((event) => event.eventId === 'E-1005'),
    );

    /* ---------- 7. 最终排期汇总 ---------- */
    harness.section('7. 跨站汇总后的对外排期');
    const events = await desk.effectiveEvents();
    for (const event of events) console.log(`  ${formatEventLine(event)}`);
    console.log('  改场记录：');
    for (const confirmation of await desk.confirmations()) {
      console.log(`    ${formatConfirmation(confirmation)}`);
    }
    const allScheduled = events.filter((event) => event.status === 'scheduled');
    const scheduledVenues = new Set(allScheduled.map((event) => event.venueId));
    harness.check(
      '两个站点的公告汇总为同一份排期（A 站 studio 与 B 站 harbor 均在场）',
      scheduledVenues.has('studio') && scheduledVenues.has('harbor'),
      `有效排期 ${allScheduled.length} 场，涉及剧场 ${[...scheduledVenues].join('、')}`,
    );

    /* ---------- 8. 单元级边界检查 ---------- */
    harness.section('8. 解析、限流闸门与折叠边界');
    runUnitChecks((name, condition, detail) =>
      harness.check(name, condition, detail),
    );
    await runRateLimitGateChecks((name, condition, detail) =>
      harness.check(name, condition, detail),
    );

    const elapsed = Date.now() - started;
    const ok = harness.checks.failed === 0 && elapsed <= TOTAL_BUDGET_MS;
    console.log(
      `\n结果：${harness.checks.passed} 项通过，${harness.checks.failed} 项失败，` +
        `耗时 ${(elapsed / 1000).toFixed(1)}s（上限 ${TOTAL_BUDGET_MS / 1000}s）`,
    );
    console.log(ok ? 'E2E PASS' : 'E2E FAIL');
    await env.store.close();
    return ok ? 0 : 1;
  } finally {
    try {
      await siteA.close();
    } catch {
      /* 已关闭 */
    }
    try {
      await siteB.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(workdir, { recursive: true, force: true });
  }
}
