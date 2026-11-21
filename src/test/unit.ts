import type { AnnouncementRow } from '../core/types';
import { computeEffective } from '../core/effective';
import { normalizeDateTime, parseRetryAfter } from '../core/time';
import { parsePage } from '../parse/parse';

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

  const stubPage = parsePage(
    '<html><body data-layout="stub" data-venue="ring"><main class="announcement-index">' +
      '<article class="entry" data-event="E-7" data-revision="2" data-site="r-7-s2">' +
      '<span class="code">E-7</span> <span class="rev">修订 2</span> ' +
      '<a class="detail-link" href="/venue/ring/detail/r-7-s2?sig=abc">详情</a></article>' +
      '</main><nav class="pager"><a rel="next" href="/venue/ring/page/2?sig=n1">下一页</a></nav></body></html>',
    'http://mock/venue/ring',
    1,
    'ring',
  );
  const stubItem = stubPage.announcements[0];
  check('摘要列表版式识别', stubPage.layout === 'stub');
  check(
    '摘要条目只带编号与修订、进入待补采',
    stubItem.parseStatus === 'pending' &&
      stubItem.eventId === 'E-7' &&
      stubItem.revision === 2 &&
      stubItem.kind === null,
  );
  check(
    '摘要条目解析出详情入口',
    stubItem.detailUrl === 'http://mock/venue/ring/detail/r-7-s2?sig=abc',
  );
  check(
    '摘要列表继续翻页',
    stubPage.nextUrl === 'http://mock/venue/ring/page/2?sig=n1',
  );
  const stubNoLink = parsePage(
    '<html><body data-layout="stub" data-venue="ring"><main class="announcement-index">' +
      '<article class="entry" data-event="E-8" data-revision="1" data-site="r-8-s1"></article>' +
      '</main></body></html>',
    'http://mock/venue/ring',
    1,
    'ring',
  );
  check(
    '缺少详情入口的摘要条目保持待补采',
    stubNoLink.announcements[0].parseStatus === 'pending' &&
      stubNoLink.announcements[0].detailUrl === null,
  );

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

  const revisedSchedule = row({
    annKey: 'r:rev2',
    venueId: 'ring',
    kind: 'schedule',
    eventId: 'E-Z',
    revision: 2,
    showTime: '2026-12-29 20:00',
    doorsTime: '2026-12-29 19:15',
  });
  const lateOldBody = row({
    annKey: 'r:rev1',
    venueId: 'ring',
    kind: 'schedule',
    eventId: 'E-Z',
    revision: 1,
    showTime: '2026-12-29 19:30',
    doorsTime: '2026-12-29 18:45',
  });
  const notReverted = computeEffective([revisedSchedule, lateOldBody]).events[0];
  check(
    '迟到的旧修订正文不把排期改回去',
    notReverted.revision === 2 && notReverted.showTime === '2026-12-29 20:00',
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
