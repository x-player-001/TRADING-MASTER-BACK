/**
 * K线回放模拟撮合引擎（纯内存、无 IO）
 *
 * 由前端运行（复制本文件与 replay_types.ts 即可，无其他依赖），后端只负责存储结果。
 * 需要累积历史、导出同步数据时用 replay_account.ts 的 ReplayAccount 封装。
 *
 * 账户模型：单向持仓（同一时刻最多一个方向的仓位），反向下单先平后开（反手）。
 *
 * 撮合规则：
 *   - 市价单：按当前游标K线收盘价立即成交（+不利滑点，taker）
 *   - 限价单：价格已穿越当前价则按收盘价立即成交（taker），否则挂单，从下一根K线开始撮合（maker）
 *   - 条件单(stop)：触发价必须在当前价外侧，触及后按触发价成交（+不利滑点，taker）
 *   - 持仓止损/止盈：触及后按触发价成交（+不利滑点，taker）
 *
 * K线内路径假设（5m 为最小粒度，无法得知真实先后顺序）：
 *   - 持多仓：O → L → H → C（先走不利方向，即「先打止损」的保守口径）
 *   - 持空仓：O → H → L → C
 *   - 空仓：  开盘价离高点更近走 O → H → L → C，否则 O → L → H → C（TradingView 规则）
 *   沿路径依次撮合，因此同一根K线内可以出现「挂单成交 → 随即被止损」。
 *
 * 跳空（开盘价已越过触发价）：
 *   - 对己不利的一律按开盘价成交（止损、条件单）
 *   - 对己有利的按挂单价成交（限价单、止盈），不吃跳空红利
 *
 * 不模拟强平；保证金不足时拒单。
 */

import {
  ReplayBar,
  ReplayDirection,
  ReplayEngineConfig,
  ReplayEvent,
  ReplayExitReason,
  ReplayFill,
  ReplayFillTrigger,
  ReplayOrder,
  ReplayPosition,
  ReplaySide,
  REPLAY_BASE_INTERVAL_MS,
} from './replay_types';

/** 引擎运行所需的账户状态 */
export interface ReplayEngineState {
  session_id: number;
  symbol: string;
  balance: number;                  // 已实现资金（初始资金 + 已实现盈亏 - 手续费）
  position: ReplayPosition | null;  // 当前持仓
  orders: ReplayOrder[];            // 挂单（仅 pending）
}

/** 成交记录（附带仓位/订单对象引用，持久化时再回填 id） */
export interface ReplayFillRecord {
  fill: ReplayFill;
  position: ReplayPosition;
  order: ReplayOrder | null;
}

/** 下一根K线中可能触发的价格点 */
interface PriceTrigger {
  kind: 'stop_loss' | 'take_profit' | 'order';
  price: number;
  dir: 'up' | 'down';          // 价格向上/向下穿越时触发
  priority: number;            // 同价位时的处理顺序（越小越先）
  order?: ReplayOrder;
}

/** 成交参数 */
interface FillParams {
  side: ReplaySide;
  qty: number;
  price: number;
  liquidity: 'maker' | 'taker';
  trigger: ReplayFillTrigger;
  bar_time: number;
  order: ReplayOrder | null;
  reduce_only: boolean;
  exit_reason: ReplayExitReason;
  attach_stop_loss: number | null;
  attach_take_profit: number | null;
}

const QTY_EPSILON = 1e-9;
const MAX_TRIGGERS_PER_SEGMENT = 100;

/** 生成前端唯一 id（浏览器 / Node 19+ 用 crypto.randomUUID，否则退化为随机串） */
export function new_client_id(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 买卖方向对应的仓位方向 */
export function side_to_direction(side: ReplaySide): ReplayDirection {
  return side === 'buy' ? 'long' : 'short';
}

/** 平掉某方向仓位需要的买卖方向 */
export function closing_side(direction: ReplayDirection): ReplaySide {
  return direction === 'long' ? 'sell' : 'buy';
}

/** 仓位在某价格下的浮动盈亏 */
export function calc_unrealized_pnl(position: ReplayPosition | null, price: number): number {
  if (!position || position.status !== 'open') return 0;
  const sign = position.direction === 'long' ? 1 : -1;
  return (price - position.avg_entry_price) * position.qty * sign;
}

/** 按有利/不利极值价刷新 MFE/MAE 百分比 */
export function refresh_excursion_pct(position: ReplayPosition): void {
  const avg = position.avg_entry_price;
  if (avg <= 0) return;
  if (position.direction === 'long') {
    position.mfe_pct = (position.max_favorable_price - avg) / avg * 100;
    position.mae_pct = (position.max_adverse_price - avg) / avg * 100;
  } else {
    position.mfe_pct = (avg - position.max_favorable_price) / avg * 100;
    position.mae_pct = (avg - position.max_adverse_price) / avg * 100;
  }
}

export class ReplayMatchingEngine {
  /** 本次操作中产生的成交 */
  readonly fills: ReplayFillRecord[] = [];
  /** 本次操作中产生的事件 */
  readonly events: ReplayEvent[] = [];
  /** 本次操作中被修改/新建的仓位（持久化用） */
  readonly touched_positions = new Set<ReplayPosition>();
  /** 本次操作中被修改/新建的订单（持久化用） */
  readonly touched_orders = new Set<ReplayOrder>();

  constructor(
    readonly state: ReplayEngineState,
    private readonly config: ReplayEngineConfig,
  ) {}

  // ==================== 对外操作 ====================

  /**
   * 提交订单（在当前游标K线收盘时刻）
   * @param order 新订单（status=pending，id 可为空）
   * @param bar   当前游标K线
   */
  submit_order(order: ReplayOrder, bar: ReplayBar): void {
    if (!order.client_id) order.client_id = new_client_id();
    this.touched_orders.add(order);
    order.created_bar_time = bar.open_time;

    const error = this.validate_new_order(order, bar);
    if (error) {
      this.reject_order(order, error);
      return;
    }

    if (order.order_type === 'market') {
      this.execute_order(order, this.with_slippage(order.side, bar.close), 'taker', 'market', bar.open_time);
      return;
    }

    const price = order.price as number;
    if (order.order_type === 'limit') {
      const marketable = order.side === 'buy' ? price >= bar.close : price <= bar.close;
      if (marketable) {
        this.execute_order(order, bar.close, 'taker', 'limit', bar.open_time);
        return;
      }
    }

    this.state.orders.push(order);
  }

  /**
   * 撤销挂单
   */
  cancel_order(order: ReplayOrder, reason: string): void {
    if (order.status !== 'pending') return;
    order.status = 'cancelled';
    order.reject_reason = reason;
    this.state.orders = this.state.orders.filter(o => o !== order);
    this.touched_orders.add(order);
    this.events.push({ type: 'order_cancelled', order, reason });
  }

  /**
   * 修改当前持仓的止损/止盈
   * @param stop_loss   undefined=不改，null=清除
   * @param take_profit undefined=不改，null=清除
   * @returns 错误信息，成功返回 null
   */
  set_protection(stop_loss: number | null | undefined, take_profit: number | null | undefined, bar: ReplayBar): string | null {
    const pos = this.state.position;
    if (!pos) return '当前无持仓';

    const sl = stop_loss === undefined ? pos.stop_loss : stop_loss;
    const tp = take_profit === undefined ? pos.take_profit : take_profit;
    const error = this.validate_protection(pos.direction, bar.close, sl, tp, '当前价');
    if (error) return error;

    pos.stop_loss = sl;
    pos.take_profit = tp;
    // 开仓时没设止损、之后首次设置 → 以此止损定义 1R
    if (sl !== null && pos.risk_amount === null) {
      pos.initial_stop_loss = sl;
      pos.risk_amount = Math.abs(pos.avg_entry_price - sl) * pos.qty;
    }
    this.touched_positions.add(pos);
    return null;
  }

  /**
   * 按当前收盘价市价平仓
   * @param qty 平仓数量，不传则全平
   */
  close_position(bar: ReplayBar, qty: number | null, trigger: 'manual' | 'session_end'): string | null {
    const pos = this.state.position;
    if (!pos) return '当前无持仓';
    const close_qty = qty === null ? pos.qty : Math.min(qty, pos.qty);
    if (!(close_qty > 0)) return '平仓数量必须大于 0';

    const side = closing_side(pos.direction);
    this.apply_fill({
      side,
      qty: close_qty,
      price: this.with_slippage(side, bar.close),
      liquidity: 'taker',
      trigger,
      bar_time: bar.open_time,
      order: null,
      reduce_only: true,
      exit_reason: trigger === 'manual' ? 'manual' : 'session_end',
      attach_stop_loss: null,
      attach_take_profit: null,
    });
    return null;
  }

  /**
   * 推进一根新K线：沿假设路径撮合挂单与持仓止损止盈
   */
  process_bar(bar: ReplayBar): void {
    this.fill_at_open(bar);

    const path = this.build_path(bar);
    let price = bar.open;
    for (let i = 1; i < path.length; i++) {
      this.walk(price, path[i], bar);
      price = path[i];
    }
  }

  /** 当前权益 = 已实现资金 + 浮动盈亏 */
  get_equity(price: number): number {
    return this.state.balance + calc_unrealized_pnl(this.state.position, price);
  }

  // ==================== 校验 ====================

  /** 新订单校验，返回错误信息 */
  private validate_new_order(order: ReplayOrder, bar: ReplayBar): string | null {
    if (!(order.qty > 0) || !Number.isFinite(order.qty)) return '数量必须大于 0';
    if (order.order_type !== 'market' && !(order.price !== null && order.price > 0)) {
      return '限价单/条件单必须指定价格';
    }

    const pos = this.state.position;
    const reducing = pos !== null && closing_side(pos.direction) === order.side;

    if (order.reduce_only) {
      if (!reducing) return '只减仓订单需要存在反方向持仓';
      order.stop_loss = null;
      order.take_profit = null;
    }

    if (order.order_type === 'stop') {
      const price = order.price as number;
      const ok = order.side === 'buy' ? price > bar.close : price < bar.close;
      if (!ok) return order.side === 'buy' ? '买入条件单触发价必须高于当前价' : '卖出条件单触发价必须低于当前价';
    }

    const ref_price = order.order_type === 'market' ? bar.close : order.price as number;
    const open_qty = this.opening_qty(order);
    if (open_qty > QTY_EPSILON) {
      const error = this.validate_protection(
        side_to_direction(order.side), ref_price, order.stop_loss, order.take_profit, '委托价',
      );
      if (error) return error;
      const margin_error = this.check_margin(order.side, open_qty, ref_price, bar.close);
      if (margin_error) return margin_error;
    } else {
      // 纯减仓单附带的止损止盈无意义
      order.stop_loss = null;
      order.take_profit = null;
    }
    return null;
  }

  /** 校验止损止盈相对参考价的方向 */
  private validate_protection(
    direction: ReplayDirection,
    ref_price: number,
    stop_loss: number | null,
    take_profit: number | null,
    ref_label: string,
  ): string | null {
    if (stop_loss !== null && !(stop_loss > 0)) return '止损价必须大于 0';
    if (take_profit !== null && !(take_profit > 0)) return '止盈价必须大于 0';
    if (direction === 'long') {
      if (stop_loss !== null && stop_loss >= ref_price) return `多单止损必须低于${ref_label}`;
      if (take_profit !== null && take_profit <= ref_price) return `多单止盈必须高于${ref_label}`;
    } else {
      if (stop_loss !== null && stop_loss <= ref_price) return `空单止损必须高于${ref_label}`;
      if (take_profit !== null && take_profit >= ref_price) return `空单止盈必须低于${ref_label}`;
    }
    return null;
  }

  /** 订单中会新开仓（或加仓）的数量 */
  private opening_qty(order: ReplayOrder): number {
    if (order.reduce_only) return 0;
    const pos = this.state.position;
    if (!pos) return order.qty;
    if (closing_side(pos.direction) !== order.side) return order.qty;
    return Math.max(0, order.qty - pos.qty);
  }

  /** 保证金检查：新开仓名义价值 / 杠杆 <= 可用权益 */
  private check_margin(side: ReplaySide, open_qty: number, fill_price: number, mark_price: number): string | null {
    const pos = this.state.position;
    const equity = this.get_equity(mark_price);
    // 同向加仓时旧仓已占用保证金；反手时旧仓会被平掉，不占用
    const same_direction = pos !== null && pos.direction === side_to_direction(side);
    const used = same_direction ? pos.qty * pos.avg_entry_price / this.config.leverage : 0;
    const required = open_qty * fill_price / this.config.leverage;
    if (required > equity - used + 1e-8) {
      return `保证金不足：需要 ${required.toFixed(2)}，可用 ${(equity - used).toFixed(2)}`;
    }
    return null;
  }

  // ==================== 路径撮合 ====================

  /** 构造K线内价格路径 */
  private build_path(bar: ReplayBar): number[] {
    const { open, high, low, close } = bar;
    const direction = this.state.position?.direction;
    if (direction === 'long') return [open, low, high, close];
    if (direction === 'short') return [open, high, low, close];
    return (high - open) < (open - low) ? [open, high, low, close] : [open, low, high, close];
  }

  /** 收集当前可触发的价格点（只包含下单K线之后的挂单） */
  private collect_triggers(bar: ReplayBar): PriceTrigger[] {
    const triggers: PriceTrigger[] = [];
    const pos = this.state.position;
    if (pos) {
      const is_long = pos.direction === 'long';
      if (pos.stop_loss !== null) {
        triggers.push({ kind: 'stop_loss', price: pos.stop_loss, dir: is_long ? 'down' : 'up', priority: 0 });
      }
      if (pos.take_profit !== null) {
        triggers.push({ kind: 'take_profit', price: pos.take_profit, dir: is_long ? 'up' : 'down', priority: 1 });
      }
    }
    this.state.orders.forEach((order, index) => {
      if (order.status !== 'pending' || order.created_bar_time >= bar.open_time) return;
      const is_buy = order.side === 'buy';
      const dir: 'up' | 'down' = order.order_type === 'limit'
        ? (is_buy ? 'down' : 'up')
        : (is_buy ? 'up' : 'down');
      triggers.push({ kind: 'order', price: order.price as number, dir, priority: 2 + index, order });
    });
    return triggers;
  }

  /** 开盘即越过触发价的（跳空）先处理 */
  private fill_at_open(bar: ReplayBar): void {
    for (let i = 0; i < MAX_TRIGGERS_PER_SEGMENT; i++) {
      const hit = this.collect_triggers(bar)
        .filter(t => t.dir === 'down' ? bar.open <= t.price : bar.open >= t.price)
        .sort((a, b) => a.priority - b.priority)[0];
      if (!hit) return;
      this.execute_trigger(hit, bar, true);
    }
  }

  /** 价格从 from 走到 to，依次撮合途经的触发价 */
  private walk(from: number, to: number, bar: ReplayBar): void {
    if (from === to) return;
    const dir: 'up' | 'down' = to > from ? 'up' : 'down';
    let current = from;

    for (let i = 0; i < MAX_TRIGGERS_PER_SEGMENT; i++) {
      const candidates = this.collect_triggers(bar).filter(t =>
        t.dir === dir && (dir === 'up'
          ? t.price >= current && t.price <= to
          : t.price <= current && t.price >= to),
      );
      if (candidates.length === 0) break;

      candidates.sort((a, b) =>
        Math.abs(a.price - current) - Math.abs(b.price - current) || a.priority - b.priority,
      );
      const hit = candidates[0];
      this.track_excursion(current, hit.price);
      this.execute_trigger(hit, bar, false);
      current = hit.price;
    }
    this.track_excursion(current, to);
  }

  /** 执行一个触发点 */
  private execute_trigger(trigger: PriceTrigger, bar: ReplayBar, at_open: boolean): void {
    const pos = this.state.position;

    if (trigger.kind === 'stop_loss' || trigger.kind === 'take_profit') {
      if (!pos) return;
      const side = closing_side(pos.direction);
      // 止损跳空按开盘价（不利），止盈跳空按止盈价（不吃红利）
      const base = trigger.kind === 'stop_loss' && at_open ? bar.open : trigger.price;
      this.apply_fill({
        side,
        qty: pos.qty,
        price: this.with_slippage(side, base),
        liquidity: 'taker',
        trigger: trigger.kind,
        bar_time: bar.open_time,
        order: null,
        reduce_only: true,
        exit_reason: trigger.kind,
        attach_stop_loss: null,
        attach_take_profit: null,
      });
      return;
    }

    const order = trigger.order as ReplayOrder;
    this.state.orders = this.state.orders.filter(o => o !== order);

    if (order.order_type === 'limit') {
      // 限价单按挂单价成交（跳空也不吃红利）
      this.execute_order(order, order.price as number, 'maker', 'limit', bar.open_time, bar.open);
    } else {
      // 条件单跳空按开盘价（不利）
      const base = at_open ? bar.open : order.price as number;
      this.execute_order(order, this.with_slippage(order.side, base), 'taker', 'stop', bar.open_time, bar.open);
    }
  }

  /**
   * 订单成交（含成交前的二次校验）
   * @param mark_price 用于保证金检查的标记价，默认用成交价
   */
  private execute_order(
    order: ReplayOrder,
    price: number,
    liquidity: 'maker' | 'taker',
    trigger: ReplayFillTrigger,
    bar_time: number,
    mark_price: number = price,
  ): void {
    this.touched_orders.add(order);
    const pos = this.state.position;

    if (order.reduce_only) {
      if (!pos || closing_side(pos.direction) !== order.side) {
        this.cancel_order(order, '无可减仓位');
        return;
      }
      order.qty = Math.min(order.qty, pos.qty);
    } else {
      const open_qty = this.opening_qty(order);
      if (open_qty > QTY_EPSILON) {
        const margin_error = this.check_margin(order.side, open_qty, price, mark_price);
        if (margin_error) {
          this.reject_order(order, margin_error);
          return;
        }
      }
    }

    const fill_record = this.apply_fill({
      side: order.side,
      qty: order.qty,
      price,
      liquidity,
      trigger,
      bar_time,
      order,
      reduce_only: order.reduce_only,
      exit_reason: 'order',
      attach_stop_loss: order.stop_loss,
      attach_take_profit: order.take_profit,
    });

    order.status = 'filled';
    order.filled_bar_time = bar_time;
    order.filled_price = price;
    order.fee = fill_record.fee;
  }

  // ==================== 成交记账 ====================

  /**
   * 成交入账：先减/平反向仓位，剩余数量开新仓或同向加仓
   * @returns 本次成交总手续费
   */
  private apply_fill(p: FillParams): { fee: number } {
    const fee_rate = p.liquidity === 'maker' ? this.config.maker_fee_rate : this.config.taker_fee_rate;
    let remaining = p.qty;
    let total_fee = 0;
    const pos = this.state.position;

    // 1) 减仓 / 平仓
    if (pos && closing_side(pos.direction) === p.side) {
      const reduce_qty = Math.min(remaining, pos.qty);
      const fee = reduce_qty * p.price * fee_rate;
      const sign = pos.direction === 'long' ? 1 : -1;
      const pnl = (p.price - pos.avg_entry_price) * reduce_qty * sign;

      this.state.balance += pnl - fee;
      pos.realized_pnl += pnl;
      pos.fee_total += fee;
      pos.avg_exit_price = ((pos.avg_exit_price ?? 0) * pos.exit_qty + p.price * reduce_qty) / (pos.exit_qty + reduce_qty);
      pos.exit_qty += reduce_qty;
      pos.qty -= reduce_qty;
      total_fee += fee;
      remaining -= reduce_qty;

      const closed = pos.qty <= pos.max_qty * QTY_EPSILON;
      this.record_fill(p, reduce_qty, fee, closed ? 'close' : 'reduce', pnl, pos);
      if (closed) {
        const reversing = !p.reduce_only && remaining > QTY_EPSILON;
        this.finalize_position(pos, p.bar_time, reversing ? 'reverse' : p.exit_reason);
      } else {
        this.touched_positions.add(pos);
      }
    }

    if (p.reduce_only || remaining <= QTY_EPSILON) {
      return { fee: total_fee };
    }

    // 2) 开仓 / 加仓
    const fee = remaining * p.price * fee_rate;
    this.state.balance -= fee;
    total_fee += fee;

    const current = this.state.position;
    if (current) {
      // 同向加仓
      const new_qty = current.qty + remaining;
      current.avg_entry_price = (current.avg_entry_price * current.qty + p.price * remaining) / new_qty;
      current.qty = new_qty;
      current.max_qty = Math.max(current.max_qty, new_qty);
      current.fee_total += fee;
      if (p.attach_stop_loss !== null) current.stop_loss = p.attach_stop_loss;
      if (p.attach_take_profit !== null) current.take_profit = p.attach_take_profit;
      if (current.stop_loss !== null) {
        if (current.risk_amount === null) {
          current.initial_stop_loss = current.stop_loss;
          current.risk_amount = Math.abs(current.avg_entry_price - current.stop_loss) * current.qty;
        } else {
          current.risk_amount += Math.abs(p.price - current.stop_loss) * remaining;
        }
      }
      refresh_excursion_pct(current);
      this.touched_positions.add(current);
      this.record_fill(p, remaining, fee, 'add', 0, current);
    } else {
      const created = this.open_position(p, remaining, fee);
      this.record_fill(p, remaining, fee, 'open', 0, created);
      this.events.push({ type: 'position_opened', position: created });
    }
    return { fee: total_fee };
  }

  /** 新建仓位 */
  private open_position(p: FillParams, qty: number, fee: number): ReplayPosition {
    const position: ReplayPosition = {
      client_id: new_client_id(),
      session_id: this.state.session_id,
      symbol: this.state.symbol,
      direction: side_to_direction(p.side),
      status: 'open',
      qty,
      max_qty: qty,
      avg_entry_price: p.price,
      exit_qty: 0,
      avg_exit_price: null,
      stop_loss: p.attach_stop_loss,
      take_profit: p.attach_take_profit,
      initial_stop_loss: p.attach_stop_loss,
      risk_amount: p.attach_stop_loss !== null ? Math.abs(p.price - p.attach_stop_loss) * qty : null,
      realized_pnl: 0,
      fee_total: fee,
      net_pnl: 0,
      r_multiple: null,
      max_favorable_price: p.price,
      max_adverse_price: p.price,
      mfe_pct: 0,
      mae_pct: 0,
      open_bar_time: p.bar_time,
      close_bar_time: null,
      bars_held: null,
      exit_reason: null,
      tags: p.order ? [...p.order.tags] : [],
      note: p.order ? p.order.note : null,
    };
    this.state.position = position;
    this.touched_positions.add(position);
    return position;
  }

  /** 仓位平完：结算并撤掉残留的只减仓挂单 */
  private finalize_position(pos: ReplayPosition, bar_time: number, reason: ReplayExitReason): void {
    pos.status = 'closed';
    pos.qty = 0;
    pos.close_bar_time = bar_time;
    pos.bars_held = Math.round((bar_time - pos.open_bar_time) / REPLAY_BASE_INTERVAL_MS);
    pos.exit_reason = reason;
    pos.net_pnl = pos.realized_pnl - pos.fee_total;
    pos.r_multiple = pos.risk_amount && pos.risk_amount > 0 ? pos.net_pnl / pos.risk_amount : null;
    refresh_excursion_pct(pos);

    this.state.position = null;
    this.touched_positions.add(pos);
    this.events.push({ type: 'position_closed', position: pos });

    for (const order of [...this.state.orders]) {
      if (order.reduce_only) this.cancel_order(order, '仓位已平，只减仓单自动撤销');
    }
  }

  /** 记录成交 */
  private record_fill(
    p: FillParams,
    qty: number,
    fee: number,
    action: ReplayFill['action'],
    realized_pnl: number,
    position: ReplayPosition,
  ): void {
    const fill: ReplayFill = {
      client_id: new_client_id(),
      session_id: this.state.session_id,
      position_client_id: position.client_id,
      order_client_id: p.order?.client_id ?? null,
      side: p.side,
      qty,
      price: p.price,
      fee,
      liquidity: p.liquidity,
      trigger_type: p.trigger,
      action,
      realized_pnl,
      bar_time: p.bar_time,
    };
    // 委托关联到最后作用的仓位（反手单 = 新开的仓位）
    if (p.order) p.order.position_client_id = position.client_id;
    this.fills.push({ fill, position, order: p.order });
    this.events.push({ type: 'fill', fill });
  }

  // ==================== 工具 ====================

  /** 更新持仓期间的最有利/最不利价格 */
  private track_excursion(a: number, b: number): void {
    const pos = this.state.position;
    if (!pos) return;
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    if (pos.direction === 'long') {
      pos.max_favorable_price = Math.max(pos.max_favorable_price, high);
      pos.max_adverse_price = Math.min(pos.max_adverse_price, low);
    } else {
      pos.max_favorable_price = Math.min(pos.max_favorable_price, low);
      pos.max_adverse_price = Math.max(pos.max_adverse_price, high);
    }
    refresh_excursion_pct(pos);
    this.touched_positions.add(pos);
  }

  /** 加不利滑点 */
  private with_slippage(side: ReplaySide, price: number): number {
    const s = this.config.slippage_rate;
    return side === 'buy' ? price * (1 + s) : price * (1 - s);
  }

  /** 拒单 */
  private reject_order(order: ReplayOrder, reason: string): void {
    order.status = 'rejected';
    order.reject_reason = reason;
    this.state.orders = this.state.orders.filter(o => o !== order);
    this.touched_orders.add(order);
    this.events.push({ type: 'order_rejected', order, reason });
  }
}
