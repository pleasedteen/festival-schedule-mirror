/** 剧场代码与显示名称。模拟公告站、解析器和查询层共用同一份映射。 */
export const VENUES: Record<string, string> = {
  grand: '大剧院',
  studio: '实验剧场',
  harbor: '海港剧场',
  ring: '环形剧场',
};

export const VENUE_IDS = Object.keys(VENUES);

export function venueName(id: string | null | undefined): string {
  if (!id) return '—';
  return VENUES[id] ?? id;
}
