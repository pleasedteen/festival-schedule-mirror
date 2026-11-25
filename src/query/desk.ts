import type { Store } from '../db/store';
import type { AnnouncementRow, ChangeConfirmation, EventState } from '../core/types';

/**
 * 查询服务：按编号查询与按剧场查询都读同一份持久化的“已确认排期”
 * （effective_events / change_confirmations），待补采读已发布快照
 * （published_announcements）。这些数据只在剧场翻到末页发布时更新；
 * 采集进程写库短开短关，查询进程只读打开即可并发使用。
 */
export class FestivalDesk {
  constructor(private readonly store: Store) {}

  async effectiveEvents(): Promise<EventState[]> {
    return this.store.effectiveEvents();
  }

  async findEvent(eventId: string): Promise<EventState | null> {
    const events = await this.store.effectiveEvents();
    return events.find((event) => event.eventId === eventId) ?? null;
  }

  /** 某剧场当前有效的排期（已确认且当前在演）。 */
  async venueSchedule(venueId: string): Promise<EventState[]> {
    const events = await this.store.effectiveEvents();
    return events
      .filter((event) => event.status === 'scheduled' && event.venueId === venueId)
      .sort((a, b) => (a.showTime ?? '').localeCompare(b.showTime ?? ''));
  }

  async confirmations(eventId?: string): Promise<ChangeConfirmation[]> {
    const confirmations = await this.store.changeConfirmations();
    return eventId
      ? confirmations.filter((item) => item.eventId === eventId)
      : confirmations;
  }

  /** 与该剧场有关的待确认改场（原剧场或新剧场任一端）。 */
  async pendingChangesForVenue(venueId: string): Promise<ChangeConfirmation[]> {
    const confirmations = await this.store.changeConfirmations();
    return confirmations.filter(
      (item) =>
        !item.confirmed &&
        (item.fromVenue === venueId || item.toVenue === venueId),
    );
  }

  /** 已发布公告中的待补采条目（与对外展示口径一致）。 */
  async pendingReparse(): Promise<AnnouncementRow[]> {
    return this.store.pendingPublished();
  }
}
