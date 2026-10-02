/**
 * 离线 5m K线缓存读取（服务器 /root/kline_cache/5m/YYYYMMDD.csv.gz）
 *
 * 缓存按北京时间分日，每行 symbol,open_time,open,high,low,close,volume，无表头、行序不保证。
 * 全市场全时段一次载入内存过大，这里按币种分批：每批扫一遍日文件只保留该批币种，
 * 再逐币产出等间隔序列（缺失K线用前收盘填充、成交额记 0）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { KlineSeries } from './backtest_types';

const STEP_MS = 300_000;
const BARS_PER_DAY = 288;
const FIELDS = 5;   // open, high, low, close, volume

export interface KlineCacheOptions {
  cache_dir: string;
  from_day: string;              // YYYYMMDD（含）
  to_day: string;                // YYYYMMDD（含）
  symbols?: string[];            // 不传则为区间内出现过的全部币种
  batch_size?: number;           // 每批币种数（默认 120，约 200MB）
  min_bars?: number;             // 有效K线少于该值的币种跳过（默认 3000）
  max_missing_ratio?: number;    // 缺失比例超过该值的币种跳过（默认 0.03）
  on_progress?: (msg: string) => void;
}

/** 北京时间 YYYYMMDD 当日 00:00 的毫秒时间戳 */
export function beijing_day_start(day: string): number {
  return Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00+08:00`);
}

/** 区间内的日文件（升序） */
export function list_cache_files(cache_dir: string, from_day: string, to_day: string): string[] {
  return fs.readdirSync(cache_dir)
    .filter(f => /^\d{8}\.csv\.gz$/.test(f) && f.slice(0, 8) >= from_day && f.slice(0, 8) <= to_day)
    .sort();
}

/** 读取并解压一个日文件，逐行回调 */
function for_each_line(file: string, cb: (parts: string[]) => void): void {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end > start) {
      const parts = text.slice(start, end).split(',');
      if (parts.length >= 7) cb(parts);
    }
    start = end + 1;
  }
}

/** 统计区间内出现过的全部币种 */
export function collect_symbols(cache_dir: string, files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) for_each_line(path.join(cache_dir, f), p => set.add(p[0]));
  return [...set].sort();
}

/**
 * 逐币产出 5m 序列（同步生成器；调用方可在两次产出之间做异步写库）
 */
export function* iterate_kline_series(opts: KlineCacheOptions): Generator<KlineSeries> {
  const files = list_cache_files(opts.cache_dir, opts.from_day, opts.to_day);
  if (!files.length) return;
  const t0 = beijing_day_start(files[0].slice(0, 8));
  const nb = Math.round((beijing_day_start(files[files.length - 1].slice(0, 8)) - t0) / STEP_MS) + BARS_PER_DAY;
  const symbols = opts.symbols?.length ? [...opts.symbols].sort() : collect_symbols(opts.cache_dir, files);
  const batch_size = opts.batch_size ?? 120;
  const min_bars = opts.min_bars ?? 3000;
  const max_missing = opts.max_missing_ratio ?? 0.03;

  for (let b = 0; b < symbols.length; b += batch_size) {
    const batch = symbols.slice(b, b + batch_size);
    const store = new Map<string, Float32Array>(batch.map(s => [s, new Float32Array(nb * FIELDS)]));
    opts.on_progress?.(`读取第 ${b / batch_size + 1}/${Math.ceil(symbols.length / batch_size)} 批（${batch.length} 个币种）`);
    for (const f of files) {
      for_each_line(path.join(opts.cache_dir, f), p => {
        const a = store.get(p[0]); if (!a) return;
        const i = (Number(p[1]) - t0) / STEP_MS;
        if (!Number.isInteger(i) || i < 0 || i >= nb) return;
        const k = i * FIELDS;
        a[k] = +p[2]; a[k + 1] = +p[3]; a[k + 2] = +p[4]; a[k + 3] = +p[5]; a[k + 4] = +p[6];
      });
    }
    for (const sym of batch) {
      const series = build_series(sym, store.get(sym)!, t0, nb, min_bars, max_missing);
      store.delete(sym);
      if (series) yield series;
    }
  }
}

/** 由紧凑数组构建序列：截取首尾有效段，缺失K线前向填充；不合格返回 null */
export function build_series(symbol: string, a: Float32Array, t0: number, nb: number, min_bars: number, max_missing: number): KlineSeries | null {
  let first = -1, last = -1;
  for (let i = 0; i < nb; i++) if (a[i * FIELDS + 3] > 0) { if (first < 0) first = i; last = i; }
  if (first < 0) return null;
  const n = last - first + 1;
  if (n < min_bars) return null;
  const mk = () => new Float64Array(n);
  const s: KlineSeries = { symbol, timeframe: '5m', time: mk(), open: mk(), high: mk(), low: mk(), close: mk(), volume: mk(), quote: mk(), length: n };
  let missing = 0;
  for (let j = 0; j < n; j++) {
    const i = first + j, k = i * FIELDS;
    s.time[j] = t0 + i * STEP_MS;
    if (a[k + 3] > 0) {
      s.open[j] = a[k]; s.high[j] = a[k + 1]; s.low[j] = a[k + 2]; s.close[j] = a[k + 3];
      s.volume[j] = a[k + 4]; s.quote[j] = a[k + 3] * a[k + 4];
    } else {
      missing++;
      const pc = s.close[j - 1];
      s.open[j] = s.high[j] = s.low[j] = s.close[j] = pc;
    }
  }
  if (missing / n > max_missing) return null;
  return s;
}
