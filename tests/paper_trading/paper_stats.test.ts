/**
 * 模拟盘统计单测
 */

import { compute_stats, equity_curve } from '@/services/paper_trading/paper_stats';
import { PaperTrade } from '@/services/paper_trading/paper_types';

function closed(id: number, exit_time: number, pnl: number, reason: 'stop' | 'take_profit' | 'time'): PaperTrade {
  return {
    id, strategy_id: 's', symbol: 'X', timeframe: '15m', side: 'short', status: 'closed',
    trigger_time: 0, setup_time: 0, signal_time: 0, entry_trigger: 1, base_stop: 1.1, stop_price: 1.1, take_profit: 0.8,
    expire_at: 0, max_hold_until: 0, fill_time: 0, fill_price: 1, qty: 100, notional: 100, risk_usdt: 10,
    exit_time, exit_price: 1, exit_reason: reason, gross_pnl: pnl, fees: 0.1, pnl, r_multiple: pnl / 10,
    mfe_r: 0, mae_r: 0, cancel_reason: null, last_bar_time: 0,
    features: { dif_ratio: 0, hist_ratio: 0, gap: 0, gdep: 0, imp_pct: 0, leg_pct: 0, qv24_m: 0, atr_pct: 0, range48: 0, wait: 0, wick: 0, body: 0 },
  };
}

describe('paper_stats', () => {
  const trades = [closed(1, 3, 20, 'take_profit'), closed(2, 1, -10, 'stop'), closed(3, 2, -10, 'stop'), closed(4, 4, 5, 'time')];

  it('资金曲线按平仓时间排序并计算回撤', () => {
    const c = equity_curve(trades);
    expect(c.map(p => p.trade_id)).toEqual([2, 3, 1, 4]);
    expect(c.map(p => p.equity)).toEqual([-10, -20, 0, 5]);
    expect(c.map(p => p.drawdown)).toEqual([10, 20, 0, 0]);
  });

  it('汇总统计', () => {
    const s = compute_stats(trades);
    expect(s.closed).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.win_rate).toBe(0.5);
    expect(s.total_pnl).toBe(5);
    expect(s.total_r).toBeCloseTo(0.5, 10);
    expect(s.avg_r).toBeCloseTo(0.125, 10);
    expect(s.profit_factor).toBeCloseTo(25 / 20, 10);
    expect(s.max_drawdown).toBe(20);
    expect(s.by_exit_reason).toEqual({ take_profit: 1, stop: 2, time: 1 });
  });

  it('无交易时返回空统计', () => {
    const s = compute_stats([]);
    expect(s.closed).toBe(0);
    expect(s.win_rate).toBeNull();
    expect(s.max_drawdown).toBe(0);
  });
});
