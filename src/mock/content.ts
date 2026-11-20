import type { AnnouncementKind } from '../core/types';

export interface MockItem {
  siteId: string;
  kind: AnnouncementKind;
  eventId: string;
  revision: number;
  title: string;
  showTime?: string;
  doorsTime?: string;
  fromVenue?: string;
  toVenue?: string;
}

export interface VenueContent {
  venueId: string;
  layout: 'v2' | 'legacy';
  items: MockItem[];
}

const schedule = (
  siteId: string,
  eventId: string,
  revision: number,
  title: string,
  showTime: string,
  doorsTime: string,
): MockItem => ({ siteId, kind: 'schedule', eventId, revision, title, showTime, doorsTime });

const change = (
  siteId: string,
  eventId: string,
  revision: number,
  title: string,
  showTime: string,
  doorsTime: string,
  fromVenue: string,
  toVenue: string,
): MockItem => ({
  siteId,
  kind: 'change',
  eventId,
  revision,
  title,
  showTime,
  doorsTime,
  fromVenue,
  toVenue,
});

const cancel = (
  siteId: string,
  eventId: string,
  revision: number,
  title: string,
): MockItem => ({ siteId, kind: 'cancel', eventId, revision, title });

function baseContent(): VenueContent[] {
  return [
    {
      venueId: 'grand',
      layout: 'v2',
      items: [
        schedule('g-1001-s1', 'E-1001', 1, '仲夏夜之梦', '2026-12-18 19:30', '2026-12-18 18:45'),
        schedule('g-1005-s1', 'E-1005', 1, '海鸥', '2026-12-21 19:30', '2026-12-21 18:45'),
        change(
          'g-1001-c2',
          'E-1001',
          2,
          '仲夏夜之梦',
          '2026-12-19 20:00',
          '2026-12-19 19:15',
          'grand',
          'studio',
        ),
        change(
          'g-1005-c2',
          'E-1005',
          2,
          '海鸥',
          '2026-12-22 19:00',
          '2026-12-22 18:15',
          'grand',
          'studio',
        ),
      ],
    },
    {
      venueId: 'studio',
      layout: 'legacy',
      items: [
        schedule('s-1002-s1', 'E-1002', 1, '玻璃动物园', '2026-12-20 19:00', '2026-12-20 18:15'),
        change(
          's-1001-c2',
          'E-1001',
          2,
          '仲夏夜之梦',
          '2026-12-19 20:00',
          '2026-12-19 19:15',
          'grand',
          'studio',
        ),
        change(
          's-1005-c2',
          'E-1005',
          2,
          '海鸥',
          '2026-12-22 19:00',
          '2026-12-22 18:15',
          'grand',
          'studio',
        ),
        change(
          's-1005-c3',
          'E-1005',
          3,
          '海鸥',
          '2026-12-23 18:30',
          '2026-12-23 17:45',
          'studio',
          'harbor',
        ),
        cancel('s-1002-x2', 'E-1002', 2, '玻璃动物园'),
        schedule('s-1008-s1', 'E-1008', 1, '安提戈涅', '2026-12-26 19:00', '2026-12-26 18:15'),
        // 故意写“待定”，用于演示待补采公告不阻塞其他公告。
        {
          siteId: 's-1010-s1',
          kind: 'schedule',
          eventId: 'E-1010',
          revision: 1,
          title: '等待戈多（档期待定）',
          showTime: '待定',
          doorsTime: '待定',
        },
      ],
    },
    {
      venueId: 'harbor',
      layout: 'v2',
      items: [
        // 首版缺少入场时间：解析不可靠，进入待补采。
        {
          siteId: 'h-1003-s2',
          kind: 'schedule',
          eventId: 'E-1003',
          revision: 2,
          title: '暴风雨',
          showTime: '2026-12-25 19:30',
        },
        schedule('h-1007-s1', 'E-1007', 1, '樱桃园', '2026-12-24 19:00', '2026-12-24 18:15'),
        schedule('h-1009-s1', 'E-1009', 1, '万尼亚舅舅', '2026-12-27 19:30', '2026-12-27 18:45'),
      ],
    },
  ];
}

function withVersion(version: number): VenueContent[] {
  const venues = baseContent();
  const harbor = venues.find((venue) => venue.venueId === 'harbor');
  const studio = venues.find((venue) => venue.venueId === 'studio');
  if (!harbor || !studio) return venues;

  if (version >= 2) {
    harbor.items = harbor.items.map((item) =>
      item.eventId === 'E-1003'
        ? { ...item, doorsTime: '2026-12-25 18:45' }
        : item,
    );
    studio.items = studio.items.map((item) =>
      item.eventId === 'E-1010'
        ? {
            ...item,
            title: '等待戈多',
            showTime: '2026-12-28 19:00',
            doorsTime: '2026-12-28 18:15',
          }
        : item,
    );
  }
  if (version >= 3) {
    // 新剧场端终于发布改场公告：E-1005 由实验剧场迁至海港剧场。
    harbor.items = [
      ...harbor.items,
      change(
        'h-1005-c3',
        'E-1005',
        3,
        '海鸥',
        '2026-12-23 18:30',
        '2026-12-23 17:45',
        'studio',
        'harbor',
      ),
    ];
  }
  return venues;
}

/**
 * 公告内容版本：
 * 1 = 初始；
 * 2 = 海港剧场修正《暴风雨》入场时间，实验剧场补全《等待戈多》档期；
 * 3 = 海港剧场补发 E-1005 改场公告（与实验剧场一端配对）。
 */
export function contentForVersion(version: number): VenueContent[] {
  return withVersion(version);
}

export function venueContent(version: number, venueId: string): VenueContent | null {
  return contentForVersion(version).find((venue) => venue.venueId === venueId) ?? null;
}

export const PAGE_SIZE = 2;

export function pageCount(content: VenueContent): number {
  return Math.max(1, Math.ceil(content.items.length / PAGE_SIZE));
}

export function itemsForPage(content: VenueContent, page: number): MockItem[] {
  const start = (page - 1) * PAGE_SIZE;
  return content.items.slice(start, start + PAGE_SIZE);
}

/**
 * 条件采集用的页面内容指纹：只取决于该页公告内容与版式，
 * 不包含会话/签名等易变信息，因此站点重启或会话轮换后指纹保持不变。
 */
export function pageFingerprint(content: VenueContent, page: number): string {
  return JSON.stringify({
    venueId: content.venueId,
    layout: content.layout,
    page,
    items: itemsForPage(content, page).map((item) => ({ ...item })),
  });
}
