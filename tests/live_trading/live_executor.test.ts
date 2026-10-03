/**
 * 实盘执行器单测（模拟交易所）：
 *   入场条件单 → 成交 → 止损止盈 → 止盈/止损/到时平仓 → 结算；过期 / 先破极值撤单；
 *   挂单时已越过触发价走 IOC；跳空低于限价不成交；止损丢失重挂；成交即越过止损立刻平仓；
 *   下单结果未知不重复下单；重启续跑；风控（同币占用 / 并发上限 / 日亏损 / 过期信号 / 非本程序持仓）；一键平仓
 */

import { LiveExecutor, LiveTradeStore, LiveNotifier, cid } from '@/services/live_trading/live_executor';
import { LIVE_CONFIG as REAL_LIVE_CONFIG, live_strategies } from '@/services/live_trading/live_config';
import { ExchangeError, LiveControlMode, LiveTrade, SymbolRules } from '@/services/live_trading/live_types';
import { DivergenceSetup, PaperBar } from '@/services/paper_trading/paper_types';
import { FakeExchange } from './fake_exchange';

/** 测试固定配置（与实盘配置解耦，实盘调参不影响用例） */
const LIVE_CONFIG = { ...REAL_LIVE_CONFIG, risk_per_trade_usdt: 2, max_notional_usdt: 150, max_leverage: 10, max_active_trades: 3, daily_loss_limit_usdt: 8 };

const M5 = 300_000, M15 = 900_000;
const SYM = 'ABCUSDT';
const T0 = 2_000_000 * M15;                    // 反转K线 open_time（15m 对齐）
const SIGNAL = T0 + M15;                       // 信号可用时刻

const RULES: SymbolRules = {
  symbol: SYM, status: 'TRADING', tick_size: '0.01', step_size: '0.001', min_qty: 0.001, max_qty: 1e6,
  market_step_size: '0.001', market_max_qty: 1e5, min_notional: 5, percent_down: 0.95,
};

/** 内存存储（快照保存，模拟落库） */
class MemoryStore implements LiveTradeStore {
  rows = new Map<number, LiveTrade>();
  events: { trade_id: number | null; kind: string; payload: unknown }[] = [];
  private next = 1;
  async insert_trade(t: LiveTrade): Promise<number | null> {
    for (const r of this.rows.values()) {
      if (r.strategy_id === t.strategy_id && r.symbol === t.symbol && r.setup_time === t.setup_time) return null;
    }
    const id = this.next++;
    this.rows.set(id, JSON.parse(JSON.stringify({ ...t, id })));
    return id;
  }
  async update_trade(t: LiveTrade): Promise<void> { this.rows.set(t.id!, JSON.parse(JSON.stringify(t))); }
  async log_event(trade_id: number | null, _symbol: string, kind: string, payload: unknown): Promise<void> { this.events.push({ trade_id, kind, payload }); }
  async realized_pnl_since(ts: number): Promise<number> {
    let s = 0;
    for (const r of this.rows.values()) if (r.status === 'closed' && (r.exit_time ?? 0) >= ts) s += r.pnl ?? 0;
    return s;
  }
  snapshot(): LiveTrade[] { return [...this.rows.values()].map(r => JSON.parse(JSON.stringify(r))); }
}

function setup(over: Partial<DivergenceSetup> = {}): DivergenceSetup {
  return {
    symbol: SYM, timeframe: '15m', dir: 1, trigger_time: T0 - M15, setup_time: T0, setup_close_time: T0 + M15 - 1,
    entry_trigger: 100, extreme: 104, atr: 2,
    features: { dif_ratio: 0.4, hist_ratio: 0.1, gap: 10, gdep: 0.5, imp_pct: 30, leg_pct: 12, qv24_m: 50, qv_surge: 1.5, atr_pct: 2, range48: 20, wait: 1, wick: 0.3, body: 0.6 },
    ...over,
  };
}

function bar(t: number, h: number, l: number, c = (h + l) / 2): PaperBar {
  return { open_time: t, close_time: t + M5 - 1, open: c, high: h, low: l, close: c, volume: 1, quote_volume: c };
}

interface Ctx {
  ex: FakeExchange;
  store: MemoryStore;
  exec: LiveExecutor;
  clock: { now: number };
  control: { mode: LiveControlMode };
  alerts: string[];
}

function make(opts: { store?: MemoryStore; ex?: FakeExchange; clock?: { now: number }; control?: { mode: LiveControlMode } } = {}): Ctx {
  const clock = opts.clock ?? { now: SIGNAL + 2000 };
  const ex = opts.ex ?? new FakeExchange(() => clock.now);
  if (!opts.ex) ex.set_price(SYM, 101);
  const store = opts.store ?? new MemoryStore();
  const control = opts.control ?? { mode: 'running' as LiveControlMode };
  const alerts: string[] = [];
  const notifier: LiveNotifier = { info: () => undefined, alert: m => { alerts.push(m); } };
  const exec = new LiveExecutor({
    mode: 'live', gateway: ex, store, notifier, config: LIVE_CONFIG, strategies: live_strategies(),
    rules: s => (s === SYM ? RULES : null), control: () => control.mode, now: () => clock.now,
  });
  return { ex, store, exec, clock, control, alerts };
}

/** 下单并触发成交，返回 open 状态的交易 */
async function open_trade(c: Ctx, fill_px = 99.5): Promise<LiveTrade> {
  const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
  expect(t.status).toBe('pending');
  c.clock.now += 60_000;
  c.ex.set_price(SYM, fill_px);
  await c.exec.sync_symbol(SYM);
  expect(t.status).toBe('open');
  return t;
}

describe('LiveExecutor 生命周期', () => {
  it('挂入场条件单 → 成交 → 挂止损止盈 → 止盈平仓结算', async () => {
    const c = make();
    const t = await open_trade(c);
    const entry = c.ex.algos.get(cid.entry(t.id!))!;
    expect(entry).toMatchObject({ order_type: 'STOP', side: 'SELL', trigger_price: 100, price: 98, quantity: 0.5 });
    expect(c.ex.leverage.get(SYM)).toBe(t.leverage);
    expect(t.filled_qty).toBe(0.5);
    expect(t.fill_price).toBe(99.5);
    expect(t.take_profit).toBe(90.5);                                 // 99.5 − 2 × 4.5
    expect(c.ex.algos.get(cid.sl(t.id!, 1))).toMatchObject({ order_type: 'STOP_MARKET', trigger_price: 104, close_position: true, status: 'NEW' });
    expect(c.ex.algos.get(cid.tp(t.id!, 1))).toMatchObject({ order_type: 'TAKE_PROFIT_MARKET', trigger_price: 90.5, status: 'NEW' });
    // 最长持仓：成交所在 15m 桶 + 49 根
    const fill_bucket = Math.floor(t.fill_time! / M15) * M15;
    expect(t.max_hold_until).toBe(fill_bucket + 49 * M15);

    c.clock.now += 600_000;
    c.ex.set_price(SYM, 90.4);
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('take_profit');
    const fees = (99.5 * 0.5 + 90.4 * 0.5) * 0.0005;
    expect(t.gross_pnl).toBeCloseTo((99.5 - 90.4) * 0.5, 9);
    expect(t.fees).toBeCloseTo(fees, 9);
    expect(t.pnl).toBeCloseTo((99.5 - 90.4) * 0.5 - fees, 9);
    expect(t.r_multiple).toBeCloseTo(t.pnl! / (0.5 * 4.5), 9);
    expect(c.ex.algos.get(cid.sl(t.id!, 1))!.status).toBe('CANCELED');   // 残余止损已撤
    expect(c.exec.get_active()).toHaveLength(0);
    expect(c.store.rows.get(t.id!)!.status).toBe('closed');
  });

  it('止损触发 → 结算 stop，止盈单被撤', async () => {
    const c = make();
    const t = await open_trade(c);
    c.ex.set_price(SYM, 104.2);
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('stop');
    expect(t.pnl!).toBeLessThan(0);
    expect(c.ex.algos.get(cid.tp(t.id!, 1))!.status).toBe('CANCELED');
  });

  it('到达最长持仓 → 收盘市价平仓（time）', async () => {
    const c = make();
    const t = await open_trade(c);
    const last = t.max_hold_until! - M5;
    c.clock.now = t.max_hold_until! + 1000;
    c.ex.set_price(SYM, 98);
    await c.exec.on_bars(SYM, [bar(last, 99, 97)]);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('time');
    expect(c.ex.calls).toContain(`new_order:${cid.exit(t.id!, 1)}`);
    expect(c.ex.positions.get(SYM)!.amount).toBe(0);
  });

  it('MFE / MAE：成交当根只计不利波动', async () => {
    const c = make();
    const t = await open_trade(c);
    const fill_bar = Math.floor(t.fill_time! / M5) * M5;
    await c.exec.on_bars(SYM, [bar(fill_bar, 101.75, 97)]);
    expect(t.mae_r).toBeCloseTo(0.5, 9);    // (101.75 − 99.5) / 4.5
    expect(t.mfe_r).toBe(0);
    await c.exec.on_bars(SYM, [bar(fill_bar + M5, 100, 95)]);
    expect(t.mfe_r).toBeCloseTo(1, 9);      // (99.5 − 95) / 4.5
  });
});

describe('LiveExecutor 入场单', () => {
  it('条件单到期：失效前最后一根收盘撤单（与模拟盘同一根生效）', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    const before_last = t.expire_at - 2 * M5;
    await c.exec.on_bars(SYM, [bar(before_last, 102, 100.5)]);
    expect(t.status).toBe('pending');
    await c.exec.on_bars(SYM, [bar(t.expire_at - M5, 102, 100.5)]);
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('expired');
    expect(c.ex.algos.get(cid.entry(t.id!))!.status).toBe('CANCELED');
  });

  it('未触发先破极值 → 撤单', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    await c.exec.on_bars(SYM, [bar(SIGNAL, 104, 101)]);
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('stop_before_entry');
  });

  it('撤单失败 → 保持 pending，兜底定时重试撤单', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    c.ex.fail_next('cancel_algo_order', new ExchangeError('Too many requests', -1003, 429, true));
    await c.exec.on_bars(SYM, [bar(SIGNAL, 104, 101)]);
    expect(t.status).toBe('pending');
    expect(t.cancel_reason).toBe('stop_before_entry');
    await c.exec.safety_tick();
    expect(t.status).toBe('cancelled');
  });

  it('挂单时已越过触发价 → IOC 限价直接成交并立即挂止损', async () => {
    const c = make();
    c.ex.set_price(SYM, 99);
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.entry_mode).toBe('ioc');
    expect(t.status).toBe('open');
    expect(t.fill_price).toBe(99);
    expect(c.ex.algos.get(cid.sl(t.id!, 1))!.status).toBe('NEW');
  });

  it('跳空低于 IOC 限价 → 不成交，交易取消（对应模拟盘 risk_out_of_range）', async () => {
    const c = make();
    c.ex.set_price(SYM, 97.9);
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('entry_unfilled');
    expect(c.ex.positions.get(SYM)?.amount ?? 0).toBe(0);
  });

  it('条件单触发但 IOC 未成交（价格穿过限价）→ 取消', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    c.ex.set_price(SYM, 97);
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('entry_unfilled');
  });

  it('下单结果未知（实际已挂上）→ 查询确认，不重复下单', async () => {
    const c = make();
    c.ex.fail_next('new_algo_order', new ExchangeError('timeout', null, null, false), true);
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.status).toBe('pending');      // submit 内的即时同步已按 client id 查到
    expect(c.ex.calls.filter(x => x.startsWith('new_algo:')).length).toBe(1);
  });

  it('下单结果未知（实际未挂上）→ 超时后取消', async () => {
    const c = make();
    c.ex.fail_next('new_algo_order', new ExchangeError('timeout', null, null, false), false);
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.status).toBe('placing');
    c.clock.now = SIGNAL + 130_000;
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('entry_not_found');
  });

  it('交易所明确拒绝入场单 → 取消', async () => {
    const c = make();
    c.ex.fail_next('new_algo_order', new ExchangeError('Invalid symbol status', -4140, 400, true));
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('entry_rejected:-4140');
    expect(c.alerts.some(a => a.includes('入场条件单被拒'))).toBe(true);
  });

  it('挂单时保证金不足 → 记录 insufficient_margin，不告警', async () => {
    const c = make();
    c.ex.fail_next('new_algo_order', new ExchangeError('Margin is insufficient.', -2019, 400, true));
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('insufficient_margin');
    expect(c.alerts).toHaveLength(0);
    expect(c.store.rows.get(t.id!)!.cancel_reason).toBe('insufficient_margin');
  });

  it('计划阶段保证金不足 → 记为 skipped / insufficient_margin，不告警', async () => {
    const c = make();
    c.ex.available = 10;
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t).toMatchObject({ status: 'skipped', cancel_reason: 'insufficient_margin' });
    expect(c.alerts).toHaveLength(0);
    expect(c.store.rows.get(t.id!)!.status).toBe('skipped');
  });
});

describe('LiveExecutor 交易所查询延迟（实测挂单后约 1 秒查不到）', () => {
  it('入场单刚挂出查不到 → 不判定取消，延迟过后正常为 pending', async () => {
    const c = make();
    c.ex.query_lag_ms = 1500;
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    expect(t.status).toBe('pending');          // submit 内即时同步查不到，仍保持 pending
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('pending');
    expect(c.ex.algos.get(cid.entry(t.id!))!.status).toBe('NEW');
    c.clock.now += 2000;
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('pending');
  });

  it('止损刚挂出查不到 → 不重复挂止损', async () => {
    const c = make();
    c.ex.query_lag_ms = 1500;
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    c.clock.now += 5000;
    c.ex.set_price(SYM, 99.5);
    await c.exec.sync_symbol(SYM);            // 成交 → 挂止损止盈 → open
    expect(t.status).toBe('open');
    await c.exec.sync_symbol(SYM);            // 同一时刻再同步（推送触发），止损仍查不到
    await c.exec.sync_symbol(SYM);
    expect(t.sl_seq).toBe(1);
    expect(t.tp_seq).toBe(1);
    c.clock.now += 2000;
    await c.exec.sync_symbol(SYM);
    expect(t.sl_seq).toBe(1);
  });

  it('宽限期过后仍查不到（真的不存在）→ 重挂止损', async () => {
    const c = make();
    const t = await open_trade(c);
    c.ex.algos.delete(cid.sl(t.id!, 1));
    c.clock.now += 20_000;
    await c.exec.sync_symbol(SYM);
    expect(t.sl_seq).toBe(2);
  });

  it('入场单信号后 2 分钟仍查不到且无持仓 → 取消', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    c.ex.algos.delete(cid.entry(t.id!));
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('pending');
    c.clock.now = SIGNAL + 130_000;
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('entry_not_found');
  });
});

describe('LiveExecutor 保护单', () => {
  it('止损单被外部撤掉 → 同步时重挂（序号递增）', async () => {
    const c = make();
    const t = await open_trade(c);
    await c.ex.cancel_algo_order(cid.sl(t.id!, 1));
    await c.exec.sync_symbol(SYM);
    expect(t.sl_seq).toBe(2);
    expect(c.ex.algos.get(cid.sl(t.id!, 2))!.status).toBe('NEW');
    expect(t.status).toBe('open');
  });

  it('成交后价格已越过止损（止损单会立即触发）→ 立即市价平仓', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    c.ex.set_price(SYM, 99.5);     // 触发成交
    c.ex.set_price(SYM, 104.5);    // 同步前已涨破止损
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('stop');
    expect(c.ex.positions.get(SYM)!.amount).toBe(0);
  });

  it('止损单连续被拒 → 市价平仓（protect_failed）并告警', async () => {
    const c = make();
    const t = (await c.exec.submit_setup('macd_top_div_15m', setup()))!;
    c.ex.set_price(SYM, 99.5);
    for (let i = 0; i < 3; i++) c.ex.fail_next('new_algo_order', new ExchangeError('rejected', -4000, 400, true));
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('protect_failed');
    expect(c.alerts.some(a => a.includes('protect_failed'))).toBe(true);
  });

  it('外部平仓（非止损止盈）→ 结算为 external', async () => {
    const c = make();
    const t = await open_trade(c);
    await c.ex.new_order({ symbol: SYM, side: 'BUY', type: 'MARKET', client_order_id: 'manual', quantity: '0.5', reduce_only: true });
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('external');
  });
});

describe('LiveExecutor 结算', () => {
  it('已结束的止损单查询不到时，按平仓均价推断平仓原因', async () => {
    const c = make();
    const t = await open_trade(c);
    c.ex.set_price(SYM, 104.1);
    c.ex.algos.delete(cid.sl(t.id!, 1));
    c.ex.algos.delete(cid.tp(t.id!, 1));
    await c.exec.sync_symbol(SYM);
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('stop');
    expect(c.store.events.some(e => e.kind === 'exit_reason_inferred')).toBe(true);
  });

  it('市价平仓被拒 → 止损单保持不撤，下次同步重试；超过次数转 error 并禁止开新仓', async () => {
    const c = make();
    const t = await open_trade(c);
    for (let i = 0; i < 10; i++) c.ex.fail_next('new_order', new ExchangeError('rejected', -4000, 400, true));
    c.control.mode = 'flatten';
    for (let i = 0; i < 6; i++) await c.exec.safety_tick();
    expect(c.ex.algos.get(cid.sl(t.id!, 1))!.status).toBe('NEW');
    expect(t.status).toBe('error');
    c.control.mode = 'running';
    const t2 = await c.exec.submit_setup('macd_top_div_15m', setup({ symbol: 'C1USDT' }));
    expect(t2).toMatchObject({ status: 'skipped', cancel_reason: 'error_pending' });
    expect(c.alerts.some(a => a.includes('需人工处理'))).toBe(true);
  });
});

describe('LiveExecutor 重启 / 风控 / 控制', () => {
  it('重启续跑：从存储恢复后继续管理到平仓', async () => {
    const c = make();
    const t = await open_trade(c);
    const c2 = make({ store: c.store, ex: c.ex, clock: c.clock });
    c2.exec.restore(c.store.snapshot());
    expect(c2.exec.get_active()).toHaveLength(1);
    c.ex.set_price(SYM, 90);
    await c2.exec.sync_all();
    const r = c.store.rows.get(t.id!)!;
    expect(r.status).toBe('closed');
    expect(r.exit_reason).toBe('take_profit');
  });

  it('重复信号（唯一键）返回 null', async () => {
    const c = make();
    await c.exec.submit_setup('macd_top_div_15m', setup());
    expect(await c.exec.submit_setup('macd_top_div_15m', setup())).toBeNull();
  });

  it('同币已有交易 → 另一策略信号跳过', async () => {
    const c = make();
    await c.exec.submit_setup('macd_top_div_15m', setup());
    const t2 = await c.exec.submit_setup('macd_top_div_5m', setup({ timeframe: '5m', setup_time: T0 + 2 * M5, setup_close_time: T0 + 3 * M5 - 1 }));
    expect(t2).toMatchObject({ status: 'skipped', cancel_reason: 'symbol_busy' });
  });

  it('过期信号 / 暂停 / 日亏损上限 跳过', async () => {
    const c = make();
    c.clock.now = SIGNAL + LIVE_CONFIG.signal_max_delay_ms + 1;
    expect(await c.exec.submit_setup('macd_top_div_15m', setup())).toMatchObject({ status: 'skipped', cancel_reason: 'stale_signal' });

    const c2 = make({ control: { mode: 'paused' } });
    expect(await c2.exec.submit_setup('macd_top_div_15m', setup())).toMatchObject({ status: 'skipped', cancel_reason: 'control_paused' });

    const c3 = make();
    c3.store.rows.set(99, { status: 'closed', exit_time: c3.clock.now - 1000, pnl: -8, strategy_id: 'x', symbol: 'X', setup_time: 1 } as any);
    expect(await c3.exec.submit_setup('macd_top_div_15m', setup())).toMatchObject({ status: 'skipped', cancel_reason: 'daily_loss_limit' });
  });

  it('并发上限', async () => {
    const c = make();
    const syms = ['A1USDT', 'A2USDT', 'A3USDT', 'A4USDT'];
    const exec = new LiveExecutor({
      mode: 'live', gateway: c.ex, store: c.store, notifier: { info: () => undefined, alert: () => undefined },
      config: LIVE_CONFIG, strategies: live_strategies(), rules: s => ({ ...RULES, symbol: s }), control: () => 'running', now: () => c.clock.now,
    });
    const res = [];
    for (const s of syms) { c.ex.set_price(s, 101); res.push(await exec.submit_setup('macd_top_div_15m', setup({ symbol: s }))); }
    expect(res.slice(0, 3).every(t => t!.status === 'pending')).toBe(true);
    expect(res[3]).toMatchObject({ status: 'skipped', cancel_reason: 'max_active_trades' });
  });

  it('该币存在非本程序持仓 → 跳过并告警', async () => {
    const c = make();
    c.ex.positions.set(SYM, { amount: 1, entry: 100 });
    const t = await c.exec.submit_setup('macd_top_div_15m', setup());
    expect(t).toMatchObject({ status: 'skipped', cancel_reason: 'symbol_dirty' });
    expect(c.alerts.length).toBe(1);
  });

  it('一键平仓：撤入场单、平掉持仓', async () => {
    const c = make();
    const t = await open_trade(c);
    c.ex.set_price('B1USDT', 101);
    const exec_rules = (s: string) => ({ ...RULES, symbol: s });
    const exec = new LiveExecutor({
      mode: 'live', gateway: c.ex, store: c.store, notifier: { info: () => undefined, alert: () => undefined },
      config: LIVE_CONFIG, strategies: live_strategies(), rules: exec_rules, control: () => c.control.mode, now: () => c.clock.now,
    });
    exec.restore(c.store.snapshot());
    const p = (await exec.submit_setup('macd_top_div_15m', setup({ symbol: 'B1USDT' })))!;
    expect(p.status).toBe('pending');
    c.control.mode = 'flatten';
    await exec.safety_tick();
    const r = c.store.rows.get(t.id!)!;
    expect(r.status).toBe('closed');
    expect(r.exit_reason).toBe('flatten');
    expect(c.store.rows.get(p.id!)!.status).toBe('cancelled');
    expect(exec.get_active()).toHaveLength(0);
  });

  it('账户对账：撤掉已结束交易残留的本程序条件单，报告非本程序持仓', async () => {
    const c = make();
    c.ex.set_price('ZZZUSDT', 5);
    await c.ex.new_algo_order({ symbol: 'ZZZUSDT', side: 'BUY', type: 'STOP_MARKET', client_algo_id: 'LV777S1', trigger_price: '6', close_position: true });
    c.ex.positions.set('OTHERUSDT', { amount: -3, entry: 1 });
    const orphans = await c.exec.reconcile_account();
    expect(c.ex.algos.get('LV777S1')!.status).toBe('CANCELED');
    expect(orphans).toEqual(['OTHERUSDT']);
  });
});

describe('LiveExecutor 影子模式', () => {
  it('只算计划写 shadow，不调用交易所', async () => {
    const store = new MemoryStore();
    const exec = new LiveExecutor({
      mode: 'shadow', gateway: null, store, notifier: { info: () => undefined, alert: () => undefined },
      config: LIVE_CONFIG, strategies: live_strategies(), rules: () => RULES, control: () => 'running', now: () => SIGNAL + 1000,
    });
    const t = await exec.submit_setup('macd_top_div_15m', setup());
    expect(t).toMatchObject({ status: 'shadow', planned_qty: 0.5, entry_limit: 98, stop_price: 104 });
    expect(exec.get_active()).toHaveLength(0);
  });
});
