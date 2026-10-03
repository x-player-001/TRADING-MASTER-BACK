/**
 * 实盘执行器：交易生命周期编排（以交易所状态为准）
 *
 * 设计原则：
 *   1. 交易所是唯一事实来源。用户数据流事件只用来「唤醒同步」，同步时一律 REST 查询
 *      条件单 / 订单 / 持仓的当前状态再推进 —— 幂等、与事件先后无关、丢事件也能收敛。
 *   2. 先落库再下单。每个订单的 client id 由交易 id + 序号确定（LV{id}E / S{n} / T{n} / X{n} / I），
 *      序号在下单前先落库；请求结果未知（超时 / 5xx）时按 client id 查询确认，绝不盲目重下。
 *   3. 持仓必须有止损。成交后立刻挂 closePosition 止损单；挂不上（价格已越过）就市价平仓；
 *      每次同步都核查止损单是否存活，丢失即重挂。
 *   4. 同一币种的所有操作串行（按币加锁）；开新仓额外全局串行，保证风控计数准确。
 *
 * 与模拟盘的对应：入场条件单 = STOP 卖出（IOC 限价），止损 = STOP_MARKET，止盈 = TAKE_PROFIT_MARKET，
 * 都按最新成交价（CONTRACT_PRICE）触发，与回测「K线高低点触及」口径一致；
 * 条件单过期 / 先破极值撤单 / 到时平仓在 5m 收盘时判断，与模拟盘同一根K线生效。
 */

import { DivergenceSetup, DivergenceStrategyConfig, PaperBar } from '@/services/paper_trading/paper_types';
import { TIMEFRAME_MS } from '@/services/paper_trading/paper_strategies';
import { bucket_start } from '@/services/paper_trading/paper_engine';
import { beijing_day_start, format_step } from './exchange_rules';
import { EntryPlan, plan_entry, take_profit_price } from './order_planner';
import {
  ACTIVE_STATUSES, AlgoOrderInfo, ERR_REDUCE_ONLY_REJECTED, ERR_WOULD_IMMEDIATELY_TRIGGER, ExchangeError, ExchangeGateway,
  LeverageBracket, LiveConfig, LiveControlMode, LiveExitReason, LiveRunMode, LiveTrade, OrderInfo, SymbolRules,
} from './live_types';

const M5 = 300_000;
const FINAL_ORDER = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH']);
const ALIVE_ALGO = new Set(['NEW', 'TRIGGERING', 'TRIGGERED']);
const PROTECT_MAX_ATTEMPTS = 3;
const FLATTEN_MAX_ATTEMPTS = 5;
const SETTLE_MAX_ATTEMPTS = 6;          // 平仓后成交明细未齐时最多重试次数
const PLACING_TIMEOUT_MS = 120_000;     // 入场单在信号后该时长内查不到不下结论（结果未知 / 交易所查询延迟）
const PROTECT_GRACE_MS = 15_000;        // 保护单挂出后该时长内查不到视为存活（实测条件单挂出约 1 秒内按 client id 查询返回 -2013）
const SHADOW_BRACKET: LeverageBracket = { max_leverage: 20, notional_cap: Infinity, maint_margin_ratio: 0.02 };

/** 交易持久化 */
export interface LiveTradeStore {
  /** 新增交易；唯一键 (strategy_id, symbol, setup_time) 冲突返回 null */
  insert_trade(t: LiveTrade): Promise<number | null>;
  update_trade(t: LiveTrade): Promise<void>;
  log_event(trade_id: number | null, symbol: string, kind: string, payload: unknown): Promise<void>;
  /** 某时刻以来已平仓交易的净盈亏之和 */
  realized_pnl_since(ts: number): Promise<number>;
}

/** 通知 */
export interface LiveNotifier {
  info(msg: string): void;
  alert(msg: string): void;
}

export interface LiveExecutorDeps {
  mode: LiveRunMode;
  gateway: ExchangeGateway | null;    // shadow 模式可为 null
  store: LiveTradeStore;
  notifier: LiveNotifier;
  config: LiveConfig;
  strategies: DivergenceStrategyConfig[];
  rules: (symbol: string) => SymbolRules | null;
  control: () => LiveControlMode;
  now?: () => number;
}

/** 按 key 串行执行（Promise 链） */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); }).catch(() => undefined);
    return next;
  }
}

/** client id */
export const cid = {
  entry: (id: number) => `LV${id}E`,
  ioc: (id: number) => `LV${id}I`,
  sl: (id: number, seq: number) => `LV${id}S${seq}`,
  tp: (id: number, seq: number) => `LV${id}T${seq}`,
  exit: (id: number, seq: number) => `LV${id}X${seq}`,
};

/** 是否本程序的订单 */
export function is_own_client_id(id: string | undefined | null): boolean {
  return !!id && /^LV\d+[EISTX]\d*$/.test(id);
}

export class LiveExecutor {
  private readonly active = new Map<number, LiveTrade>();
  private readonly errors = new Map<number, LiveTrade>();
  private readonly locks = new KeyedMutex();
  private readonly strategies: Map<string, DivergenceStrategyConfig>;
  private readonly settle_attempts = new Map<number, number>();
  private readonly flatten_attempts = new Map<number, number>();
  private readonly placed_at = new Map<string, number>();   // client id → 本进程挂出时刻（查询延迟宽限）
  private readonly now: () => number;

  constructor(private readonly d: LiveExecutorDeps) {
    this.strategies = new Map(d.strategies.map(s => [s.id, s]));
    this.now = d.now ?? Date.now;
    if (d.mode === 'live' && !d.gateway) throw new Error('live 模式必须提供交易所网关');
  }

  // ==================== 查询 ====================

  /** 进行中的交易 */
  get_active(): LiveTrade[] {
    return [...this.active.values()];
  }

  /** 需人工处理的交易 */
  get_errors(): LiveTrade[] {
    return [...this.errors.values()];
  }

  /** 某币是否有进行中的交易 */
  symbol_busy(symbol: string): boolean {
    for (const t of this.active.values()) if (t.symbol === symbol) return true;
    return false;
  }

  /** 恢复进行中 / 待人工处理的交易（启动时调用，之后应对每笔做一次同步） */
  restore(trades: LiveTrade[]): void {
    for (const t of trades) {
      if (t.id === undefined) continue;
      if (ACTIVE_STATUSES.includes(t.status)) this.active.set(t.id, t);
      else if (t.status === 'error') this.errors.set(t.id, t);
    }
  }

  // ==================== 新信号 ====================

  /**
   * 处理一个背离 setup：风控 → 计划 → 落库 → 下入场条件单
   * 返回新建的交易记录（含 skipped / shadow），重复信号返回 null
   */
  async submit_setup(strategy_id: string, setup: DivergenceSetup): Promise<LiveTrade | null> {
    return this.locks.run('__entry__', () => this.locks.run(setup.symbol, () => this.submit_locked(strategy_id, setup)));
  }

  private async submit_locked(strategy_id: string, setup: DivergenceSetup): Promise<LiveTrade | null> {
    const st = this.strategies.get(strategy_id);
    if (!st || !st.enabled) return null;
    const now = this.now();
    const t = this.new_trade(st, setup);

    const skip = async (reason: string): Promise<LiveTrade | null> => {
      t.status = 'skipped';
      t.cancel_reason = reason;
      const id = await this.d.store.insert_trade(t);
      if (id === null) return null;
      t.id = id;
      return t;
    };

    // ---- 风控（不需要交易所的部分）----
    if (now - (setup.setup_close_time + 1) > this.d.config.signal_max_delay_ms) return skip('stale_signal');
    const ctl = this.d.control();
    if (ctl !== 'running') return skip(`control_${ctl}`);
    if (this.errors.size > 0) return skip('error_pending');
    if (this.symbol_busy(setup.symbol)) return skip('symbol_busy');
    if (this.active.size >= this.d.config.max_active_trades) return skip('max_active_trades');
    const day_pnl = await this.d.store.realized_pnl_since(beijing_day_start(now));
    if (day_pnl <= -this.d.config.daily_loss_limit_usdt) return skip('daily_loss_limit');
    const rules = this.d.rules(setup.symbol);
    if (!rules) return skip('no_symbol_rules');

    // ---- 影子模式：只算计划 ----
    if (this.d.mode === 'shadow') {
      const res = plan_entry({
        strategy: st, setup, rules, bracket: SHADOW_BRACKET, config: this.d.config,
        available_usdt: this.d.config.shadow_balance_usdt, reserved_margin_usdt: this.reserved_margin(),
      });
      if (!res.ok) return skip(res.reason);
      this.apply_plan(t, res.plan);
      t.status = 'shadow';
      const id = await this.d.store.insert_trade(t);
      if (id === null) return null;
      t.id = id;
      this.d.notifier.info(`👻 [影子] ${this.tag(t)} 计划做空 触发 ${t.entry_trigger} 限价 ${t.entry_limit} 止损 ${t.stop_price} ` +
        `数量 ${t.planned_qty} 风险 ${t.risk_usdt.toFixed(2)}U ${t.leverage}x`);
      return t;
    }

    // ---- 实盘：交易所侧检查 ----
    const gw = this.d.gateway!;
    const [pos, open_orders, open_algos] = await Promise.all([
      gw.get_position(setup.symbol), gw.get_open_orders(setup.symbol), gw.get_open_algo_orders(setup.symbol),
    ]);
    if (pos.amount !== 0 || open_orders.length || open_algos.length) {
      this.d.notifier.alert(`⚠️ ${setup.symbol} 有非本程序管理的持仓/挂单（持仓 ${pos.amount}，挂单 ${open_orders.length}，条件单 ${open_algos.length}），信号跳过`);
      return skip('symbol_dirty');
    }
    const available = await gw.get_available_balance();
    const bracket = await gw.get_leverage_bracket(setup.symbol, this.d.config.max_notional_usdt);
    const res = plan_entry({
      strategy: st, setup, rules, bracket, config: this.d.config,
      available_usdt: available, reserved_margin_usdt: this.reserved_margin(),
    });
    if (!res.ok) return skip(res.reason);
    this.apply_plan(t, res.plan);

    // ---- 落库（唯一键防重复）----
    t.status = 'placing';
    const id = await this.d.store.insert_trade(t);
    if (id === null) return null;
    t.id = id;
    this.active.set(id, t);

    // ---- 逐仓 + 杠杆（下单前，失败则不下单）----
    try {
      await gw.set_isolated_margin(t.symbol);
      await gw.set_leverage(t.symbol, t.leverage);
    } catch (err) {
      await this.finish_cancelled(t, `setup_failed:${err_code(err)}`);
      await this.log(t, 'setup_failed', { error: err_text(err) });
      this.d.notifier.alert(`❌ ${this.tag(t)} 设置逐仓/杠杆失败，未下单：${err_text(err)}`);
      return t;
    }

    await this.place_entry(t);
    // 立即同步一次：IOC 直接成交时马上挂止损，不等用户数据流 / 定时对账
    await this.guarded(t, () => this.sync(t));
    return t;
  }

  /** 下入场单：STOP 卖出条件单（IOC 限价）；挂单时已越过触发价则直接 IOC 限价单 */
  private async place_entry(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!, rules = this.d.rules(t.symbol)!, id = t.id!;
    t.entry_mode = 'algo';
    await this.save(t);
    try {
      this.placed_at.set(cid.entry(id), this.now());
      await gw.new_algo_order({
        symbol: t.symbol, side: 'SELL', type: 'STOP', client_algo_id: cid.entry(id),
        trigger_price: format_step(t.entry_trigger, rules.tick_size),
        price: format_step(t.entry_limit, rules.tick_size),
        quantity: format_step(t.planned_qty, rules.step_size),
        time_in_force: 'IOC',
      });
      t.status = 'pending';
      await this.save(t);
      await this.log(t, 'entry_placed', { trigger: t.entry_trigger, limit: t.entry_limit, qty: t.planned_qty });
      this.d.notifier.info(`📝 ${this.tag(t)} 挂入场单 做空 触发 ${t.entry_trigger} 限价 ${t.entry_limit} 止损 ${t.stop_price} ` +
        `数量 ${t.planned_qty}（风险 ${t.risk_usdt.toFixed(2)}U，${t.leverage}x）`);
      return;
    } catch (err) {
      if (!(err instanceof ExchangeError) || !err.definite) {
        // 结果未知：保持 placing，由同步按 client id 查询确认
        await this.log(t, 'entry_unknown', { error: err_text(err) });
        return;
      }
      if (err.code !== ERR_WOULD_IMMEDIATELY_TRIGGER) {
        await this.finish_cancelled(t, `entry_rejected:${err.code}`);
        await this.log(t, 'entry_rejected', { error: err_text(err) });
        this.d.notifier.alert(`❌ ${this.tag(t)} 入场条件单被拒：${err_text(err)}`);
        return;
      }
    }

    // 价格已在触发价下方：等价于模拟盘「下一根开盘即越过触发价」，直接 IOC 限价卖出
    t.entry_mode = 'ioc';
    await this.save(t);
    try {
      const order = await gw.new_order({
        symbol: t.symbol, side: 'SELL', type: 'LIMIT', client_order_id: cid.ioc(id),
        quantity: format_step(t.planned_qty, rules.step_size),
        price: format_step(t.entry_limit, rules.tick_size),
        time_in_force: 'IOC',
      });
      await this.log(t, 'entry_ioc', { order });
      await this.handle_entry_order(t, order);
    } catch (err) {
      if (err instanceof ExchangeError && err.definite) {
        await this.finish_cancelled(t, `ioc_rejected:${err.code}`);
        await this.log(t, 'ioc_rejected', { error: err_text(err) });
        this.d.notifier.alert(`❌ ${this.tag(t)} IOC 入场单被拒：${err_text(err)}`);
      } else {
        await this.log(t, 'ioc_unknown', { error: err_text(err) });
      }
    }
  }

  // ==================== 同步 ====================

  /** 同步某币所有进行中的交易（用户数据流事件 / 定时对账调用） */
  async sync_symbol(symbol: string): Promise<void> {
    await this.locks.run(symbol, async () => {
      for (const t of this.get_active().filter(x => x.symbol === symbol)) await this.guarded(t, () => this.sync(t));
    });
  }

  /** 同步全部进行中的交易 */
  async sync_all(): Promise<void> {
    const symbols = new Set(this.get_active().map(t => t.symbol));
    for (const s of symbols) await this.sync_symbol(s);
  }

  /** 推进一笔交易到与交易所一致的状态（调用方持有该币的锁） */
  private async sync(t: LiveTrade): Promise<void> {
    if (this.d.mode !== 'live') return;
    // 一次同步内可能连续推进多个状态（如 pending → entering → open），最多走几步防止死循环
    for (let step = 0; step < 6; step++) {
      const before = t.status;
      switch (t.status) {
        case 'placing': await this.sync_placing(t); break;
        case 'pending': await this.sync_pending(t); break;
        case 'entering': await this.sync_entering(t); break;
        case 'open': await this.sync_open(t); break;
        case 'closing': await this.sync_closing(t); break;
        default: return;
      }
      if (t.status === before) return;
    }
  }

  /** placing：确认入场单是否已到交易所 */
  private async sync_placing(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!, id = t.id!;
    if (t.entry_mode === 'ioc') {
      const order = await gw.get_order(t.symbol, { client_order_id: cid.ioc(id) });
      if (order) return this.handle_entry_order(t, order);
    } else if (t.entry_mode === 'algo') {
      const algo = await this.find_algo(t.symbol, cid.entry(id));
      if (algo) {
        t.status = 'pending';
        await this.save(t);
        return;
      }
    }
    if (this.now() - t.signal_time > PLACING_TIMEOUT_MS) {
      if (await this.recover_fill_from_position(t)) return;
      await this.finish_cancelled(t, t.entry_mode ? 'entry_not_found' : 'not_placed');
    }
  }

  /** pending：入场条件单是否触发 / 结束 */
  private async sync_pending(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!;
    const algo = await this.find_algo(t.symbol, cid.entry(t.id!));
    if (!algo) {
      // 刚挂出的条件单交易所约 1 秒内查不到：信号后宽限期内不下结论
      if (this.now() - t.signal_time <= PLACING_TIMEOUT_MS) return;
      if (await this.recover_fill_from_position(t)) return;
      await this.finish_cancelled(t, t.cancel_reason ?? 'entry_not_found');
      return;
    }
    if (algo.status === 'NEW' || algo.status === 'TRIGGERING') return;

    if (algo.actual_order_id) {
      const order = await gw.get_order(t.symbol, { order_id: algo.actual_order_id });
      if (order) return this.handle_entry_order(t, order);
      if (algo.status === 'TRIGGERED') return;   // 订单尚未可查，下次同步
    }
    if (algo.status === 'TRIGGERED') return;
    // FINISHED 无订单 / CANCELED / EXPIRED / REJECTED
    const reason = algo.status === 'FINISHED' ? 'entry_unfilled' : (t.cancel_reason ?? `entry_${algo.status.toLowerCase()}`);
    await this.finish_cancelled(t, reason);
  }

  /**
   * 查不到入场单时的兜底：该币只归本交易管理（开仓前已确认无其他持仓/挂单），
   * 若存在空头持仓即视为已成交，按持仓与成交明细还原，避免把真实仓位误判为未成交而裸奔
   */
  private async recover_fill_from_position(t: LiveTrade): Promise<boolean> {
    const gw = this.d.gateway!;
    const pos = await gw.get_position(t.symbol);
    if (pos.amount >= 0) return false;
    const sells = (await gw.get_user_trades(t.symbol, t.signal_time - 60_000)).filter(x => x.side === 'SELL' && x.time >= t.signal_time - 60_000);
    t.entry_order_id = sells.length ? sells[0].order_id : null;
    t.filled_qty = Math.abs(pos.amount);
    t.fill_price = pos.entry_price;
    t.fill_time = sells.length ? sells[0].time : this.now();
    t.cancel_reason = null;
    t.status = 'entering';
    await this.save(t);
    await this.log(t, 'fill_recovered', { amount: pos.amount, entry_price: pos.entry_price });
    this.d.notifier.alert(`⚠️ ${this.tag(t)} 入场单查询不到，按持仓还原成交 ${t.filled_qty} @ ${t.fill_price}`);
    return true;
  }

  /** 入场订单回报 → 记录成交 / 未成交结束 */
  private async handle_entry_order(t: LiveTrade, order: OrderInfo): Promise<void> {
    t.entry_order_id = order.order_id;
    const final = FINAL_ORDER.has(order.status);
    if (order.executed_qty > 0) {
      const first = t.filled_qty === null;
      t.filled_qty = order.executed_qty;
      t.fill_price = order.avg_price;
      t.fill_time = t.fill_time ?? order.update_time;
      t.cancel_reason = null;
      t.status = 'entering';
      await this.save(t);
      if (first) {
        await this.log(t, 'entry_filled', { order });
        this.d.notifier.info(`🎯 ${this.tag(t)} 成交 做空 ${t.filled_qty} @ ${t.fill_price}  止损 ${t.stop_price}`);
      }
      return;
    }
    if (final) await this.finish_cancelled(t, t.cancel_reason ?? 'entry_unfilled');
    else await this.save(t);
  }

  /** entering：确认入场单终态，挂止损、止盈，转 open */
  private async sync_entering(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!;
    let entry_final = true;
    if (t.entry_order_id) {
      const order = await gw.get_order(t.symbol, { order_id: t.entry_order_id });
      if (order) {
        entry_final = FINAL_ORDER.has(order.status);
        if (order.executed_qty > 0) {
          t.filled_qty = order.executed_qty;
          t.fill_price = order.avg_price;
        }
        // 入场单若还挂着（理论上 IOC 不会），立即撤掉剩余部分，避免止损后又开出新仓
        if (!entry_final) {
          await gw.cancel_order(t.symbol, { order_id: t.entry_order_id });
          entry_final = true;
        }
      }
    }

    const pos = await gw.get_position(t.symbol);
    if (pos.amount === 0) {           // 刚成交就被止损 / 外部平仓
      t.status = 'closing';
      await this.save(t);
      return;
    }
    if (pos.amount > 0) return this.begin_flatten(t, 'wrong_side', `持仓方向异常（${pos.amount}）`);

    if (!(await this.ensure_stop(t))) return;
    if (!entry_final) return;
    await this.ensure_take_profit(t);
    if (t.status !== 'entering') return;   // 止盈已越过 → 已转平仓

    const st = this.strategies.get(t.strategy_id);
    const tf_ms = TIMEFRAME_MS[st?.timeframe ?? t.timeframe];
    const fill_bar = Math.floor(t.fill_time! / M5) * M5;
    t.max_hold_until = bucket_start(fill_bar, tf_ms) + ((st?.max_hold_bars ?? 48) + 1) * tf_ms;
    t.mfe_r = t.mfe_r ?? 0;
    t.mae_r = t.mae_r ?? 0;
    t.status = 'open';
    await this.save(t);
    await this.log(t, 'opened', { fill_price: t.fill_price, qty: t.filled_qty, tp: t.take_profit, max_hold_until: t.max_hold_until });
    this.d.notifier.info(`🛡️ ${this.tag(t)} 持仓 ${t.filled_qty} @ ${t.fill_price}  止损 ${t.stop_price}  止盈 ${t.take_profit ?? '-'}`);
  }

  /** open：核查持仓与保护单 */
  private async sync_open(t: LiveTrade): Promise<void> {
    const pos = await this.d.gateway!.get_position(t.symbol);
    if (pos.amount === 0) {
      t.status = 'closing';
      await this.save(t);
      return;
    }
    if (pos.amount > 0) return this.begin_flatten(t, 'wrong_side', `持仓方向异常（${pos.amount}）`);
    if (!(await this.ensure_stop(t))) return;
    await this.ensure_take_profit(t);
  }

  /** closing：仍有持仓则市价平，已无持仓则结算 */
  private async sync_closing(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!, id = t.id!;
    const pos = await gw.get_position(t.symbol);
    if (pos.amount === 0) return this.settle(t);

    // 上一笔平仓单还在途就等待
    if (t.exit_seq > 0) {
      const prev = await gw.get_order(t.symbol, { client_order_id: cid.exit(id, t.exit_seq) });
      if (prev && !FINAL_ORDER.has(prev.status)) return;
    }
    const attempts = (this.flatten_attempts.get(id) ?? 0) + 1;
    this.flatten_attempts.set(id, attempts);
    if (attempts > FLATTEN_MAX_ATTEMPTS) {
      await this.mark_error(t, `平仓失败已重试 ${FLATTEN_MAX_ATTEMPTS} 次，持仓 ${pos.amount}`);
      return;
    }

    const rules = this.d.rules(t.symbol)!;
    const side = pos.amount < 0 ? 'BUY' : 'SELL';
    let remaining = Math.abs(pos.amount);
    t.exit_seq++;
    await this.save(t);
    try {
      // 超过市价单最大数量时分批（每批独立 client id）
      while (remaining > 0) {
        const q = Math.min(remaining, rules.market_max_qty);
        await gw.new_order({
          symbol: t.symbol, side, type: 'MARKET', client_order_id: cid.exit(id, t.exit_seq),
          quantity: format_step(q, rules.market_step_size), reduce_only: true,
        });
        remaining = Number((remaining - q).toFixed(12));
        if (remaining > 0) { t.exit_seq++; await this.save(t); }
      }
      await this.log(t, 'flatten_sent', { amount: pos.amount });
    } catch (err) {
      if (err instanceof ExchangeError && err.code === ERR_REDUCE_ONLY_REJECTED) return;   // 已无持仓，下次结算
      await this.log(t, 'flatten_failed', { error: err_text(err) });
      if (err instanceof ExchangeError && err.definite) this.d.notifier.alert(`❌ ${this.tag(t)} 市价平仓被拒：${err_text(err)}（将重试）`);
    }
    const after = await gw.get_position(t.symbol);
    if (after.amount === 0) await this.settle(t);
  }

  // ==================== 保护单 ====================

  /** 确保止损单存活；挂不上则转市价平仓。返回 false 表示已转入平仓 */
  private async ensure_stop(t: LiveTrade): Promise<boolean> {
    const gw = this.d.gateway!, id = t.id!, rules = this.d.rules(t.symbol)!;
    if (t.sl_seq > 0) {
      const sl_id = cid.sl(id, t.sl_seq);
      const cur = await this.find_algo(t.symbol, sl_id);
      if (cur && ALIVE_ALGO.has(cur.status)) return true;
      if (!cur && this.recently_placed(sl_id)) return true;
    }
    for (let attempt = 1; attempt <= PROTECT_MAX_ATTEMPTS; attempt++) {
      t.sl_seq++;
      await this.save(t);
      const client_id = cid.sl(id, t.sl_seq);
      this.placed_at.set(client_id, this.now());
      try {
        await gw.new_algo_order({
          symbol: t.symbol, side: 'BUY', type: 'STOP_MARKET', client_algo_id: client_id,
          trigger_price: format_step(t.stop_price, rules.tick_size), close_position: true,
        });
        await this.log(t, 'stop_placed', { client_id, stop: t.stop_price });
        return true;
      } catch (err) {
        if (err instanceof ExchangeError && err.code === ERR_WOULD_IMMEDIATELY_TRIGGER) {
          await this.begin_flatten(t, 'stop', `价格已越过止损 ${t.stop_price}`);
          return false;
        }
        if (!(err instanceof ExchangeError) || !err.definite) {
          const found = await this.safe_get_algo(client_id);
          if (found && ALIVE_ALGO.has(found.status)) return true;
        }
        await this.log(t, 'stop_failed', { client_id, attempt, error: err_text(err) });
      }
    }
    await this.begin_flatten(t, 'protect_failed', '止损单连续挂单失败');
    return false;
  }

  /** 确保止盈单存活（成交均价确定后）；价格已越过止盈则市价平仓 */
  private async ensure_take_profit(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!, id = t.id!, rules = this.d.rules(t.symbol)!;
    if (t.take_profit === null) {
      t.take_profit = take_profit_price(t.fill_price!, t.stop_price, this.d.config.take_profit_r, rules.tick_size);
      await this.save(t);
      if (t.take_profit === null) return;
    }
    if (t.tp_seq > 0) {
      const tp_id = cid.tp(id, t.tp_seq);
      const cur = await this.find_algo(t.symbol, tp_id);
      if (cur && ALIVE_ALGO.has(cur.status)) return;
      if (!cur && this.recently_placed(tp_id)) return;
    }
    for (let attempt = 1; attempt <= PROTECT_MAX_ATTEMPTS; attempt++) {
      t.tp_seq++;
      await this.save(t);
      const client_id = cid.tp(id, t.tp_seq);
      this.placed_at.set(client_id, this.now());
      try {
        await gw.new_algo_order({
          symbol: t.symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', client_algo_id: client_id,
          trigger_price: format_step(t.take_profit, rules.tick_size), close_position: true,
        });
        await this.log(t, 'tp_placed', { client_id, tp: t.take_profit });
        return;
      } catch (err) {
        if (err instanceof ExchangeError && err.code === ERR_WOULD_IMMEDIATELY_TRIGGER) {
          await this.begin_flatten(t, 'take_profit', `价格已越过止盈 ${t.take_profit}`);
          return;
        }
        if (!(err instanceof ExchangeError) || !err.definite) {
          const found = await this.safe_get_algo(client_id);
          if (found && ALIVE_ALGO.has(found.status)) return;
        }
        await this.log(t, 'tp_failed', { client_id, attempt, error: err_text(err) });
      }
    }
    // 止盈挂不上不致命（止损仍在），告警后由下次对账重试
    this.d.notifier.alert(`⚠️ ${this.tag(t)} 止盈单连续挂单失败，下次对账重试`);
  }

  // ==================== 平仓 / 撤单 / 结算 ====================

  /** 转入平仓：记录原因，交给 closing 同步执行市价平仓 */
  private async begin_flatten(t: LiveTrade, reason: LiveExitReason, note: string): Promise<void> {
    if (t.exit_reason === null) t.exit_reason = reason;
    t.status = 'closing';
    await this.save(t);
    await this.log(t, 'flatten_begin', { reason, note });
    if (reason !== 'time' && reason !== 'stop' && reason !== 'take_profit') this.d.notifier.alert(`⚠️ ${this.tag(t)} 市价平仓（${reason}）：${note}`);
  }

  /** 撤入场单（过期 / 先破极值 / 暂停），随后同步确认（撤单与触发可能并发） */
  private async cancel_entry(t: LiveTrade, reason: string): Promise<void> {
    t.cancel_reason = reason;
    await this.save(t);
    await this.d.gateway!.cancel_algo_order(cid.entry(t.id!));
    await this.log(t, 'entry_cancel_sent', { reason });
    await this.sync(t);
  }

  /** 平仓结算：撤残余保护单，按成交明细计算盈亏 */
  private async settle(t: LiveTrade): Promise<void> {
    const gw = this.d.gateway!, id = t.id!;
    if (t.filled_qty === null || t.fill_price === null || t.fill_time === null) {
      await this.finish_cancelled(t, t.cancel_reason ?? 'no_position');
      return;
    }

    // 撤掉仍存活的止损 / 止盈（closePosition 单无持仓时虽不会成交，但必须清理）
    let sl: AlgoOrderInfo | null = null, tp: AlgoOrderInfo | null = null;
    if (t.sl_seq > 0) sl = await gw.get_algo_order(cid.sl(id, t.sl_seq));
    if (t.tp_seq > 0) tp = await gw.get_algo_order(cid.tp(id, t.tp_seq));
    if (sl && sl.status === 'NEW') await gw.cancel_algo_order(sl.client_algo_id);
    if (tp && tp.status === 'NEW') await gw.cancel_algo_order(tp.client_algo_id);

    const trades = await gw.get_user_trades(t.symbol, t.fill_time - 60_000);
    const entry_trades = trades.filter(x => x.order_id === t.entry_order_id);
    const exit_trades = trades.filter(x => x.side === 'BUY' && x.time >= t.fill_time! && x.order_id !== t.entry_order_id);
    const exit_qty = exit_trades.reduce((s, x) => s + x.qty, 0);

    if (exit_qty < t.filled_qty * 0.999) {
      const n = (this.settle_attempts.get(id) ?? 0) + 1;
      this.settle_attempts.set(id, n);
      if (n < SETTLE_MAX_ATTEMPTS) {
        if (t.status !== 'closing') { t.status = 'closing'; await this.save(t); }
        return;   // 成交明细可能稍有延迟，下次同步再结算
      }
      await this.log(t, 'settle_incomplete', { exit_qty, filled_qty: t.filled_qty });
    }

    const fee_rows = [...entry_trades, ...exit_trades];
    const non_usdt = fee_rows.filter(x => x.commission_asset !== 'USDT' && x.commission > 0);
    const fees = fee_rows.filter(x => x.commission_asset === 'USDT').reduce((s, x) => s + x.commission, 0);
    const gross = exit_trades.reduce((s, x) => s + x.realized_pnl, 0);
    const exit_time = exit_trades.length ? Math.max(...exit_trades.map(x => x.time)) : this.now();
    let funding = 0;
    try { funding = await gw.get_funding_fee(t.symbol, t.fill_time, exit_time + 1); } catch { /* 资金费取不到不影响结算 */ }

    const exit_vwap = exit_qty > 0 ? exit_trades.reduce((s, x) => s + x.price * x.qty, 0) / exit_qty : null;
    if (t.exit_reason === null) {
      if (sl && (sl.status === 'FINISHED' || sl.status === 'TRIGGERED')) t.exit_reason = 'stop';
      else if (tp && (tp.status === 'FINISHED' || tp.status === 'TRIGGERED')) t.exit_reason = 'take_profit';
      else if (!sl && !tp && exit_vwap !== null) {
        // 已结束的条件单查询不到时，按平仓均价推断（0.5% 容差），并留痕
        if (exit_vwap >= t.stop_price * 0.995) t.exit_reason = 'stop';
        else if (t.take_profit !== null && exit_vwap <= t.take_profit * 1.005) t.exit_reason = 'take_profit';
        else t.exit_reason = 'external';
        await this.log(t, 'exit_reason_inferred', { exit_vwap, reason: t.exit_reason });
      } else t.exit_reason = 'external';
    }
    const risk = t.filled_qty * (t.stop_price - t.fill_price);
    t.exit_time = exit_time;
    t.exit_price = exit_vwap;
    t.gross_pnl = gross;
    t.fees = fees;
    t.funding = funding;
    t.pnl = gross - fees + funding;
    t.r_multiple = risk > 0 ? t.pnl / risk : null;
    if (non_usdt.length) t.error_msg = `手续费含非 USDT 资产（${[...new Set(non_usdt.map(x => x.commission_asset))].join(',')}），未计入 fees`;
    t.status = 'closed';
    this.active.delete(id);
    this.settle_attempts.delete(id);
    this.flatten_attempts.delete(id);
    this.forget_placed(id);
    await this.save(t);
    await this.log(t, 'closed', { exit_reason: t.exit_reason, exit_price: t.exit_price, pnl: t.pnl, fees, funding });
    const emoji = t.pnl >= 0 ? '✅' : '❌';
    this.d.notifier.info(`${emoji} ${this.tag(t)} 平仓（${t.exit_reason}）@ ${t.exit_price ?? '-'}  净盈亏 ${t.pnl.toFixed(2)}U  ${t.r_multiple?.toFixed(2) ?? '-'}R`);
  }

  /** 入场未成交结束 */
  private async finish_cancelled(t: LiveTrade, reason: string): Promise<void> {
    t.status = 'cancelled';
    t.cancel_reason = reason;
    if (t.id !== undefined) { this.active.delete(t.id); this.forget_placed(t.id); }
    await this.save(t);
    await this.log(t, 'cancelled', { reason });
  }

  /** 无法自动收敛：转 error，告警，禁止开新仓 */
  private async mark_error(t: LiveTrade, msg: string): Promise<void> {
    t.status = 'error';
    t.error_msg = msg;
    this.active.delete(t.id!);
    this.errors.set(t.id!, t);
    await this.save(t);
    await this.log(t, 'error', { msg });
    this.d.notifier.alert(`🚨 ${this.tag(t)} 需人工处理：${msg}（已停止开新仓）`);
  }

  // ==================== K线收盘 ====================

  /**
   * 5m 收盘（可一次传入多根：重启预热 / 补缺口时批量追赶，只同步一次交易所）：
   * 先同步，再按时间顺序逐根套用模拟盘口径 —— 条件单过期 / 先破极值撤单 / 到时平仓，并更新 MFE/MAE。
   * 与模拟盘同一根K线生效：模拟盘在 open_time ≥ expire_at 的那根判过期，实盘在其前一根收盘时撤单；
   * 模拟盘同根先判触发再判极值，实盘若交易所未触发（条件单仍为 NEW）说明本根未触及触发价，触及极值即撤。
   */
  async on_bars(symbol: string, bars: PaperBar[]): Promise<void> {
    if (!bars.length) return;
    await this.locks.run(symbol, async () => {
      for (const t of this.get_active().filter(x => x.symbol === symbol)) {
        const todo = bars.filter(b => b.open_time > t.last_bar_time && b.open_time >= t.signal_time);
        if (!todo.length) continue;
        await this.guarded(t, async () => {
          await this.sync(t);
          for (const bar of todo) {
            if (t.status === 'pending') {
              if (bar.close_time + 1 >= t.expire_at) { await this.cancel_entry(t, 'expired'); break; }
              if (bar.high >= t.base_stop) { await this.cancel_entry(t, 'stop_before_entry'); break; }
            } else if (t.status === 'open') {
              this.update_excursion(t, bar);
              if (t.max_hold_until !== null && bar.close_time + 1 >= t.max_hold_until) {
                await this.begin_flatten(t, 'time', '到达最长持仓');
                await this.sync(t);
                break;
              }
            } else {
              break;
            }
          }
          if (this.active.has(t.id!)) {
            t.last_bar_time = Math.max(t.last_bar_time, todo[todo.length - 1].open_time);
            await this.save(t);
          }
        });
      }
    });
  }

  /** 更新 MFE / MAE（R）；成交当根只计不利波动，与模拟盘一致 */
  private update_excursion(t: LiveTrade, bar: PaperBar): void {
    if (t.fill_price === null || t.fill_time === null) return;
    const risk_px = t.stop_price - t.fill_price;
    if (!(risk_px > 0)) return;
    const fill_bar = Math.floor(t.fill_time / M5) * M5;
    if (bar.open_time < fill_bar) return;
    t.mae_r = Math.max(t.mae_r ?? 0, (bar.high - t.fill_price) / risk_px);
    if (bar.open_time > fill_bar) t.mfe_r = Math.max(t.mfe_r ?? 0, (t.fill_price - bar.low) / risk_px);
  }

  // ==================== 定时兜底 / 控制 ====================

  /**
   * 定时兜底（行情流中断时 K 线驱动的撤单 / 平仓不会发生）：
   * 过期仍挂着的入场单撤掉；超过最长持仓 1 分钟仍未平的市价平；控制开关为 flatten 时全部撤单平仓
   */
  async safety_tick(): Promise<void> {
    const now = this.now(), ctl = this.d.control();
    for (const t0 of this.get_active()) {
      await this.locks.run(t0.symbol, () => this.guarded(t0, async () => {
        const t = this.active.get(t0.id!);
        if (!t) return;
        await this.sync(t);
        if (t.status === 'pending' || t.status === 'placing') {
          if (ctl === 'flatten') await this.cancel_entry(t, 'control_flatten');
          else if (now >= t.expire_at + 5_000) await this.cancel_entry(t, 'expired');
          else if (t.status === 'pending' && t.cancel_reason) await this.cancel_entry(t, t.cancel_reason);   // 上次撤单失败，重试
        } else if (t.status === 'open' || t.status === 'entering') {
          if (ctl === 'flatten') {
            await this.begin_flatten(t, 'flatten', '控制开关一键平仓');
            await this.sync(t);
          } else if (t.status === 'open' && t.max_hold_until !== null && now >= t.max_hold_until + 60_000) {
            await this.begin_flatten(t, 'time', '到达最长持仓（兜底）');
            await this.sync(t);
          }
        }
      }));
    }
  }

  /**
   * 账户级对账：本程序管理之外的持仓告警；不属于任何进行中交易的本程序挂单（LV 前缀）撤掉
   * 返回非本程序管理的持仓币种（供告警限频）
   */
  async reconcile_account(): Promise<string[]> {
    if (this.d.mode !== 'live') return [];
    const gw = this.d.gateway!;
    const [positions, algos, orders] = await Promise.all([gw.get_open_positions(), gw.get_open_algo_orders(), gw.get_open_orders()]);
    const managed = new Set(this.get_active().map(t => t.symbol));
    for (const t of this.errors.values()) managed.add(t.symbol);
    const active_ids = new Set(this.get_active().map(t => t.id));

    const owner_id = (client_id: string): number | null => {
      const m = /^LV(\d+)/.exec(client_id);
      return m ? Number(m[1]) : null;
    };
    for (const a of algos) {
      if (!is_own_client_id(a.client_algo_id)) continue;
      const oid = owner_id(a.client_algo_id);
      if (oid !== null && !active_ids.has(oid)) {
        // 必须在锁内撤：避免与该币正在进行的操作竞争
        await this.locks.run(a.symbol, async () => {
          if (!this.active.has(oid)) await gw.cancel_algo_order(a.client_algo_id);
        });
        await this.d.store.log_event(oid, a.symbol, 'orphan_algo_cancelled', { client_algo_id: a.client_algo_id });
      }
    }
    for (const o of orders) {
      if (!is_own_client_id(o.client_order_id)) continue;
      const oid = owner_id(o.client_order_id);
      if (oid !== null && !active_ids.has(oid)) {
        await this.locks.run(o.symbol, async () => {
          if (!this.active.has(oid)) await gw.cancel_order(o.symbol, { order_id: o.order_id });
        });
        await this.d.store.log_event(oid, o.symbol, 'orphan_order_cancelled', { client_order_id: o.client_order_id });
      }
    }
    return positions.filter(p => p.amount !== 0 && !managed.has(p.symbol)).map(p => p.symbol);
  }

  // ==================== 工具 ====================

  /** 新建交易对象（未落库） */
  private new_trade(st: DivergenceStrategyConfig, setup: DivergenceSetup): LiveTrade {
    return {
      strategy_id: st.id, symbol: setup.symbol, timeframe: st.timeframe, side: 'short', status: 'skipped',
      trigger_time: setup.trigger_time, setup_time: setup.setup_time, signal_time: setup.setup_close_time + 1,
      entry_trigger: setup.entry_trigger, entry_limit: 0, base_stop: setup.extreme,
      stop_price: setup.extreme + st.stop_atr_buffer * setup.atr, take_profit: null,
      planned_qty: 0, leverage: 0, risk_usdt: 0,
      expire_at: setup.setup_time + (st.order_valid_bars + 1) * TIMEFRAME_MS[st.timeframe], max_hold_until: null,
      entry_mode: null, entry_order_id: null, filled_qty: null, fill_price: null, fill_time: null,
      sl_seq: 0, tp_seq: 0, exit_seq: 0,
      exit_time: null, exit_price: null, exit_reason: null,
      gross_pnl: null, fees: null, funding: null, pnl: null, r_multiple: null, mfe_r: null, mae_r: null,
      cancel_reason: null, error_msg: null, last_bar_time: setup.setup_time, features: setup.features,
    };
  }

  /** 计划写入交易 */
  private apply_plan(t: LiveTrade, p: EntryPlan): void {
    t.entry_trigger = p.entry_trigger;
    t.entry_limit = p.entry_limit;
    t.base_stop = p.base_stop;
    t.stop_price = p.stop_price;
    t.planned_qty = p.qty;
    t.leverage = p.leverage;
    t.risk_usdt = p.risk_usdt;
    t.expire_at = p.expire_at;
  }

  /** 挂单中（未成交）交易成交后将占用的保证金 */
  private reserved_margin(): number {
    let s = 0;
    for (const t of this.active.values()) {
      if ((t.status === 'placing' || t.status === 'pending') && t.leverage > 0) s += t.planned_qty * t.entry_trigger / t.leverage;
    }
    return s;
  }

  /** 查询条件单，出错返回 null（只用于结果未知时的确认） */
  private async safe_get_algo(client_id: string): Promise<AlgoOrderInfo | null> {
    try { return await this.d.gateway!.get_algo_order(client_id); } catch { return null; }
  }

  /**
   * 查条件单：按 client id 查不到时再查当前条件单列表
   * （实测条件单挂出后约 1 秒内按 client id 查询返回 -2013，不能据此判定不存在）
   */
  private async find_algo(symbol: string, client_id: string): Promise<AlgoOrderInfo | null> {
    const gw = this.d.gateway!;
    const a = await gw.get_algo_order(client_id);
    if (a) return a;
    const open = await gw.get_open_algo_orders(symbol);
    return open.find(x => x.client_algo_id === client_id) ?? null;
  }

  /** 清理某交易的挂单时刻记录 */
  private forget_placed(id: number): void {
    for (const k of [...this.placed_at.keys()]) {
      const m = /^LV(\d+)/.exec(k);
      if (m && Number(m[1]) === id) this.placed_at.delete(k);
    }
  }

  /** 本进程刚挂出的单（查询延迟宽限期内） */
  private recently_placed(client_id: string): boolean {
    const at = this.placed_at.get(client_id);
    return at !== undefined && this.now() - at <= PROTECT_GRACE_MS;
  }

  /** 执行单笔交易的操作，异常只记录（状态保持，下次同步重试） */
  private async guarded(t: LiveTrade, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      await this.log(t, 'op_error', { status: t.status, error: err_text(err) });
      console.error(`❌ ${this.tag(t)} 操作失败（${t.status}）: ${err_text(err)}`);
    }
  }

  private async save(t: LiveTrade): Promise<void> {
    if (t.id === undefined) return;
    try {
      await this.d.store.update_trade(t);
    } catch (err) {
      console.error(`❌ ${this.tag(t)} 写库失败: ${err_text(err)}`);
    }
  }

  private async log(t: LiveTrade, kind: string, payload: unknown): Promise<void> {
    try {
      await this.d.store.log_event(t.id ?? null, t.symbol, kind, payload);
    } catch (err) {
      console.error(`❌ 写事件失败 ${kind}: ${err_text(err)}`);
    }
  }

  private tag(t: LiveTrade): string {
    return `[${t.strategy_id}#${t.id ?? '-'}] ${t.symbol}`;
  }
}

/** 错误码（无则 unknown） */
function err_code(err: unknown): string {
  return err instanceof ExchangeError && err.code !== null ? String(err.code) : 'unknown';
}

/** 错误描述 */
export function err_text(err: unknown): string {
  if (err instanceof ExchangeError) return `${err.code ?? ''} ${err.message}${err.definite ? '' : '（结果未知）'}`.trim();
  return err instanceof Error ? err.message : String(err);
}
