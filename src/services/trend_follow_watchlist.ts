/**
 * 趋势跟随观察列表（按币种合并）
 *
 * 把 trend_follow_watch_contexts 中同一币种多个周期的活跃观察区合并为一行，
 * 计算列表上直接可见的关键数字（涨幅 / 当前回撤 / 缩量 / 距高点根数 / 成交额 / 阶段），
 * 并给出排序分：回撤到位、缩量、多周期共振靠前；回撤过深、临近超时靠后。
 *
 * 纯函数，无 I/O（数据由路由从仓库读取后传入）。
 */

import { TrendFollowWatchContextRecord } from '@/database/trend_follow_repository';
import { MAX_PULLBACK_BARS_BY_TF, VOLUME_SHRINK_RATIO, Timeframe } from '@/services/trend_follow_service';

/** 默认纳入合并列表的周期（5m 单独看，不合并） */
export const WATCHLIST_DEFAULT_TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h'];

const TF_RANK: Record<string, number> = { '5m': 0, '15m': 1, '1h': 2, '4h': 3 };

/**
 * 回调阶段（按当前价回撤比例）
 *   RISING   < 23.6%（还在高位 / 仍在拉升）
 *   PULLBACK 23.6% ~ 38.2%
 *   IN_ZONE  38.2% ~ 61.8%（回撤到位）
 *   DEEP     > 61.8%
 */
export type WatchStage = 'RISING' | 'PULLBACK' | 'IN_ZONE' | 'DEEP';

/** 单周期明细 */
export interface WatchlistTimeframeItem {
  id: number;
  timeframe: string;
  state: string;
  last_alert_level: number | null;
  wave_start_price: number;
  wave_end_price: number;
  wave_amplitude_pct: number;
  wave_bar_count: number;
  wave_end_time: number;
  pullback_lowest_price: number;
  pullback_bar_count: number;       // 距第一波高点的根数
  max_pullback_bars: number;        // 该周期回调根数上限（超过即废弃）
  retrace_now: number;              // 按当前价的回撤比例
  retrace_max: number;              // 按回调最低影线的最大回撤比例
  volume_ratio: number | null;      // 回调均量 / 第一波均量（回调不足 2 根为 null）
  volume_shrink: boolean;
  stage: WatchStage;
  stale: boolean;                   // 回调根数已达上限的 70%，临近超时
  watch_start_time: number;
  remark: string | null;
}

/** 合并后的单币种行 */
export interface WatchlistItem {
  symbol: string;
  current_price: number;
  quote_volume_24h: number | null;
  timeframes: string[];             // 大周期在前
  tf_count: number;
  primary_timeframe: string;        // 最大周期，行上的关键数字取自它
  wave_amplitude_pct: number;
  retrace_now: number;
  retrace_max: number;
  pullback_bar_count: number;
  volume_shrink: boolean;
  stage: WatchStage;
  stale: boolean;
  max_alert_level: number | null;   // 各周期中最高的报警等级
  score: number;
  score_tags: string[];
  details: WatchlistTimeframeItem[];
  updated_at: Date | null;
}

/** 当前价回撤比例 → 阶段 */
function stage_of(retrace: number): WatchStage {
  if (retrace > 0.618) return 'DEEP';
  if (retrace >= 0.382) return 'IN_ZONE';
  if (retrace >= 0.236) return 'PULLBACK';
  return 'RISING';
}

/** 单条观察区记录 → 周期明细（按币种统一现价计算回撤） */
function to_timeframe_item(r: TrendFollowWatchContextRecord, current_price: number): WatchlistTimeframeItem {
  const amp = r.wave_end_price - r.wave_start_price;
  const retrace_now = amp > 0 ? (r.wave_end_price - current_price) / amp : 0;
  const retrace_max = amp > 0 ? (r.wave_end_price - r.pullback_lowest_price) / amp : 0;
  const volume_ratio = r.pullback_bar_count >= 2 && r.wave_avg_volume > 0
    ? r.pullback_avg_volume / r.wave_avg_volume : null;
  const max_pullback_bars = MAX_PULLBACK_BARS_BY_TF[r.timeframe as Timeframe] ?? 60;
  return {
    id: r.id!,
    timeframe: r.timeframe,
    state: r.state,
    last_alert_level: r.last_alert_level ?? null,
    wave_start_price: r.wave_start_price,
    wave_end_price: r.wave_end_price,
    wave_amplitude_pct: r.wave_amplitude_pct,
    wave_bar_count: r.wave_bar_count,
    wave_end_time: r.wave_end_time,
    pullback_lowest_price: r.pullback_lowest_price,
    pullback_bar_count: r.pullback_bar_count,
    max_pullback_bars,
    retrace_now,
    retrace_max,
    volume_ratio,
    volume_shrink: volume_ratio !== null && volume_ratio < VOLUME_SHRINK_RATIO,
    stage: stage_of(retrace_now),
    stale: r.pullback_bar_count >= max_pullback_bars * 0.7,
    watch_start_time: r.watch_start_time,
    remark: r.remark ?? null,
  };
}

/**
 * 排序分（取最大周期的状态 + 多周期共振）：
 *   +3 回撤到位(38.2~61.8%)   +1 回调中(23.6~38.2%)   +2 缩量
 *   +1/+2 多周期共振(2 个 / 3 个及以上周期)
 *   -2 回撤过深(>61.8%)       -1 临近超时
 */
function score_of(primary: WatchlistTimeframeItem, tf_count: number): { score: number; tags: string[] } {
  let score = 0;
  const tags: string[] = [];
  if (primary.stage === 'IN_ZONE') { score += 3; tags.push('回撤到位'); }
  if (primary.stage === 'PULLBACK') { score += 1; tags.push('回调中'); }
  if (primary.volume_shrink) { score += 2; tags.push('缩量'); }
  if (tf_count >= 2) { score += Math.min(tf_count - 1, 2); tags.push(`多周期×${tf_count}`); }
  if (primary.stage === 'DEEP') { score -= 2; tags.push('回撤过深'); }
  if (primary.stale) { score -= 1; tags.push('临近超时'); }
  return { score, tags };
}

/**
 * 构建合并观察列表
 * @param records    活跃观察区记录（WATCHING / ALERTED，未删除）
 * @param timeframes 纳入合并的周期，默认 15m / 1h / 4h
 */
export function build_watchlist(
  records: TrendFollowWatchContextRecord[],
  timeframes: string[] = WATCHLIST_DEFAULT_TIMEFRAMES,
): WatchlistItem[] {
  const by_symbol = new Map<string, TrendFollowWatchContextRecord[]>();
  for (const r of records) {
    if (!timeframes.includes(r.timeframe) || r.id === undefined) continue;
    if (r.state !== 'WATCHING' && r.state !== 'ALERTED') continue;
    let list = by_symbol.get(r.symbol);
    if (!list) by_symbol.set(r.symbol, list = []);
    list.push(r);
  }

  const items: WatchlistItem[] = [];
  for (const [symbol, rows] of by_symbol) {
    // 现价 / 成交额取最近更新的一条（监控每 5 分钟用最新 5m 收盘价刷新）
    const latest = rows.reduce((a, b) =>
      (b.updated_at?.getTime() ?? 0) > (a.updated_at?.getTime() ?? 0) ? b : a);
    const current_price = latest.current_price;

    const details = rows
      .map(r => to_timeframe_item(r, current_price))
      .sort((a, b) => (TF_RANK[b.timeframe] ?? 0) - (TF_RANK[a.timeframe] ?? 0));
    const primary = details[0];
    const { score, tags } = score_of(primary, details.length);
    const levels = details.map(d => d.last_alert_level).filter((x): x is number => x !== null);

    items.push({
      symbol,
      current_price,
      quote_volume_24h: latest.quote_volume_24h ?? rows.map(r => r.quote_volume_24h).find(v => v != null) ?? null,
      timeframes: details.map(d => d.timeframe),
      tf_count: details.length,
      primary_timeframe: primary.timeframe,
      wave_amplitude_pct: primary.wave_amplitude_pct,
      retrace_now: primary.retrace_now,
      retrace_max: primary.retrace_max,
      pullback_bar_count: primary.pullback_bar_count,
      volume_shrink: primary.volume_shrink,
      stage: primary.stage,
      stale: primary.stale,
      max_alert_level: levels.length ? Math.max(...levels) : null,
      score,
      score_tags: tags,
      details,
      updated_at: latest.updated_at ?? null,
    });
  }

  return items.sort((a, b) =>
    b.score - a.score || (b.quote_volume_24h ?? 0) - (a.quote_volume_24h ?? 0));
}
