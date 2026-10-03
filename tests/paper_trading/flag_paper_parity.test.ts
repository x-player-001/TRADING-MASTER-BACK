/**
 * 第三推策略：模拟盘逐根推进 ↔ 回测批量计算 逐笔对拍
 *   1. 同一段行情，模拟盘（PaperTradingService + PaperEngine）与回测 run_flag_third_push 的入场/出场完全一致
 *   2. 持仓中途「重启」（从交易记录恢复 + 历史K线预热）后结果不变
 */

import { PaperEngine } from '@/services/paper_trading/paper_engine';
import { PaperTradingService } from '@/services/paper_trading/paper_trading_service';
import { PAPER_ACCOUNT } from '@/services/paper_trading/paper_strategies';
import { FlagStrategyConfig, PaperBar, PaperTrade } from '@/services/paper_trading/paper_types';
import { run_flag_third_push } from '@/services/strategy_backtest/strategies/flag_third_push';
import { FLAG_THIRD_PUSH_CONFIRM_DEFAULTS, FlagThirdPushParams } from '@/services/strategy_backtest/strategies/flag_third_push_core';
import { KlineSeries } from '@/services/strategy_backtest/backtest_types';

const M5 = 300_000;
const ACCOUNT = { ...PAPER_ACCOUNT, one_position_per_symbol: false };   // 回测不限单币单仓
const PARAMS: FlagThirdPushParams = {
  ...FLAG_THIRD_PUSH_CONFIRM_DEFAULTS,
  lows_mode: 'any', max_pre_waves: 99, leg_max_pct: 10, leg_min_bars: 1, leg_max_bar_ratio: 1, retr_limit: 0.786, max_dist_to_top: 1, max_hi_trend: null,
};
const STRATEGY: FlagStrategyConfig = { kind: 'flag_third_push', id: 'flag_test', name: 'test', timeframe: '5m', enabled: true, params: PARAMS };

/** 可复现随机数 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** 随机 5m 行情 */
function random_bars(n: number, seed: number): PaperBar[] {
  const r = rng(seed), bars: PaperBar[] = [];
  let price = 1, drift = 0, vol = 0.004;
  for (let i = 0; i < n; i++) {
    if (r() < 0.03) drift = (r() - 0.4) * 0.008;
    if (r() < 0.03) vol = 0.002 + r() * 0.01;
    const o = price, c = Math.max(1e-6, o * (1 + drift + (r() - 0.5) * 2 * vol));
    const t = 1_700_000_000_000 - (1_700_000_000_000 % M5) + i * M5;
    bars.push({ open_time: t, close_time: t + M5 - 1, open: o, high: Math.max(o, c) * (1 + r() * vol), low: Math.min(o, c) * (1 - r() * vol), close: c, volume: 1e7, quote_volume: 1e7 * c });
    price = c;
  }
  return bars;
}

/** PaperBar[] → 回测序列 */
function to_series(bars: PaperBar[]): KlineSeries {
  const n = bars.length, mk = () => new Float64Array(n);
  const s: KlineSeries = { symbol: 'TESTUSDT', timeframe: '5m', time: mk(), open: mk(), high: mk(), low: mk(), close: mk(), volume: mk(), quote: mk(), length: n };
  bars.forEach((b, i) => { s.time[i] = b.open_time; s.open[i] = b.open; s.high[i] = b.high; s.low[i] = b.low; s.close[i] = b.close; s.volume[i] = b.volume; s.quote[i] = b.quote_volume; });
  return s;
}

/** 模拟盘逐根推进，返回已平仓交易；restart_at 给定时在该根之前「重启」 */
function run_paper(bars: PaperBar[], restart_at?: number): PaperTrade[] {
  const all = new Map<string, PaperTrade>();
  const key = (t: PaperTrade) => `${t.strategy_id}|${t.setup_time}`;
  let engine = new PaperEngine(ACCOUNT, [STRATEGY]);
  let service = new PaperTradingService(engine, [STRATEGY]);
  bars.forEach((bar, i) => {
    if (restart_at !== undefined && i === restart_at) {
      // 重启：进行中交易经 JSON 往返（模拟落库再读出），新进程用历史K线预热（live=false 不下新单）
      const active = engine.get_active().map(t => JSON.parse(JSON.stringify(t)) as PaperTrade);
      engine = new PaperEngine(ACCOUNT, [STRATEGY]);
      engine.restore(active);
      engine.mark_seen([...all.values()].map(t => `${t.strategy_id}|${t.symbol}|${t.setup_time}`));
      service = new PaperTradingService(engine, [STRATEGY]);
      for (let j = 0; j < i; j++) service.process_5m('TESTUSDT', bars[j], false);
      for (const t of active) all.set(key(t), t);
    }
    const res = service.process_5m('TESTUSDT', bar, true);
    for (const t of [...res.submitted, ...res.changed]) all.set(key(t), t);
  });
  return [...all.values()].filter(t => t.status === 'closed').sort((a, b) => a.setup_time - b.setup_time);
}

describe('第三推：模拟盘 ↔ 回测 对拍', () => {
  test.each([1, 2, 3, 4])('seed=%i 逐笔一致', seed => {
    const bars = random_bars(6000, seed);
    const bt = run_flag_third_push(to_series(bars), PARAMS, 'flag_test');
    const paper = run_paper(bars);
    expect(bt.length).toBeGreaterThan(5);
    expect(paper.map(t => t.setup_time)).toEqual(bt.map(t => t.entry_time));
    paper.forEach((p, i) => {
      const b = bt[i];
      expect(p.fill_price).toBe(b.entry_price);
      expect(p.exit_time).toBe(b.exit_time);
      expect(p.exit_price).toBeCloseTo(b.exit_price!, 12);
      expect(p.exit_reason).toBe(b.exit_reason);
      expect(p.pnl!).toBeCloseTo(b.pnl!, 5);
      expect((p.features as any).breakout).toBe(b.features.breakout);
    });
  });

  test.each([1, 2])('seed=%i 持仓中途重启结果不变', seed => {
    const bars = random_bars(6000, seed);
    const base = run_paper(bars);
    // 在若干笔持仓中途重启（入场后第 3 根）
    for (const t of base.filter(x => x.exit_time! - x.setup_time > 5 * M5).slice(0, 3)) {
      const at = bars.findIndex(b => b.open_time === t.setup_time + 3 * M5);
      const restarted = run_paper(bars, at);
      expect(restarted.map(x => [x.setup_time, x.exit_time, x.exit_reason, x.pnl])).toEqual(base.map(x => [x.setup_time, x.exit_time, x.exit_reason, x.pnl]));
    }
  });
});
