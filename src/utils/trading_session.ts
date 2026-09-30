/**
 * 交易时段与K线分桶（纯函数，无依赖）
 *
 * - 无时段：按 UTC 整点对齐分桶（币安、GC 等 24h/近 24h 品种）
 * - 有时段（如 ES 美股常规时段 09:30~16:00 America/New_York）：
 *   只保留时段内的K线，桶从当天开盘起算，最后一个桶截断到收盘（1h 的 15:30 桶只有半小时）；
 *   夏令时由时区自动处理
 */

/** 每日交易时段（交易所当地时间） */
export interface TradingSession {
  time_zone: string;     // IANA 时区，如 America/New_York
  open: string;          // 'HH:mm'
  close: string;         // 'HH:mm'
}

/** K线桶（毫秒，end 不含） */
export interface KlineBucket {
  start: number;
  end: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** 取某时区的格式化器（缓存） */
function get_formatter(time_zone: string): Intl.DateTimeFormat {
  let f = formatters.get(time_zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: time_zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    formatters.set(time_zone, f);
  }
  return f;
}

/** 'HH:mm' → 当天分钟数 */
function to_minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 某时刻所在当地日期的开盘/收盘时间（UTC 毫秒）
 * 当地日期与 UTC 偏移都取自 ts 本身（时段不跨越凌晨 2 点的夏令时切换点即可）
 */
export function session_bounds(ts: number, session: TradingSession): { open: number; close: number } {
  const parts: Record<string, number> = {};
  for (const p of get_formatter(session.time_zone).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const local_midnight_as_utc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const local_now_as_utc = local_midnight_as_utc + (parts.hour * 60 + parts.minute) * 60_000;
  const offset = local_now_as_utc - Math.floor(ts / 60_000) * 60_000;   // 当地时间 - UTC
  return {
    open: local_midnight_as_utc + to_minutes(session.open) * 60_000 - offset,
    close: local_midnight_as_utc + to_minutes(session.close) * 60_000 - offset,
  };
}

/**
 * K线（open_time = ts）所属的桶；有时段且 ts 不在时段内返回 null
 * @param interval_ms 桶周期
 */
export function kline_bucket(ts: number, interval_ms: number, session?: TradingSession | null): KlineBucket | null {
  if (!session) {
    const start = Math.floor(ts / interval_ms) * interval_ms;
    return { start, end: start + interval_ms };
  }
  const { open, close } = session_bounds(ts, session);
  if (ts < open || ts >= close) return null;
  const start = open + Math.floor((ts - open) / interval_ms) * interval_ms;
  return { start, end: Math.min(start + interval_ms, close) };
}
