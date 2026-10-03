/**
 * 实盘下单计划 / 精度工具单测
 */

import { plan_entry, take_profit_price } from '@/services/live_trading/order_planner';
import { round_to_step, step_decimals, format_step, beijing_day_start } from '@/services/live_trading/exchange_rules';
import { LIVE_CONFIG as REAL_LIVE_CONFIG } from '@/services/live_trading/live_config';
import { LeverageBracket, SymbolRules } from '@/services/live_trading/live_types';
import { PAPER_STRATEGIES } from '@/services/paper_trading/paper_strategies';
import { DivergenceSetup, DivergenceStrategyConfig } from '@/services/paper_trading/paper_types';

/** 测试固定配置（与实盘配置解耦，实盘调参不影响用例） */
const LIVE_CONFIG = { ...REAL_LIVE_CONFIG, risk_per_trade_usdt: 2, max_notional_usdt: 150, max_leverage: 10, max_active_trades: 3, daily_loss_limit_usdt: 8 };

const M15 = 900_000;
const S1 = PAPER_STRATEGIES.find(s => s.id === 'macd_top_div_15m') as DivergenceStrategyConfig;
const S2 = PAPER_STRATEGIES.find(s => s.id === 'macd_top_div_5m') as DivergenceStrategyConfig;

const RULES: SymbolRules = {
  symbol: 'ABCUSDT', status: 'TRADING', tick_size: '0.01', step_size: '0.001', min_qty: 0.001, max_qty: 1e6,
  market_step_size: '0.001', market_max_qty: 1e5, min_notional: 5, percent_down: 0.95,
};
const BRACKET: LeverageBracket = { max_leverage: 20, notional_cap: 5000, maint_margin_ratio: 0.01 };

function setup(over: Partial<DivergenceSetup> = {}): DivergenceSetup {
  const t0 = 1000 * M15;
  return {
    symbol: 'ABCUSDT', timeframe: '15m', dir: 1, trigger_time: t0 - M15, setup_time: t0, setup_close_time: t0 + M15 - 1,
    entry_trigger: 100, extreme: 104, atr: 2,
    features: { dif_ratio: 0.4, hist_ratio: 0.1, gap: 10, gdep: 0.5, imp_pct: 30, leg_pct: 12, qv24_m: 50, qv_surge: 1.5, atr_pct: 2, range48: 20, wait: 1, wick: 0.3, body: 0.6 },
    ...over,
  };
}

function plan(over: Partial<DivergenceSetup> = {}, extra: { strategy?: DivergenceStrategyConfig; rules?: Partial<SymbolRules>; available?: number; reserved?: number; bracket?: Partial<LeverageBracket> } = {}) {
  return plan_entry({
    strategy: extra.strategy ?? S1, setup: setup(over), rules: { ...RULES, ...extra.rules }, bracket: { ...BRACKET, ...extra.bracket },
    config: LIVE_CONFIG, available_usdt: extra.available ?? 100, reserved_margin_usdt: extra.reserved ?? 0,
  });
}

describe('exchange_rules', () => {
  it('步长小数位与取整无浮点尾差', () => {
    expect(step_decimals('0.00100')).toBe(3);
    expect(step_decimals('1')).toBe(0);
    expect(round_to_step(0.3, '0.1', 'floor')).toBe(0.3);
    expect(round_to_step(1.23456, '0.001', 'floor')).toBe(1.234);
    expect(round_to_step(1.2341, '0.001', 'ceil')).toBe(1.235);
    expect(round_to_step(1.234, '0.001', 'ceil')).toBe(1.234);
    expect(round_to_step(7.5, '5', 'floor')).toBe(5);
    expect(format_step(0.1 + 0.2, '0.01')).toBe('0.30');
  });

  it('北京时间日界', () => {
    const ts = Date.UTC(2026, 9, 3, 15, 59);   // 北京 23:59
    expect(beijing_day_start(ts)).toBe(Date.UTC(2026, 9, 2, 16, 0));
    expect(beijing_day_start(Date.UTC(2026, 9, 3, 16, 0))).toBe(Date.UTC(2026, 9, 3, 16, 0));
  });
});

describe('plan_entry', () => {
  it('15m：止损=极值，固定风险算数量，限价 = 止损 − 1.5R，杠杆保证强平距离 ≥ 2 倍最差止损距离', () => {
    const r = plan();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.plan;
    expect(p.entry_trigger).toBe(100);
    expect(p.stop_price).toBe(104);
    expect(p.qty).toBe(0.5);                          // 2U / 4
    expect(p.risk_usdt).toBeCloseTo(2);
    expect(p.entry_limit).toBe(98);                   // 104 − 1.5 × 4
    const d = (104 - 98) / 98;
    expect(p.leverage).toBe(Math.floor(1 / (2 * d + 0.01)));
    expect(1 / p.leverage - 0.01).toBeGreaterThanOrEqual(2 * d);
    expect(p.expire_at).toBe(1000 * M15 + 7 * M15);   // 与模拟盘同一失效时刻
  });

  it('5m：止损 = 极值 + 0.5ATR（向上取整到 tick）', () => {
    const r = plan({ timeframe: '5m', atr: 0.333 }, { strategy: S2 });
    expect(r.ok && r.plan.stop_price).toBe(104.17);   // 104.1665 → 104.17
  });

  it('极值距离不在 [0.3%, 10%] 跳过（与模拟盘成交时检查同口径）', () => {
    expect(plan({ extreme: 100.2 })).toEqual({ ok: false, reason: 'risk_out_of_range' });
    expect(plan({ extreme: 111 })).toEqual({ ok: false, reason: 'risk_out_of_range' });
  });

  it('限价不低于 极值/(1+10%)，保证跳空成交后距离仍 ≤ 10%', () => {
    const r = plan({ extreme: 109, atr: 2 });   // 止损距离 9%，1.5R 会到 95.5，被 99.09 兜住
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entry_limit).toBeCloseTo(99.1, 2);
    expect((109 - r.plan.entry_limit) / r.plan.entry_limit).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('限价不低于 PERCENT_PRICE 价格带（触发价 × (下限 + 1%)）', () => {
    const r = plan({ extreme: 109 }, { rules: { percent_down: 0.98 } });   // 带下限 99，限价被抬到 99.1 以上
    expect(r.ok && r.plan.entry_limit).toBeCloseTo(99.1, 2);
    const r2 = plan({ extreme: 108 }, { rules: { percent_down: 0.985 } });  // 99.5 > 108/1.1=98.18
    expect(r2.ok && r2.plan.entry_limit).toBeCloseTo(99.5, 2);
  });

  it('止损很近时名义价值封顶（风险随之缩小）', () => {
    const r = plan({ extreme: 100.5 });   // 0.5% → 2U 需 400U 名义，封顶 150U
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.notional).toBeLessThanOrEqual(LIVE_CONFIG.max_notional_usdt + 1e-9);
    expect(r.plan.risk_usdt).toBeLessThan(2);
    expect(r.plan.leverage).toBeLessThanOrEqual(LIVE_CONFIG.max_leverage);
  });

  it('杠杆受分层上限约束', () => {
    const r = plan({ extreme: 100.5 }, { bracket: { max_leverage: 3 } });
    expect(r.ok && r.plan.leverage).toBe(3);
  });

  it('最小名义价值 / 最小数量 / 保证金不足 / 非交易状态', () => {
    expect(plan({}, { rules: { min_notional: 100 } })).toEqual({ ok: false, reason: 'below_min_notional' });
    expect(plan({}, { rules: { step_size: '1', min_qty: 1 } })).toEqual({ ok: false, reason: 'below_min_qty' });
    expect(plan({}, { available: 10, reserved: 0 })).toEqual({ ok: false, reason: 'insufficient_margin' });
    expect(plan({}, { rules: { status: 'SETTLING' } })).toEqual({ ok: false, reason: 'symbol_not_trading' });
  });

  it('止盈按实际成交均价 2R', () => {
    expect(take_profit_price(99.5, 104, 2, '0.01')).toBe(90.5);
    expect(take_profit_price(10, 30, 2, '0.01')).toBeNull();
  });
});
