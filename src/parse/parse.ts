import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { venuesFromMoveText, venueIdByName } from './venues';
import { assertDoorsBeforeShow, normalizeDateTime } from '../core/time';
import type {
  AnnouncementInput,
  AnnouncementKind,
  Layout,
  ParsedPage,
} from '../core/types';

export class AnnouncementParseError extends Error {}

function textOf(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** 从一段自由文本中提取日期时间，兼容中文、斜杠、短横线三种写法。 */
function extractDateTime(text: string | null): string {
  if (!text) throw new AnnouncementParseError('缺少时间字段');
  const match = text.match(
    /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?\s*[T\s]\s*(\d{1,2}):(\d{2})/,
  );
  if (!match) throw new AnnouncementParseError(`无法识别时间：${text}`);
  const [, y, mo, d, h, mi] = match;
  return normalizeDateTime(`${y}-${mo}-${d} ${h}:${mi}`);
}

/** 兼容 "演出时间：...；入场时间：..." 这类标签文本。 */
function extractLabeledTime(
  text: string | null,
  labels: string[],
): string | null {
  if (!text) return null;
  for (const label of labels) {
    const re = new RegExp(`${label}[：:]\\s*([^；;\\n]+)`);
    const match = text.match(re);
    if (match) return extractDateTime(match[1]);
  }
  return null;
}

function resolveChangeVenues(
  el: cheerio.Cheerio<any>,
  moveText: string | null,
): { from: string | null; to: string | null } {
  const declaredFrom = venueIdByName(el.attr('data-from'));
  const declaredTo = venueIdByName(el.attr('data-to'));
  const fromText = venuesFromMoveText(moveText);
  return {
    from: declaredFrom ?? fromText.from,
    to: declaredTo ?? fromText.to,
  };
}

function isRecordedKind(kind: string | undefined | null): boolean {
  return kind === 'schedule' || kind === 'change' || kind === 'cancel';
}

interface ParseContext {
  venueId: string;
  sourceUrl: string;
  sourcePage: number;
  layout: Layout;
  index: number;
}

function buildBase(
  el: cheerio.Cheerio<any>,
  $: CheerioAPI,
  ctx: ParseContext,
): {
  rawHtml: string;
  kind: AnnouncementKind | null;
  eventId: string | null;
  revision: number | null;
  siteId: string | null;
} {
  const rawHtml = $.html(el);
  const kindRaw = el.attr('data-kind')?.trim() ?? null;
  const kind = isRecordedKind(kindRaw) ? (kindRaw as AnnouncementKind) : null;
  const eventId = textOf(el.attr('data-event'));
  const revisionRaw = textOf(el.attr('data-revision'));
  const revision =
    revisionRaw && /^\d+$/.test(revisionRaw) ? Number(revisionRaw) : null;
  const siteId = textOf(el.attr('data-site'));
  return { rawHtml, kind, eventId, revision, siteId };
}

function parseV2(
  $: CheerioAPI,
  el: cheerio.Cheerio<any>,
  ctx: ParseContext,
): AnnouncementInput {
  const base = buildBase(el, $, ctx);
  const title = textOf(el.find('h2.title').first().text());
  const moveText = textOf(el.find('p.move').first().text());
  const showRaw =
    textOf(el.find('.show-time').first().attr('data-time')) ??
    textOf(el.find('.show-time').first().text());
  const doorsRaw =
    textOf(el.find('.doors-time').first().attr('data-time')) ??
    textOf(el.find('.doors-time').first().text());

  const move = resolveChangeVenues(el, moveText);
  const fromVenue = move.from;
  const toVenue = move.to;

  let parseError: string | null = null;
  let showTime: string | null = null;
  let doorsTime: string | null = null;

  const needTimes = base.kind === 'schedule' || base.kind === 'change';
  try {
    if (!base.kind) throw new AnnouncementParseError('公告类型无法识别');
    if (!base.eventId) throw new AnnouncementParseError('缺少演出编号');
    if (base.revision === null) throw new AnnouncementParseError('缺少修订号');
    if (needTimes) {
      if (!showRaw) throw new AnnouncementParseError('缺少演出时间');
      if (!doorsRaw) throw new AnnouncementParseError('缺少入场时间');
      showTime = extractDateTime(showRaw);
      doorsTime = extractDateTime(doorsRaw);
      assertDoorsBeforeShow(doorsTime, showTime);
    }
    if (base.kind === 'change') {
      if (!fromVenue) throw new AnnouncementParseError('缺少原剧场');
      if (!toVenue) throw new AnnouncementParseError('缺少新剧场');
      if (fromVenue === toVenue) throw new AnnouncementParseError('改场两端相同');
    }
  } catch (error) {
    parseError = (error as Error).message;
  }

  return {
    annKey: '',
    venueId: ctx.venueId,
    siteId: base.siteId,
    kind: base.kind,
    eventId: base.eventId,
    revision: base.revision,
    title,
    showTime,
    doorsTime,
    fromVenue: base.kind === 'change' ? fromVenue : null,
    toVenue: base.kind === 'change' ? toVenue : null,
    sourceUrl: ctx.sourceUrl,
    sourcePage: ctx.sourcePage,
    layout: ctx.layout,
    rawHtml: base.rawHtml,
    parseStatus: parseError ? 'pending' : 'parsed',
    parseError,
  };
}

function parseLegacy(
  $: CheerioAPI,
  el: cheerio.Cheerio<any>,
  ctx: ParseContext,
): AnnouncementInput {
  const base = buildBase(el, $, ctx);
  const title = textOf(el.find('.headline').first().text());
  const moveText = textOf(el.find('.move').first().text());
  const whenText = textOf(el.find('.when').first().text());
  const legacyLabel = textOf(el.find('.kind-label').first().text());

  let kind = base.kind;
  if (!kind && legacyLabel) {
    if (legacyLabel.includes('取消')) kind = 'cancel';
    else if (legacyLabel.includes('改场')) kind = 'change';
    else if (legacyLabel.includes('排期')) kind = 'schedule';
  }

  const move = resolveChangeVenues(el, moveText);
  const fromVenue = move.from;
  const toVenue = move.to;

  let parseError: string | null = null;
  let showTime: string | null = null;
  let doorsTime: string | null = null;

  try {
    if (!kind) throw new AnnouncementParseError('公告类型无法识别');
    if (!base.eventId) throw new AnnouncementParseError('缺少演出编号');
    if (base.revision === null) throw new AnnouncementParseError('缺少修订号');
    if (kind !== 'cancel') {
      showTime =
        extractLabeledTime(whenText, ['演出时间', '演出']) ??
        (whenText ? extractDateTime(whenText) : null);
      doorsTime = extractLabeledTime(whenText, ['入场时间', '入场']);
      if (!showTime) throw new AnnouncementParseError('缺少演出时间');
      if (!doorsTime) throw new AnnouncementParseError('缺少入场时间');
      assertDoorsBeforeShow(doorsTime, showTime);
    }
    if (kind === 'change') {
      if (!fromVenue) throw new AnnouncementParseError('缺少原剧场');
      if (!toVenue) throw new AnnouncementParseError('缺少新剧场');
      if (fromVenue === toVenue) throw new AnnouncementParseError('改场两端相同');
    }
  } catch (error) {
    parseError = (error as Error).message;
  }

  return {
    annKey: '',
    venueId: ctx.venueId,
    siteId: base.siteId,
    kind,
    eventId: base.eventId,
    revision: base.revision,
    title,
    showTime,
    doorsTime,
    fromVenue: kind === 'change' ? fromVenue : null,
    toVenue: kind === 'change' ? toVenue : null,
    sourceUrl: ctx.sourceUrl,
    sourcePage: ctx.sourcePage,
    layout: ctx.layout,
    rawHtml: base.rawHtml,
    parseStatus: parseError ? 'pending' : 'parsed',
    parseError,
  };
}

function detectLayout($: CheerioAPI): Layout | null {
  const declared = $('body').attr('data-layout')?.trim();
  if (declared === 'v2' || declared === 'legacy') return declared;
  if ($('main.announcement-list article.announcement').length > 0) return 'v2';
  if ($('#notices.old-layout .notice').length > 0) return 'legacy';
  return null;
}

function nextUrlOf(
  $: CheerioAPI,
  baseUrl: string,
  layout: Layout,
): string | null {
  const link =
    layout === 'v2'
      ? $('nav.pager a[rel="next"]').first()
      : $('#notices .pages a, .pages a').first();
  const href = textOf(link.attr('href'));
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function parsePage(
  html: string,
  sourceUrl: string,
  page: number,
  fallbackVenueId: string,
): ParsedPage {
  const $ = cheerio.load(html);
  const layout = detectLayout($);
  if (!layout) {
    throw new AnnouncementParseError('无法识别公告版式');
  }

  const venueId =
    textOf($('body').attr('data-venue')) ??
    textOf($('#notices').attr('data-venue')) ??
    fallbackVenueId;

  const announcements: AnnouncementInput[] = [];
  const elements =
    layout === 'v2' ? $('article.announcement').toArray() : $('#notices .notice').toArray();

  elements.forEach((element, index) => {
    const el = $(element);
    const ctx: ParseContext = {
      venueId,
      sourceUrl,
      sourcePage: page,
      layout,
      index,
    };
    let parsed: AnnouncementInput;
    try {
      parsed =
        layout === 'v2'
          ? parseV2($, el, ctx)
          : parseLegacy($, el, ctx);
    } catch (error) {
      parsed = {
        annKey: '',
        venueId,
        siteId: textOf(el.attr('data-site')),
        kind: null,
        eventId: textOf(el.attr('data-event')),
        revision: null,
        title: null,
        showTime: null,
        doorsTime: null,
        fromVenue: null,
        toVenue: null,
        sourceUrl,
        sourcePage: page,
        layout,
        rawHtml: $.html(el),
        parseStatus: 'pending',
        parseError: (error as Error).message,
      };
    }

    if (!parsed.annKey) {
      parsed.annKey = parsed.siteId
        ? `${venueId}:${parsed.siteId}`
        : `${venueId}:page-${page}-item-${index}`;
    }
    announcements.push(parsed);
  });

  const bodyPage = Number($('body').attr('data-page'));
  const bodyPageCount = Number($('body').attr('data-page-count'));
  return {
    layout,
    announcements,
    nextUrl: nextUrlOf($, sourceUrl, layout),
    pageLabel: textOf($('.page-label').first().text()),
    pageNo: Number.isInteger(bodyPage) && bodyPage > 0 ? bodyPage : page,
    pageCount:
      Number.isInteger(bodyPageCount) && bodyPageCount > 0 ? bodyPageCount : null,
    listToken: textOf($('body').attr('data-list-token')),
  };
}
