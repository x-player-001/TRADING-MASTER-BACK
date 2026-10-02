/**
 * 回测用序列工具（纯计算，无 I/O）
 */

import { BacktestTimeframe, KlineSeries, TIMEFRAME_5M_MULTIPLE, TIMEFRAME_MS } from './backtest_types';

/** EMA（首值取第一根，与研究脚本一致） */
export function ema(values: ArrayLike<number>, period: number): Float64Array {
  const out = new Float64Array(values.length);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

/** MACD 柱（12/26/9，柱 = 2 × (DIF − DEA)） */
export function macd_hist(close: ArrayLike<number>): Float64Array {
  const e12 = ema(close, 12), e26 = ema(close, 26);
  const dif = new Float64Array(close.length);
  for (let i = 0; i < close.length; i++) dif[i] = e12[i] - e26[i];
  const dea = ema(dif, 9);
  const out = new Float64Array(close.length);
  for (let i = 0; i < close.length; i++) out[i] = 2 * (dif[i] - dea[i]);
  return out;
}

/** ATR（Wilder 平滑，首值为第一根振幅） */
export function atr(high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, period = 14): Float64Array {
  const n = high.length, out = new Float64Array(n);
  if (!n) return out;
  out[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

/** 滚动求和（含当前根，窗口 window 根；不足窗口时为已有部分之和） */
export function rolling_sum(values: ArrayLike<number>, window: number): Float64Array {
  const out = new Float64Array(values.length);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= window) s -= values[i - window];
    out[i] = s;
  }
  return out;
}

/**
 * 5m 序列聚合为更大周期（按 open_time 整除周期对齐，即 UTC 对齐；首尾不完整的K线丢弃）
 */
export function aggregate_series(s5: KlineSeries, timeframe: BacktestTimeframe): KlineSeries {
  if (timeframe === '5m') return s5;
  const m = TIMEFRAME_5M_MULTIPLE[timeframe], tf_ms = TIMEFRAME_MS[timeframe];
  let start = 0;
  while (start < s5.length && s5.time[start] % tf_ms !== 0) start++;
  const n = Math.floor((s5.length - start) / m);
  const make = () => new Float64Array(n);
  const out: KlineSeries = {
    symbol: s5.symbol, timeframe, time: make(), open: make(), high: make(), low: make(), close: make(), volume: make(), quote: make(), length: n,
  };
  for (let b = 0; b < n; b++) {
    const s = start + b * m;
    let h = -Infinity, l = Infinity, v = 0, q = 0;
    for (let j = s; j < s + m; j++) { h = Math.max(h, s5.high[j]); l = Math.min(l, s5.low[j]); v += s5.volume[j]; q += s5.quote[j]; }
    out.time[b] = s5.time[s]; out.open[b] = s5.open[s]; out.high[b] = h; out.low[b] = l; out.close[b] = s5.close[s + m - 1];
    out.volume[b] = v; out.quote[b] = q;
  }
  return out;
}
