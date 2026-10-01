/**
 * 模拟盘撮合引擎（纯计算、无 IO）
 *
 * 以已收盘 5m K线逐根撮合（策略周期为 15m 时同样用 5m 推进，比回测的 15m 撮合更贴近真实）：
 *
 *   pending（条件单）
 *     · open_time ≥ expire_at                   → expired
 *     · 触及触发价（顶：low ≤ 反转K线低点）      → 成交，价格 = min(开盘价, 触发价)（跳空按开盘价）
 *       成交价到极值的距离不在 [min_risk, max_risk] → cancelled(risk_out_of_range)
 *       同一根K线又触及止损                       → 直接止损（不利方向优先）
 *     · 未触发却先触及极值（顶：high ≥ 新高）    → cancelled(stop_before_entry)
 *   open（持仓）
 *     · 先判止损，再判止盈；均未触及且到达 max_hold_until → 按该根收盘价时间平仓
 *
 * 每笔按固定风险开仓：qty = risk_per_trade / |止损 − 成交价|；手续费按名义价值双边收取。
 */

import { TIMEFRAME_MS } from './paper_strategies';
import {
  DivergenceSetup, PaperAccountConfig, PaperBar, PaperExitReason,
  PaperStrategyConfig, PaperTrade,
} from './paper_types';

/** 某时刻所在周期K线的起始时间（UTC 对齐） */
export function bucket_start(ts: number, tf_ms: number): number {
  return Math.floor(ts / tf_ms) * tf_ms;
}

/** setup 是否满足策略过滤（不含成交时才可知的止损距离） */
export function passes_filters(strategy: PaperStrategyConfig, setup: DivergenceSetup): boolean {
  const f = strategy.filters, x = setup.features;
  return setup.dir === strategy.dir
    && setup.timeframe === strategy.timeframe
    && x.gap >= f.min_gap
    && x.gdep >= f.min_gdep
    && x.dif_ratio < f.max_dif_ratio
    && x.hist_ratio < f.max_hist_ratio
    && x.imp_pct >= f.min_imp_pct
    && x.leg_pct >= f.min_leg_pct
    && x.qv24_m >= f.min_qv24_m;
}

/** 交易唯一键（同策略同币同一根反转K线只下一次单） */
export function trade_key(t: Pick<PaperTrade, 'strategy_id' | 'symbol' | 'setup_time'>): string {
  return `${t.strategy_id}|${t.symbol}|${t.setup_time}`;
}

export class PaperEngine {
  private readonly active = new Map<string, PaperTrade>();   // key → pending/open
  private readonly seen = new Set<string>();
  private readonly strategies: Map<string, PaperStrategyConfig>;

  constructor(private readonly account: PaperAccountConfig, strategies: PaperStrategyConfig[]) {
    this.strategies = new Map(strategies.map(s => [s.id, s]));
  }

  /** 恢复进行中的交易（重启续跑） */
  restore(trades: PaperTrade[]): void {
    for (const t of trades) {
      const key = trade_key(t);
      this.seen.add(key);
      if (t.status === 'pending' || t.status === 'open') this.active.set(key, t);
    }
  }

  /** 标记已存在的交易键（避免重启后重复下单） */
  mark_seen(keys: Iterable<string>): void {
    for (const k of keys) this.seen.add(k);
  }

  /** 进行中的交易 */
  get_active(): PaperTrade[] {
    return [...this.active.values()];
  }

  /** 某币是否有进行中的交易 */
  private symbol_busy(symbol: string): boolean {
    for (const t of this.active.values()) if (t.symbol === symbol) return true;
    return false;
  }

  /**
   * 提交 setup：不满足过滤返回 null；已处理过返回 null；
   * 币种已有仓位/挂单时返回 status=skipped 的记录（入库留痕），否则返回 pending 订单
   */
  submit(strategy_id: string, setup: DivergenceSetup): PaperTrade | null {
    const st = this.strategies.get(strategy_id);
    if (!st || !st.enabled || !passes_filters(st, setup)) return null;

    const tf_ms = TIMEFRAME_MS[st.timeframe];
    const trade: PaperTrade = {
      strategy_id: st.id,
      symbol: setup.symbol,
      timeframe: st.timeframe,
      side: setup.dir > 0 ? 'short' : 'long',
      status: 'pending',
      trigger_time: setup.trigger_time,
      setup_time: setup.setup_time,
      signal_time: setup.setup_close_time + 1,
      entry_trigger: setup.entry_trigger,
      base_stop: setup.extreme,
      stop_price: setup.extreme + setup.dir * st.stop_atr_buffer * setup.atr,
      take_profit: null,
      expire_at: setup.setup_time + (st.order_valid_bars + 1) * tf_ms,
      max_hold_until: null,
      fill_time: null, fill_price: null, qty: null, notional: null,
      risk_usdt: this.account.risk_per_trade_usdt,
      exit_time: null, exit_price: null, exit_reason: null,
      gross_pnl: null, fees: null, pnl: null, r_multiple: null, mfe_r: null, mae_r: null,
      cancel_reason: null,
      last_bar_time: setup.setup_time,
      features: setup.features,
    };

    const key = trade_key(trade);
    if (this.seen.has(key)) return null;
    this.seen.add(key);

    if (this.account.one_position_per_symbol && this.symbol_busy(setup.symbol)) {
      trade.status = 'skipped';
      trade.cancel_reason = 'symbol_busy';
      return trade;
    }
    this.active.set(key, trade);
    return trade;
  }

  /** 逐根推进某币的所有进行中交易，返回状态或数值有变化的交易 */
  on_bar(symbol: string, bar: PaperBar): PaperTrade[] {
    const changed: PaperTrade[] = [];
    for (const [key, t] of this.active) {
      if (t.symbol !== symbol || bar.open_time <= t.last_bar_time) continue;
      // 挂单在信号K线收盘后才生效
      if (bar.open_time < t.signal_time) continue;
      t.last_bar_time = bar.open_time;
      if (t.status === 'pending') this.step_pending(t, bar);
      else this.step_open(t, bar, false);
      if (t.status !== 'pending' && t.status !== 'open') this.active.delete(key);
      changed.push(t);
    }
    return changed;
  }

  /** 推进挂单 */
  private step_pending(t: PaperTrade, bar: PaperBar): void {
    if (bar.open_time >= t.expire_at) {
      t.status = 'expired';
      t.cancel_reason = 'expired';
      return;
    }
    const dir = t.side === 'short' ? 1 : -1;
    const hit_trigger = dir > 0 ? bar.low <= t.entry_trigger : bar.high >= t.entry_trigger;
    const hit_extreme = dir > 0 ? bar.high >= t.base_stop : bar.low <= t.base_stop;

    if (!hit_trigger) {
      if (hit_extreme) { t.status = 'cancelled'; t.cancel_reason = 'stop_before_entry'; }
      return;
    }

    const st = this.strategies.get(t.strategy_id)!;
    const fill = dir > 0 ? Math.min(bar.open, t.entry_trigger) : Math.max(bar.open, t.entry_trigger);
    const base_risk_pct = dir * (t.base_stop - fill) / fill * 100;
    if (!(base_risk_pct >= st.filters.min_risk_pct && base_risk_pct <= st.filters.max_risk_pct)) {
      t.status = 'cancelled';
      t.cancel_reason = 'risk_out_of_range';
      return;
    }

    const risk_px = dir * (t.stop_price - fill);
    const tf_ms = TIMEFRAME_MS[st.timeframe];
    t.status = 'open';
    t.fill_time = bar.open_time;
    t.fill_price = fill;
    t.qty = t.risk_usdt / risk_px;
    t.notional = t.qty * fill;
    t.take_profit = fill - dir * st.take_profit_r * risk_px;
    t.max_hold_until = bucket_start(bar.open_time, tf_ms) + (st.max_hold_bars + 1) * tf_ms;
    t.mfe_r = 0;
    t.mae_r = 0;
    this.step_open(t, bar, true);
  }

  /** 推进持仓；fill_bar=true 表示成交当根（只判止损，与回测一致） */
  private step_open(t: PaperTrade, bar: PaperBar, fill_bar: boolean): void {
    const dir = t.side === 'short' ? 1 : -1;
    const fill = t.fill_price!, risk_px = dir * (t.stop_price - fill);

    if (dir > 0 ? bar.high >= t.stop_price : bar.low <= t.stop_price) {
      t.mae_r = Math.max(t.mae_r ?? 0, 1);
      this.close(t, t.stop_price, bar.open_time, 'stop');
      return;
    }
    const adverse = dir * ((dir > 0 ? bar.high : bar.low) - fill) / risk_px;
    t.mae_r = Math.max(t.mae_r ?? 0, adverse);
    if (fill_bar) return;

    const favorable = -dir * ((dir > 0 ? bar.low : bar.high) - fill) / risk_px;
    t.mfe_r = Math.max(t.mfe_r ?? 0, favorable);
    if (t.take_profit !== null && (dir > 0 ? bar.low <= t.take_profit : bar.high >= t.take_profit)) {
      this.close(t, t.take_profit, bar.open_time, 'take_profit');
      return;
    }
    if (t.max_hold_until !== null && bar.close_time + 1 >= t.max_hold_until) {
      this.close(t, bar.close, bar.open_time, 'time');
    }
  }

  /** 平仓结算 */
  private close(t: PaperTrade, price: number, time: number, reason: PaperExitReason): void {
    const dir = t.side === 'short' ? 1 : -1;
    const qty = t.qty!;
    t.status = 'closed';
    t.exit_price = price;
    t.exit_time = time;
    t.exit_reason = reason;
    t.gross_pnl = -dir * (price - t.fill_price!) * qty;
    t.fees = (t.fill_price! + price) * qty * this.account.fee_rate;
    t.pnl = t.gross_pnl - t.fees;
    t.r_multiple = t.pnl / t.risk_usdt;
  }
}
