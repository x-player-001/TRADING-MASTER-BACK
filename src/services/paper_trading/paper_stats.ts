/**
 * 交易统计（纯函数）：胜率、盈亏、R、最大回撤、资金曲线
 * 模拟盘与实盘共用：只依赖 StatTrade 中的字段
 */

/** 统计所需的交易字段（模拟盘 / 实盘交易均满足） */
export interface StatTrade {
  id?: number;
  symbol: string;
  status: string;
  pnl: number | null;
  r_multiple: number | null;
  fees: number | null;
  exit_time: number | null;
  exit_reason: string | null;
}

export interface PaperStats {
  closed: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  total_pnl: number;
  total_fees: number;
  total_r: number;
  avg_r: number | null;
  profit_factor: number | null;
  max_drawdown: number;          // 已实现资金曲线最大回撤（U）
  best_r: number | null;
  worst_r: number | null;
  by_exit_reason: Record<string, number>;
}

export interface EquityPoint {
  time: number;          // 平仓时间
  trade_id: number | undefined;
  symbol: string;
  pnl: number;
  equity: number;        // 累计已实现盈亏
  drawdown: number;      // 距前高回撤（≥0）
}

/** 资金曲线（按平仓时间排序的已平仓交易） */
export function equity_curve(closed: StatTrade[]): EquityPoint[] {
  const sorted = [...closed].filter(t => t.status === 'closed').sort((a, b) => (a.exit_time ?? 0) - (b.exit_time ?? 0));
  let equity = 0, peak = 0;
  return sorted.map(t => {
    equity += t.pnl ?? 0;
    peak = Math.max(peak, equity);
    return { time: t.exit_time ?? 0, trade_id: t.id, symbol: t.symbol, pnl: t.pnl ?? 0, equity, drawdown: peak - equity };
  });
}

/** 汇总统计 */
export function compute_stats(trades: StatTrade[]): PaperStats {
  const closed = trades.filter(t => t.status === 'closed');
  const pnls = closed.map(t => t.pnl ?? 0);
  const rs = closed.map(t => t.r_multiple ?? 0);
  const gain = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const loss = -pnls.filter(p => p < 0).reduce((a, b) => a + b, 0);
  const curve = equity_curve(closed);
  const by_exit_reason: Record<string, number> = {};
  for (const t of closed) by_exit_reason[t.exit_reason ?? 'unknown'] = (by_exit_reason[t.exit_reason ?? 'unknown'] ?? 0) + 1;
  const total_r = rs.reduce((a, b) => a + b, 0);

  return {
    closed: closed.length,
    wins: pnls.filter(p => p > 0).length,
    losses: pnls.filter(p => p <= 0).length,
    win_rate: closed.length ? pnls.filter(p => p > 0).length / closed.length : null,
    total_pnl: pnls.reduce((a, b) => a + b, 0),
    total_fees: closed.reduce((a, t) => a + (t.fees ?? 0), 0),
    total_r,
    avg_r: closed.length ? total_r / closed.length : null,
    profit_factor: loss > 0 ? gain / loss : null,
    max_drawdown: curve.reduce((m, p) => Math.max(m, p.drawdown), 0),
    best_r: rs.length ? Math.max(...rs) : null,
    worst_r: rs.length ? Math.min(...rs) : null,
    by_exit_reason,
  };
}

export interface DailyStat {
  date: string;          // 北京时间日期 YYYY-MM-DD（按平仓时间）
  trades: number;
  wins: number;
  pnl: number;
  r: number;
  equity: number;        // 截至当日累计已实现盈亏
}

/** 按北京时间日期汇总已平仓交易 */
export function daily_stats(closed: StatTrade[]): DailyStat[] {
  const by = new Map<string, DailyStat>();
  for (const t of closed) {
    if (t.status !== 'closed' || t.exit_time === null) continue;
    const date = new Date(t.exit_time + 8 * 3600_000).toISOString().slice(0, 10);
    const d = by.get(date) ?? { date, trades: 0, wins: 0, pnl: 0, r: 0, equity: 0 };
    d.trades++;
    if ((t.pnl ?? 0) > 0) d.wins++;
    d.pnl += t.pnl ?? 0;
    d.r += t.r_multiple ?? 0;
    by.set(date, d);
  }
  let equity = 0;
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ ...d, equity: (equity += d.pnl) }));
}
