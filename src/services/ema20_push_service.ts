/**
 * EMA20 均线推动监控服务
 *
 * 识别价格回调到 EMA20 ±5% 后反弹的次数，次数越多说明趋势越强。
 * 支持 15m / 1h / 4h 三个周期。
 *
 * 推动条件：
 *   1. 当前K线影线最低价进入 EMA20 ±5% 范围
 *   2. 当前K线收阳（反弹确认）
 *   3. 距上次推动至少间隔 3 根K线
 */

import { AggregatedKline } from '@/core/data/kline_aggregator';

// ==================== 类型定义 ====================

export type EMA20Timeframe = '15m' | '1h' | '4h';

export interface EMA20PushRecord {
  push_index: number;     // 第几次推动（从1开始）
  kline_time: number;     // 推动确认K线时间戳
  low_price: number;      // 本次回调最低影线价
  close_price: number;    // 确认K线收盘价
  ema20: number;          // 当前 EMA20 值
  distance_pct: number;   // 最低价距 EMA20 的偏差%（负=跌破）
}

export interface EMA20PushContext {
  symbol: string;
  timeframe: EMA20Timeframe;
  push_count: number;               // 累计推动次数
  pushes: EMA20PushRecord[];        // 历史推动记录
  ema20: number | null;             // 当前 EMA20
  current_price: number;            // 最新收盘价
  start_price: number;              // 第一次推动时的收盘价（计算涨幅用）
  last_push_time: number | null;    // 最后一次推动时间
  last_push_bar_index: number;      // 最后一次推动的K线序号（用于间隔判断）
  bar_index: number;                // 当前K线序号
  updated_at: number;               // 最后更新时间
}

export interface EMA20PushAlert {
  symbol: string;
  timeframe: EMA20Timeframe;
  push_count: number;
  push_record: EMA20PushRecord;
  amplitude_pct: number;            // 第一次推动以来的涨幅%
  ema20: number;
  current_price: number;
  kline_time: number;
}

// ==================== 配置 ====================

const CONFIG = {
  ema20_period: 20,
  support_range: 0.05,       // EMA20 ±5% 范围
  min_push_interval: 3,      // 两次推动最少间隔根数
  min_amplitude_pct: 5,      // 第一次推动到当前价最小涨幅%
  max_cache_size: 200,
};

// ==================== 服务类 ====================

export class EMA20PushService {
  // K线缓存: `${symbol}_${timeframe}` -> AggregatedKline[]
  private kline_cache: Map<string, AggregatedKline[]> = new Map();

  // EMA缓存: `${symbol}_${timeframe}` -> ema值
  private ema_cache: Map<string, number> = new Map();

  // 推动上下文: `${symbol}_${timeframe}` -> EMA20PushContext
  private push_contexts: Map<string, EMA20PushContext> = new Map();

  // 回调
  private on_push_cb?: (alert: EMA20PushAlert) => void;

  on_push(cb: (alert: EMA20PushAlert) => void): void {
    this.on_push_cb = cb;
  }

  /** 初始化K线缓存（冷启动预热） */
  init_cache(symbol: string, timeframe: EMA20Timeframe, klines: AggregatedKline[]): void {
    const key = this._key(symbol, timeframe);
    const recent = klines.slice(-CONFIG.max_cache_size);
    this.kline_cache.set(key, recent);

    // 预热 EMA
    if (recent.length >= CONFIG.ema20_period) {
      const ema = this._init_ema(recent.map(k => k.close));
      if (ema !== null) this.ema_cache.set(key, ema);
    }
  }

  /** 处理一根聚合K线 */
  process_kline(kline: AggregatedKline): void {
    const tf = kline.interval as EMA20Timeframe;
    if (!['15m', '1h', '4h'].includes(tf)) return;

    const key = this._key(kline.symbol, tf);

    // 更新缓存
    let cache = this.kline_cache.get(key);
    if (!cache) { cache = []; this.kline_cache.set(key, cache); }
    if (cache.length > 0 && cache[cache.length - 1].open_time === kline.open_time) {
      cache[cache.length - 1] = kline;
    } else {
      cache.push(kline);
      if (cache.length > CONFIG.max_cache_size) cache.shift();
    }

    // 更新 EMA20
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
        symbol: kline.symbol,
        timeframe: tf,
        push_count: 0,
        pushes: [],
        ema20: ema,
        current_price: kline.close,
        start_price: kline.close,
        last_push_time: null,
        last_push_bar_index: -CONFIG.min_push_interval - 1,
        bar_index: 0,
        updated_at: kline.close_time,
      };
      this.push_contexts.set(key, ctx);
    }

    ctx.ema20 = ema;
    ctx.current_price = kline.close;
    ctx.bar_index++;
    ctx.updated_at = kline.close_time;

    // 判断是否满足推动条件
    const is_bull = kline.close > kline.open;
    const distance = (kline.low - ema) / ema;         // 负值表示跌破EMA20
    const in_range = Math.abs(distance) <= CONFIG.support_range;
    const interval_ok = ctx.bar_index - ctx.last_push_bar_index >= CONFIG.min_push_interval;

    if (is_bull && in_range && interval_ok) {
      ctx.push_count++;
      ctx.last_push_time = kline.open_time;
      ctx.last_push_bar_index = ctx.bar_index;

      if (ctx.push_count === 1) {
        ctx.start_price = kline.close;
      }

      const record: EMA20PushRecord = {
        push_index:   ctx.push_count,
        kline_time:   kline.open_time,
        low_price:    kline.low,
        close_price:  kline.close,
        ema20:        ema,
        distance_pct: distance * 100,
      };
      ctx.pushes.push(record);

      const amplitude_pct = (kline.close - ctx.start_price) / ctx.start_price * 100;

      // 涨幅不足时不触发回调（但推动已计入ctx，等待涨幅达标后下次推动时触发）
      if (amplitude_pct < CONFIG.min_amplitude_pct) return;

      this.on_push_cb?.({
        symbol:       kline.symbol,
        timeframe:    tf,
        push_count:   ctx.push_count,
        push_record:  record,
        amplitude_pct,
        ema20:        ema,
        current_price: kline.close,
        kline_time:   kline.open_time,
      });
    }
  }

  /** 获取所有有推动记录的上下文列表 */
  get_all_contexts(): EMA20PushContext[] {
    return Array.from(this.push_contexts.values())
      .filter(c => c.push_count > 0)
      .sort((a, b) => b.push_count - a.push_count || b.updated_at - a.updated_at);
  }

  /** 获取指定币种周期的上下文 */
  get_context(symbol: string, timeframe: EMA20Timeframe): EMA20PushContext | undefined {
    return this.push_contexts.get(this._key(symbol, timeframe));
  }

  /** 从数据库记录恢复上下文（冷启动时调用） */
  restore_context(record: {
    symbol: string;
    timeframe: EMA20Timeframe;
    push_count: number;
    start_price: number;
    current_price: number;
    amplitude_pct: number;
    ema20: number;
    last_push_time: number | null;
    pushes: EMA20PushRecord[];
  }): void {
    const key = this._key(record.symbol, record.timeframe);
    if (this.push_contexts.has(key)) return; // 已有内存状态，不覆盖
    const ctx: EMA20PushContext = {
      symbol:              record.symbol,
      timeframe:           record.timeframe,
      push_count:          record.push_count,
      pushes:              record.pushes,
      ema20:               record.ema20,
      current_price:       record.current_price,
      start_price:         record.start_price,
      last_push_time:      record.last_push_time,
      last_push_bar_index: -CONFIG.min_push_interval - 1, // 重启后允许立即触发
      bar_index:           0,
      updated_at:          Date.now(),
    };
    this.push_contexts.set(key, ctx);
    // EMA 缓存也需要恢复，否则下一根K线无法增量更新
    this.ema_cache.set(key, record.ema20);
  }

  /** 重置某币种某周期的推动计数（手动清除） */
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
