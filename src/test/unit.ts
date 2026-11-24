import type { AnnouncementRow } from '../core/types';
import { computeEffective } from '../core/effective';
import { normalizeDateTime, parseRetryAfter } from '../core/time';
import { parsePage } from '../parse/parse';
import { RateLimitGate, SiteRateLimitError } from '../core/rateLimit';
import type { Store, SiteRateLimitRecord } from '../db/store';

export type Check = (name: string, condition: boolean, detail?: string) => void;

function row(
  partial: Partial<AnnouncementRow> &
    Pick<AnnouncementRow, 'annKey' | 'venueId' | 'kind' | 'eventId' | 'revision'>,
): AnnouncementRow {
  return {
    siteId: partial.annKey,
    title: '测试演出',
    showTime: null,
    doorsTime: null,
    fromVenue: null,
    toVenue: null,
    sourceUrl: 'http://mock/x',
    sourcePage: 1,
    layout: 'v2',
    rawHtml: '',
    parseStatus: 'parsed',
    parseError: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

/** 解析、时间规范化与改场折叠的边界检查，供 E2E 和单元脚本共用。 */
export function runUnitChecks(check: Check): void {
  check('时间补零规范化', normalizeDateTime('2026-1-2 3:04') === '2026-01-02 03:04');
  let invalidDate = false;
  try {
    normalizeDateTime('2026-02-30 10:00');
  } catch {
    invalidDate = true;
  }
  check('非法日期被拒绝', invalidDate);
  let pendingText = false;
  try {
    normalizeDateTime('待定');
  } catch {
    pendingText = true;
  }
  check('“待定”等占位文字被拒绝', pendingText);
  check('Retry-After 秒数', parseRetryAfter('2') === 2000);
  check(
    'Retry-After HTTP-date',
    (parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) ?? 0) > 3000,
  );
  check('缺失 Retry-After', parseRetryAfter(null) === null);

  const parsed = parsePage(
    '<html><body data-layout="v2" data-venue="grand"><main class="announcement-list">' +
      '<article class="announcement" data-kind="schedule" data-event="E-9" data-revision="1" data-site="x">' +
      '<h2 class="title">T</h2><time class="show-time">2026-12-01 19:00</time></article>' +
      '</main></body></html>',
    'http://mock/venue/grand',
    1,
    'grand',
  );
  check('缺少入场时间 → 待补采', parsed.announcements[0].parseStatus === 'pending');
  check('待补采原因可读', /入场/.test(parsed.announcements[0].parseError ?? ''));
  let unknownLayout = false;
  try {
    parsePage('<html><body>nothing</body></html>', 'http://mock/venue/grand', 1, 'grand');
  } catch {
    unknownLayout = true;
  }
  check('无法识别版式时明确报错', unknownLayout);

  const base = row({
    annKey: 'g:base',
    venueId: 'grand',
    kind: 'schedule',
    eventId: 'E-X',
    revision: 1,
    showTime: '2026-12-10 19:30',
    doorsTime: '2026-12-10 18:45',
  });
  const changeFrom = row({
    annKey: 'g:change',
    venueId: 'grand',
    kind: 'change',
    eventId: 'E-X',
    revision: 2,
    showTime: '2026-12-11 20:00',
    doorsTime: '2026-12-11 19:15',
    fromVenue: 'grand',
    toVenue: 'studio',
  });
  const changeTo = row({
    annKey: 's:change',
    venueId: 'studio',
    kind: 'change',
    eventId: 'E-X',
    revision: 2,
    showTime: '2026-12-11 20:00',
    doorsTime: '2026-12-11 19:15',
    fromVenue: 'grand',
    toVenue: 'studio',
  });

  const oneEnd = computeEffective([base, changeFrom]).events[0];
  check(
    '仅一端改场：仍展示旧排期并标记待确认',
    oneEnd.venueId === 'grand' &&
      oneEnd.showTime === '2026-12-10 19:30' &&
      oneEnd.hasPendingChange &&
      oneEnd.status === 'scheduled',
  );

  const toEndOnly = computeEffective([base, changeTo]).events[0];
  check(
    '先收到新剧场端：同样不切换、标记待确认',
    toEndOnly.venueId === 'grand' &&
      toEndOnly.showTime === '2026-12-10 19:30' &&
      toEndOnly.hasPendingChange,
  );

  const bothEnds = computeEffective([base, changeFrom, changeTo]).events[0];
  check(
    '两端确认：切换剧场与时间',
    bothEnds.venueId === 'studio' &&
      bothEnds.showTime === '2026-12-11 20:00' &&
      !bothEnds.hasPendingChange,
  );

  const mismatched = row({
    annKey: 's:change2',
    venueId: 'studio',
    kind: 'change',
    eventId: 'E-X',
    revision: 2,
    showTime: '2026-12-11 21:00',
    doorsTime: '2026-12-11 20:15',
    fromVenue: 'grand',
    toVenue: 'studio',
  });
  const mismatch = computeEffective([base, changeFrom, mismatched]).events[0];
  check('两端时间不一致：不切换', mismatch.venueId === 'grand' && mismatch.hasPendingChange);

  const cancel = row({
    annKey: 's:cancel',
    venueId: 'studio',
    kind: 'cancel',
    eventId: 'E-X',
    revision: 3,
  });
  const cancelled = computeEffective([base, changeFrom, changeTo, cancel]).events[0];
  check('取消公告独立生效', cancelled.status === 'cancelled');

  const olderRevision = row({
    annKey: 'h:old-change',
    venueId: 'harbor',
    kind: 'change',
    eventId: 'E-X',
    revision: 0,
    showTime: '2026-12-01 10:00',
    doorsTime: '2026-12-01 09:00',
    fromVenue: 'harbor',
    toVenue: 'studio',
  });
  const noRegress = computeEffective([base, changeFrom, changeTo, olderRevision]).events[0];
  check(
    '低修订号不会覆盖已确认排期',
    noRegress.venueId === 'studio' && noRegress.revision === 2,
  );

  const unparsable = row({
    annKey: 'h:bad',
    venueId: 'harbor',
    kind: 'schedule',
    eventId: 'E-Y',
    revision: 1,
    parseStatus: 'pending',
    parseError: '缺少入场时间',
  });
  const pendingEvent = computeEffective([unparsable]).events[0];
  check('只有待补采公告时状态为待补采', pendingEvent.status === 'pending_reparse');
  check(
    '待补采说明包含来源',
    (pendingEvent.pendingReparseNote ?? '').includes('harbor'),
  );
}

/** 只实现闸门用到的持久化接口的内存 Store，避免单元检查依赖 DuckDB。 */
class MemoryRateLimitStore {
  private readonly rows = new Map<string, SiteRateLimitRecord>();

  async upsertSiteRateLimit(record: SiteRateLimitRecord): Promise<void> {
    this.rows.set(record.siteBaseUrl, { ...record });
  }

  async siteRateLimits(): Promise<SiteRateLimitRecord[]> {
    return [...this.rows.values()];
  }

  async deleteSiteRateLimit(siteBaseUrl: string): Promise<void> {
    this.rows.delete(siteBaseUrl);
  }
}

/** 站点级限流闸门的边界检查（异步部分）。 */
export async function runRateLimitGateChecks(check: Check): Promise<void> {
  const site = 'http://127.0.0.1:8801';
  const otherSite = 'http://127.0.0.1:8802';

  // 1) 未超上限：等待 Retry-After 后继续，恢复成功时清除记录。
  {
    const store = new MemoryRateLimitStore() as unknown as Store;
    let slept = 0;
    const gate = new RateLimitGate({
      store,
      maxWaitMs: 5000,
      sleepFn: async (ms) => {
        slept += ms;
      },
    });
    await gate.noteRateLimit(site, 1000, new Date().toISOString());
    check('限流等待按 Retry-After 睡眠', slept === 1000, `睡眠 ${slept}ms`);
    check('限流期间闸门处于激活状态', await gate.isActive(site));
    check('其他站点不受同站限流影响', !(await gate.isActive(otherSite)));
    await gate.clear(site);
    check('站点恢复后闸门关闭', !(await gate.isActive(site)));
    check('恢复后持久化记录被删除', (await store.siteRateLimits()).length === 0);
  }

  // 2) 超过单次上限：抛出并保留站点给出的恢复时刻。
  {
    const store = new MemoryRateLimitStore() as unknown as Store;
    const gate = new RateLimitGate({
      store,
      maxWaitMs: 800,
      sleepFn: async () => undefined,
    });
    let threw = false;
    try {
      await gate.noteRateLimit(site, 3000, new Date().toISOString());
    } catch (error) {
      threw =
        error instanceof SiteRateLimitError &&
        error.siteBaseUrl === site &&
        Date.parse(error.resumeAt) > Date.now();
    }
    check('等待超上限时抛出 SiteRateLimitError', threw);
    check('超上限后同站剧场仍被闸门拦截', await gate.isActive(site));
    const rows = await store.siteRateLimits();
    check('超上限的恢复时刻已持久化', rows.length === 1 && rows[0].siteBaseUrl === site);
  }

  // 3) hydrate：重启后读入恢复时刻；未到点跳过，到点放行并清理过期记录。
  {
    const store = new MemoryRateLimitStore() as unknown as Store;
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    await store.upsertSiteRateLimit({
      siteBaseUrl: site,
      resumeAt: future,
      requestedMs: 60_000,
      updatedAt: new Date().toISOString(),
    });
    await store.upsertSiteRateLimit({
      siteBaseUrl: otherSite,
      resumeAt: past,
      requestedMs: 1000,
      updatedAt: new Date().toISOString(),
    });
    const gate = new RateLimitGate({
      store,
      maxWaitMs: 5000,
      sleepFn: async () => undefined,
    });
    await gate.hydrate();
    check('hydrate 后未到恢复时刻的站点仍被拦截', await gate.isActive(site));
    check('hydrate 时清理已过期的限流记录', !(await gate.isActive(otherSite)));
    let skipped = false;
    try {
      await gate.awaitRecovery(site);
    } catch (error) {
      skipped = error instanceof SiteRateLimitError;
    }
    check('未到恢复时刻且超上限时 awaitRecovery 直接抛出', skipped);
  }
}
