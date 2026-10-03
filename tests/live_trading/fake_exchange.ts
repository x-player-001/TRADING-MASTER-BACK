/**
 * 单测用模拟交易所（单向持仓、逐仓），模拟币安条件单 / IOC / 市价 / closePosition 的关键语义：
 *   - STOP 卖出：最新价 ≤ 触发价时触发，生成 IOC 限价卖单（现价 ≥ 限价才成交，按现价全部成交）
 *   - STOP_MARKET / TAKE_PROFIT_MARKET 买入 closePosition：触发后市价平掉全部空仓
 *   - 挂单时已满足触发条件 → -2021；reduceOnly 无持仓 → -2022
 * 支持注入故障：某方法下一次调用抛错（可选「先执行再抛结果未知」）
 */

import {
  AlgoOrderInfo, ExchangeError, ExchangeGateway, LeverageBracket, NewAlgoOrderParams, NewOrderParams, OrderInfo,
  PositionInfo, UserTrade,
} from '@/services/live_trading/live_types';

interface Fault { method: string; error: ExchangeError; execute_first: boolean }

export class FakeExchange implements ExchangeGateway {
  price = new Map<string, number>();
  positions = new Map<string, { amount: number; entry: number }>();
  algos = new Map<string, AlgoOrderInfo>();
  orders = new Map<number, OrderInfo>();
  trades: UserTrade[] = [];
  available = 100;
  fee_rate = 0.0005;
  leverage = new Map<string, number>();
  calls: string[] = [];
  /** 查询延迟：条件单创建后该时长内按 client id / 列表都查不到（模拟实测的 -2013 延迟） */
  query_lag_ms = 0;
  private created_at = new Map<string, number>();
  private faults: Fault[] = [];
  private next_id = 1000;

  constructor(public clock: () => number) {}

  /** 注入故障 */
  fail_next(method: string, error: ExchangeError, execute_first = false): void {
    this.faults.push({ method, error, execute_first });
  }

  private fault(method: string): Fault | undefined {
    const i = this.faults.findIndex(f => f.method === method);
    return i >= 0 ? this.faults.splice(i, 1)[0] : undefined;
  }

  private pos(symbol: string) {
    return this.positions.get(symbol) ?? { amount: 0, entry: 0 };
  }

  /** 成交：更新持仓、记录明细（空单平仓计算已实现盈亏） */
  private fill(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, order_id: number): void {
    const p = this.pos(symbol);
    let realized = 0;
    if (side === 'SELL') {
      const amt = p.amount - qty;
      p.entry = p.amount === 0 ? price : (p.entry * -p.amount + price * qty) / -amt;
      p.amount = amt;
    } else {
      realized = (p.entry - price) * qty;
      p.amount = Number((p.amount + qty).toFixed(12));
      if (p.amount === 0) p.entry = 0;
    }
    this.positions.set(symbol, p);
    this.trades.push({
      id: this.next_id++, order_id, symbol, side, price, qty, realized_pnl: realized,
      commission: price * qty * this.fee_rate, commission_asset: 'USDT', time: this.clock(),
    });
  }

  /** 设定最新价并撮合触发条件单 */
  set_price(symbol: string, p: number): void {
    this.price.set(symbol, p);
    for (const a of [...this.algos.values()]) {
      if (a.symbol !== symbol || a.status !== 'NEW') continue;
      const hit = (a.order_type === 'STOP' && a.side === 'SELL' && p <= a.trigger_price)
        || (a.order_type === 'STOP_MARKET' && a.side === 'BUY' && p >= a.trigger_price)
        || (a.order_type === 'TAKE_PROFIT_MARKET' && a.side === 'BUY' && p <= a.trigger_price);
      if (!hit) continue;
      const oid = this.next_id++;
      if (a.order_type === 'STOP') {
        const ok = p >= a.price;
        this.orders.set(oid, this.order_info(oid, `algo-${a.algo_id}`, symbol, 'SELL', 'LIMIT', ok ? 'FILLED' : 'EXPIRED', a.quantity, ok ? a.quantity : 0, ok ? p : 0));
        if (ok) this.fill(symbol, 'SELL', a.quantity, p, oid);
      } else {
        const amt = this.pos(symbol).amount;
        const q = amt < 0 ? -amt : 0;
        this.orders.set(oid, this.order_info(oid, `algo-${a.algo_id}`, symbol, 'BUY', 'MARKET', q > 0 ? 'FILLED' : 'EXPIRED', q, q, q > 0 ? p : 0));
        if (q > 0) this.fill(symbol, 'BUY', q, p, oid);
      }
      a.status = 'FINISHED';
      a.actual_order_id = oid;
    }
  }

  private order_info(id: number, cid: string, symbol: string, side: 'BUY' | 'SELL', type: string, status: any, orig: number, exec: number, avg: number): OrderInfo {
    return { order_id: id, client_order_id: cid, symbol, side, type, status, orig_qty: orig, executed_qty: exec, avg_price: avg, update_time: this.clock() };
  }

  async new_algo_order(p: NewAlgoOrderParams): Promise<AlgoOrderInfo> {
    this.calls.push(`new_algo:${p.client_algo_id}`);
    const f = this.fault('new_algo_order');
    if (f && !f.execute_first) throw f.error;
    for (const a of this.algos.values()) {
      if (a.client_algo_id === p.client_algo_id && a.status === 'NEW') throw new ExchangeError('duplicate clientAlgoId', -4116, 400, true);
    }
    const px = this.price.get(p.symbol)!, trig = Number(p.trigger_price);
    const immediate = (p.type === 'STOP' && px <= trig) || (p.type === 'STOP_MARKET' && px >= trig) || (p.type === 'TAKE_PROFIT_MARKET' && px <= trig);
    if (immediate) throw new ExchangeError('Order would immediately trigger.', -2021, 400, true);
    const a: AlgoOrderInfo = {
      algo_id: this.next_id++, client_algo_id: p.client_algo_id, symbol: p.symbol, side: p.side, order_type: p.type,
      status: 'NEW', trigger_price: trig, price: Number(p.price ?? 0), quantity: Number(p.quantity ?? 0),
      close_position: !!p.close_position, actual_order_id: null, update_time: this.clock(),
    };
    this.algos.set(p.client_algo_id, a);
    this.created_at.set(p.client_algo_id, this.clock());
    if (f) throw f.error;   // 已执行但返回结果未知
    return { ...a };
  }

  private visible(client_algo_id: string): boolean {
    return this.clock() - (this.created_at.get(client_algo_id) ?? -Infinity) >= this.query_lag_ms;
  }

  async get_algo_order(client_algo_id: string): Promise<AlgoOrderInfo | null> {
    this.calls.push(`get_algo:${client_algo_id}`);
    const a = this.algos.get(client_algo_id);
    return a && this.visible(client_algo_id) ? { ...a } : null;
  }

  async cancel_algo_order(client_algo_id: string): Promise<void> {
    this.calls.push(`cancel_algo:${client_algo_id}`);
    const f = this.fault('cancel_algo_order');
    if (f) throw f.error;
    const a = this.algos.get(client_algo_id);
    if (a && a.status === 'NEW') a.status = 'CANCELED';
  }

  async get_open_algo_orders(symbol?: string): Promise<AlgoOrderInfo[]> {
    return [...this.algos.values()].filter(a => a.status === 'NEW' && (!symbol || a.symbol === symbol) && this.visible(a.client_algo_id)).map(a => ({ ...a }));
  }

  async new_order(p: NewOrderParams): Promise<OrderInfo> {
    this.calls.push(`new_order:${p.client_order_id}`);
    const f = this.fault('new_order');
    if (f) throw f.error;
    const px = this.price.get(p.symbol)!, qty = Number(p.quantity), oid = this.next_id++;
    if (p.type === 'LIMIT') {
      const ok = p.side === 'SELL' ? px >= Number(p.price) : px <= Number(p.price);
      const o = this.order_info(oid, p.client_order_id, p.symbol, p.side, 'LIMIT', ok ? 'FILLED' : 'EXPIRED', qty, ok ? qty : 0, ok ? px : 0);
      this.orders.set(oid, o);
      if (ok) this.fill(p.symbol, p.side, qty, px, oid);
      return { ...o };
    }
    const amt = this.pos(p.symbol).amount;
    if (p.reduce_only && (amt === 0 || (p.side === 'BUY' && amt > 0) || (p.side === 'SELL' && amt < 0))) {
      throw new ExchangeError('ReduceOnly Order is rejected.', -2022, 400, true);
    }
    const q = p.reduce_only ? Math.min(qty, Math.abs(amt)) : qty;
    const o = this.order_info(oid, p.client_order_id, p.symbol, p.side, 'MARKET', 'FILLED', qty, q, px);
    this.orders.set(oid, o);
    this.fill(p.symbol, p.side, q, px, oid);
    return { ...o };
  }

  async get_order(symbol: string, ref: { order_id?: number; client_order_id?: string }): Promise<OrderInfo | null> {
    for (const o of this.orders.values()) {
      if (o.symbol !== symbol) continue;
      if (ref.order_id !== undefined ? o.order_id === ref.order_id : o.client_order_id === ref.client_order_id) return { ...o };
    }
    return null;
  }

  async cancel_order(): Promise<void> { /* IOC / 市价单即时终态，无需处理 */ }
  async get_open_orders(): Promise<OrderInfo[]> { return []; }

  async get_position(symbol: string): Promise<PositionInfo> {
    const p = this.pos(symbol);
    return { symbol, amount: p.amount, entry_price: p.entry, liquidation_price: 0, margin_type: 'isolated', leverage: this.leverage.get(symbol) ?? 0 };
  }

  async get_open_positions(): Promise<PositionInfo[]> {
    const out: PositionInfo[] = [];
    for (const s of this.positions.keys()) { const p = await this.get_position(s); if (p.amount !== 0) out.push(p); }
    return out;
  }

  async get_user_trades(symbol: string, start_time: number): Promise<UserTrade[]> {
    return this.trades.filter(t => t.symbol === symbol && t.time >= start_time).map(t => ({ ...t }));
  }

  async get_funding_fee(): Promise<number> { return 0; }
  async get_available_balance(): Promise<number> { return this.available; }
  async get_leverage_bracket(): Promise<LeverageBracket> { return { max_leverage: 20, notional_cap: 5000, maint_margin_ratio: 0.01 }; }
  async set_isolated_margin(): Promise<void> { /* noop */ }
  async set_leverage(symbol: string, leverage: number): Promise<void> { this.leverage.set(symbol, leverage); }
}
