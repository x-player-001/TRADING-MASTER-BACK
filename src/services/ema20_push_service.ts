/**
 * EMA20 均线推动监控服务（实时版）
 *
 * 识别"从EMA附近起跳→涨幅≥6%→回落到EMA附近"的完整推动周期。
 * 支持 15m / 1h / 4h 三个周期。
 *
 * 推动识别逻辑：
 *   1. 起跳条件：影线进入 EMA ±5%，当前K线收阳，收盘在EMA上方
 *   2. 进入"追踪中"状态，持续记录最高收盘价
 *   3. 当价格再次回落到 EMA ±5% 范围时，推动结束
 *   4. 从起跳到最高点涨幅 ≥ 6% 才算一次有效推动
 */

import { AggregatedKline } from '@/core/data/kline_aggregator';

// ==================== 类型定义 ====================

export type EMA20Timeframe = '15m' | '1h' | '4h';

export interface EMA20PushRecord {
  push_index: number;
  kline_time: number;       // 起跳K线时间戳
  low_price: number;        // 起跳K线影线最低价
  close_price: number;      // 起跳K线收盘价
  peak_price: number;       // 本次推动最高收盘价
  gain_pct: number;         // 本次推动涨幅%（peak/close-1）
  ema20: number;
  distance_pct: number;     // 起跳时影线距EMA偏差%
}

export interface EMA20PushContext {
  symbol: string;
  timeframe: EMA20Timeframe;
  push_count: number;
  pushes: EMA20PushRecord[];
  ema20: number | null;
  current_price: number;
  start_price: number;
  last_push_time: number | null;
  last_push_bar_index: number;
  bar_index: number;
  updated_at: number;
  // 追踪状态
  tracking: boolean;              // 是否处于推动追踪中
  tracking_launch_price: number;  // 起跳价
  tracking_launch_low: number;    // 起跳影线最低
  tracking_launch_ema: number;    // 起跳时EMA
  tracking_launch_dist: number;   // 起跳时影线距EMA偏差
  tracking_launch_time: number;   // 起跳K线时间
  tracking_peak: number;          // 追踪期间最高收盘价
}

export interface EMA20PushAlert {
  symbol: string;
  timeframe: EMA20Timeframe;
  push_count: number;
  push_record: EMA20PushRecord;
  amplitude_pct: number;
  ema20: number;
  current_price: number;
  kline_time: number;
}

// ==================== 配置 ====================

const CONFIG = {
  ema20_period: 20,
  support_range: 0.05,        // EMA ±5% 范围
  min_push_gain_pct: 0.06,    // 每次推动最小涨幅 6%
  min_push_interval: 10,      // 两次起跳最少间隔根数
  min_amplitude_pct: 5,       // 累计涨幅达到5%才触发回调写库
  max_cache_size: 200,
};

// ==================== 服务类 ====================

export class EMA20PushService {
  private kline_cache: Map<string, AggregatedKline[]> = new Map();
  private ema_cache: Map<string, number> = new Map();
  private push_contexts: Map<string, EMA20PushContext> = new Map();
  private on_push_cb?: (alert: EMA20PushAlert) => void;

  on_push(cb: (alert: EMA20PushAlert) => void): void {
    this.on_push_cb = cb;
  }

  init_cache(symbol: string, timeframe: EMA20Timeframe, klines: AggregatedKline[]): void {
    const key = this._key(symbol, timeframe);
    const recent = klines.slice(-CONFIG.max_cache_size);
    this.kline_cache.set(key, recent);
    if (recent.length >= CONFIG.ema20_period) {
      const ema = this._init_ema(recent.map(k => k.close));
      if (ema !== null) this.ema_cache.set(key, ema);
    }
  }

  process_kline(kline: AggregatedKline): void {
    const tf = kline.interval as EMA20Timeframe;
    if (!['15m', '1h', '4h'].includes(tf)) return;

    const key = this._key(kline.symbol, tf);

    // 更新K线缓存
    let cache = this.kline_cache.get(key);
    if (!cache) { cache = []; this.kline_cache.set(key, cache); }
    if (cache.length > 0 && cache[cache.length - 1].open_time === kline.open_time) {
      cache[cache.length - 1] = kline;
    } else {
      cache.push(kline);
      if (cache.length > CONFIG.max_cache_size) cache.shift();
    }

    // 更新 EMA
    const prev_ema = this.ema_cache.get(key);
    let ema: number | null = null;
    if (prev_ema !== undefined) {
      const k = 2 / (CONFIG.ema20_period + 1);
      ema = kline.close * k + prev_ema * (1 - k);
      this.ema_cache.set(key, ema);
    } else if (cache.length >= CONFIG.ema20_period) {
      ema = this._init_ema(cache.map(c => c.close));
      if (ema !== null) this.ema_cache.set(key, ema);
    }
    if (ema === null) return;

    // 获取或创建上下文
    let ctx = this.push_contexts.get(key);
    if (!ctx) {
      ctx = {
        symbol: kline.symbol, timeframe: tf,
        push_count: 0, pushes: [], ema20: ema,
        current_price: kline.close, start_price: kline.close,
        last_push_time: null,
        last_push_bar_index: -CONFIG.min_push_interval - 1,
        bar_index: 0, updated_at: kline.close_time,
        tracking: false,
        tracking_launch_price: 0, tracking_launch_low: 0,
        tracking_launch_ema: 0, tracking_launch_dist: 0,
        tracking_launch_time: 0, tracking_peak: 0,
      };
      this.push_contexts.set(key, ctx);
    }

    ctx.ema20 = ema;
    ctx.current_price = kline.close;
    ctx.bar_index++;
    ctx.updated_at = kline.close_time;

    const dist_low = (kline.low - ema) / ema;
    const in_range = Math.abs(dist_low) <= CONFIG.support_range;
    const close_above = kline.close > ema;

    if (ctx.tracking) {
      // ---- 追踪中：更新最高价，判断是否结束 ----
      if (kline.close > ctx.tracking_peak) {
        ctx.tracking_peak = kline.close;
      }

      // 价格回落到EMA附近 → 本次推动结束，判断是否有效
      if (in_range) {
        const gain = (ctx.tracking_peak - ctx.tracking_launch_price) / ctx.tracking_launch_price;
        if (gain >= CONFIG.min_push_gain_pct) {
          // 有效推动
          const last_close = ctx.pushes.length > 0 ? ctx.pushes[ctx.pushes.length - 1].close_price : 0;
          if (ctx.tracking_launch_price > last_close) {
            ctx.push_count++;
            if (ctx.push_count === 1) ctx.start_price = ctx.tracking_launch_price;
            ctx.last_push_time = ctx.tracking_launch_time;
            ctx.last_push_bar_index = ctx.bar_index;

            const record: EMA20PushRecord = {
              push_index:   ctx.push_count,
              kline_time:   ctx.tracking_launch_time,
              low_price:    ctx.tracking_launch_low,
              close_price:  ctx.tracking_launch_price,
              peak_price:   ctx.tracking_peak,
              gain_pct:     gain * 100,
              ema20:        ctx.tracking_launch_ema,
              distance_pct: ctx.tracking_launch_dist,
            };
            ctx.pushes.push(record);

            const amplitude_pct = (kline.close - ctx.start_price) / ctx.start_price * 100;
            if (amplitude_pct >= CONFIG.min_amplitude_pct) {
              this.on_push_cb?.({
                symbol: kline.symbol, timeframe: tf,
                push_count: ctx.push_count, push_record: record,
                amplitude_pct, ema20: ema,
                current_price: kline.close, kline_time: kline.open_time,
              });
            }
          }
        }
        ctx.tracking = false;

        // 当前K线同时满足新起跳条件，立即开始新一次追踪
        const is_bull = kline.close > kline.open;
        const interval_ok = ctx.bar_index - ctx.last_push_bar_index >= CONFIG.min_push_interval;
        if (is_bull && close_above && interval_ok) {
          ctx.tracking = true;
          ctx.tracking_launch_price = kline.close;
          ctx.tracking_launch_low   = kline.low;
          ctx.tracking_launch_ema   = ema;
          ctx.tracking_launch_dist  = dist_low * 100;
          ctx.tracking_launch_time  = kline.open_time;
          ctx.tracking_peak         = kline.close;
        }
      }
    } else {
      // ---- 未追踪：检查起跳条件 ----
      const is_bull = kline.close > kline.open;
      const interval_ok = ctx.bar_index - ctx.last_push_bar_index >= CONFIG.min_push_interval;
      if (is_bull && in_range && close_above && interval_ok) {
        ctx.tracking = true;
        ctx.tracking_launch_price = kline.close;
        ctx.tracking_launch_low   = kline.low;
        ctx.tracking_launch_ema   = ema;
        ctx.tracking_launch_dist  = dist_low * 100;
        ctx.tracking_launch_time  = kline.open_time;
        ctx.tracking_peak         = kline.close;
      }
    }
  }

  get_all_contexts(): EMA20PushContext[] {
    return Array.from(this.push_contexts.values())
      .filter(c => c.push_count > 0)
      .sort((a, b) => b.push_count - a.push_count || b.updated_at - a.updated_at);
  }

  get_context(symbol: string, timeframe: EMA20Timeframe): EMA20PushContext | undefined {
    return this.push_contexts.get(this._key(symbol, timeframe));
  }

  restore_context(record: {
    symbol: string; timeframe: EMA20Timeframe;
    push_count: number; start_price: number; current_price: number;
    amplitude_pct: number; ema20: number; last_push_time: number | null;
    pushes: EMA20PushRecord[];
  }): void {
    const key = this._key(record.symbol, record.timeframe);
    if (this.push_contexts.has(key)) return;
    const ctx: EMA20PushContext = {
      symbol: record.symbol, timeframe: record.timeframe,
      push_count: record.push_count, pushes: record.pushes,
      ema20: record.ema20, current_price: record.current_price,
      start_price: record.start_price, last_push_time: record.last_push_time,
      last_push_bar_index: -CONFIG.min_push_interval - 1,
      bar_index: 0, updated_at: Date.now(),
      tracking: false,
      tracking_launch_price: 0, tracking_launch_low: 0,
      tracking_launch_ema: 0, tracking_launch_dist: 0,
      tracking_launch_time: 0, tracking_peak: 0,
    };
    this.push_contexts.set(key, ctx);
    this.ema_cache.set(key, record.ema20);
  }

  reset_context(symbol: string, timeframe: EMA20Timeframe): void {
    this.push_contexts.delete(this._key(symbol, timeframe));
    this.ema_cache.delete(this._key(symbol, timeframe));
  }

  private _key(symbol: string, timeframe: EMA20Timeframe): string {
    return `${symbol}_${timeframe}`;
  }

  private _init_ema(closes: number[]): number | null {
    const n = CONFIG.ema20_period;
    if (closes.length < n) return null;
    const k = 2 / (n + 1);
    let ema = closes.slice(0, n).reduce((s, c) => s + c, 0) / n;
    for (let i = n; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }
}
