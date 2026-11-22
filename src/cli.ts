#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db/store';
import { FestivalDesk } from './query/desk';
import { Collector } from './collect/collector';
import { formatConfirmation, formatEventLine, statusLabel } from './query/view';
import { VENUES, VENUE_IDS, venueName } from './venues';
import { ProgressTracker, defaultProgressPath } from './progress/tracker';
import { ProgressReader } from './progress/reader';
import { formatProgress } from './progress/view';
import type { EventState } from './core/types';

const DEFAULT_DB = resolve(process.cwd(), 'data/festival.duckdb');
const DEFAULT_SITE = 'http://127.0.0.1:8787';

function usage(): void {
  console.log(`戏剧节服务台

用法：
  node dist/cli.js mock [--port 8787] [--content 1]
      启动本地模拟公告站（前台运行，Ctrl+C 结束）

  node dist/cli.js collect [--site URL] [--db PATH] [--venue ID ...] [--progress PATH]
      采集各剧场公告并写入 DuckDB（采集态实时写入进度文件）

  node dist/cli.js query event <演出编号> [--db PATH]
  node dist/cli.js query venue <剧场代码> [--db PATH]
  node dist/cli.js query all [--db PATH]
  node dist/cli.js query pending [--db PATH]
      查询已确认排期（不联网）

  node dist/cli.js progress [--db PATH] [--progress PATH] [--json]
      独立诊断查询：最后已提交页、限流预计恢复时间、会话轮换重读、
      以及采集进程被强制结束后停在哪个提交边界（只读进度文件，不打开数据库）

  node dist/cli.js repair [--db PATH] [--site URL] [--progress PATH]
      对“待补采”公告所在剧场重新采集

  node dist/cli.js test
      80 秒内验证翻页恢复、公告补采与改场前后查询结果
`);
}

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(name, [...(flags.get(name) ?? []), next]);
        i += 1;
      } else {
        flags.set(name, [...(flags.get(name) ?? []), 'true']);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function single(args: Args, name: string): string | null {
  const values = args.flags.get(name);
  return values && values.length > 0 ? values[values.length - 1] : null;
}

function dbPath(args: Args): string {
  return resolve(single(args, 'db') ?? DEFAULT_DB);
}

function progressPathFor(args: Args): string {
  return resolve(single(args, 'progress') ?? defaultProgressPath(dbPath(args)));
}

async function withStore<T>(path: string, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = await Store.open(path);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

async function cmdCollect(args: Args): Promise<number> {
  const site = single(args, 'site') ?? DEFAULT_SITE;
  const path = dbPath(args);
  const venues = args.flags.get('venue') ?? VENUE_IDS;
  const unknown = venues.filter((id) => !VENUES[id]);
  if (unknown.length > 0) {
    console.error(`未知剧场代码：${unknown.join(', ')}（可用：${VENUE_IDS.join(', ')}）`);
    return 2;
  }

  console.log(`采集站点 ${site}`);
  console.log(`数据库   ${path}`);
  const progressFile = progressPathFor(args);
  console.log(`进度文件 ${progressFile}（可用 progress 子命令独立查询）`);
  const tracker = new ProgressTracker(progressFile, path);
  return withStore(path, async (store) => {
    const collector = new Collector({
      baseUrl: site,
      store,
      log: (message) => console.log(message),
      progress: tracker,
    });
    const result = await collector.collectAll(venues);
    console.log('');
    for (const venue of result.venues) {
      const mark = venue.ok ? '✓' : '✗';
      console.log(
        `${mark} ${venue.venueId}（${venueName(venue.venueId)}）` +
          ` 版式 ${venue.layout ?? '-'} 页数 ${venue.pages}` +
          ` 公告 ${venue.announcements} 条 待补采 ${venue.pending}` +
          ` 翻页恢复 ${venue.recoveries} 次 限流等待 ${venue.rateLimitWaits} 次` +
          (venue.error ? ` 错误：${venue.error}` : ''),
      );
    }
    const desk = new FestivalDesk(store);
    const pending = await desk.pendingReparse();
    if (pending.length > 0) {
      console.log('');
      console.log(`待补采 ${pending.length} 条：`);
      for (const row of pending) {
        console.log(`  - ${row.venueId} ${row.sourceUrl}（${row.parseError ?? '解析失败'}）`);
      }
    }
    return result.venues.every((venue) => venue.ok) ? 0 : 1;
  });
}

function printEvent(event: EventState): void {
  console.log(formatEventLine(event));
  if (event.hasPendingChange && event.pendingNote) {
    console.log(`    ${event.pendingNote}`);
  }
  if (event.status !== 'scheduled' && event.pendingReparseNote && event.pendingReparseCount > 0) {
    console.log(`    待补采：${event.pendingReparseNote}`);
  }
}

async function cmdQuery(args: Args): Promise<number> {
  const [what, value] = args.positional;
  const path = dbPath(args);
  return withStore(path, async (store) => {
    const desk = new FestivalDesk(store);

    if (what === 'event') {
      if (!value) {
        console.error('请提供演出编号');
        return 2;
      }
      const event = await desk.findEvent(value);
      if (!event) {
        console.log(`未找到演出 ${value}`);
        return 1;
      }
      console.log(`演出 ${event.eventId}  ${event.title ?? ''}`);
      console.log(`状态 ${statusLabel(event.status)}`);
      printEvent(event);
      const confs = await desk.confirmations(value);
      if (confs.length > 0) {
        console.log('改场记录：');
        for (const confirmation of confs) {
          console.log(`  ${formatConfirmation(confirmation)}`);
        }
      }
      return 0;
    }

    if (what === 'venue') {
      if (!value) {
        console.error('请提供剧场代码');
        return 2;
      }
      if (!VENUES[value]) {
        console.error(`未知剧场代码：${value}（可用：${VENUE_IDS.join(', ')}）`);
        return 2;
      }
      const events = await desk.venueSchedule(value);
      console.log(`${venueName(value)}（${value}）有效排期 ${events.length} 场`);
      for (const event of events) {
        console.log(
          `  ${event.showTime} 入场 ${event.doorsTime}  ${event.eventId} ${event.title ?? ''}`,
        );
      }
      const all = await desk.effectiveEvents();
      const related = await desk.pendingChangesForVenue(value);
      const movedAway = all.filter(
        (event) =>
          event.status === 'scheduled' &&
          event.hasPendingChange &&
          related.some((item) => item.eventId === event.eventId),
      );
      if (movedAway.length > 0) {
        console.log('改场待确认（仍展示最近一次已确认排期）：');
        for (const event of movedAway) {
          console.log(`  ${formatEventLine(event)}`);
        }
      }
      return 0;
    }

    if (what === 'pending' || what === undefined) {
      const pending = await desk.pendingReparse();
      console.log(`待补采公告 ${pending.length} 条`);
      for (const row of pending) {
        console.log(`  - ${row.venueId} ${row.sourceUrl}（${row.parseError ?? '解析失败'}）`);
      }
      return 0;
    }

    if (what === 'all') {
      const events = await desk.effectiveEvents();
      console.log(`有效排期 ${events.length} 场`);
      for (const event of events) printEvent(event);
      return 0;
    }

    console.error(`未知查询对象：${what}`);
    usage();
    return 2;
  });
}

async function cmdRepair(args: Args): Promise<number> {
  const path = dbPath(args);
  const site = single(args, 'site') ?? DEFAULT_SITE;
  const tracker = new ProgressTracker(progressPathFor(args), path);
  return withStore(path, async (store) => {
    const desk = new FestivalDesk(store);
    const pending = await desk.pendingReparse();
    if (pending.length === 0) {
      console.log('没有待补采公告');
      return 0;
    }
    const venues = [...new Set(pending.map((row) => row.venueId))];
    console.log(`待补采涉及剧场：${venues.join(', ')}；重新采集…`);
    const collector = new Collector({
      baseUrl: site,
      store,
      log: (message) => console.log(message),
      progress: tracker,
    });
    const result = await collector.collectAll(venues);
    const remaining = await desk.pendingReparse();
    console.log(
      `补采完成：${result.venues.map((venue) => `${venue.venueId} ${venue.ok ? '成功' : '失败'}`).join('，')}`,
    );
    console.log(`剩余待补采 ${remaining.length} 条`);
    return remaining.length === 0 ? 0 : 1;
  });
}

async function cmdProgress(args: Args): Promise<number> {
  const file = progressPathFor(args);
  if (!existsSync(file)) {
    console.error(`未找到采集进度文件：${file}`);
    console.error('请先运行 collect（默认与数据库同目录、同名加 .progress.json），或用 --progress 指定。');
    return 1;
  }
  const diagnosis = ProgressReader.read(file);
  if (args.flags.has('json')) {
    console.log(JSON.stringify(diagnosis, null, 2));
  } else {
    console.log(formatProgress(diagnosis));
  }
  return 0;
}

async function cmdMock(args: Args): Promise<number> {
  const { MockSite } = await import('./mock/server');
  const port = Number(single(args, 'port') ?? 8787);
  const version = Number(single(args, 'content') ?? 1);
  const site = new MockSite({ contentVersion: version });
  await site.listen(port);
  console.log(`模拟公告站已启动：${site.baseUrl}`);
  console.log('入口：');
  for (const id of VENUE_IDS) {
    console.log(`  ${site.baseUrl}/venue/${id}   ${venueName(id)}`);
  }
  console.log('控制（供演示/测试）：POST /_control/content {"version":2|3}');
  console.log('按 Ctrl+C 结束');
  const shutdown = async () => {
    await site.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<void>(() => undefined);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional.shift();
  switch (command) {
    case 'mock':
      return cmdMock(args);
    case 'collect':
      return cmdCollect(args);
    case 'query':
      return cmdQuery(args);
    case 'progress':
      return cmdProgress(args);
    case 'repair':
      return cmdRepair(args);
    case 'test': {
      const { runE2E } = await import('./test/e2e');
      return runE2E();
    }
    case undefined:
    case 'help':
    case '--help':
      usage();
      return 0;
    default:
      console.error(`未知命令：${command}`);
      usage();
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
