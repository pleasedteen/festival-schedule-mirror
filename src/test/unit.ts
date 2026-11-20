import type { AnnouncementRow } from '../core/types';
import { computeEffective } from '../core/effective';
import { normalizeDateTime, parseRetryAfter } from '../core/time';
import { parsePage } from '../parse/parse';
import { editVenueContent, listTokenOf, longVenueContent, pageCount } from '../mock/content';

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

  // 列表元数据：页码、总页数、列表指纹从 HTML 的 body 属性解析。
  const pageWithMeta = parsePage(
    '<html><body data-layout="v2" data-venue="grand" data-page="7" data-page-count="64" data-list-token="tok-123"><main class="announcement-list">' +
      '<article class="announcement" data-kind="schedule" data-event="E-9" data-revision="1" data-site="x">' +
      '<h2 class="title">T</h2>' +
      '<time class="show-time" data-time="2026-12-01 19:00">2026-12-01 19:00</time>' +
      '<time class="doors-time" data-time="2026-12-01 18:15">2026-12-01 18:15</time></article>' +
      '</main></body></html>',
    'http://mock/venue/grand?page=7',
    7,
    'grand',
  );
  check('解析当前页码', pageWithMeta.pageNo === 7);
  check('解析总页数', pageWithMeta.pageCount === 64);
  check('解析列表指纹', pageWithMeta.listToken === 'tok-123');

  // 长列表：128 条 / 每页 2 条 = 64 页（超过 60 页）。
  const longList = longVenueContent('grand', 'v2', 128);
  check('长列表超过 60 页', pageCount(longList) === 64 && longList.items.length === 128);
  const tokenBefore = listTokenOf(longList);
  check('列表指纹为非空字符串', typeof tokenBefore === 'string' && tokenBefore.length > 0);

  // 重排改变指纹但不改变条目数。
  const swapped = editVenueContent(longList, { swap: [0, 9] });
  check('重排不改变条目数', swapped.items.length === longList.items.length);
  check('重排改变列表指纹', listTokenOf(swapped) !== tokenBefore);
  check('重排交换了位置', swapped.items[0].siteId === longList.items[9].siteId);

  // 增删：补发改指纹，删除既改指纹又减条目。
  const prepended = editVenueContent(longList, { prepend: 2 });
  check('补发增加条目并改变指纹', prepended.items.length === 130 && listTokenOf(prepended) !== tokenBefore);
  const removed = editVenueContent(longList, { removeAt: [3, 4] });
  check('删除减少条目并改变指纹', removed.items.length === 126 && listTokenOf(removed) !== tokenBefore);
}
