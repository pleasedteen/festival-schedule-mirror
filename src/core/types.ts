export type AnnouncementKind = 'schedule' | 'change' | 'cancel';

export type ParseStatus = 'parsed' | 'pending';

export type EventStatus = 'scheduled' | 'cancelled' | 'pending_reparse' | 'pending';

export type Layout = 'v2' | 'legacy' | 'stub';

/**
 * 摘要列表（stub）只提供演出编号、修订号与详情入口，正文需按当前会话单独拉取。
 * 列表条目先以此标记入库（待补采），正文取回并核对编号/修订后才更新为 parsed。
 */
export const STUB_PENDING_PARSE_ERROR = '列表仅含编号与修订，正文待补采';

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
  /** 摘要列表条目的详情入口（绑定当前会话的签名链接）；非摘要版式为空。 */
  detailUrl?: string | null;
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
