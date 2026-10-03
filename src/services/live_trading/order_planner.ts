/**
 * 实盘下单计划（纯函数）：背离 setup → 入场条件单参数 / 跳过原因
 *
 * 与模拟盘口径对应关系（paper_engine.ts）：
 *   触发价 = 反转K线低点；止损 = 极值 + buffer × ATR；条件单有效期 = setup_time + (有效根数 + 1) × 周期
 *   模拟盘在「成交后」检查 极值到成交价距离 ∈ [min_risk, max_risk]，实盘改为挂单前按触发价检查：
 *     · 不跳空时成交价 = 触发价，结果与模拟盘完全一致
 *     · 跳空只会让成交价更低、距离更大，所以下限不会因跳空失效；上限由 IOC 限价兜住
 *   IOC 限价 = max(止损 − k × (止损 − 触发价), 极值 / (1 + max_risk%), 触发价 × (价格带下限 + 1%))：
 *     第一项限制滑点导致的超额亏损（k = 1.5 即最多亏 1.5R），第二项保证距离不超过 max_risk，
 *     第三项避免触发时限价低于 PERCENT_PRICE 价格带被拒（留 1% 余量吸收标记价与成交价偏差）
 *
 * 杠杆：逐仓空单强平价 ≈ 入场 × (1 + 1/杠杆 − 维持保证金率)，
 *       要求强平距离 ≥ liq_distance_mult × 最差止损距离 → 杠杆 ≤ 1 / (mult × d + mmr)
 */

import { DivergenceSetup, DivergenceStrategyConfig } from '@/services/paper_trading/paper_types';
import { TIMEFRAME_MS } from '@/services/paper_trading/paper_strategies';
import { round_to_step } from './exchange_rules';
import { LeverageBracket, LiveConfig, SymbolRules } from './live_types';

/** 入场计划 */
export interface EntryPlan {
  entry_trigger: number;
  entry_limit: number;
  base_stop: number;
  stop_price: number;
  qty: number;
  notional: number;        // qty × 触发价
  risk_usdt: number;       // qty × (止损 − 触发价)
  leverage: number;
  margin: number;          // 名义价值 / 杠杆
  expire_at: number;
  base_risk_pct: number;   // 极值到触发价距离 %
}

export type PlanResult = { ok: true; plan: EntryPlan } | { ok: false; reason: string };

export interface PlanInput {
  strategy: DivergenceStrategyConfig;
  setup: DivergenceSetup;
  rules: SymbolRules;
  bracket: LeverageBracket;
  config: LiveConfig;
  available_usdt: number;        // 当前可用余额
  reserved_margin_usdt: number;  // 其他挂单成交后将占用的保证金（条件单不预占，需自行预留）
}

/** 计算入场计划 */
export function plan_entry(inp: PlanInput): PlanResult {
  const { strategy: st, setup, rules, bracket, config: cfg } = inp;
  if (setup.dir !== 1 || st.dir !== 1) return { ok: false, reason: 'only_short_supported' };
  if (rules.status !== 'TRADING') return { ok: false, reason: 'symbol_not_trading' };

  const tick = rules.tick_size;
  const trigger = round_to_step(setup.entry_trigger, tick, 'round');
  const base_stop = setup.extreme;
  // 止损向上取整到 tick：不会比模拟盘止损更近
  const stop = round_to_step(setup.extreme + st.stop_atr_buffer * setup.atr, tick, 'ceil');
  if (!(trigger > 0) || !(stop > trigger)) return { ok: false, reason: 'invalid_prices' };

  const base_risk_pct = (base_stop - trigger) / trigger * 100;
  if (!(base_risk_pct >= st.filters.min_risk_pct && base_risk_pct <= st.filters.max_risk_pct)) {
    return { ok: false, reason: 'risk_out_of_range' };
  }

  // IOC 限价（卖出：向上取整更保守），不高于触发价
  const stop_dist = stop - trigger;
  const band_floor = rules.percent_down > 0 ? trigger * (rules.percent_down + 0.01) : 0;
  const limit_raw = Math.max(stop - cfg.entry_slippage_mult * stop_dist, base_stop / (1 + st.filters.max_risk_pct / 100), band_floor);
  let limit = round_to_step(limit_raw, tick, 'ceil');
  if (limit > trigger) limit = trigger;
  if (!(limit > 0)) return { ok: false, reason: 'invalid_prices' };

  // 数量：固定风险，名义价值封顶
  let qty_raw = cfg.risk_per_trade_usdt / stop_dist;
  qty_raw = Math.min(qty_raw, cfg.max_notional_usdt / trigger, rules.max_qty);
  const qty = round_to_step(qty_raw, rules.step_size, 'floor');
  if (!(qty >= rules.min_qty) || qty <= 0) return { ok: false, reason: 'below_min_qty' };
  // 最低名义价值按最差成交价（IOC 限价）检查
  if (qty * limit < rules.min_notional) return { ok: false, reason: 'below_min_notional' };

  // 杠杆
  const d_worst = (stop - limit) / limit;
  const lev_raw = Math.floor(1 / (cfg.liq_distance_mult * d_worst + bracket.maint_margin_ratio));
  const leverage = Math.min(lev_raw, cfg.max_leverage, bracket.max_leverage);
  if (!(leverage >= 1)) return { ok: false, reason: 'stop_too_wide' };

  const notional = qty * trigger;
  const margin = notional / leverage;
  if (inp.available_usdt - inp.reserved_margin_usdt - margin < cfg.margin_buffer_usdt) {
    return { ok: false, reason: 'insufficient_margin' };
  }

  const tf_ms = TIMEFRAME_MS[st.timeframe];
  return {
    ok: true,
    plan: {
      entry_trigger: trigger,
      entry_limit: limit,
      base_stop,
      stop_price: stop,
      qty,
      notional,
      risk_usdt: qty * stop_dist,
      leverage,
      margin,
      expire_at: setup.setup_time + (st.order_valid_bars + 1) * tf_ms,
      base_risk_pct,
    },
  };
}

/** 止盈触发价（按实际成交均价，空单向下），对齐 tick */
export function take_profit_price(fill_price: number, stop_price: number, r: number, tick: string): number | null {
  const tp = fill_price - r * (stop_price - fill_price);
  if (!(tp > 0)) return null;
  return round_to_step(tp, tick, 'round');
}
