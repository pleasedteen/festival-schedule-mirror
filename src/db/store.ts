import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { computeEffective } from '../core/effective';
import { sleep } from '../core/time';
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
}

export interface StoreOpenOptions {
  /**
   * 只读打开：不建表、不自愈、不持写锁。
   * 服务台查询进程使用，可与采集进程（写库短开短关）并发运行。
   */
  readOnly?: boolean;
}

/** DuckDB 单写者：写端持锁时其他打开会报锁冲突，短等重试即可。 */
function isLockConflict(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /could not set lock|conflicting lock/i.test(message);
}

async function openInstance(path: string, readOnly: boolean): Promise<DuckDBInstance> {
  const config = readOnly ? { access_mode: 'read_only' } : undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await DuckDBInstance.create(path, config);
    } catch (error) {
      if (!isLockConflict(error)) throw error;
      lastError = error;
      await sleep(Math.min(250, 50 + attempt * 25));
    }
  }
  throw lastError;
}

export class Store {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    public readonly path: string,
    public readonly readOnly: boolean,
  ) {}

  static async open(path: string, options: StoreOpenOptions = {}): Promise<Store> {
    const readOnly = options.readOnly ?? false;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const instance = await openInstance(path, readOnly);
    const connection = await instance.connect();
    const store = new Store(instance, connection, path, readOnly);
    if (!readOnly) {
      await store.migrate();
      await store.selfHeal();
    }
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
        announcement_count INTEGER NOT NULL
      )
    `);
    // 发布快照：只有“翻到末页”的剧场才会把工作区公告发布到这里。
    // 服务台的一切对外数据（已确认排期、待补采）都由这份快照派生；
    // 采到一半的剧场不发布，沿用快照中上次的公告。
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS published_announcements (
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
        updated_at VARCHAR NOT NULL,
        published_at VARCHAR NOT NULL
      )
    `);
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
  }

  /**
   * 读写打开时的自愈（只读打开不做任何写操作）：
   * - 老库迁移：工作区已有公告但从未发布过时，按 venue_sync 中
   *   最近完整采完（status='ok'）的剧场做首次发布；采到一半
   *   （collecting/failed/incomplete）的剧场不发布，等续采完成再发布。
   * - 已发布过的库：刷新派生排期，保证派生表与发布快照一致。
   * 中断前已入库的公告留在工作区，续采到末页后随该剧场一起发布。
   */
  private async selfHeal(): Promise<void> {
    const published = await this.publishedAnnouncements();
    const rows = await this.allAnnouncements();
    if (published.length === 0 && rows.length > 0) {
      const sync = await this.venueSyncState();
      const okVenues = sync.filter((item) => item.status === 'ok').map((item) => item.venueId);
      // 更老的库连 venue_sync 都没有：退化为发布全部（与旧行为一致）。
      const fallback = sync.length === 0 ? [...new Set(rows.map((row) => row.venueId))] : [];
      const now = new Date().toISOString();
      for (const venueId of okVenues.length > 0 ? okVenues : fallback) {
        await this.publishVenue(venueId, now);
      }
      return;
    }
    if (published.length > 0) await this.refreshEffective();
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
    let inserted = 0;
    let changed = 0;
    let unchanged = 0;
    await this.connection.run('BEGIN TRANSACTION');
    try {
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
      await this.connection.run('COMMIT');
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
    return { inserted, changed, unchanged };
  }

  /** 已发布快照中的全部公告（服务台对外数据的唯一来源）。 */
  async publishedAnnouncements(): Promise<AnnouncementRow[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT ${COLUMNS.join(', ')} FROM published_announcements ORDER BY ann_key`,
    );
    return reader.getRowObjects().map(rowFromRecord);
  }

  /** 已发布快照中的待补采公告。 */
  async pendingPublished(): Promise<AnnouncementRow[]> {
    const reader = await this.connection.runAndReadAll(
      `SELECT ${COLUMNS.join(', ')} FROM published_announcements WHERE parse_status = 'pending' ORDER BY ann_key`,
    );
    return reader.getRowObjects().map(rowFromRecord);
  }

  async countVenueAnnouncements(venueId: string): Promise<number> {
    const reader = await this.connection.runAndReadAll(
      `SELECT COUNT(*) AS c FROM announcements WHERE venue_id = ?`,
      [venueId],
    );
    const rows = reader.getRowObjects();
    return rows.length > 0 ? Number(rows[0].c) : 0;
  }

  /** 标记剧场进入采集中：此时不发布，查询沿用上次已发布的公告。 */
  async markVenueCollecting(venueId: string, now: string): Promise<void> {
    await this.connection.run(
      `INSERT INTO venue_sync (venue_id, last_run_at, pages, recoveries, rate_limit_waits, status, last_error, announcement_count)
       VALUES (?, ?, 0, 0, 0, 'collecting', NULL, 0)
       ON CONFLICT (venue_id) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         status = 'collecting',
         last_error = NULL`,
      [venueId, now],
    );
  }

  /**
   * 发布一个剧场：把工作区中该剧场的公告整体快照进 published_announcements，
   * 并在同一事务里把全部已发布公告折叠成派生排期。要么全部生效，要么不变，
   * 查询进程任何时候打开看到的都是一致的“已发布”状态。
   */
  async publishVenue(
    venueId: string,
    now: string,
    compute: (rows: AnnouncementRow[]) => {
      events: EventState[];
      confirmations: ChangeConfirmation[];
    } = computeEffective,
  ): Promise<{ published: number; events: number; confirmations: number }> {
    await this.connection.run('BEGIN TRANSACTION');
    try {
      await this.connection.run(
        `DELETE FROM published_announcements WHERE venue_id = ?`,
        [venueId],
      );
      await this.connection.run(
        `INSERT INTO published_announcements (${COLUMNS.join(', ')}, published_at)
         SELECT ${COLUMNS.join(', ')}, ? FROM announcements WHERE venue_id = ?`,
        [now, venueId],
      );
      const countReader = await this.connection.runAndReadAll(
        `SELECT COUNT(*) AS c FROM published_announcements WHERE venue_id = ?`,
        [venueId],
      );
      const published = Number(countReader.getRowObjects()[0]?.c ?? 0);
      const folded = await this.foldIntoDerived(compute, now);
      await this.connection.run('COMMIT');
      return { published, ...folded };
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
  }

  async recordVenueSync(record: VenueSyncRecord): Promise<void> {
    await this.connection.run(
      `INSERT INTO venue_sync (venue_id, last_run_at, pages, recoveries, rate_limit_waits, status, last_error, announcement_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         pages = excluded.pages,
         recoveries = excluded.recoveries,
         rate_limit_waits = excluded.rate_limit_waits,
         status = excluded.status,
         last_error = excluded.last_error,
         announcement_count = excluded.announcement_count`,
      [
        record.venueId,
        record.runAt,
        record.pages,
        record.recoveries,
        record.rateLimitWaits,
        record.status,
        record.lastError,
        record.announcements,
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
    }));
  }

  /**
   * 把当前已发布公告折叠成唯一一份已确认排期并落库。
   * 供自愈与测试使用；采集路径请用 publishVenue（快照+折叠同一事务）。
   */
  async refreshEffective(
    compute: (rows: AnnouncementRow[]) => {
      events: EventState[];
      confirmations: ChangeConfirmation[];
    } = computeEffective,
  ): Promise<{ events: number; confirmations: number }> {
    const now = new Date().toISOString();
    await this.connection.run('BEGIN TRANSACTION');
    try {
      const folded = await this.foldIntoDerived(compute, now);
      await this.connection.run('COMMIT');
      return folded;
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * 从已发布快照重算派生排期（调用方须已开启事务）。
   * 查询只读这两张派生表，按编号与按剧场结果一致。
   */
  private async foldIntoDerived(
    compute: (rows: AnnouncementRow[]) => {
      events: EventState[];
      confirmations: ChangeConfirmation[];
    },
    now: string,
  ): Promise<{ events: number; confirmations: number }> {
    const rows = await this.publishedAnnouncements();
    const computed = compute(rows);
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
