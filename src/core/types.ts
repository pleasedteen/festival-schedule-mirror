export type AnnouncementKind = 'schedule' | 'change' | 'cancel';

export type ParseStatus = 'parsed' | 'pending';

export type EventStatus = 'scheduled' | 'cancelled' | 'pending_reparse' | 'pending';

export type Layout = 'v2' | 'legacy';

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
