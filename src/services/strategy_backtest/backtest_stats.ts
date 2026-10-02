/**
 * 回测交易统计（纯计算，各策略通用）
 */

/** 统计所需的交易字段 */
export interface StatTrade {
  symbol: string;
  exit_time: number;
  exit_reason: string | null;
  pnl: number;
  r_multiple: number | null;
}

export interface BacktestSummary {
  trades: number;
  wins: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number | null;      // 总盈利 / 总亏损（无亏损为 null）
  t_stat: number | null;             // 每笔盈亏均值的 t 值
  avg_r: number | null;              // 有硬止损时的平均 R
  max_drawdown: number;              // 按平仓时间累计盈亏的最大回撤（USDT）
  max_consecutive_losses: number;
  symbols: number;
}

export interface GroupStat {
  key: string;
  trades: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** 汇总统计（trades 不要求有序） */
export function compute_summary(trades: StatTrade[]): BacktestSummary {
  const n = trades.length;
  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p <= 0);
  const total = pnls.reduce((a, b) => a + b, 0);
  const mean = n ? total / n : 0;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / (n - 1)) : 0;
  const rs = trades.map(t => t.r_multiple).filter((r): r is number => r !== null && Number.isFinite(r));
  const loss_sum = -losses.reduce((a, b) => a + b, 0);

  let cum = 0, peak = 0, dd = 0, run = 0, max_run = 0;
  for (const t of [...trades].sort((a, b) => a.exit_time - b.exit_time)) {
    cum += t.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
    run = t.pnl <= 0 ? run + 1 : 0; max_run = Math.max(max_run, run);
  }
  return {
    trades: n,
    wins: wins.length,
    win_rate: n ? round(wins.length / n) : 0,
    total_pnl: round(total),
    avg_pnl: round(mean),
    avg_win: wins.length ? round(wins.reduce((a, b) => a + b, 0) / wins.length) : 0,
    avg_loss: losses.length ? round(-loss_sum / losses.length) : 0,
    profit_factor: loss_sum > 0 ? round(wins.reduce((a, b) => a + b, 0) / loss_sum) : null,
    t_stat: sd > 0 ? round(mean / sd * Math.sqrt(n), 2) : null,
    avg_r: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    max_drawdown: round(dd),
    max_consecutive_losses: max_run,
    symbols: new Set(trades.map(t => t.symbol)).size,
  };
}

/** 按 key 分组统计（按 key 升序） */
export function group_stats(trades: StatTrade[], key_of: (t: StatTrade) => string): GroupStat[] {
  const groups = new Map<string, StatTrade[]>();
  for (const t of trades) {
    const k = key_of(t);
    const g = groups.get(k);
    if (g) g.push(t); else groups.set(k, [t]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, g]) => {
    const total = g.reduce((a, t) => a + t.pnl, 0);
    return { key, trades: g.length, win_rate: round(g.filter(t => t.pnl > 0).length / g.length), total_pnl: round(total), avg_pnl: round(total / g.length) };
  });
}

/** 北京时间月份 YYYY-MM */
export function beijing_month(ts: number): string {
  return new Date(ts + 8 * 3_600_000).toISOString().slice(0, 7);
}

/** 完整统计：汇总 + 按月 + 按出场原因 */
export function compute_full_stats(trades: StatTrade[]) {
  return {
    summary: compute_summary(trades),
    by_month: group_stats(trades, t => beijing_month(t.exit_time)),
    by_exit_reason: group_stats(trades, t => t.exit_reason ?? 'unknown'),
  };
}
