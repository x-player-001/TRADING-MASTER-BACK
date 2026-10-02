/**
 * 高位整理第三推低点限价策略
 *   1. 人工构造的标准形态：识别三推、在第三推低点成交、突破后 MACD 柱缩短离场
 *   2. 无前视：截断数据后重跑，截断前已结束的交易必须与完整数据完全一致
 *   3. 默认参数下产出的交易都满足过滤条件
 */

import { run_flag_third_push, FLAG_THIRD_PUSH_DEFAULTS, FLAG_THIRD_PUSH_CONFIRM, FlagThirdPushParams } from '@/services/strategy_backtest/strategies/flag_third_push';
import { KlineSeries } from '@/services/strategy_backtest/backtest_types';

const T0 = Date.UTC(2026, 0, 1);

/** 由 [open, close, low?, high?] 构建 5m 序列（未给影线时上下各 0.05） */
function make_series(rows: number[][], volume = 1000): KlineSeries {
  const n = rows.length, mk = () => new Float64Array(n);
  const s: KlineSeries = { symbol: 'TESTUSDT', timeframe: '5m', time: mk(), open: mk(), high: mk(), low: mk(), close: mk(), volume: mk(), quote: mk(), length: n };
  rows.forEach(([o, c, lo, hi], i) => {
    s.time[i] = T0 + i * 300_000; s.open[i] = o; s.close[i] = c;
    s.low[i] = lo ?? Math.min(o, c) - 0.05; s.high[i] = hi ?? Math.max(o, c) + 0.05;
    s.volume[i] = volume; s.quote[i] = volume * c;
  });
  return s;
}

/** 标准形态：平台 → 6 根拉升 → 三推（低点 104.0 / 104.4 / 104.8 抬高）→ 回踩第三推低点 → 突破 */
function standard_pattern() {
  const rows: number[][] = [];
  for (let i = 0; i < 320; i++) rows.push(i % 2 ? [100, 100.02] : [100.02, 100]);
  for (let k = 0; k < 6; k++) rows.push([100 + k, 101 + k]);                    // 拉升到 106（影线 106.05）
  const peak = rows.length - 1;
  rows.push([106, 105.6], [105.6, 105.0], [105.0, 104.5]);
  const push1 = rows.length; rows.push([104.5, 104.3, 104.0]);
  rows.push([104.3, 104.8], [104.8, 105.3], [105.3, 105.8], [105.8, 105.4], [105.4, 104.9]);
  const push2 = rows.length; rows.push([104.9, 104.7, 104.4]);
  rows.push([104.7, 105.2], [105.2, 105.8], [105.8, 105.5], [105.5, 105.1]);
  const push3 = rows.length; rows.push([105.1, 105.0, 104.8]);
  rows.push([105.0, 105.3], [105.3, 105.5]);                                      // push3 + 2：确认挂单
  rows.push([105.5, 105.0]);
  const fill = rows.length; rows.push([105.0, 104.85, 104.8]);                     // 回踩成交
  rows.push([104.85, 105.5], [105.5, 106.2], [106.2, 107.0], [107.0, 107.6], [107.6, 107.5], [107.5, 107.4]);
  for (let i = 0; i < 60; i++) rows.push(i % 2 ? [107.4, 107.45] : [107.45, 107.4]);
  return { series: make_series(rows), peak, push1, push2, push3, fill };
}

describe('flag_third_push：标准形态', () => {
  const { series, push1, push2, push3, fill } = standard_pattern();
  const trades = run_flag_third_push(series);

  test('识别一笔并在第三推低点成交', () => {
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.status).toBe('closed');
    expect(t.signal_time).toBe(series.time[push3 + 2]);
    expect(t.entry_time).toBe(series.time[fill]);
    expect(t.entry_price).toBeCloseTo(104.8, 8);
    expect([t.features.push1, t.features.push2, t.features.push3]).toEqual([104.0, 104.4, 104.8]);
    expect(t.features.pre_waves).toBe(0);
    expect(t.features.lows_rising).toBe(true);
  });

  test('突破后 MACD 柱缩短离场且盈利', () => {
    const t = trades[0];
    expect(t.exit_reason).toBe('macd_shrink');
    expect(t.features.breakout).toBe(true);
    expect(t.pnl!).toBeGreaterThan(0);
    // 名义 100U：盈亏 = 100 × (出场/入场 − 1) − 0.1
    expect(t.pnl!).toBeCloseTo(100 * (t.exit_price! / 104.8 - 1) - 0.1, 5);
  });

  test('标注包含三推、挂单线、入场与出场', () => {
    const a = trades[0].annotations;
    const pushes = a.filter(x => x.type === 'marker' && x.role === 'point' && x.label.startsWith('第'));
    expect(pushes.map(x => (x as any).time)).toEqual([push1, push2, push3].map(i => series.time[i]));
    expect(a.some(x => x.type === 'hline' && x.label === '限价挂单' && x.price === 104.8)).toBe(true);
    expect(a.some(x => x.type === 'marker' && x.role === 'entry')).toBe(true);
    expect(a.some(x => x.type === 'marker' && x.role === 'exit')).toBe(true);
    expect(a.some(x => x.type === 'box')).toBe(true);
  });

  test('不满足低点抬高（第三推更低）时不挂单', () => {
    const rows: number[][] = [];
    for (let i = 0; i < series.length; i++) rows.push([series.open[i], series.close[i], series.low[i], series.high[i]]);
    rows[push3][2] = 104.3;                     // 第三推低于第二推 104.4
    expect(run_flag_third_push(make_series(rows))).toHaveLength(0);
    // 容差模式：低 0.1 在区间高度 10% 以内，算持平
    expect(run_flag_third_push(make_series(rows), { lows_mode: 'flat' }).length).toBeGreaterThan(0);
  });

  test('挂单后未回踩则记为未成交', () => {
    const rows: number[][] = [];
    for (let i = 0; i <= push3 + 2; i++) rows.push([series.open[i], series.close[i], series.low[i], series.high[i]]);
    for (let i = 0; i < 80; i++) rows.push(i % 2 ? [105.4, 105.5] : [105.5, 105.4]);
    const t = run_flag_third_push(make_series(rows));
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe('unfilled');
    expect(t[0].exit_time).toBe(T0 + (push3 + 2 + FLAG_THIRD_PUSH_DEFAULTS.order_valid_bars) * 300_000);
  });

  test('固定止损：成交当根跌破止损按止损价出场', () => {
    const rows: number[][] = [];
    for (let i = 0; i < series.length; i++) rows.push([series.open[i], series.close[i], series.low[i], series.high[i]]);
    rows[fill][2] = 101;                         // 成交K线下影线刺穿 3% 止损
    const t = run_flag_third_push(make_series(rows), { stop_pct: 0.03 });
    expect(t[0].exit_reason).toBe('stop');
    expect(t[0].r_multiple!).toBeCloseTo(-1 - 0.001 / 0.03, 6);
  });
});

describe('flag_third_push_confirm：确认入场', () => {
  const { series, push3 } = standard_pattern();

  test('第三推确认K线收盘直接入场，无挂单线', () => {
    const t = FLAG_THIRD_PUSH_CONFIRM.run(series, {});
    expect(t).toHaveLength(1);
    expect(t[0].strategy_id).toBe('flag_third_push_confirm');
    expect(t[0].entry_time).toBe(series.time[push3 + 2]);
    expect(t[0].signal_time).toBe(t[0].entry_time);
    expect(t[0].entry_price).toBeCloseTo(105.5, 8);
    expect(t[0].features.hi_trend).toBe(0);
    expect(t[0].annotations.some(a => a.type === 'hline' && a.label === '限价挂单')).toBe(false);
    expect(t[0].pnl!).toBeGreaterThan(0);
  });

  test('第三推前反弹高点抬高时过滤', () => {
    const rows: number[][] = [];
    for (let i = 0; i < series.length; i++) rows.push([series.open[i], series.close[i], series.low[i], series.high[i]]);
    rows[push3 - 3][3] = 106.0;                  // 第二推与第三推之间的反弹高点抬到 106.0（> 105.85）
    expect(FLAG_THIRD_PUSH_CONFIRM.run(make_series(rows), {})).toHaveLength(0);
    expect(FLAG_THIRD_PUSH_CONFIRM.run(make_series(rows), { max_hi_trend: null })).toHaveLength(1);
  });
});

/** 可复现随机数 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** 带趋势段与波动爆发的随机行情 */
function random_series(n: number, seed: number): KlineSeries {
  const r = rng(seed), rows: number[][] = [];
  let price = 1, drift = 0, vol = 0.004;
  for (let i = 0; i < n; i++) {
    if (r() < 0.03) drift = (r() - 0.4) * 0.008;
    if (r() < 0.03) vol = 0.002 + r() * 0.01;
    const o = price, c = Math.max(1e-6, o * (1 + drift + (r() - 0.5) * 2 * vol));
    rows.push([o, c, Math.min(o, c) * (1 - r() * vol), Math.max(o, c) * (1 + r() * vol)]);
    price = c;
  }
  return make_series(rows, 1e7);
}

/** 截取前 len 根 */
function truncate(s: KlineSeries, len: number): KlineSeries {
  const cut = (a: Float64Array) => a.slice(0, len);
  return { ...s, time: cut(s.time), open: cut(s.open), high: cut(s.high), low: cut(s.low), close: cut(s.close), volume: cut(s.volume), quote: cut(s.quote), length: len };
}

describe('flag_third_push：无前视', () => {
  const loose: Partial<FlagThirdPushParams> = { lows_mode: 'any', max_pre_waves: 99, leg_max_pct: 10, leg_min_bars: 1, leg_max_bar_ratio: 1, retr_limit: 0.786, max_dist_to_top: 1 };

  test.each([1, 2, 3])('随机行情 seed=%i：截断前结束的交易与完整数据一致', seed => {
    const full_series = random_series(6000, seed);
    const full = run_flag_third_push(full_series, loose);
    expect(full.length).toBeGreaterThan(3);
    for (const cut of [2500, 3500, 4500]) {
      const cut_time = full_series.time[cut - 1];
      const part = run_flag_third_push(truncate(full_series, cut), loose);
      const done_before = (ts: typeof full) => ts.filter(t => t.exit_time !== null && t.exit_time <= cut_time).map(t => JSON.stringify(t));
      expect(done_before(part)).toEqual(done_before(full));
    }
  });

  test.each([1, 2])('确认入场 seed=%i：截断前结束的交易与完整数据一致', seed => {
    const full_series = random_series(6000, seed);
    const p = { ...loose, entry_mode: 'confirm' as const };
    const full = run_flag_third_push(full_series, p);
    expect(full.length).toBeGreaterThan(3);
    for (const cut of [3000, 4500]) {
      const cut_time = full_series.time[cut - 1];
      const part = run_flag_third_push(truncate(full_series, cut), p);
      const done_before = (ts: typeof full) => ts.filter(t => t.exit_time !== null && t.exit_time <= cut_time).map(t => JSON.stringify(t));
      expect(done_before(part)).toEqual(done_before(full));
    }
  });

  test('默认参数产出的交易满足过滤条件', () => {
    for (const seed of [4, 5, 6, 7]) {
      for (const t of run_flag_third_push(random_series(6000, seed))) {
        const f = t.features as Record<string, any>;
        expect(f.leg_pct).toBeGreaterThanOrEqual(0.04);
        expect(f.leg_pct).toBeLessThanOrEqual(0.2);
        expect(f.retr).toBeLessThanOrEqual(0.5);
        expect(f.pre_waves).toBeLessThanOrEqual(2);
        expect(f.lows_rising).toBe(true);
        expect(f.dist_to_top).toBeLessThanOrEqual(0.05);
      }
    }
  });
});
