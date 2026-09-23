/**
 * 回放模拟交易统计（纯函数）
 *
 * 输入已平仓回合，输出胜率、期望、R 分布、回撤、连亏等训练指标，
 * 并按方向 / 标签 / 出场原因拆分。胜负以净盈亏（扣手续费）判定。
 */

import { ReplayPosition } from './replay_types';

/** 一组交易的汇总指标 */
export interface ReplayTradeStats {
  trade_count: number;
  win_count: number;
  loss_count: number;
  win_rate: number | null;              // 0~1
  total_net_pnl: number;
  total_fee: number;
  avg_win: number | null;               // 平均盈利（USDT）
  avg_loss: number | null;              // 平均亏损（USDT，负数）
  payoff_ratio: number | null;          // 盈亏比 = avg_win / |avg_loss|
  profit_factor: number | null;         // 总盈利 / 总亏损
  expectancy: number | null;            // 每笔期望（USDT）
  // R 口径（仅统计设置过止损的交易）
  r_trade_count: number;
  total_r: number;
  avg_r: number | null;                 // 期望 R
  avg_win_r: number | null;
  avg_loss_r: number | null;
  // 连续性与回撤（按平仓时间顺序）
  max_consecutive_wins: number;
  max_consecutive_losses: number;
  max_drawdown: number;                 // 累计净盈亏曲线最大回撤（USDT，正数）
  max_drawdown_pct: number | null;      // 相对（初始资金 + 峰值累计盈亏）的回撤%
  max_drawdown_r: number;               // 累计 R 曲线最大回撤
  // 过程指标
  avg_bars_held: number | null;
  avg_mfe_pct: number | null;
  avg_mae_pct: number | null;
}

/** 完整统计结果 */
export interface ReplayStatsReport {
  overall: ReplayTradeStats;
  by_direction: Record<string, ReplayTradeStats>;
  by_tag: Record<string, ReplayTradeStats>;
  by_exit_reason: Record<string, ReplayTradeStats>;
  /** 累计净盈亏 / 累计 R 曲线（按平仓顺序） */
  equity_curve: Array<{ position_id: number | undefined; close_bar_time: number; cum_net_pnl: number; cum_r: number }>;
}

/** 平均值（空数组返回 null） */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** 按平仓时间排序（同时间按 id） */
function sort_by_close(positions: ReplayPosition[]): ReplayPosition[] {
  return [...positions].sort((a, b) =>
    (a.close_bar_time ?? 0) - (b.close_bar_time ?? 0) || (a.id ?? 0) - (b.id ?? 0),
  );
}

/** 曲线最大回撤，返回 [回撤值, 回撤发生时的峰值] */
function max_drawdown_of(curve: number[]): [number, number] {
  let peak = 0;
  let max_dd = 0;
  let peak_at_max = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak - v > max_dd) {
      max_dd = peak - v;
      peak_at_max = peak;
    }
  }
  return [max_dd, peak_at_max];
}

/**
 * 计算一组已平仓回合的指标
 * @param positions       已平仓回合
 * @param initial_balance 初始资金（用于回撤百分比，可不传）
 */
export function calc_trade_stats(positions: ReplayPosition[], initial_balance?: number): ReplayTradeStats {
  const trades = sort_by_close(positions.filter(p => p.status === 'closed'));
  const pnls = trades.map(p => p.net_pnl);
  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v < 0);
  const gross_win = wins.reduce((s, v) => s + v, 0);
  const gross_loss = losses.reduce((s, v) => s + v, 0);

  const r_values = trades.filter(p => p.r_multiple !== null).map(p => p.r_multiple as number);

  // 连胜/连亏
  let max_wins = 0, max_losses = 0, cur_wins = 0, cur_losses = 0;
  for (const v of pnls) {
    if (v > 0) { cur_wins++; cur_losses = 0; }
    else if (v < 0) { cur_losses++; cur_wins = 0; }
    else { cur_wins = 0; cur_losses = 0; }
    max_wins = Math.max(max_wins, cur_wins);
    max_losses = Math.max(max_losses, cur_losses);
  }

  // 回撤
  let cum = 0;
  const pnl_curve = pnls.map(v => (cum += v));
  cum = 0;
  const r_curve = r_values.map(v => (cum += v));
  const [max_dd, peak_at_max] = max_drawdown_of(pnl_curve);
  const [max_dd_r] = max_drawdown_of(r_curve);
  const dd_base = initial_balance !== undefined ? initial_balance + peak_at_max : null;

  const avg_win = mean(wins);
  const avg_loss = mean(losses);

  return {
    trade_count: trades.length,
    win_count: wins.length,
    loss_count: losses.length,
    win_rate: trades.length > 0 ? wins.length / trades.length : null,
    total_net_pnl: pnls.reduce((s, v) => s + v, 0),
    total_fee: trades.reduce((s, p) => s + p.fee_total, 0),
    avg_win,
    avg_loss,
    payoff_ratio: avg_win !== null && avg_loss !== null && avg_loss !== 0 ? avg_win / Math.abs(avg_loss) : null,
    profit_factor: gross_loss !== 0 ? gross_win / Math.abs(gross_loss) : null,
    expectancy: mean(pnls),
    r_trade_count: r_values.length,
    total_r: r_values.reduce((s, v) => s + v, 0),
    avg_r: mean(r_values),
    avg_win_r: mean(r_values.filter(v => v > 0)),
    avg_loss_r: mean(r_values.filter(v => v < 0)),
    max_consecutive_wins: max_wins,
    max_consecutive_losses: max_losses,
    max_drawdown: max_dd,
    max_drawdown_pct: dd_base && dd_base > 0 ? max_dd / dd_base * 100 : null,
    max_drawdown_r: max_dd_r,
    avg_bars_held: mean(trades.filter(p => p.bars_held !== null).map(p => p.bars_held as number)),
    avg_mfe_pct: mean(trades.map(p => p.mfe_pct)),
    avg_mae_pct: mean(trades.map(p => p.mae_pct)),
  };
}

/** 按 key 分组统计 */
function group_stats(
  positions: ReplayPosition[],
  key_of: (p: ReplayPosition) => string[],
): Record<string, ReplayTradeStats> {
  const groups: Record<string, ReplayPosition[]> = {};
  for (const p of positions) {
    for (const key of key_of(p)) {
      (groups[key] ||= []).push(p);
    }
  }
  const result: Record<string, ReplayTradeStats> = {};
  for (const [key, list] of Object.entries(groups)) {
    result[key] = calc_trade_stats(list);
  }
  return result;
}

/**
 * 生成完整统计报告
 * @param positions       回合列表（未平仓的会被忽略）
 * @param initial_balance 初始资金（单会话统计时传入）
 */
export function build_stats_report(positions: ReplayPosition[], initial_balance?: number): ReplayStatsReport {
  const closed = sort_by_close(positions.filter(p => p.status === 'closed'));

  let cum_pnl = 0;
  let cum_r = 0;
  const equity_curve = closed.map(p => {
    cum_pnl += p.net_pnl;
    cum_r += p.r_multiple ?? 0;
    return { position_id: p.id, close_bar_time: p.close_bar_time as number, cum_net_pnl: cum_pnl, cum_r };
  });

  return {
    overall: calc_trade_stats(closed, initial_balance),
    by_direction: group_stats(closed, p => [p.direction]),
    by_tag: group_stats(closed, p => (p.tags.length > 0 ? p.tags : ['(无标签)'])),
    by_exit_reason: group_stats(closed, p => [p.exit_reason ?? 'unknown']),
    equity_curve,
  };
}
