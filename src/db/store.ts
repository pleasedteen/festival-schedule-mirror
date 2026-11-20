import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { computeEffective } from '../core/effective';
import type {
  AnnouncementInput,
  AnnouncementRow,
  ChangeConfirmation,
  EventState,
} from '../core/types';

const COLUMNS = [
  'ann_key',
  'venue_id',
  'site_id',
  'kind',
  'event_id',
  'revision',
  'title',
  'show_time',
  'doors_time',
  'from_venue',
  'to_venue',
  'source_url',
  'source_page',
  'layout',
  'raw_html',
  'parse_status',
  'parse_error',
  'first_seen_at',
  'updated_at',
] as const;

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function rowFromRecord(record: Record<string, unknown>): AnnouncementRow {
  return {
    annKey: String(record.ann_key),
    venueId: String(record.venue_id),
    siteId: asString(record.site_id),
    kind: asString(record.kind) as AnnouncementRow['kind'],
    eventId: asString(record.event_id),
    revision: asNumber(record.revision),
    title: asString(record.title),
    showTime: asString(record.show_time),
    doorsTime: asString(record.doors_time),
    fromVenue: asString(record.from_venue),
    toVenue: asString(record.to_venue),
    sourceUrl: String(record.source_url),
    sourcePage: Number(record.source_page ?? 1),
    layout: asString(record.layout) as AnnouncementRow['layout'],
    rawHtml: String(record.raw_html ?? ''),
    parseStatus: String(record.parse_status) as AnnouncementRow['parseStatus'],
    parseError: asString(record.parse_error),
    firstSeenAt: String(record.first_seen_at),
    updatedAt: String(record.updated_at),
  };
}

/**
 * 内容指纹：不含 source_url，因为翻页签名会随会话变化；
 * 只有公告内容（版式/解析结果/原文）变化才算“更新”。
 */
function signatureOf(item: AnnouncementInput | AnnouncementRow): string {
  return JSON.stringify([
    item.venueId,
    item.siteId,
    item.kind,
    item.eventId,
    item.revision,
    item.title,
    item.showTime,
    item.doorsTime,
    item.fromVenue,
    item.toVenue,
    item.sourcePage,
    item.layout,
    item.rawHtml,
    item.parseStatus,
    item.parseError,
  ]);
}

/** 去掉查询串，避免带会话签名的翻页 URL 被当作公告内容变化。 */
function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.split('?')[0];
  }
}

export interface VenueSyncRecord {
  venueId: string;
  runAt: string;
  pages: number;
  recoveries: number;
  rateLimitWaits: number;
  status: string;
  lastError: string | null;
  announcements: number;
  layout: string | null;
}

export class Store {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    public readonly path: string,
  ) {}

  static async open(path: string): Promise<Store> {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();
    const store = new Store(instance, connection, path);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS announcements (
        ann_key VARCHAR PRIMARY KEY,
        venue_id VARCHAR NOT NULL,
        site_id VARCHAR,
        kind VARCHAR,
        event_id VARCHAR,
        revision INTEGER,
        title VARCHAR,
        show_time VARCHAR,
        doors_time VARCHAR,
        from_venue VARCHAR,
        to_venue VARCHAR,
        source_url VARCHAR NOT NULL,
        source_page INTEGER NOT NULL,
        layout VARCHAR,
        raw_html VARCHAR NOT NULL,
        parse_status VARCHAR NOT NULL,
        parse_error VARCHAR,
        first_seen_at VARCHAR NOT NULL,
        updated_at VARCHAR NOT NULL
      )
    `);
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS venue_sync (
        venue_id VARCHAR PRIMARY KEY,
        last_run_at VARCHAR NOT NULL,
        pages INTEGER NOT NULL,
        recoveries INTEGER NOT NULL,
        rate_limit_waits INTEGER NOT NULL,
        status VARCHAR NOT NULL,
        last_error VARCHAR,
        announcement_count INTEGER NOT NULL,
        layout VARCHAR
      )
    `);
    // 旧库升级：venue_sync 早期没有 layout 列。
    const syncColumns = await this.connection.runAndReadAll(
      "PRAGMA table_info('venue_sync')",
    );
    const hasLayout = syncColumns
      .getRowObjects()
      .some((record) => String(record.name) === 'layout');
    if (!hasLayout) {
      await this.connection.run('ALTER TABLE venue_sync ADD COLUMN layout VARCHAR');
    }
    // 派生表：服务台对外唯一使用的“已确认排期”。
    // 按编号查询与按剧场查询都只读这两张表，避免各自重算产生分歧。
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS effective_events (
        event_id VARCHAR PRIMARY KEY,
        title VARCHAR,
        status VARCHAR NOT NULL,
        venue_id VARCHAR,
        show_time VARCHAR,
        doors_time VARCHAR,
        revision INTEGER,
        last_change_kind VARCHAR,
        has_pending_change BOOLEAN NOT NULL,
        pending_revision INTEGER,
        pending_note VARCHAR,
        pending_reparse_count INTEGER NOT NULL,
        pending_reparse_note VARCHAR,
        refreshed_at VARCHAR NOT NULL
      )
    `);
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS change_confirmations (
        event_id VARCHAR NOT NULL,
        revision INTEGER NOT NULL,
        from_venue VARCHAR NOT NULL,
        to_venue VARCHAR NOT NULL,
        show_time VARCHAR,
        doors_time VARCHAR,
        from_ann_key VARCHAR,
        to_ann_key VARCHAR,
        from_seen_at VARCHAR,
        to_seen_at VARCHAR,
        confirmed BOOLEAN NOT NULL,
        confirmed_at VARCHAR,
        received_from BOOLEAN NOT NULL,
        received_to BOOLEAN NOT NULL,
        note VARCHAR,
        PRIMARY KEY (event_id, revision)
      )
    `);
    // 条件采集状态：每个剧场每一页最近一次“已入库正文”的 ETag。
    // 只有正文成功入库后才写入，因此“下载后未入库即中断”的页面
    // 不会留下 ETag，下次续采会重新拉取该页正文。
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS page_states (
        venue_id VARCHAR NOT NULL,
        source_page INTEGER NOT NULL,
        etag VARCHAR NOT NULL,
        updated_at VARCHAR NOT NULL,
        PRIMARY KEY (venue_id, source_page)
      )
    `);
    await this.selfHealEffective();
  }

  /**
   * 启动时用已入库公告重建派生排期：即使上次采集中途被杀，
   * 重启后也能立即查到此前已确认的排期与未确认的改场。
   */
  private async selfHealEffective(): Promise<void> {
    const rows = await this.allAnnouncements();
    if (rows.length > 0) await this.refreshEffective();
  }

  async close(): Promise<void> {
    try {
      this.connection.closeSync();
    } finally {
      this.instance.closeSync();
    }
  }

  async allAnnouncements(): Promise<AnnouncementRow[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT ${COLUMNS.join(', ')} FROM announcements ORDER BY ann_key`,
    );
    return reader.getRowObjects().map(rowFromRecord);
  }

  private async existing(annKey: string): Promise<AnnouncementRow | null> {
    const reader = await this.connection.runAndReadAll(
      `SELECT ${COLUMNS.join(', ')} FROM announcements WHERE ann_key = ?`,
      [annKey],
    );
    const rows = reader.getRowObjects();
    return rows.length > 0 ? rowFromRecord(rows[0]) : null;
  }

  /**
   * 按公告键幂等写入。内容未变化时不改 updated_at，
   * 内容变化（例如公告修正）时保留 first_seen_at 并刷新 updated_at。
   */
  async upsertPage(items: AnnouncementInput[], now: string): Promise<{
    inserted: number;
    changed: number;
    unchanged: number;
  }> {
    await this.connection.run('BEGIN TRANSACTION');
    try {
      const result = await this.writePageItems(items, now);
      await this.connection.run('COMMIT');
      return result;
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * 正文入库与页面 ETag 落库放在同一个事务里：
   * 只有正文确认写入后，条件采集状态才会更新；
   * 事务失败 / 进程中断时两者一起回滚，下次续采会重新拉取该页。
   */
  async upsertPageWithState(
    items: AnnouncementInput[],
    venueId: string,
    sourcePage: number,
    etag: string,
    now: string,
  ): Promise<{ inserted: number; changed: number; unchanged: number }> {
    await this.connection.run('BEGIN TRANSACTION');
    try {
      const result = await this.writePageItems(items, now);
      await this.connection.run(
        `INSERT INTO page_states (venue_id, source_page, etag, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (venue_id, source_page) DO UPDATE SET
           etag = excluded.etag,
           updated_at = excluded.updated_at`,
        [venueId, sourcePage, etag, now],
      );
      await this.connection.run('COMMIT');
      return result;
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
  }

  /** 调用方负责包裹事务。 */
  private async writePageItems(
    items: AnnouncementInput[],
    now: string,
  ): Promise<{ inserted: number; changed: number; unchanged: number }> {
    let inserted = 0;
    let changed = 0;
    let unchanged = 0;
    for (const item of items) {
      const current = await this.existing(item.annKey);
      const sourceUrl = canonicalUrl(item.sourceUrl);
      if (!current) {
        await this.connection.run(
          `INSERT INTO announcements (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
          [
            item.annKey,
            item.venueId,
            item.siteId,
            item.kind,
            item.eventId,
            item.revision,
            item.title,
            item.showTime,
            item.doorsTime,
            item.fromVenue,
            item.toVenue,
            sourceUrl,
            item.sourcePage,
            item.layout,
            item.rawHtml,
            item.parseStatus,
            item.parseError,
            now,
            now,
          ],
        );
        inserted += 1;
        continue;
      }
      if (signatureOf(current) === signatureOf(item)) {
        unchanged += 1;
        continue;
      }
      await this.connection.run(
        `UPDATE announcements SET
           venue_id = ?, site_id = ?, kind = ?, event_id = ?, revision = ?,
           title = ?, show_time = ?, doors_time = ?, from_venue = ?, to_venue = ?,
           source_url = ?, source_page = ?, layout = ?, raw_html = ?,
           parse_status = ?, parse_error = ?, updated_at = ?
         WHERE ann_key = ?`,
        [
          item.venueId,
          item.siteId,
          item.kind,
          item.eventId,
          item.revision,
          item.title,
          item.showTime,
          item.doorsTime,
          item.fromVenue,
          item.toVenue,
          canonicalUrl(item.sourceUrl),
          item.sourcePage,
          item.layout,
          item.rawHtml,
          item.parseStatus,
          item.parseError,
          now,
          item.annKey,
        ],
      );
      changed += 1;
    }
    return { inserted, changed, unchanged };
  }

  /** 某剧场全部已入库页面的 ETag（venueId → page → etag）。 */
  async pageStates(
    venueId?: string,
  ): Promise<{ venueId: string; sourcePage: number; etag: string }[]> {
    const reader = venueId
      ? await this.connection.runAndReadAll(
          'SELECT venue_id, source_page, etag FROM page_states WHERE venue_id = ? ORDER BY source_page',
          [venueId],
        )
      : await this.connection.runAndReadAll(
          'SELECT venue_id, source_page, etag FROM page_states ORDER BY venue_id, source_page',
        );
    return reader.getRowObjects().map((record) => ({
      venueId: String(record.venue_id),
      sourcePage: Number(record.source_page),
      etag: String(record.etag),
    }));
  }

  async pendingAnnouncements(): Promise<AnnouncementRow[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT ${COLUMNS.join(', ')} FROM announcements WHERE parse_status = 'pending' ORDER BY ann_key`,
    );
    return reader.getRowObjects().map(rowFromRecord);
  }

  async recordVenueSync(record: VenueSyncRecord): Promise<void> {
    await this.connection.run(
      `INSERT INTO venue_sync (venue_id, last_run_at, pages, recoveries, rate_limit_waits, status, last_error, announcement_count, layout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         pages = excluded.pages,
         recoveries = excluded.recoveries,
         rate_limit_waits = excluded.rate_limit_waits,
         status = excluded.status,
         last_error = excluded.last_error,
         announcement_count = excluded.announcement_count,
         layout = COALESCE(excluded.layout, venue_sync.layout)`,
      [
        record.venueId,
        record.runAt,
        record.pages,
        record.recoveries,
        record.rateLimitWaits,
        record.status,
        record.lastError,
        record.announcements,
        record.layout,
      ],
    );
  }

  async venueSyncState(): Promise<VenueSyncRecord[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT * FROM venue_sync ORDER BY venue_id`,
    );
    return reader.getRowObjects().map((record) => ({
      venueId: String(record.venue_id),
      runAt: String(record.last_run_at),
      pages: Number(record.pages),
      recoveries: Number(record.recoveries),
      rateLimitWaits: Number(record.rate_limit_waits),
      status: String(record.status),
      lastError: asString(record.last_error),
      announcements: Number(record.announcement_count),
      layout: asString(record.layout),
    }));
  }

  /**
   * 把当前公告折叠成唯一一份已确认排期并落库。
   * 每次采集结束都会调用，查询只读派生的两张表。
   */
  async refreshEffective(
    compute: (rows: AnnouncementRow[]) => {
      events: EventState[];
      confirmations: ChangeConfirmation[];
    } = computeEffective,
  ): Promise<{ events: number; confirmations: number }> {
    const rows = await this.allAnnouncements();
    const computed = compute(rows);
    const now = new Date().toISOString();
    await this.connection.run('BEGIN TRANSACTION');
    try {
      await this.connection.run('DELETE FROM effective_events');
      await this.connection.run('DELETE FROM change_confirmations');
      for (const event of computed.events) {
        await this.connection.run(
          `INSERT INTO effective_events (
             event_id, title, status, venue_id, show_time, doors_time, revision,
             last_change_kind, has_pending_change, pending_revision, pending_note,
             pending_reparse_count, pending_reparse_note, refreshed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.eventId,
            event.title,
            event.status,
            event.venueId,
            event.showTime,
            event.doorsTime,
            event.revision,
            event.lastChangeKind,
            event.hasPendingChange,
            event.pendingRevision,
            event.pendingNote,
            event.pendingReparseCount,
            event.pendingReparseNote,
            now,
          ],
        );
      }
      for (const confirmation of computed.confirmations) {
        await this.connection.run(
          `INSERT INTO change_confirmations (
             event_id, revision, from_venue, to_venue, show_time, doors_time,
             from_ann_key, to_ann_key, from_seen_at, to_seen_at, confirmed,
             confirmed_at, received_from, received_to, note
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            confirmation.eventId,
            confirmation.revision,
            confirmation.fromVenue,
            confirmation.toVenue,
            confirmation.showTime,
            confirmation.doorsTime,
            confirmation.fromAnnKey,
            confirmation.toAnnKey,
            confirmation.fromSeenAt,
            confirmation.toSeenAt,
            confirmation.confirmed,
            confirmation.confirmedAt,
            confirmation.receivedFrom,
            confirmation.receivedTo,
            confirmation.note,
          ],
        );
      }
      await this.connection.run('COMMIT');
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
    return {
      events: computed.events.length,
      confirmations: computed.confirmations.length,
    };
  }

  async effectiveEvents(): Promise<EventState[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT * FROM effective_events ORDER BY event_id`,
    );
    return reader.getRowObjects().map((record) => ({
      eventId: String(record.event_id),
      title: asString(record.title),
      status: String(record.status) as EventState['status'],
      venueId: asString(record.venue_id),
      showTime: asString(record.show_time),
      doorsTime: asString(record.doors_time),
      revision: asNumber(record.revision),
      lastChangeKind: asString(
        record.last_change_kind,
      ) as EventState['lastChangeKind'],
      hasPendingChange: Boolean(record.has_pending_change),
      pendingRevision: asNumber(record.pending_revision),
      pendingNote: asString(record.pending_note),
      pendingReparseCount: Number(record.pending_reparse_count ?? 0),
      pendingReparseNote: asString(record.pending_reparse_note),
    }));
  }

  async changeConfirmations(): Promise<ChangeConfirmation[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT * FROM change_confirmations ORDER BY event_id, revision`,
    );
    return reader.getRowObjects().map((record) => ({
      eventId: String(record.event_id),
      revision: Number(record.revision),
      fromVenue: String(record.from_venue),
      toVenue: String(record.to_venue),
      showTime: asString(record.show_time),
      doorsTime: asString(record.doors_time),
      fromAnnKey: asString(record.from_ann_key),
      toAnnKey: asString(record.to_ann_key),
      fromSeenAt: asString(record.from_seen_at),
      toSeenAt: asString(record.to_seen_at),
      confirmed: Boolean(record.confirmed),
      confirmedAt: asString(record.confirmed_at),
      receivedFrom: Boolean(record.received_from),
      receivedTo: Boolean(record.received_to),
      note: asString(record.note),
    }));
  }
}
