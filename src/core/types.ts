export type AnnouncementKind = 'schedule' | 'change' | 'cancel';

export type ParseStatus = 'parsed' | 'pending';

export type EventStatus = 'scheduled' | 'cancelled' | 'pending_reparse' | 'pending';

export type Layout = 'v2' | 'legacy' | 'compact';

export interface ParseOptions {
  /**
   * 可识别的版式白名单。解析器修复前的采集可只传旧版式，
   * 修复后再放开新版式，用于演示“修复后离线补采”。
   */
  layouts?: Layout[];
  /**
   * 是否容忍公告容器缺失（解析器升级后的容错能力）。
   * 修复前的采集传 false：容器缺失即整页判损、留存原文；
   * 修复后的离线补采传 true：退而按公告元素本身查找。
   */
  tolerateMissingContainer?: boolean;
}

export type AnnouncementInput = {
  annKey: string;
  venueId: string;
  siteId: string | null;
  kind: AnnouncementKind | null;
  eventId: string | null;
  revision: number | null;
  title: string | null;
  showTime: string | null;
  doorsTime: string | null;
  fromVenue: string | null;
  toVenue: string | null;
  sourceUrl: string;
  sourcePage: number;
  layout: Layout | null;
  rawHtml: string;
  parseStatus: ParseStatus;
  parseError: string | null;
};

export interface ParsedPage {
  layout: Layout | null;
  announcements: AnnouncementInput[];
  nextUrl: string | null;
  pageLabel: string | null;
}

export interface AnnouncementRow extends AnnouncementInput {
  firstSeenAt: string;
  updatedAt: string;
}

/**
 * 整页无法可靠解析（版式认不出 / 公告容器缺失）时留存的原始页面。
 * 采集只留存原文并继续翻页，待解析修复后由 repair --offline 按顺序回放。
 */
export interface DamagedPageRow {
  seq: number;
  venueId: string;
  sourceUrl: string;
  sourcePage: number;
  reason: string;
  rawHtml: string;
  capturedAt: string;
  repairedAt: string | null;
}

export interface EventState {
  eventId: string;
  title: string | null;
  status: EventStatus;
  venueId: string | null;
  showTime: string | null;
  doorsTime: string | null;
  revision: number | null;
  lastChangeKind: AnnouncementKind | null;
  hasPendingChange: boolean;
  pendingRevision: number | null;
  pendingNote: string | null;
  pendingReparseCount: number;
  pendingReparseNote: string | null;
}

export interface ChangeConfirmation {
  eventId: string;
  revision: number;
  fromVenue: string;
  toVenue: string;
  showTime: string | null;
  doorsTime: string | null;
  fromAnnKey: string | null;
  toAnnKey: string | null;
  fromSeenAt: string | null;
  toSeenAt: string | null;
  confirmed: boolean;
  confirmedAt: string | null;
  receivedFrom: boolean;
  receivedTo: boolean;
  note: string | null;
}
