import type { ChangeConfirmation, EventState } from '../core/types';
import { venueName } from '../venues';

const STATUS_LABEL: Record<EventState['status'], string> = {
  scheduled: '已确认',
  cancelled: '已取消',
  pending_reparse: '待补采',
  pending: '待确认',
};

export interface EventView {
  event: EventState;
  confirmation: ChangeConfirmation | null;
}

export function statusLabel(status: EventState['status']): string {
  return STATUS_LABEL[status];
}

/** 是否应该出现在某剧场的“有效排期”里。 */
export function isActiveAt(event: EventState, venueId: string): boolean {
  return event.status === 'scheduled' && event.venueId === venueId;
}

export function formatEventLine(event: EventState): string {
  const title = event.title ?? '（未命名）';
  const head = `${event.eventId}  ${title}`;
  if (event.status === 'cancelled') {
    const rev = event.revision ? `（修订 ${event.revision}）` : '';
    return `${head}  【已取消】${rev}`;
  }
  if (event.status === 'scheduled') {
    const venue = venueName(event.venueId);
    const rev = event.revision ? ` · 修订 ${event.revision}` : '';
    const pending = event.hasPendingChange ? ' · 另有改场待确认' : '';
    return `${head}  ${venue} ${event.showTime} 入场 ${event.doorsTime}${rev}${pending}`;
  }
  if (event.status === 'pending_reparse') {
    return `${head}  【待补采】${event.pendingReparseNote ?? ''}`;
  }
  return `${head}  【待确认】${event.pendingNote ?? event.pendingReparseNote ?? ''}`;
}

export function formatConfirmation(confirmation: ChangeConfirmation): string {
  const base = `${confirmation.eventId} 修订 ${confirmation.revision}：${venueName(confirmation.fromVenue)} → ${venueName(confirmation.toVenue)}`;
  if (confirmation.confirmed) {
    return `${base}  已确认（两端公告一致）${confirmation.showTime ? `，${confirmation.showTime} 入场 ${confirmation.doorsTime}` : ''}`;
  }
  return `${base}  待确认（${confirmation.note ?? ''}）`;
}
