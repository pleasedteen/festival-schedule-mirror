import { VENUES } from '../venues';

export function venueIdByName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  if (VENUES[candidate]) return candidate;
  for (const [id, name] of Object.entries(VENUES)) {
    if (candidate === name) return id;
  }
  return null;
}

/**
 * 从“由 A 迁至 B / A 改为 B / 从 A 移到 B”这类文本里解析两端，
 * 避免简单取首次出现剧场而把新剧场误当成原剧场。
 */
export function venuesFromMoveText(
  text: string | null,
): { from: string | null; to: string | null } {
  if (!text) return { from: null, to: null };
  const pattern =
    /(?:由|从)?\s*([^，。；;、\s]+?)\s*(?:迁至|迁往|移至|移到|改为|变更为|→|->)\s*([^，。；;、\s]+)/;
  const match = text.match(pattern);
  if (match) {
    return {
      from: venueIdByName(match[1]),
      to: venueIdByName(match[2]),
    };
  }
  return { from: null, to: null };
}
