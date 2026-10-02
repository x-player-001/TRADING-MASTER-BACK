/**
 * 模拟盘撮合引擎单测：挂单生效/失效/撤单、跳空成交、不利优先、止盈止损、时间平仓、单币单仓
 */

import { PaperEngine } from '@/services/paper_trading/paper_engine';
import { PAPER_ACCOUNT, PAPER_STRATEGIES } from '@/services/paper_trading/paper_strategies';
import { DivergenceSetup, PaperBar, PaperStrategyConfig } from '@/services/paper_trading/paper_types';

const M5 = 300_000, M15 = 900_000;
const S15 = PAPER_STRATEGIES.find(s => s.id === 'macd_top_div_15m')!;
const S5 = PAPER_STRATEGIES.find(s => s.id === 'macd_top_div_5m')!;
const S15_VOL = PAPER_STRATEGIES.find(s => s.id === 'macd_top_div_15m_vol')!;
const S5_IMP30 = PAPER_STRATEGIES.find(s => s.id === 'macd_top_div_5m_imp30')!;

/** 满足过滤条件的顶背离 setup（反转K线 open_time = t0） */
function setup(tf: '5m' | '15m', t0: number, over: Partial<DivergenceSetup> = {}): DivergenceSetup {
  const tf_ms = tf === '5m' ? M5 : M15;
  return {
    symbol: 'ABCUSDT', timeframe: tf, dir: 1,
    trigger_time: t0 - tf_ms, setup_time: t0, setup_close_time: t0 + tf_ms - 1,
    entry_trigger: 100, extreme: 104, atr: 2,
    features: { dif_ratio: 0.4, hist_ratio: 0.1, gap: 10, gdep: 0.5, imp_pct: 30, leg_pct: 12, qv24_m: 50, qv_surge: 1.5, atr_pct: 2, range48: 20, wait: 1, wick: 0.3, body: 0.6 },
    ...over,
  };
}

/** 5m K线 */
function bar(t: number, o: number, h: number, l: number, c: number): PaperBar {
  return { open_time: t, close_time: t + M5 - 1, open: o, high: h, low: l, close: c, volume: 1, quote_volume: c };
}

function engine(strategies: PaperStrategyConfig[] = PAPER_STRATEGIES) {
  return new PaperEngine(PAPER_ACCOUNT, strategies);
}

describe('PaperEngine', () => {
  const T0 = 1_000 * M15;   // 15m 对齐

  it('不满足过滤条件不下单', () => {
    const e = engine();
    expect(e.submit(S15.id, setup('15m', T0, { features: { ...setup('15m', T0).features, imp_pct: 15 } }))).toBeNull();
    expect(e.submit(S15.id, setup('5m', T0))).toBeNull();   // 周期不匹配
  });

  it('挂单在反转K线收盘前不生效；触发后按触发价成交，2R 止盈', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0))!;
    expect(t.status).toBe('pending');
    // 反转K线自身的 5m 子K线不参与撮合
    expect(e.on_bar('ABCUSDT', bar(T0 + M5, 101, 101, 95, 96))).toHaveLength(0);
    e.on_bar('ABCUSDT', bar(T0 + M15, 101, 101.5, 99.5, 99.8));
    expect(t.status).toBe('open');
    expect(t.fill_price).toBe(100);
    expect(t.qty).toBeCloseTo(10 / 4, 10);
    expect(t.take_profit).toBeCloseTo(92, 10);
    e.on_bar('ABCUSDT', bar(T0 + M15 + M5, 99.8, 100, 91.5, 92.5));
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('take_profit');
    expect(t.gross_pnl).toBeCloseTo(20, 10);
    expect(t.fees).toBeCloseTo((100 + 92) * 2.5 * 0.0005, 10);
    expect(t.r_multiple).toBeCloseTo((20 - t.fees!) / 10, 10);
    expect(e.get_active()).toHaveLength(0);
  });

  it('跳空低开按开盘价成交', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0))!;
    e.on_bar('ABCUSDT', bar(T0 + M15, 98, 99, 97, 98.5));
    expect(t.fill_price).toBe(98);
    expect(t.qty).toBeCloseTo(10 / 6, 10);
  });

  it('成交当根同时触及止损 → 直接止损（不利方向优先）', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0))!;
    e.on_bar('ABCUSDT', bar(T0 + M15, 101, 104.5, 99, 103));
    expect(t.status).toBe('closed');
    expect(t.exit_reason).toBe('stop');
    expect(t.exit_price).toBe(104);
    expect(t.r_multiple).toBeCloseTo(-1 - (100 + 104) * 2.5 * 0.0005 / 10, 10);
  });

  it('未成交先触及新高 → 撤单', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0))!;
    e.on_bar('ABCUSDT', bar(T0 + M15, 101, 104.2, 100.5, 103));
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('stop_before_entry');
  });

  it('条件单 6 根内未触发 → 失效', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0))!;
    for (let k = 3; k < 3 * 7; k++) e.on_bar('ABCUSDT', bar(T0 + k * M5, 101, 102, 100.5, 101));
    expect(t.status).toBe('pending');   // 第 6 根 15m 收盘前仍有效
    e.on_bar('ABCUSDT', bar(T0 + 7 * M15, 101, 102, 99, 101));
    expect(t.status).toBe('expired');
  });

  it('5m 策略止损 = 极值 + 0.5ATR，挂单撤单仍以极值为准', () => {
    const e = engine();
    const t = e.submit(S5.id, setup('5m', T0))!;
    expect(t.stop_price).toBe(105);
    e.on_bar('ABCUSDT', bar(T0 + M5, 101, 104.5, 99.5, 104));   // 成交当根触及 104.5 < 105，不止损
    expect(t.status).toBe('open');
    expect(t.take_profit).toBeCloseTo(90, 10);
    e.on_bar('ABCUSDT', bar(T0 + 2 * M5, 104, 105.1, 103, 105));
    expect(t.exit_reason).toBe('stop');
    expect(t.exit_price).toBe(105);
  });

  it('到达最长持仓按收盘价平仓（15m：成交所在 15m 起算第 48 根收盘）', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0))!;
    const fill_t = T0 + M15 + M5;   // 成交在第 1 根 15m 的第 2 根 5m
    e.on_bar('ABCUSDT', bar(fill_t, 100.5, 100.8, 99.9, 100.2));
    expect(t.max_hold_until).toBe(T0 + M15 + 49 * M15);
    let k = fill_t + M5;
    while (t.status === 'open') { e.on_bar('ABCUSDT', bar(k, 100, 101, 99, 99.5)); k += M5; }
    expect(t.exit_reason).toBe('time');
    expect(t.exit_price).toBe(99.5);
    expect(t.exit_time! + M5).toBe(t.max_hold_until);
    expect(t.mfe_r).toBeCloseTo(0.25, 10);
  });

  it('单仓按策略计算：同策略同币已有挂单时记为 skipped，不同策略互不影响；同一 setup 不重复下单', () => {
    const e = engine();
    expect(e.submit(S15.id, setup('15m', T0))!.status).toBe('pending');
    const s = e.submit(S15.id, setup('15m', T0 + M15))!;
    expect(s.status).toBe('skipped');
    expect(s.cancel_reason).toBe('symbol_busy');
    expect(e.submit(S5.id, setup('5m', T0 + M15))!.status).toBe('pending');
    expect(e.submit(S15.id, setup('15m', T0))).toBeNull();
  });

  it('放量策略要求 qv_surge ≥ 2（NaN 视为不满足）', () => {
    const e = engine();
    const base = setup('15m', T0);
    expect(e.submit(S15_VOL.id, base)).toBeNull();
    expect(e.submit(S15_VOL.id, setup('15m', T0 + M15, { features: { ...base.features, qv_surge: NaN } }))).toBeNull();
    expect(e.submit(S15_VOL.id, setup('15m', T0 + 2 * M15, { features: { ...base.features, qv_surge: 2.5 } }))!.status).toBe('pending');
  });

  it('前波≥30% 策略', () => {
    const e = engine();
    const base = setup('5m', T0);
    expect(e.submit(S5_IMP30.id, setup('5m', T0, { features: { ...base.features, imp_pct: 25 } }))).toBeNull();
    expect(e.submit(S5_IMP30.id, setup('5m', T0 + M5, { features: { ...base.features, imp_pct: 35 } }))!.status).toBe('pending');
  });

  it('成交价止损距离超出 [0.3%, 10%] → 撤单', () => {
    const e = engine();
    const t = e.submit(S15.id, setup('15m', T0, { extreme: 100.2 }))!;
    e.on_bar('ABCUSDT', bar(T0 + M15, 100.1, 100.15, 99.9, 100));
    expect(t.status).toBe('cancelled');
    expect(t.cancel_reason).toBe('risk_out_of_range');
  });

  it('restore 后从 last_bar_time 之后继续撮合', () => {
    const e1 = engine();
    const t = e1.submit(S15.id, setup('15m', T0))!;
    e1.on_bar('ABCUSDT', bar(T0 + M15, 101, 101.5, 99.5, 99.8));
    const saved = JSON.parse(JSON.stringify(t));
    const e2 = engine();
    e2.restore([saved]);
    expect(e2.on_bar('ABCUSDT', bar(T0 + M15, 101, 101.5, 99.5, 99.8))).toHaveLength(0);   // 已处理过
    e2.on_bar('ABCUSDT', bar(T0 + M15 + M5, 99.8, 100, 91.5, 92.5));
    expect(saved.status).toBe('closed');
  });
});
