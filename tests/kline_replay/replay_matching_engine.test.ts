/**
 * K线回放撮合引擎 / 模拟账户 / 统计 单元测试（纯内存，不连数据库）
 */

import { ReplayMatchingEngine, ReplayEngineState } from '../../src/services/kline_replay/replay_matching_engine';
import { build_stats_report } from '../../src/services/kline_replay/replay_stats';
import { ReplayBar, ReplayOrder, ReplayPosition, ReplayEngineConfig, ReplaySession } from '../../src/services/kline_replay/replay_types';
import { ReplayAccount } from '../../src/services/kline_replay/replay_account';

const STEP = 5 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 1);

const CONFIG: ReplayEngineConfig = { leverage: 10, taker_fee_rate: 0.0005, maker_fee_rate: 0.0002, slippage_rate: 0 };

/** 构造第 i 根 5m K线 */
function bar(i: number, open: number, high: number, low: number, close: number): ReplayBar {
  return { open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open, high, low, close, volume: 1 };
}

/** 构造订单 */
function order(partial: Partial<ReplayOrder> & Pick<ReplayOrder, 'side' | 'order_type' | 'qty'>): ReplayOrder {
  return {
    client_id: '', position_client_id: null,
    session_id: 1, price: null, reduce_only: false, stop_loss: null, take_profit: null,
    status: 'pending', created_bar_time: 0, filled_bar_time: null, filled_price: null,
    fee: 0, reject_reason: null, tags: [], note: null, ...partial,
  };
}

function new_state(balance = 10000): ReplayEngineState {
  return { session_id: 1, symbol: 'TESTUSDT', balance, position: null, orders: [] };
}

function new_engine(state: ReplayEngineState, config: ReplayEngineConfig = CONFIG): ReplayMatchingEngine {
  return new ReplayMatchingEngine(state, config);
}

describe('ReplayMatchingEngine', () => {
  test('市价开多 → 下一根触及止盈平仓，盈亏/手续费/R 正确', () => {
    const state = new_state();
    const b0 = bar(0, 100, 101, 99, 100);
    let engine = new_engine(state);
    engine.submit_order(order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 98, take_profit: 104 }), b0);

    const pos = state.position as ReplayPosition;
    expect(pos.direction).toBe('long');
    expect(pos.avg_entry_price).toBe(100);
    expect(pos.risk_amount).toBeCloseTo(2);
    expect(state.balance).toBeCloseTo(10000 - 0.05);

    engine = new_engine(state);
    engine.process_bar(bar(1, 100, 105, 99.5, 104.5));

    expect(state.position).toBeNull();
    expect(pos.status).toBe('closed');
    expect(pos.exit_reason).toBe('take_profit');
    expect(pos.avg_exit_price).toBe(104);
    expect(pos.realized_pnl).toBeCloseTo(4);
    expect(pos.fee_total).toBeCloseTo(0.05 + 104 * 0.0005);
    expect(pos.r_multiple).toBeCloseTo((4 - pos.fee_total) / 2);
    expect(pos.bars_held).toBe(1);
    expect(state.balance).toBeCloseTo(10000 + pos.net_pnl);
  });

  test('多单同一根K线同时触及止损和止盈 → 保守口径先止损', () => {
    const state = new_state();
    new_engine(state).submit_order(order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 98, take_profit: 103 }), bar(0, 100, 100, 100, 100));
    const pos = state.position as ReplayPosition;
    new_engine(state).process_bar(bar(1, 100, 104, 97, 103.5));
    expect(pos.exit_reason).toBe('stop_loss');
    expect(pos.avg_exit_price).toBe(98);
  });

  test('空单同一根K线同时触及止损和止盈 → 先止损', () => {
    const state = new_state();
    new_engine(state).submit_order(order({ side: 'sell', order_type: 'market', qty: 1, stop_loss: 102, take_profit: 97 }), bar(0, 100, 100, 100, 100));
    const pos = state.position as ReplayPosition;
    expect(pos.direction).toBe('short');
    new_engine(state).process_bar(bar(1, 100, 103, 96, 97));
    expect(pos.exit_reason).toBe('stop_loss');
    expect(pos.realized_pnl).toBeCloseTo(-2);
  });

  test('空单止盈盈亏方向正确', () => {
    const state = new_state();
    new_engine(state).submit_order(order({ side: 'sell', order_type: 'market', qty: 2, stop_loss: 102, take_profit: 95 }), bar(0, 100, 100, 100, 100));
    const pos = state.position as ReplayPosition;
    new_engine(state).process_bar(bar(1, 99, 100, 94, 96));
    expect(pos.exit_reason).toBe('take_profit');
    expect(pos.realized_pnl).toBeCloseTo(10);
    expect(pos.mfe_pct).toBeCloseTo(5);   // 95 止盈离场，之后的下探不计入
  });

  test('限价挂单下一根才撮合；同根内成交后随即被止损', () => {
    const state = new_state();
    const b0 = bar(0, 100, 100.5, 99.5, 100);
    const o = order({ side: 'buy', order_type: 'limit', qty: 1, price: 97, stop_loss: 95 });
    new_engine(state).submit_order(o, b0);
    expect(o.status).toBe('pending');
    expect(state.position).toBeNull();

    // 空仓：开盘离高点近 → O→H→L→C；下行途中 97 成交，继续下探到 94 打掉 95 止损
    const engine = new_engine(state);
    engine.process_bar(bar(1, 100, 101, 94, 99));
    expect(o.status).toBe('filled');
    expect(o.filled_price).toBe(97);
    expect(state.position).toBeNull();
    const closed = engine.events.find(e => e.type === 'position_closed');
    expect(closed).toBeDefined();
    const pos = (closed as { position: ReplayPosition }).position;
    expect(pos.exit_reason).toBe('stop_loss');
    expect(pos.fee_total).toBeCloseTo(97 * 0.0002 + 95 * 0.0005);
  });

  test('跳空：止损按开盘价（不利）成交', () => {
    const state = new_state();
    new_engine(state).submit_order(order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 95 }), bar(0, 100, 100, 100, 100));
    const pos = state.position as ReplayPosition;
    new_engine(state).process_bar(bar(1, 93, 94, 92, 93.5));
    expect(pos.avg_exit_price).toBe(93);
    expect(pos.exit_reason).toBe('stop_loss');
  });

  test('跳空：限价单按挂单价（不吃红利）成交', () => {
    const state = new_state();
    const o = order({ side: 'buy', order_type: 'limit', qty: 1, price: 97 });
    new_engine(state).submit_order(o, bar(0, 100, 100, 99, 100));
    new_engine(state).process_bar(bar(1, 95, 96, 94, 95.5));
    expect(o.filled_price).toBe(97);
  });

  test('条件单触发价在当前价内侧 → 拒单', () => {
    const state = new_state();
    const o = order({ side: 'buy', order_type: 'stop', qty: 1, price: 99 });
    const engine = new_engine(state);
    engine.submit_order(o, bar(0, 100, 100, 100, 100));
    expect(o.status).toBe('rejected');
    expect(engine.events[0].type).toBe('order_rejected');
  });

  test('突破条件单触发后按触发价+滑点成交', () => {
    const state = new_state();
    const config = { ...CONFIG, slippage_rate: 0.001 };
    const o = order({ side: 'buy', order_type: 'stop', qty: 1, price: 102, stop_loss: 99 });
    new_engine(state, config).submit_order(o, bar(0, 100, 100, 100, 100));
    new_engine(state, config).process_bar(bar(1, 100, 103, 99.5, 102.5));
    expect(o.status).toBe('filled');
    expect(o.filled_price).toBeCloseTo(102 * 1.001);
    expect(state.position?.direction).toBe('long');
  });

  test('反手：持多 1 → 市价卖 2 → 平多(reverse) + 开空 1', () => {
    const state = new_state();
    const b0 = bar(0, 100, 100, 100, 100);
    new_engine(state).submit_order(order({ side: 'buy', order_type: 'market', qty: 1 }), b0);
    const long_pos = state.position as ReplayPosition;

    const engine = new_engine(state);
    engine.submit_order(order({ side: 'sell', order_type: 'market', qty: 2, stop_loss: 105 }), bar(1, 100, 102, 100, 102));
    expect(long_pos.status).toBe('closed');
    expect(long_pos.exit_reason).toBe('reverse');
    expect(long_pos.realized_pnl).toBeCloseTo(2);
    expect(state.position?.direction).toBe('short');
    expect(state.position?.qty).toBe(1);
    expect(state.position?.stop_loss).toBe(105);
  });

  test('只减仓挂单在仓位被止损后自动撤销', () => {
    const state = new_state();
    new_engine(state).submit_order(order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 98 }), bar(0, 100, 100, 100, 100));
    const tp_order = order({ side: 'sell', order_type: 'limit', qty: 1, price: 110, reduce_only: true });
    new_engine(state).submit_order(tp_order, bar(0, 100, 100, 100, 100));
    expect(tp_order.status).toBe('pending');

    new_engine(state).process_bar(bar(1, 100, 100, 97, 97.5));
    expect(state.position).toBeNull();
    expect(tp_order.status).toBe('cancelled');
    expect(state.orders).toHaveLength(0);
  });

  test('只减仓单在无反向仓位时拒绝', () => {
    const state = new_state();
    const o = order({ side: 'sell', order_type: 'market', qty: 1, reduce_only: true });
    new_engine(state).submit_order(o, bar(0, 100, 100, 100, 100));
    expect(o.status).toBe('rejected');
  });

  test('保证金不足拒单', () => {
    const state = new_state(1000);
    const o = order({ side: 'buy', order_type: 'market', qty: 101 }); // 名义 10100 / 10x = 1010 > 1000
    new_engine(state).submit_order(o, bar(0, 100, 100, 100, 100));
    expect(o.status).toBe('rejected');
    expect(o.reject_reason).toContain('保证金不足');
  });

  test('止损止盈方向校验', () => {
    const state = new_state();
    const o = order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 101 });
    new_engine(state).submit_order(o, bar(0, 100, 100, 100, 100));
    expect(o.status).toBe('rejected');
    expect(o.reject_reason).toContain('止损');
  });

  test('同向加仓：均价与计划风险累加', () => {
    const state = new_state();
    new_engine(state).submit_order(order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 95 }), bar(0, 100, 100, 100, 100));
    new_engine(state).submit_order(order({ side: 'buy', order_type: 'market', qty: 1 }), bar(1, 110, 110, 110, 110));
    const pos = state.position as ReplayPosition;
    expect(pos.qty).toBe(2);
    expect(pos.avg_entry_price).toBeCloseTo(105);
    expect(pos.risk_amount).toBeCloseTo(5 + 15);
  });

  test('持仓后补设止损 → 以此定义 1R', () => {
    const state = new_state();
    const engine = new_engine(state);
    engine.submit_order(order({ side: 'buy', order_type: 'market', qty: 2 }), bar(0, 100, 100, 100, 100));
    expect(state.position?.risk_amount).toBeNull();
    expect(engine.set_protection(97, undefined, bar(0, 100, 100, 100, 100))).toBeNull();
    expect(state.position?.risk_amount).toBeCloseTo(6);
    expect(engine.set_protection(101, undefined, bar(0, 100, 100, 100, 100))).toContain('止损');
  });

  test('手动部分平仓后仓位保留', () => {
    const state = new_state();
    const engine = new_engine(state);
    engine.submit_order(order({ side: 'buy', order_type: 'market', qty: 4 }), bar(0, 100, 100, 100, 100));
    engine.close_position(bar(1, 105, 105, 105, 105), 1, 'manual');
    const pos = state.position as ReplayPosition;
    expect(pos.qty).toBe(3);
    expect(pos.realized_pnl).toBeCloseTo(5);
    expect(pos.status).toBe('open');
  });
});

describe('replay_stats', () => {
  /** 构造已平仓回合 */
  function closed(id: number, net_pnl: number, r: number | null, tags: string[] = []): ReplayPosition {
    return {
      id, client_id: `p${id}`, session_id: 1, symbol: 'X', direction: id % 2 ? 'long' : 'short', status: 'closed', qty: 0, max_qty: 1,
      avg_entry_price: 100, exit_qty: 1, avg_exit_price: 100, stop_loss: null, take_profit: null,
      initial_stop_loss: null, risk_amount: null, realized_pnl: net_pnl, fee_total: 0, net_pnl, r_multiple: r,
      max_favorable_price: 100, max_adverse_price: 100, mfe_pct: 1, mae_pct: -1, open_bar_time: 0,
      close_bar_time: id * STEP, bars_held: 2, exit_reason: 'manual', tags, note: null,
    };
  }

  test('胜率、期望R、连亏、回撤', () => {
    const report = build_stats_report([
      closed(1, 20, 2, ['lv1']),
      closed(2, -10, -1, ['lv1']),
      closed(3, -10, -1),
      closed(4, 30, 3, ['lv1', 'breakout']),
    ], 1000);
    const s = report.overall;
    expect(s.trade_count).toBe(4);
    expect(s.win_rate).toBeCloseTo(0.5);
    expect(s.avg_r).toBeCloseTo(0.75);
    expect(s.max_consecutive_losses).toBe(2);
    expect(s.max_drawdown).toBeCloseTo(20);
    expect(s.max_drawdown_pct).toBeCloseTo(20 / 1020 * 100);
    expect(s.profit_factor).toBeCloseTo(50 / 20);
    expect(report.by_tag['lv1'].trade_count).toBe(3);
    expect(report.by_tag['(无标签)'].trade_count).toBe(1);
    expect(report.equity_curve[3].cum_net_pnl).toBeCloseTo(30);
  });
});

describe('ReplayAccount', () => {
  const SESSION: ReplaySession = {
    id: 7, name: 't', symbol: 'TESTUSDT', start_time: T0, cursor_time: T0, last_price: 100,
    initial_balance: 10000, balance: 10000, leverage: 10, taker_fee_rate: 0.0005, maker_fee_rate: 0.0002,
    slippage_rate: 0, status: 'active', bars_stepped: 0, sync_revision: 0, note: null,
  };

  test('累积全部历史，同步数据的关联完整（含反手）', () => {
    const account = new ReplayAccount(SESSION);
    account.submit_order({ side: 'buy', order_type: 'market', qty: 1, tags: ['lv1'] }, bar(0, 100, 100, 100, 100));
    const { order: reverse } = account.submit_order({ side: 'sell', order_type: 'market', qty: 2, stop_loss: 105 }, bar(1, 102, 102, 102, 102));
    account.process_bar(bar(2, 102, 106, 101, 105));   // 空单被 105 止损

    const payload = account.to_sync_payload({ cursor_time: T0 + 2 * STEP, last_price: 105, bars_stepped: 2, status: 'active' }, 1);
    expect(payload.positions).toHaveLength(2);
    expect(payload.positions.every(p => p.status === 'closed')).toBe(true);
    expect(payload.positions[0].tags).toEqual(['lv1']);
    expect(payload.fills).toHaveLength(4);   // 开多 / 平多 / 开空 / 空单止损

    const position_ids = new Set(payload.positions.map(p => p.client_id));
    expect(payload.fills.every(f => position_ids.has(f.position_client_id))).toBe(true);
    const short_pos = payload.positions.find(p => p.direction === 'short')!;
    expect(reverse.position_client_id).toBe(short_pos.client_id);   // 反手单关联新开的空仓
    expect(payload.progress.balance).toBeCloseTo(account.state.balance);
    expect(new Set([...payload.orders, ...payload.fills].map(x => x.client_id)).size).toBe(payload.orders.length + payload.fills.length);
  });

  test('从存储数据恢复后继续撮合', () => {
    const first = new ReplayAccount(SESSION);
    first.submit_order({ side: 'buy', order_type: 'market', qty: 1, stop_loss: 95 }, bar(0, 100, 100, 100, 100));
    first.submit_order({ side: 'sell', order_type: 'limit', qty: 1, price: 110, reduce_only: true }, bar(0, 100, 100, 100, 100));
    const saved = JSON.parse(JSON.stringify(first.to_sync_payload({ cursor_time: T0, last_price: 100, bars_stepped: 0, status: 'active' }, 1)));

    const restored = new ReplayAccount({ ...SESSION, balance: saved.progress.balance }, saved);
    expect(restored.state.position?.direction).toBe('long');
    expect(restored.state.orders).toHaveLength(1);

    restored.process_bar(bar(1, 100, 111, 99, 110));   // 触及 110 止盈挂单
    expect(restored.state.position).toBeNull();
    const payload = restored.to_sync_payload({ cursor_time: T0 + STEP, last_price: 110, bars_stepped: 1, status: 'active' }, 2);
    expect(payload.positions).toHaveLength(1);
    expect(payload.positions[0].exit_reason).toBe('order');
    expect(payload.orders.every(o => o.status === 'filled')).toBe(true);
  });
});
