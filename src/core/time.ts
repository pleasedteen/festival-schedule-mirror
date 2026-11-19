/**
 * 公告中的时间统一规范为 `YYYY-MM-DD HH:MM`，方便排序、比较与展示。
 * 只接受带日期的明确时刻；缺日期、占位文字等一律视为不可靠解析。
 */
export function normalizeDateTime(input: string | null | undefined): string {
  if (!input) throw new Error('缺少时间');
  const text = input.trim();
  if (!text) throw new Error('时间为空');
  const match = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s])(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!match) throw new Error(`时间格式无效：${text}`);
  const [, y, mo, d, h, mi] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12) throw new Error(`月份越界：${text}`);
  if (hour > 23 || minute > 59) throw new Error(`时刻越界：${text}`);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) throw new Error(`日期越界：${text}`);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function assertDoorsBeforeShow(doors: string, show: string): void {
  if (doors >= show) {
    throw new Error(`入场时间 ${doors} 不早于演出时间 ${show}`);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 解析 Retry-After，支持秒数与 HTTP-date 两种形式，返回毫秒。 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
