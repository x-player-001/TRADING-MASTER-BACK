/**
 * 回放模拟账户（前端使用）
 *
 * 在 ReplayMatchingEngine 之上累积整个会话的全部仓位 / 委托 / 成交，
 * 支持从后端 GET /sessions/:id/state 恢复，并导出 POST /sessions/:id/sync 的同步数据。
 * 纯内存、无依赖：前端复制 replay_types.ts + replay_matching_engine.ts + 本文件即可。
 *
 * 用法：
 *   const account = new ReplayAccount(session, state_from_server);
 *   account.process_bar(next_bar);                      // 每揭示一根
 *   account.submit_order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 95 }, cursor_bar);
 *   fetch(`/sessions/${id}/sync`, { body: JSON.stringify(account.to_sync_payload(progress, revision)) });
 */

import { ReplayMatchingEngine, ReplayEngineState, calc_unrealized_pnl, new_client_id } from './replay_matching_engine';
import {
  ReplayBar,
  ReplayEngineConfig,
  ReplayEvent,
  ReplayFill,
  ReplayOrder,
  ReplayOrderType,
  ReplayPosition,
  ReplaySession,
  ReplaySide,
} from './replay_types';

/** 新委托参数（数量需前端事先换算好） */
export interface ReplayOrderInput {
  side: ReplaySide;
  order_type: ReplayOrderType;
  qty: number;
  price?: number | null;
  reduce_only?: boolean;
  stop_loss?: number | null;
  take_profit?: number | null;
  tags?: string[];
  note?: string | null;
}

/** 后端 GET /sessions/:id/state 返回的交易记录 */
export interface ReplayStoredState {
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  fills: ReplayFill[];
}

/** POST /sessions/:id/sync 的请求体 */
export interface ReplaySyncPayload {
  revision: number;
  progress: {
    cursor_time: number;
    last_price: number;
    balance: number;
    bars_stepped: number;
    status: ReplaySession['status'];
  };
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  fills: ReplayFill[];
}

export class ReplayAccount {
  readonly state: ReplayEngineState;
  readonly config: ReplayEngineConfig;
  /** 全部仓位（按创建顺序） */
  readonly positions = new Map<string, ReplayPosition>();
  /** 全部委托（按创建顺序） */
  readonly orders = new Map<string, ReplayOrder>();
  /** 全部成交 */
  readonly fills: ReplayFill[] = [];

  constructor(session: ReplaySession, stored?: ReplayStoredState) {
    this.config = {
      leverage: session.leverage,
      taker_fee_rate: session.taker_fee_rate,
      maker_fee_rate: session.maker_fee_rate,
      slippage_rate: session.slippage_rate,
    };
    this.state = {
      session_id: session.id as number,
      symbol: session.symbol,
      balance: session.balance,
      position: null,
      orders: [],
    };
    if (stored) {
      stored.positions.forEach(p => this.positions.set(p.client_id, p));
      stored.orders.forEach(o => this.orders.set(o.client_id, o));
      this.fills.push(...stored.fills);
      this.state.position = stored.positions.find(p => p.status === 'open') ?? null;
      this.state.orders = stored.orders.filter(o => o.status === 'pending');
    }
  }

  /** 推进一根新K线 */
  process_bar(bar: ReplayBar): ReplayEvent[] {
    return this.run(engine => engine.process_bar(bar));
  }

  /** 在当前游标K线收盘时下单（被拒时 order.status='rejected'） */
  submit_order(input: ReplayOrderInput, cursor_bar: ReplayBar): { order: ReplayOrder; events: ReplayEvent[] } {
    const order: ReplayOrder = {
      client_id: new_client_id(),
      session_id: this.state.session_id,
      position_client_id: null,
      side: input.side,
      order_type: input.order_type,
      qty: input.qty,
      price: input.order_type === 'market' ? null : input.price ?? null,
      reduce_only: Boolean(input.reduce_only),
      stop_loss: input.stop_loss ?? null,
      take_profit: input.take_profit ?? null,
      status: 'pending',
      created_bar_time: cursor_bar.open_time,
      filled_bar_time: null,
      filled_price: null,
      fee: 0,
      reject_reason: null,
      tags: input.tags ?? [],
      note: input.note ?? null,
    };
    const events = this.run(engine => engine.submit_order(order, cursor_bar));
    return { order, events };
  }

  /** 撤单 */
  cancel_order(client_id: string): ReplayEvent[] {
    const order = this.state.orders.find(o => o.client_id === client_id);
    if (!order) return [];
    return this.run(engine => engine.cancel_order(order, '手动撤单'));
  }

  /** 改持仓止损/止盈（undefined=不改，null=清除），返回错误信息或 null */
  set_protection(stop_loss: number | null | undefined, take_profit: number | null | undefined, cursor_bar: ReplayBar): string | null {
    let error: string | null = null;
    this.run(engine => { error = engine.set_protection(stop_loss, take_profit, cursor_bar); });
    return error;
  }

  /** 按当前收盘价市价平仓（qty 不传=全平） */
  close_position(cursor_bar: ReplayBar, qty: number | null = null): { error: string | null; events: ReplayEvent[] } {
    let error: string | null = null;
    const events = this.run(engine => { error = engine.close_position(cursor_bar, qty, 'manual'); });
    return { error, events };
  }

  /** 结束会话：平仓 + 撤掉全部挂单 */
  finish(cursor_bar: ReplayBar): ReplayEvent[] {
    return this.run(engine => {
      if (engine.state.position) engine.close_position(cursor_bar, null, 'session_end');
      for (const order of [...engine.state.orders]) engine.cancel_order(order, '会话结束');
    });
  }

  /** 修改某仓位的复盘标签/笔记 */
  update_journal(position_client_id: string, patch: { tags?: string[]; note?: string | null }): void {
    const pos = this.positions.get(position_client_id);
    if (!pos) return;
    if (patch.tags !== undefined) pos.tags = patch.tags;
    if (patch.note !== undefined) pos.note = patch.note;
  }

  /** 当前权益 */
  get_equity(price: number): number {
    return this.state.balance + calc_unrealized_pnl(this.state.position, price);
  }

  /** 导出同步数据（整份替换） */
  to_sync_payload(
    progress: Omit<ReplaySyncPayload['progress'], 'balance'>,
    revision: number,
  ): ReplaySyncPayload {
    return {
      revision,
      progress: { ...progress, balance: this.state.balance },
      positions: [...this.positions.values()],
      orders: [...this.orders.values()],
      fills: this.fills,
    };
  }

  /** 在账户状态上运行一次引擎操作并累积结果 */
  private run(action: (engine: ReplayMatchingEngine) => void): ReplayEvent[] {
    const engine = new ReplayMatchingEngine(this.state, this.config);
    action(engine);
    engine.touched_positions.forEach(p => this.positions.set(p.client_id, p));
    engine.touched_orders.forEach(o => this.orders.set(o.client_id, o));
    engine.fills.forEach(f => this.fills.push(f.fill));
    return engine.events;
  }
}
