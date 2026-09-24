/**
 * K线回放数据加载
 *
 * - 5m：按日分表 kline_5m_YYYYMMDD（回放步进的唯一数据源）
 * - 15m/1h/4h：已收盘K线读聚合表（kline_15m_agg_* / kline_1h_agg / kline_4h_agg），
 *   游标所在的未收盘K线由 5m 实时聚合，保证看不到未来数据。
 *   聚合表缺失的桶用 5m 补齐。
 */

import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import {
  ReplayBar,
  ReplayIntervalBar,
  REPLAY_BASE_INTERVAL_MS,
  REPLAY_INTERVALS,
} from './replay_types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** 前向加载每次拉取的时间跨度 */
const FORWARD_CHUNK_MS = 2 * ONE_DAY_MS;
/** 用 5m 补齐聚合表缺失桶时最多回溯的跨度（避免跨几十张日表） */
const MAX_BACKFILL_SPAN_MS = 20 * ONE_DAY_MS;

/** 5m 行转回放K线 */
function to_bar(k: Kline5mData | ReplayBar): ReplayBar {
  return {
    open_time: k.open_time,
    close_time: k.close_time,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
  };
}

/** 桶起点 */
export function bucket_start(time: number, interval_ms: number): number {
  return Math.floor(time / interval_ms) * interval_ms;
}

/**
 * 把 5m K线聚合成大周期
 * @param bars        已按时间升序的 5m K线
 * @param interval_ms 目标周期毫秒数
 * @param cursor_time 当前游标（最后一根已揭示 5m 的 open_time），用于判断最后一个桶是否收盘
 */
export function aggregate_bars(bars: ReplayBar[], interval_ms: number, cursor_time: number): ReplayIntervalBar[] {
  const result: ReplayIntervalBar[] = [];
  let current: ReplayIntervalBar | null = null;
  for (const b of bars) {
    const start = bucket_start(b.open_time, interval_ms);
    if (!current || current.open_time !== start) {
      current = {
        open_time: start,
        close_time: start + interval_ms - 1,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        is_closed: true,
      };
      result.push(current);
    } else {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += b.volume;
    }
  }
  const last = result[result.length - 1];
  if (last) {
    last.is_closed = cursor_time + REPLAY_BASE_INTERVAL_MS >= last.open_time + interval_ms;
  }
  return result;
}

export class ReplayKlineLoader {
  private readonly kline_5m_repo: Kline5mRepository;
  private readonly aggregator: KlineAggregator;

  constructor() {
    // 只读使用，关闭写入定时器
    this.kline_5m_repo = new Kline5mRepository();
    this.kline_5m_repo.stop_flush_timer();
    this.aggregator = new KlineAggregator();
    this.aggregator.stop_flush_timer();
  }

  /** 读取 5m 区间（含两端） */
  async load_5m(symbol: string, start_time: number, end_time: number): Promise<ReplayBar[]> {
    const rows = await this.kline_5m_repo.get_klines_by_time_range(symbol, start_time, end_time);
    return rows.map(to_bar);
  }

  /**
   * 取某时刻所在或之前最近的一根 5m（1 天内）
   */
  async get_bar_at_or_before(symbol: string, time: number): Promise<ReplayBar | null> {
    const bars = await this.load_5m(symbol, time - ONE_DAY_MS, time);
    return bars.length > 0 ? bars[bars.length - 1] : null;
  }

  /**
   * 前向加载 after_time 之后的 5m K线（遇到数据空洞自动跳到下一段有数据的位置）
   * @returns 空数组表示已到数据末尾
   */
  async load_forward(symbol: string, after_time: number): Promise<ReplayBar[]> {
    const bars = await this.load_5m(symbol, after_time + 1, after_time + FORWARD_CHUNK_MS);
    if (bars.length > 0) return bars;

    const next_time = await this.kline_5m_repo.find_next_open_time(symbol, after_time);
    if (next_time === null) return [];
    return this.load_5m(symbol, next_time, next_time + FORWARD_CHUNK_MS);
  }

  /**
   * after_time 之后最多 limit 根 5m（跨越数据空洞）
   * @returns end_of_data=true 表示后面已经没有数据
   */
  async load_bars_after(symbol: string, after_time: number, limit: number): Promise<{ bars: ReplayBar[]; end_of_data: boolean }> {
    const bars: ReplayBar[] = [];
    let after = after_time;
    while (bars.length < limit) {
      const chunk = await this.load_forward(symbol, after);
      if (chunk.length === 0) return { bars, end_of_data: true };
      bars.push(...chunk);
      after = chunk[chunk.length - 1].open_time;
    }
    return { bars: bars.slice(0, limit), end_of_data: false };
  }

  /** 所有 5m 日表日期（YYYYMMDD） */
  async list_5m_dates(): Promise<string[]> {
    return this.kline_5m_repo.list_table_dates();
  }

  /**
   * 游标视角下某周期的K线（截止到游标，最后一根可能未收盘）
   * @param cursor_time 游标 5m K线 open_time
   * @param limit       返回根数
   */
  async get_interval_bars(symbol: string, interval: string, cursor_time: number, limit: number): Promise<ReplayIntervalBar[]> {
    const interval_ms = REPLAY_INTERVALS[interval];
    if (!interval_ms) throw new Error(`不支持的周期: ${interval}`);

    if (interval_ms === REPLAY_BASE_INTERVAL_MS) {
      const bars = await this.load_5m(symbol, cursor_time - (limit - 1) * interval_ms, cursor_time);
      return bars.slice(-limit).map(b => ({ ...b, is_closed: true }));
    }

    // 1) 游标所在桶：由 5m 聚合（可能未收盘）
    const current_start = bucket_start(cursor_time, interval_ms);
    const current_5m = await this.load_5m(symbol, current_start, cursor_time);
    const current_bar = aggregate_bars(current_5m, interval_ms, cursor_time);

    // 2) 之前已收盘的桶：读聚合表
    const history_start = current_start - (limit - 1) * interval_ms;
    const history_end = current_start - 1;
    const agg_rows = limit > 1
      ? await this.aggregator.get_klines_from_db(symbol, interval, history_start, history_end)
      : [];
    const history = new Map<number, ReplayIntervalBar>();
    for (const r of agg_rows) {
      history.set(r.open_time, { ...to_bar(r), close_time: r.open_time + interval_ms - 1, is_closed: true });
    }

    // 3) 聚合表缺失的桶用 5m 补（只补最近一段，数据空洞期 5m 也没有，补不到就留空）
    await this.backfill_missing_buckets(symbol, interval_ms, history_start, current_start, history);

    const merged = [...history.values()].sort((a, b) => a.open_time - b.open_time);
    return [...merged, ...current_bar].slice(-limit);
  }

  /** 用 5m 聚合补齐聚合表里缺失的已收盘桶 */
  private async backfill_missing_buckets(
    symbol: string,
    interval_ms: number,
    history_start: number,
    current_start: number,
    history: Map<number, ReplayIntervalBar>,
  ): Promise<void> {
    let first_missing: number | null = null;
    const floor = Math.max(history_start, current_start - MAX_BACKFILL_SPAN_MS);
    for (let t = bucket_start(floor, interval_ms); t < current_start; t += interval_ms) {
      if (t >= history_start && !history.has(t)) {
        first_missing = t;
        break;
      }
    }
    if (first_missing === null) return;

    const bars_5m = await this.load_5m(symbol, first_missing, current_start - 1);
    for (const bar of aggregate_bars(bars_5m, interval_ms, current_start - REPLAY_BASE_INTERVAL_MS)) {
      if (!history.has(bar.open_time)) history.set(bar.open_time, { ...bar, is_closed: true });
    }
  }
}
