/**
 * 趋势跟随监控服务
 *
 * 识别强势第一波行情，进入观察区后对回调进行分级报警：
 *   等级1（轻度回调）- 回调 < 38.2%，缩量
 *   等级2（黄金回调）- 回调 38.2%~50%，缩量且出现止跌形态
 *   等级3（深度回调）- 回调 50%~61.8%，需谨慎
 *   废弃             - 回调 > 61.8%，或时间超限，或连续大阴线
 *
 * 支持 5m / 15m / 1h / 4h 四个级别同时监控
 */

import { Kline5mData } from '@/database/kline_5m_repository';
import { AggregatedKline } from '@/core/data/kline_aggregator';

// ==================== 类型定义 ====================

export type Timeframe = '5m' | '15m' | '1h' | '4h';
export type WatchState = 'IDLE' | 'DETECTING' | 'WATCHING' | 'ALERTED' | 'ABANDONED';
export type AlertLevel = 1 | 2 | 3;

/** 统一K线格式（5m 和聚合K线都转换为此格式） */
export interface UnifiedKline {
  symbol: string;
  timeframe: Timeframe;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 第一波强势行情记录 */
export interface FirstWave {
  start_index: number;       // 在缓存中的起始索引
  start_price: number;       // 起涨价
  end_price: number;         // 高点价格
  amplitude: number;         // 第一波幅度（high - start_price）
  bar_count: number;         // 第一波 K 线根数
  avg_volume: number;        // 第一波平均成交量
  end_time: number;          // 高点时间戳
}

/** 回调状态跟踪 */
export interface PullbackState {
  lowest_price: number;      // 回调过程中的最低价
  bar_count: number;         // 回调根数
  min_volume: number;        // 回调期间最小成交量（判断缩量）
  avg_volume: number;        // 回调期间平均成交量
  big_down_bars: number;     // 连续大阴线计数
}

/** 观察区状态机（每个币种每个周期独立一个） */
export interface WatchContext {
  symbol: string;
  timeframe: Timeframe;
  state: WatchState;
  wave?: FirstWave;
  pullback?: PullbackState;
  last_alert_level?: AlertLevel;
  watch_start_time?: number;
  abandoned_reason?: string;
}

/** 报警结果 */
export interface TrendAlert {
  symbol: string;
  timeframe: Timeframe;
  alert_level: AlertLevel;
  wave: FirstWave;
  pullback: PullbackState;
  pullback_ratio: number;       // 回调比例 0~1
  fib_zone: string;             // 斐波那契区间描述
  volume_shrink: boolean;       // 是否缩量
  reversal_signal: boolean;     // 是否出现止跌形态
  current_price: number;
  kline_time: number;
}

/** 废弃事件 */
export interface AbandonEvent {
  symbol: string;
  timeframe: Timeframe;
  reason: string;
  wave: FirstWave;
}

// ==================== 配置 ====================

const CONFIG = {
  // 强势第一波判定
  min_consecutive_bull: 4,          // 最少连续阳线根数
  allow_small_bear_gap: 1,          // 允许中间夹的小阴线根数（实体 < 平均实体 30%）
  min_body_ratio: 0.80,             // 连续阳线中实体占比 >= 80% 的根数比例
  min_body_ratio_bars: 0.75,        // 满足实体占比的根数 >= 总根数 75%
  amplitude_multiplier: 1.5,        // 第一波平均实体 >= 前N根平均实体 × 1.5
  amplitude_lookback: 25,           // 计算基准平均实体的回溯根数

  // 回调判定
  fib_38: 0.382,
  fib_50: 0.500,
  fib_62: 0.618,

  volume_shrink_ratio: 0.5,         // 回调均量 < 第一波均量 × 0.5 认为缩量
  max_pullback_bars_multiplier: 2,  // 回调根数上限 = 第一波根数 × 2
  max_watch_abandon_bars: 20,       // 观察区超过此根数废弃（时间衰减）
  big_down_bar_multiplier: 2.0,     // 阴线实体 > 第一波平均实体 × 2 认为大阴线
  max_big_down_bars: 2,             // 连续大阴线超过此数废弃

  // 止跌形态（末端止跌信号）
  reversal_upper_shadow_max: 0.3,   // 上影线 <= 30% 振幅
  reversal_lower_shadow_min: 0.3,   // 下影线 >= 30% 振幅（或十字星实体 <= 10%）
  reversal_doji_body_max: 0.10,     // 十字星实体 <= 10% 振幅

  // 缓存大小
  max_cache_size: 200,
};

// ==================== 服务类 ====================

export class TrendFollowService {
  // K线缓存: `${symbol}_${timeframe}` -> UnifiedKline[]
  private kline_cache: Map<string, UnifiedKline[]> = new Map();

  // 观察区状态机: `${symbol}_${timeframe}` -> WatchContext
  private watch_contexts: Map<string, WatchContext> = new Map();

  // 回调: 触发报警时调用
  private on_alert_cb?: (alert: TrendAlert) => void;
  private on_abandon_cb?: (event: AbandonEvent) => void;

  /** 注册报警回调 */
  on_alert(cb: (alert: TrendAlert) => void): void {
    this.on_alert_cb = cb;
  }

  /** 注册废弃回调 */
  on_abandon(cb: (event: AbandonEvent) => void): void {
    this.on_abandon_cb = cb;
  }

  /**
   * 喂入一根 5m 完结K线，同时更新 5m 级别分析
   */
  process_5m_kline(kline: Kline5mData): void {
    const unified: UnifiedKline = {
      symbol: kline.symbol,
      timeframe: '5m',
      open_time: kline.open_time,
      close_time: kline.close_time,
      open: kline.open,
      high: kline.high,
      low: kline.low,
      close: kline.close,
      volume: kline.volume,
    };
    this._process_kline(unified);
  }

  /**
   * 喂入一根聚合完结K线（15m / 1h / 4h）
   */
  process_aggregated_kline(kline: AggregatedKline): void {
    const tf = kline.interval as Timeframe;
    if (!['15m', '1h', '4h'].includes(tf)) return;

    const unified: UnifiedKline = {
      symbol: kline.symbol,
      timeframe: tf,
      open_time: kline.open_time,
      close_time: kline.close_time,
      open: kline.open,
      high: kline.high,
      low: kline.low,
      close: kline.close,
      volume: kline.volume,
    };
    this._process_kline(unified);
  }

  /**
   * 初始化某币种某周期的历史K线缓存（冷启动预热）
   */
  init_cache(symbol: string, timeframe: Timeframe, klines: UnifiedKline[]): void {
    const key = this._cache_key(symbol, timeframe);
    this.kline_cache.set(key, klines.slice(-CONFIG.max_cache_size));
  }

  /** 获取所有观察中的上下文（用于状态打印） */
  get_watching_contexts(): WatchContext[] {
    return Array.from(this.watch_contexts.values())
      .filter(c => c.state === 'WATCHING' || c.state === 'ALERTED');
  }

  /** 获取统计数据 */
  get_statistics(): { total_watching: number; total_abandoned: number } {
    let watching = 0;
    let abandoned = 0;
    for (const ctx of this.watch_contexts.values()) {
      if (ctx.state === 'WATCHING' || ctx.state === 'ALERTED') watching++;
      if (ctx.state === 'ABANDONED') abandoned++;
    }
    return { total_watching: watching, total_abandoned: abandoned };
  }

  // ==================== 核心逻辑 ====================

  private _cache_key(symbol: string, timeframe: Timeframe): string {
    return `${symbol}_${timeframe}`;
  }

  private _get_or_create_context(symbol: string, timeframe: Timeframe): WatchContext {
    const key = this._cache_key(symbol, timeframe);
    let ctx = this.watch_contexts.get(key);
    if (!ctx) {
      ctx = { symbol, timeframe, state: 'IDLE' };
      this.watch_contexts.set(key, ctx);
    }
    return ctx;
  }

  /** 处理一根完结K线 */
  private _process_kline(kline: UnifiedKline): void {
    const key = this._cache_key(kline.symbol, kline.timeframe);

    // 更新缓存
    let cache = this.kline_cache.get(key);
    if (!cache) {
      cache = [];
      this.kline_cache.set(key, cache);
    }
    // 防重复
    if (cache.length > 0 && cache[cache.length - 1].open_time === kline.open_time) {
      cache[cache.length - 1] = kline;
    } else {
      cache.push(kline);
      if (cache.length > CONFIG.max_cache_size) cache.shift();
    }

    const ctx = this._get_or_create_context(kline.symbol, kline.timeframe);

    switch (ctx.state) {
      case 'IDLE':
      case 'DETECTING':
        this._detect_first_wave(ctx, cache, kline);
        break;
      case 'WATCHING':
      case 'ALERTED':
        this._update_pullback(ctx, cache, kline);
        break;
      case 'ABANDONED':
        // 重置为 IDLE 等待下一波
        ctx.state = 'IDLE';
        ctx.wave = undefined;
        ctx.pullback = undefined;
        ctx.last_alert_level = undefined;
        ctx.watch_start_time = undefined;
        ctx.abandoned_reason = undefined;
        this._detect_first_wave(ctx, cache, kline);
        break;
    }
  }

  /**
   * 检测第一波强势行情
   */
  private _detect_first_wave(
    ctx: WatchContext,
    cache: UnifiedKline[],
    current: UnifiedKline
  ): void {
    if (cache.length < CONFIG.min_consecutive_bull + CONFIG.amplitude_lookback) return;

    // 向前扫描，找连续阳线序列（允许夹小阴线）
    const wave = this._find_bull_wave(cache);
    if (!wave) {
      ctx.state = 'DETECTING';
      return;
    }

    // 进入观察区
    ctx.state = 'WATCHING';
    ctx.wave = wave;
    ctx.watch_start_time = current.open_time;
    ctx.pullback = {
      lowest_price: current.low,
      bar_count: 0,
      min_volume: current.volume,
      avg_volume: current.volume,
      big_down_bars: 0,
    };
    ctx.last_alert_level = undefined;
  }

  /**
   * 从缓存尾部向前扫描，识别最近一段强势阳线波
   * 返回 null 表示未发现强势波
   */
  private _find_bull_wave(cache: UnifiedKline[]): FirstWave | null {
    const len = cache.length;

    // 基准平均实体（取波前 lookback 根）
    const base_klines = cache.slice(
      Math.max(0, len - CONFIG.amplitude_lookback - CONFIG.min_consecutive_bull),
      Math.max(0, len - CONFIG.min_consecutive_bull)
    );
    if (base_klines.length < 5) return null;
    const base_avg_body = base_klines.reduce((s, k) => s + Math.abs(k.close - k.open), 0) / base_klines.length;

    // 从最后一根向前找连续阳线段（最多看最近 20 根）
    const scan_limit = Math.min(len, 20);
    let seq: UnifiedKline[] = [];
    let small_bear_count = 0;

    for (let i = len - 1; i >= len - scan_limit; i--) {
      const k = cache[i];
      const is_bull = k.close > k.open;
      const body = Math.abs(k.close - k.open);
      const range = k.high - k.low;
      const is_small_bear = !is_bull && range > 0 && body / range < 0.3 && body < base_avg_body * 0.3;

      if (is_bull) {
        seq.unshift(k);
      } else if (is_small_bear && small_bear_count < CONFIG.allow_small_bear_gap && seq.length > 0) {
        // 允许夹小阴线
        seq.unshift(k);
        small_bear_count++;
      } else {
        break;
      }
    }

    if (seq.length < CONFIG.min_consecutive_bull) return null;

    // 过滤：只保留首尾都是阳线
    while (seq.length > 0 && seq[0].close <= seq[0].open) seq.shift();
    while (seq.length > 0 && seq[seq.length - 1].close <= seq[seq.length - 1].open) seq.pop();
    if (seq.length < CONFIG.min_consecutive_bull) return null;

    // 检查实体占比：满足条件的根数 >= 总根数 75%
    const bull_bars = seq.filter(k => k.close > k.open);
    const good_body_count = bull_bars.filter(k => {
      const range = k.high - k.low;
      return range > 0 && Math.abs(k.close - k.open) / range >= CONFIG.min_body_ratio;
    }).length;
    if (good_body_count / bull_bars.length < CONFIG.min_body_ratio_bars) return null;

    // 检查幅度：波内平均实体 >= 基准平均实体 × 1.5
    const wave_avg_body = bull_bars.reduce((s, k) => s + Math.abs(k.close - k.open), 0) / bull_bars.length;
    if (wave_avg_body < base_avg_body * CONFIG.amplitude_multiplier) return null;

    const start_price = seq[0].open;
    const end_price = Math.max(...seq.map(k => k.high));
    const amplitude = end_price - start_price;
    if (amplitude <= 0) return null;

    const avg_volume = seq.reduce((s, k) => s + k.volume, 0) / seq.length;

    return {
      start_index: cache.length - seq.length,
      start_price,
      end_price,
      amplitude,
      bar_count: seq.length,
      avg_volume,
      end_time: seq[seq.length - 1].close_time,
    };
  }

  /**
   * 在观察区内更新回调状态并决定报警/废弃
   */
  private _update_pullback(
    ctx: WatchContext,
    cache: UnifiedKline[],
    current: UnifiedKline
  ): void {
    const wave = ctx.wave!;
    const pb = ctx.pullback!;

    // 更新回调统计
    pb.bar_count++;
    pb.lowest_price = Math.min(pb.lowest_price, current.low);
    pb.avg_volume = (pb.avg_volume * (pb.bar_count - 1) + current.volume) / pb.bar_count;
    pb.min_volume = Math.min(pb.min_volume, current.volume);

    // 大阴线计数（连续）
    const is_bear = current.close < current.open;
    const body = Math.abs(current.close - current.open);
    if (is_bear && body > wave.avg_volume * 0 && body > wave.amplitude / wave.bar_count * CONFIG.big_down_bar_multiplier) {
      pb.big_down_bars++;
    } else {
      pb.big_down_bars = 0;
    }

    // ---- 废弃条件 ----
    const pullback_amount = wave.end_price - pb.lowest_price;
    const pullback_ratio = pullback_amount / wave.amplitude;

    // 1. 回调超过 61.8%
    if (pullback_ratio > CONFIG.fib_62) {
      return this._abandon(ctx, wave, `回调幅度 ${(pullback_ratio * 100).toFixed(1)}% 超过 61.8%`);
    }
    // 2. 连续大阴线
    if (pb.big_down_bars >= CONFIG.max_big_down_bars) {
      return this._abandon(ctx, wave, `出现 ${pb.big_down_bars} 根连续大阴线`);
    }
    // 3. 回调根数超限
    if (pb.bar_count > wave.bar_count * CONFIG.max_pullback_bars_multiplier) {
      return this._abandon(ctx, wave, `回调时间过长（${pb.bar_count} 根 > 第一波 ${wave.bar_count} 根 × ${CONFIG.max_pullback_bars_multiplier}）`);
    }
    // 4. 时间衰减
    if (pb.bar_count > CONFIG.max_watch_abandon_bars) {
      return this._abandon(ctx, wave, `观察区超过 ${CONFIG.max_watch_abandon_bars} 根K线`);
    }

    // ---- 报警判断 ----
    const volume_shrink = pb.avg_volume < wave.avg_volume * CONFIG.volume_shrink_ratio;
    const reversal = this._check_reversal_signal(current);

    const new_level = this._calc_alert_level(pullback_ratio, volume_shrink, reversal);
    if (new_level === null) return;

    // 只升级不降级（已报警过更高等级则忽略）
    if (ctx.last_alert_level !== undefined && new_level <= ctx.last_alert_level) return;

    ctx.last_alert_level = new_level;
    ctx.state = 'ALERTED';

    const fib_zone = this._fib_zone_label(pullback_ratio);

    const alert: TrendAlert = {
      symbol: ctx.symbol,
      timeframe: ctx.timeframe,
      alert_level: new_level,
      wave,
      pullback: { ...pb },
      pullback_ratio,
      fib_zone,
      volume_shrink,
      reversal_signal: reversal,
      current_price: current.close,
      kline_time: current.open_time,
    };

    this.on_alert_cb?.(alert);
  }

  /**
   * 根据回调比例、缩量、止跌信号计算报警等级
   * 返回 null 表示不满足任何等级
   */
  private _calc_alert_level(
    pullback_ratio: number,
    volume_shrink: boolean,
    reversal: boolean
  ): AlertLevel | null {
    if (pullback_ratio > CONFIG.fib_62) return null;

    if (pullback_ratio <= CONFIG.fib_38) {
      // 等级1：轻度回调，需缩量
      if (volume_shrink) return 1;
      return null;
    }

    if (pullback_ratio <= CONFIG.fib_50) {
      // 等级2：黄金区间，缩量 + 止跌形态
      if (volume_shrink && reversal) return 2;
      if (volume_shrink) return 1;  // 缩量但无形态，先给1级
      return null;
    }

    // 50% ~ 61.8%：等级3，谨慎区间
    return 3;
  }

  /**
   * 检测止跌形态：倒锤头（下影线长）或十字星（实体小）
   */
  private _check_reversal_signal(k: UnifiedKline): boolean {
    const range = k.high - k.low;
    if (range === 0) return false;
    const body = Math.abs(k.close - k.open);
    const lower_shadow = Math.min(k.open, k.close) - k.low;
    const upper_shadow = k.high - Math.max(k.open, k.close);

    const is_doji = body / range <= CONFIG.reversal_doji_body_max;
    const is_hammer = lower_shadow / range >= CONFIG.reversal_lower_shadow_min
      && upper_shadow / range <= CONFIG.reversal_upper_shadow_max;

    return is_doji || is_hammer;
  }

  private _fib_zone_label(ratio: number): string {
    if (ratio < CONFIG.fib_38) return `< 38.2%（${(ratio * 100).toFixed(1)}%）`;
    if (ratio < CONFIG.fib_50) return `38.2%~50%（${(ratio * 100).toFixed(1)}%）`;
    return `50%~61.8%（${(ratio * 100).toFixed(1)}%）`;
  }

  private _abandon(ctx: WatchContext, wave: FirstWave, reason: string): void {
    ctx.state = 'ABANDONED';
    ctx.abandoned_reason = reason;
    this.on_abandon_cb?.({
      symbol: ctx.symbol,
      timeframe: ctx.timeframe,
      reason,
      wave,
    });
  }
}
