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

  // 新版式 compact：旧解析器（白名单不含 compact）判损，升级后可解析。
  const compactHtml =
    '<html><body data-venue="studio" data-layout="compact">' +
    '<section class="board" data-venue="studio">' +
    '<div class="card" data-kind="schedule" data-event="E-C" data-revision="1" data-site="c-1">' +
    '<h3 class="card-title">紧凑公告</h3>' +
    '<span class="show-time" data-time="2026-12-01 19:00">2026-12-01 19:00</span>' +
    '<span class="doors-time" data-time="2026-12-01 18:30">2026-12-01 18:30</span>' +
    '</div></section></body></html>';
  let compactRejected = false;
  try {
    parsePage(compactHtml, 'http://mock/venue/studio', 2, 'studio', {
      layouts: ['v2', 'legacy'],
      tolerateMissingContainer: false,
    });
  } catch {
    compactRejected = true;
  }
  check('旧解析器拒绝 compact 新版式（整页判损）', compactRejected);
  const compactParsed = parsePage(compactHtml, 'http://mock/venue/studio', 2, 'studio');
  check(
    '升级后 compact 公告可解析',
    compactParsed.layout === 'compact' &&
      compactParsed.announcements[0].parseStatus === 'parsed' &&
      compactParsed.announcements[0].eventId === 'E-C',
  );

  // 容器缺失：body 仍声明 v2，但 main.announcement-list 不见了。
  const missingContainerHtml =
    '<html><body data-layout="v2" data-venue="harbor">' +
    '<div class="orphans"><article class="announcement" data-kind="schedule" ' +
    'data-event="E-M" data-revision="1" data-site="m-1">' +
    '<h2 class="title">散落公告</h2>' +
    '<time class="show-time" data-time="2026-12-02 19:00"></time>' +
    '<time class="doors-time" data-time="2026-12-02 18:30"></time>' +
    '</article></div></body></html>';
  let containerRejected = false;
  try {
    parsePage(missingContainerHtml, 'http://mock/venue/harbor', 1, 'harbor', {
      tolerateMissingContainer: false,
    });
  } catch {
    containerRejected = true;
  }
  check('不容忍容器缺失时整页判损', containerRejected);
  const recovered = parsePage(missingContainerHtml, 'http://mock/venue/harbor', 1, 'harbor');
  check(
    '容错开启后可找回容器外的公告',
    recovered.announcements[0].eventId === 'E-M' &&
      recovered.announcements[0].parseStatus === 'parsed',
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
