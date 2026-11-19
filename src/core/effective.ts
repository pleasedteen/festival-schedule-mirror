import type {
  AnnouncementRow,
  ChangeConfirmation,
  EventState,
} from './types';

function byUpdatedDesc(a: AnnouncementRow, b: AnnouncementRow): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

interface Applied {
  revision: number;
  kind: 'schedule' | 'change' | 'cancel';
  venueId: string | null;
  showTime: string | null;
  doorsTime: string | null;
}

interface TimelineStep {
  revision: number;
  kind: 'change' | 'cancel';
  venueId: string | null;
  showTime: string | null;
  doorsTime: string | null;
}

/**
 * 判定一个修订号的改场是否已被两端确认。
 * 原剧场端 = 发布在 fromVenue 站点上的公告；新剧场端 = 发布在 toVenue 站点上的公告。
 * 两端必须方向一致且时间一致，否则不切换。
 */
function evaluateChange(
  eventId: string,
  revision: number,
  group: AnnouncementRow[],
): { confirmation: ChangeConfirmation; applied: Applied | null } {
  const sorted = [...group].sort(byUpdatedDesc);
  const anchor = sorted[0];
  const fromEnd = sorted.find((row) => row.venueId === row.fromVenue) ?? null;
  const toEnd = sorted.find((row) => row.venueId === row.toVenue) ?? null;

  const fromVenue = anchor?.fromVenue ?? '';
  const toVenue = anchor?.toVenue ?? '';
  let showTime = fromEnd?.showTime ?? toEnd?.showTime ?? null;
  let doorsTime = fromEnd?.doorsTime ?? toEnd?.doorsTime ?? null;

  let confirmed = false;
  let note: string | null;

  if (fromEnd && toEnd) {
    if (fromEnd.fromVenue !== toEnd.fromVenue || fromEnd.toVenue !== toEnd.toVenue) {
      note = '两端公告的改场方向不一致，暂不切换';
    } else if (
      fromEnd.showTime !== toEnd.showTime ||
      fromEnd.doorsTime !== toEnd.doorsTime
    ) {
      note = '两端公告的演出或入场时间不一致，暂不切换';
    } else {
      confirmed = true;
      showTime = fromEnd.showTime;
      doorsTime = fromEnd.doorsTime;
      note = '两端公告一致';
    }
  } else if (fromEnd) {
    note = `仅收到原剧场（${fromVenue}）公告，等待新剧场（${toVenue}）确认`;
  } else if (toEnd) {
    note = `仅收到新剧场（${toVenue}）公告，等待原剧场（${fromVenue}）确认`;
  } else {
    note = '改场公告缺少可识别的发布端，待补采';
  }

  const confirmation: ChangeConfirmation = {
    eventId,
    revision,
    fromVenue,
    toVenue,
    showTime,
    doorsTime,
    fromAnnKey: fromEnd?.annKey ?? null,
    toAnnKey: toEnd?.annKey ?? null,
    fromSeenAt: fromEnd?.firstSeenAt ?? null,
    toSeenAt: toEnd?.firstSeenAt ?? null,
    confirmed,
    confirmedAt: confirmed
      ? [fromEnd?.updatedAt ?? '', toEnd?.updatedAt ?? ''].sort().at(-1) ?? null
      : null,
    receivedFrom: Boolean(fromEnd),
    receivedTo: Boolean(toEnd),
    note,
  };

  const applied =
    confirmed && fromVenue && toVenue && showTime && doorsTime
      ? {
          revision,
          kind: 'change' as const,
          venueId: toVenue,
          showTime,
          doorsTime,
        }
      : null;

  return { confirmation, applied };
}

/**
 * 将一个演出的全部公告折叠为唯一一份“已确认排期”。
 * 按编号查询和按剧场查询都调用这里，保证两处结果一致。
 */
export function computeEvent(
  eventId: string,
  rows: AnnouncementRow[],
): { state: EventState; confirmations: ChangeConfirmation[] } {
  const parsed = rows.filter((row) => row.parseStatus === 'parsed');
  const unparsed = rows.filter((row) => row.parseStatus === 'pending');

  const schedules = parsed
    .filter((row) => row.kind === 'schedule' && row.revision !== null)
    .sort((a, b) => byUpdatedDesc(a, b));
  const base = [...schedules].sort((a, b) => {
    const diff = (b.revision ?? 0) - (a.revision ?? 0);
    return diff !== 0 ? diff : byUpdatedDesc(a, b);
  })[0];

  const current: Applied = base
    ? {
        revision: base.revision ?? 0,
        kind: 'schedule',
        venueId: base.venueId,
        showTime: base.showTime,
        doorsTime: base.doorsTime,
      }
    : {
        revision: 0,
        kind: 'schedule',
        venueId: null,
        showTime: null,
        doorsTime: null,
      };

  const changeGroups = new Map<number, AnnouncementRow[]>();
  for (const row of parsed) {
    if (row.kind !== 'change' || row.revision === null) continue;
    if (!row.fromVenue || !row.toVenue) continue;
    const group = changeGroups.get(row.revision) ?? [];
    group.push(row);
    changeGroups.set(row.revision, group);
  }

  const confirmations: ChangeConfirmation[] = [];
  const timeline: TimelineStep[] = [];
  for (const [revision, group] of [...changeGroups.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const evaluated = evaluateChange(eventId, revision, group);
    confirmations.push(evaluated.confirmation);
    if (evaluated.applied) {
      timeline.push({
        revision,
        kind: 'change',
        venueId: evaluated.applied.venueId,
        showTime: evaluated.applied.showTime,
        doorsTime: evaluated.applied.doorsTime,
      });
    }
  }

  // 取消公告独立生效，不依赖任何另一端。
  const cancels = new Map<number, AnnouncementRow>();
  for (const row of parsed) {
    if (row.kind !== 'cancel' || row.revision === null) continue;
    const existing = cancels.get(row.revision);
    if (!existing || byUpdatedDesc(existing, row) > 0) cancels.set(row.revision, row);
  }
  for (const revision of [...cancels.keys()].sort((a, b) => a - b)) {
    timeline.push({
      revision,
      kind: 'cancel',
      venueId: null,
      showTime: null,
      doorsTime: null,
    });
  }

  timeline.sort((a, b) => {
    if (a.revision !== b.revision) return a.revision - b.revision;
    // 同一修订号下取消优先，避免被同号改场覆盖。
    return a.kind === 'cancel' ? -1 : 1;
  });

  for (const step of timeline) {
    if (step.revision < current.revision) continue;
    if (step.revision === current.revision) {
      // 同号：只有取消能压过排期；同号改场不能覆盖更新的取消结论。
      if (step.kind === 'cancel') {
        current.kind = 'cancel';
        current.venueId = null;
        current.showTime = null;
        current.doorsTime = null;
      }
      continue;
    }
    current.revision = step.revision;
    current.kind = step.kind;
    if (step.kind === 'cancel') {
      current.venueId = null;
      current.showTime = null;
      current.doorsTime = null;
    } else {
      current.venueId = step.venueId;
      current.showTime = step.showTime;
      current.doorsTime = step.doorsTime;
    }
  }

  const pendingChanges = confirmations
    .filter((item) => !item.confirmed && item.revision > current.revision)
    .sort((a, b) => a.revision - b.revision);
  const nextPending = pendingChanges[0] ?? null;

  let status: EventState['status'];
  if (current.kind === 'cancel') status = 'cancelled';
  else if (current.venueId && current.showTime) status = 'scheduled';
  else if (nextPending) status = 'pending';
  else if (unparsed.length > 0) status = 'pending_reparse';
  else status = 'pending';

  const title =
    [...parsed].sort(byUpdatedDesc).find((row) => row.title)?.title ??
    unparsed.find((row) => row.title)?.title ??
    null;

  return {
    state: {
      eventId,
      title,
      status,
      venueId: current.venueId,
      showTime: current.showTime,
      doorsTime: current.doorsTime,
      revision: current.revision > 0 ? current.revision : null,
      lastChangeKind: current.kind,
      hasPendingChange: pendingChanges.length > 0,
      pendingRevision: nextPending?.revision ?? null,
      pendingNote: nextPending
        ? `修订 ${nextPending.revision} 改场 ${nextPending.fromVenue} → ${nextPending.toVenue} 待确认：${nextPending.note ?? ''}`
        : null,
      pendingReparseCount: unparsed.length,
      pendingReparseNote:
        unparsed.length === 0
          ? null
          : unparsed
              .slice(0, 3)
              .map(
                (row) =>
                  `${row.venueId} ${row.sourceUrl}（${row.parseError ?? '解析失败'}）`,
              )
              .join('；') +
            (unparsed.length > 3 ? ` 等 ${unparsed.length} 条` : ''),
    },
    confirmations: [...confirmations].sort((a, b) => a.revision - b.revision),
  };
}

export interface ComputedEffective {
  events: EventState[];
  confirmations: ChangeConfirmation[];
}

/** 对全部公告做一次折叠，得到服务台对外唯一使用的排期。 */
export function computeEffective(rows: AnnouncementRow[]): ComputedEffective {
  const grouped = new Map<string, AnnouncementRow[]>();
  for (const row of rows) {
    if (!row.eventId) continue;
    const group = grouped.get(row.eventId) ?? [];
    group.push(row);
    grouped.set(row.eventId, group);
  }

  const events: EventState[] = [];
  const confirmations: ChangeConfirmation[] = [];
  for (const [eventId, group] of grouped) {
    const computed = computeEvent(eventId, group);
    events.push(computed.state);
    confirmations.push(...computed.confirmations);
  }

  events.sort((a, b) => a.eventId.localeCompare(b.eventId));
  confirmations.sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || a.revision - b.revision,
  );
  return { events, confirmations };
}
