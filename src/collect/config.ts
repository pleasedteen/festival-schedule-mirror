import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VENUES, VENUE_IDS } from '../venues';

export interface VenueTarget {
  venueId: string;
  siteBaseUrl: string;
}

export interface ResolveOptions {
  /** 保留原单站用法：给定时所有剧场都采这个站。 */
  site?: string | null;
  /** JSON 配置文件路径，内容为 { 剧场代码: 站点 URL }。 */
  configPath?: string | null;
  /** 重复 --venue-site grand=http://... 形式的参数。 */
  venueSiteArgs?: string[];
  /** 只采集这些剧场；缺省为全部已知剧场。 */
  onlyVenues?: string[];
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  new URL(url); // 非法地址直接报错，避免把错误写进数据库
  return url.replace(/\/$/, '');
}

/** 读取 JSON 配置：{ "grand": "http://127.0.0.1:8787", ... }。 */
export function readVenueSites(configPath: string): Record<string, string> {
  const absolute = resolve(configPath);
  const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [venueId, url] of Object.entries(parsed)) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error(`配置文件 ${absolute} 中 ${venueId} 的站点地址无效`);
    }
    result[venueId] = normalizeUrl(url);
  }
  return result;
}

function parseVenueSiteArg(arg: string): { venueId: string; siteBaseUrl: string } {
  const index = arg.indexOf('=');
  if (index <= 0) {
    throw new Error(`--venue-site 参数格式应为 剧场代码=站点URL，收到：${arg}`);
  }
  const venueId = arg.slice(0, index).trim();
  const url = arg.slice(index + 1).trim();
  if (!VENUES[venueId]) {
    throw new Error(`未知剧场代码：${venueId}（可用：${VENUE_IDS.join(', ')}）`);
  }
  return { venueId, siteBaseUrl: normalizeUrl(url) };
}

/**
 * 把命令行参数解析为“剧场 → 站点”采集清单。
 * 优先级：--venue-site 覆盖配置文件；未单独配置的剧场在给了 --site 时走该站。
 */
export function resolveVenueTargets(options: ResolveOptions): VenueTarget[] {
  const selected = options.onlyVenues && options.onlyVenues.length > 0
    ? options.onlyVenues
    : VENUE_IDS;
  const unknown = selected.filter((id) => !VENUES[id]);
  if (unknown.length > 0) {
    throw new Error(`未知剧场代码：${unknown.join(', ')}（可用：${VENUE_IDS.join(', ')}）`);
  }

  const configured: Record<string, string> = {};
  if (options.configPath) {
    Object.assign(configured, readVenueSites(options.configPath));
  }
  for (const arg of options.venueSiteArgs ?? []) {
    const { venueId, siteBaseUrl } = parseVenueSiteArg(arg);
    configured[venueId] = siteBaseUrl;
  }

  const fallbackSite = options.site ? normalizeUrl(options.site) : null;
  const targets: VenueTarget[] = [];
  const missing: string[] = [];
  for (const venueId of selected) {
    const siteBaseUrl = configured[venueId] ?? fallbackSite;
    if (!siteBaseUrl) {
      missing.push(venueId);
      continue;
    }
    targets.push({ venueId, siteBaseUrl });
  }
  if (missing.length > 0) {
    throw new Error(
      `剧场 ${missing.join(', ')} 没有配置站点：请用 --site、--config 或 --venue-site 指定`,
    );
  }
  return targets;
}
