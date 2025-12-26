/**
 * 支撑阻力位报警服务
 *
 * 功能:
 * 1. 定期检测支撑阻力位
 * 2. 监控价格是否接近支撑阻力位
 * 3. 基于爆发预测评分筛选高质量信号
 * 4. 生成报警信号并存储
 */

import { SupportResistanceDetector, SRLevel, KlineData } from '@/analysis/support_resistance_detector';
import { BreakoutPredictor, SRLevelInfo, BreakoutPrediction } from '@/analysis/breakout_predictor';
import { SRLevelRepository, SRAlert, SRAlertType, SRLevelType } from '@/database/sr_level_repository';
import { logger } from '@/utils/logger';

/**
 * 报警服务配置
 */
export interface SRAlertServiceConfig {
  // 报警阈值
  approaching_threshold_pct: number;  // 接近阈值，默认0.5%
  touched_threshold_pct: number;      // 触碰阈值，默认0.1%

  // 检测配置
  pivot_left_bars: number;
  pivot_right_bars: number;
  cluster_threshold_pct: number;
  min_touch_count: number;
  min_strength: number;
  max_levels: number;

  // 冷却时间 (防止重复报警)
  cooldown_ms: number;  // 同一价位的冷却时间，默认 30 分钟

  // 爆发预测评分阈值
  min_breakout_score: number;   // 最小爆发评分，低于此分数不报警，默认 60
  enable_squeeze_alert: boolean; // 是否启用纯 SQUEEZE 报警（无需接近关键位）
  squeeze_score_threshold: number; // SQUEEZE 报警评分阈值，默认 80

  // 连续阳线报警配置
  enable_bullish_streak_alert: boolean;  // 是否启用连续阳线报警
  bullish_streak_count: number;          // 连续阳线数量，默认 5
  bullish_streak_min_gain_pct: number;   // 至少一根K线的最小涨幅，默认 1%

  // 回调企稳报警配置
  enable_pullback_alert: boolean;        // 是否启用回调企稳报警
  pullback_min_surge_pct: number;        // 主升浪最小涨幅，默认 5%
  pullback_max_retrace: number;          // 最大回撤比例，默认 0.618
  pullback_min_retrace: number;          // 最小回撤比例，默认 0.236
  pullback_stabilize_bars: number;       // 企稳确认K线数，默认 3

  // 接近/触碰报警配置
  enable_approaching_alert: boolean;     // 是否启用接近/触碰支撑阻力位报警
}

const DEFAULT_CONFIG: SRAlertServiceConfig = {
  approaching_threshold_pct: 0.5,
  touched_threshold_pct: 0.1,
  pivot_left_bars: 5,
  pivot_right_bars: 5,
  cluster_threshold_pct: 0.3,
  min_touch_count: 2,
  min_strength: 30,
  max_levels: 15,
  cooldown_ms: 30 * 60 * 1000,  // 30 分钟
  min_breakout_score: 60,       // 最小评分 60
  enable_squeeze_alert: true,    // 启用 SQUEEZE 报警
  squeeze_score_threshold: 80,   // SQUEEZE 评分阈值 80
  enable_bullish_streak_alert: true,  // 启用连续阳线报警
  bullish_streak_count: 5,            // 连续5根阳线
  bullish_streak_min_gain_pct: 1.0,   // 至少一根涨幅 >= 1%
  enable_pullback_alert: true,        // 启用回调企稳报警
  pullback_min_surge_pct: 5.0,        // 主升浪最小涨幅 5%
  pullback_max_retrace: 0.618,        // 最大回撤 61.8%
  pullback_min_retrace: 0.236,        // 最小回撤 23.6%
  pullback_stabilize_bars: 3,         // 企稳确认 3 根K线
  enable_approaching_alert: true      // 启用接近/触碰报警
};

/**
 * 币种的支撑阻力位缓存
 */
/**
 * 波段信息
 */
interface SwingPoint {
  index: number;
  price: number;
  time: number;
  type: 'HIGH' | 'LOW';
}

/**
 * 回调企稳检测结果
 */
interface PullbackResult {
  is_pullback_ready: boolean;       // 是否触发回调企稳
  swing_low: number;                // 波段低点
  swing_high: number;               // 波段高点
  surge_pct: number;                // 主升浪涨幅
  current_retrace: number;          // 当前回撤比例 (0-1)
  fib_level: string;                // 斐波那契位置描述
  stabilize_signal: string;         // 企稳信号类型
  volume_shrink_pct: number;        // 成交量萎缩百分比
}

interface SymbolSRCache {
  levels: SRLevel[];
  last_update: number;
  last_alerts: Map<string, number>;  // level_key -> last_alert_time
  last_squeeze_alert: number;        // 上次 SQUEEZE 报警时间
  last_squeeze_pct: number;          // 上次 SQUEEZE 报警时的粘合度
  last_bullish_streak_alert: number; // 上次连续阳线报警时间
  last_pullback_alert: number;       // 上次回调企稳报警时间
}

export class SRAlertService {
  private config: SRAlertServiceConfig;
  private detector: SupportResistanceDetector;
  private predictor: BreakoutPredictor;
  private cache: Map<string, SymbolSRCache> = new Map();

  constructor(config?: Partial<SRAlertServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.detector = new SupportResistanceDetector({
      pivot_left_bars: this.config.pivot_left_bars,
      pivot_right_bars: this.config.pivot_right_bars,
      cluster_threshold_pct: this.config.cluster_threshold_pct,
      min_touch_count: this.config.min_touch_count,
      min_strength: this.config.min_strength,
      max_levels: this.config.max_levels
    });
    this.predictor = new BreakoutPredictor();
  }

  /**
   * 更新币种的支撑阻力位
   * @param symbol 币种
   * @param interval K线周期
   * @param klines K线数据
   */
  update_levels(symbol: string, interval: string, klines: KlineData[]): SRLevel[] {
    const cache_key = `${symbol}_${interval}`;

    const levels = this.detector.detect(klines);

    // 更新缓存
    const existing = this.cache.get(cache_key);
    this.cache.set(cache_key, {
      levels,
      last_update: Date.now(),
      last_alerts: existing?.last_alerts || new Map(),
      last_squeeze_alert: existing?.last_squeeze_alert || 0,
      last_squeeze_pct: existing?.last_squeeze_pct ?? Infinity,
      last_bullish_streak_alert: existing?.last_bullish_streak_alert || 0,
      last_pullback_alert: existing?.last_pullback_alert || 0
    });

    return levels;
  }

  /**
   * 检查价格是否触发报警（集成爆发预测评分）
   * @param symbol 币种
   * @param interval K线周期
   * @param klines K线数据
   * @param current_price 当前价格
   * @param kline_time K线时间
   * @returns 触发的报警列表
   */
  check_alerts_with_prediction(
    symbol: string,
    interval: string,
    klines: KlineData[],
    current_price: number,
    kline_time: number
  ): SRAlert[] {
    const cache_key = `${symbol}_${interval}`;
    const cache = this.cache.get(cache_key);

    if (!cache) {
      return [];
    }

    // 检查均线多头排列条件: EMA30 > EMA60 > EMA120 > EMA200
    if (!this.is_bullish_ema_alignment(klines)) {
      return [];  // 均线未多头排列，不产生任何报警
    }

    const alerts: SRAlert[] = [];
    const now = Date.now();

    // 将 SRLevel 转换为 SRLevelInfo 用于预测器
    const sr_levels_info: SRLevelInfo[] = cache.levels.map(l => ({
      price: l.price,
      type: l.type as 'SUPPORT' | 'RESISTANCE',
      strength: l.strength
    }));

    // 获取爆发预测评分
    const prediction = this.predictor.predict(symbol, klines, sr_levels_info);

    if (!prediction) {
      return [];
    }

    // 计算24小时涨幅
    const interval_ms = this.get_interval_ms(interval);
    const { max_gain_pct, has_big_move } = this.calc_24h_max_gain(klines, interval_ms);
    const gain_hint = has_big_move ? ` ⚠️24h涨${max_gain_pct.toFixed(1)}%` : '';

    // 1. 检查是否满足 SQUEEZE 报警条件
    // 触发条件：MA收敛评分 = 100 (表示 EMA20/EMA60 粘合度 <= 0.03%)
    const ma_score = prediction.feature_scores.ma_convergence_score;
    const should_alert_squeeze = this.config.enable_squeeze_alert && ma_score === 100;

    if (should_alert_squeeze) {
      // 计算当前粘合度
      const current_squeeze_pct = this.calc_current_squeeze_pct(klines);

      // 判断是否触发报警:
      // 1. 冷却时间已过，或
      // 2. 在冷却时间内但粘合度比上次更低（更紧密）
      const cooldown_passed = now - cache.last_squeeze_alert >= this.config.cooldown_ms;
      const is_tighter = current_squeeze_pct < cache.last_squeeze_pct;

      if (cooldown_passed || is_tighter) {
        const nearest = prediction.nearest_level;

        const alert: SRAlert = {
          symbol,
          interval,
          alert_type: 'SQUEEZE',
          level_type: nearest?.type || 'SUPPORT',
          level_price: nearest?.price || current_price,
          current_price,
          distance_pct: prediction.distance_to_level_pct,
          level_strength: nearest?.strength || 0,
          kline_time,
          description: `${symbol} EMA20/60粘合 ${(current_squeeze_pct * 100).toFixed(3)}%${gain_hint} | ${prediction.description}`,
          breakout_score: prediction.total_score,
          volatility_score: prediction.feature_scores.volatility_score,
          volume_score: prediction.feature_scores.volume_score,
          ma_convergence_score: ma_score,
          pattern_score: prediction.feature_scores.pattern_score,
          predicted_direction: prediction.predicted_direction
        };

        alerts.push(alert);
        cache.last_squeeze_alert = now;
        cache.last_squeeze_pct = current_squeeze_pct;

        // 如果冷却时间已过，重置上次粘合度记录
        if (cooldown_passed) {
          cache.last_squeeze_pct = current_squeeze_pct;
        }
      }
    } else {
      // 如果不满足SQUEEZE条件且冷却时间已过，重置粘合度记录
      if (now - cache.last_squeeze_alert >= this.config.cooldown_ms) {
        cache.last_squeeze_pct = Infinity;
      }
    }

    // 2. 检查连续阳线报警
    if (this.config.enable_bullish_streak_alert) {
      const bullish_result = this.check_bullish_streak(klines);
      if (bullish_result.is_bullish_streak) {
        // 检查冷却时间
        const cooldown_passed = now - cache.last_bullish_streak_alert >= this.config.cooldown_ms;
        if (cooldown_passed) {
          const nearest = prediction.nearest_level;
          const total_gain = bullish_result.total_gain_pct;
          const max_single = bullish_result.max_single_gain_pct;

          const alert: SRAlert = {
            symbol,
            interval,
            alert_type: 'BULLISH_STREAK',
            level_type: nearest?.type || 'SUPPORT',
            level_price: nearest?.price || current_price,
            current_price,
            distance_pct: prediction.distance_to_level_pct,
            level_strength: nearest?.strength || 0,
            kline_time,
            description: `${symbol} 连续${this.config.bullish_streak_count}根阳线 累计涨${total_gain.toFixed(2)}% 单根最大${max_single.toFixed(2)}%${gain_hint}`,
            breakout_score: prediction.total_score,
            volatility_score: prediction.feature_scores.volatility_score,
            volume_score: prediction.feature_scores.volume_score,
            ma_convergence_score: ma_score,
            pattern_score: prediction.feature_scores.pattern_score,
            predicted_direction: 'UP'  // 连续阳线预测向上
          };

          alerts.push(alert);
          cache.last_bullish_streak_alert = now;
        }
      }
    }

    // 3. 检查回调企稳报警
    if (this.config.enable_pullback_alert) {
      const pullback_result = this.check_pullback_ready(klines);
      if (pullback_result.is_pullback_ready) {
        // 检查冷却时间
        const cooldown_passed = now - cache.last_pullback_alert >= this.config.cooldown_ms;
        if (cooldown_passed) {
          const nearest = prediction.nearest_level;
          const retrace_pct = (pullback_result.current_retrace * 100).toFixed(1);

          const alert: SRAlert = {
            symbol,
            interval,
            alert_type: 'PULLBACK_READY',
            level_type: 'SUPPORT',  // 回调企稳通常是支撑
            level_price: pullback_result.swing_low + (pullback_result.swing_high - pullback_result.swing_low) * (1 - pullback_result.current_retrace),
            current_price,
            distance_pct: prediction.distance_to_level_pct,
            level_strength: nearest?.strength || 50,
            kline_time,
            description: `${symbol} 回调企稳 涨${pullback_result.surge_pct.toFixed(1)}%后回撤${retrace_pct}%(${pullback_result.fib_level}) ${pullback_result.stabilize_signal} 量缩${pullback_result.volume_shrink_pct.toFixed(0)}%${gain_hint}`,
            breakout_score: prediction.total_score,
            volatility_score: prediction.feature_scores.volatility_score,
            volume_score: prediction.feature_scores.volume_score,
            ma_convergence_score: ma_score,
            pattern_score: prediction.feature_scores.pattern_score,
            predicted_direction: 'UP'  // 回调企稳预测向上
          };

          alerts.push(alert);
          cache.last_pullback_alert = now;
        }
      }
    }

    // 4. 检查是否接近支撑阻力位
    // 如果禁用了接近/触碰报警，直接返回
    if (!this.config.enable_approaching_alert) {
      return alerts;
    }

    // 评分条件：评分 >= min_breakout_score，或者24小时有大涨幅（>=10%）
    const score_ok = prediction.total_score >= this.config.min_breakout_score;
    const big_move_bypass = has_big_move;  // 24h涨幅>=10%可以绕过评分限制

    if (!score_ok && !big_move_bypass) {
      // 评分过低且没有大涨幅，不产生接近/触碰报警
      return alerts;
    }

    for (const level of cache.levels) {
      const distance_pct = Math.abs(current_price - level.price) / level.price * 100;
      const level_key = `${level.type}_${level.price.toFixed(8)}`;

      // 检查冷却时间
      const last_alert_time = cache.last_alerts.get(level_key) || 0;
      if (now - last_alert_time < this.config.cooldown_ms) {
        continue;
      }

      let alert_type: SRAlertType | null = null;
      let description = '';
      const type_label = level.type === 'SUPPORT' ? '支撑' : '阻力';

      // 判断报警类型
      if (distance_pct <= this.config.touched_threshold_pct) {
        alert_type = 'TOUCHED';
        description = `${symbol} 触碰${type_label}位 ${level.price.toFixed(6)}${gain_hint} | ${prediction.description}`;
      } else if (distance_pct <= this.config.approaching_threshold_pct) {
        alert_type = 'APPROACHING';
        description = `${symbol} 接近${type_label}位 ${level.price.toFixed(6)}${gain_hint} | ${prediction.description}`;
      }

      if (alert_type) {
        const alert: SRAlert = {
          symbol,
          interval,
          alert_type,
          level_type: level.type as SRLevelType,
          level_price: level.price,
          current_price,
          distance_pct,
          level_strength: level.strength,
          kline_time,
          description,
          breakout_score: prediction.total_score,
          volatility_score: prediction.feature_scores.volatility_score,
          volume_score: prediction.feature_scores.volume_score,
          ma_convergence_score: prediction.feature_scores.ma_convergence_score,
          pattern_score: prediction.feature_scores.pattern_score,
          predicted_direction: prediction.predicted_direction
        };

        alerts.push(alert);

        // 更新冷却时间
        cache.last_alerts.set(level_key, now);
      }
    }

    return alerts;
  }

  /**
   * 检查价格是否触发报警（保留旧接口兼容）
   * @deprecated 使用 check_alerts_with_prediction 替代
   */
  check_alerts(
    symbol: string,
    interval: string,
    current_price: number,
    kline_time: number
  ): SRAlert[] {
    const cache_key = `${symbol}_${interval}`;
    const cache = this.cache.get(cache_key);

    if (!cache || cache.levels.length === 0) {
      return [];
    }

    const alerts: SRAlert[] = [];
    const now = Date.now();

    for (const level of cache.levels) {
      const distance_pct = Math.abs(current_price - level.price) / level.price * 100;
      const level_key = `${level.type}_${level.price.toFixed(8)}`;

      // 检查冷却时间
      const last_alert_time = cache.last_alerts.get(level_key) || 0;
      if (now - last_alert_time < this.config.cooldown_ms) {
        continue;
      }

      let alert_type: SRAlertType | null = null;
      let description = '';

      // 判断报警类型
      if (distance_pct <= this.config.touched_threshold_pct) {
        // 触碰
        alert_type = 'TOUCHED';
        description = `${symbol} 触碰${level.type === 'SUPPORT' ? '支撑' : '阻力'}位 ${level.price.toFixed(6)}`;
      } else if (distance_pct <= this.config.approaching_threshold_pct) {
        // 接近
        alert_type = 'APPROACHING';
        description = `${symbol} 接近${level.type === 'SUPPORT' ? '支撑' : '阻力'}位 ${level.price.toFixed(6)} (距离 ${distance_pct.toFixed(2)}%)`;
      }

      if (alert_type) {
        const alert: SRAlert = {
          symbol,
          interval,
          alert_type,
          level_type: level.type as SRLevelType,
          level_price: level.price,
          current_price,
          distance_pct,
          level_strength: level.strength,
          kline_time,
          description
        };

        alerts.push(alert);

        // 更新冷却时间
        cache.last_alerts.set(level_key, now);
      }
    }

    return alerts;
  }

  /**
   * 完整处理流程：更新支撑阻力位 + 基于爆发预测评分检查报警
   */
  async process(
    symbol: string,
    interval: string,
    klines: KlineData[],
    current_price: number,
    kline_time: number,
    repository?: SRLevelRepository
  ): Promise<SRAlert[]> {
    // 1. 更新支撑阻力位
    this.update_levels(symbol, interval, klines);

    // 2. 基于爆发预测评分检查报警
    const alerts = this.check_alerts_with_prediction(
      symbol,
      interval,
      klines,
      current_price,
      kline_time
    );

    // 3. 保存到数据库（如果提供了 repository）
    if (repository && alerts.length > 0) {
      for (const alert of alerts) {
        try {
          // 检查是否已存在相同报警
          const exists = await repository.alert_exists(
            alert.symbol,
            alert.interval,
            alert.alert_type,
            alert.level_price,
            alert.kline_time
          );

          if (!exists) {
            await repository.save_alert(alert);
            logger.info(`SR Alert [${alert.alert_type}] ${alert.symbol}: 评分=${alert.breakout_score}, 方向=${alert.predicted_direction}`);
          }
        } catch (error) {
          logger.error(`Failed to save SR alert: ${error}`);
        }
      }
    }

    return alerts;
  }

  /**
   * 获取爆发预测（不触发报警，仅用于查询）
   */
  get_breakout_prediction(
    symbol: string,
    interval: string,
    klines: KlineData[]
  ): BreakoutPrediction | null {
    const cache = this.cache.get(`${symbol}_${interval}`);
    const sr_levels_info: SRLevelInfo[] = cache?.levels.map(l => ({
      price: l.price,
      type: l.type as 'SUPPORT' | 'RESISTANCE',
      strength: l.strength
    })) || [];

    return this.predictor.predict(symbol, klines, sr_levels_info);
  }

  /**
   * 获取缓存的支撑阻力位
   */
  get_cached_levels(symbol: string, interval: string): SRLevel[] {
    const cache_key = `${symbol}_${interval}`;
    return this.cache.get(cache_key)?.levels || [];
  }

  /**
   * 获取当前价格附近的支撑阻力位
   */
  get_nearby_levels(
    symbol: string,
    interval: string,
    current_price: number,
    range_pct: number = 3.0
  ): { supports: SRLevel[]; resistances: SRLevel[] } {
    const levels = this.get_cached_levels(symbol, interval);
    return this.detector.find_nearby_levels(levels, current_price, range_pct);
  }

  /**
   * 计算当前粘合度（EMA20 vs EMA60 的差距百分比）
   */
  private calc_current_squeeze_pct(klines: KlineData[]): number {
    const closes = klines.map(k => k.close);
    if (closes.length < 60) {
      return Infinity;
    }

    const ema20 = this.calc_ema(closes, 20);
    const ema60 = this.calc_ema(closes, 60);
    const current_price = closes[closes.length - 1];

    return Math.abs(ema20 - ema60) / current_price;
  }

  /**
   * 计算24小时内最大涨幅
   * @param klines K线数据
   * @param interval_ms K线周期毫秒数
   * @returns { max_gain_pct: number, has_big_move: boolean }
   */
  private calc_24h_max_gain(klines: KlineData[], interval_ms: number): { max_gain_pct: number; has_big_move: boolean } {
    const hours_24_ms = 24 * 60 * 60 * 1000;
    const bars_in_24h = Math.ceil(hours_24_ms / interval_ms);

    if (klines.length < bars_in_24h) {
      return { max_gain_pct: 0, has_big_move: false };
    }

    // 取最近24小时的K线
    const recent_klines = klines.slice(-bars_in_24h);

    // 找24小时内的最低价和当前价
    const low_24h = Math.min(...recent_klines.map(k => k.low));
    const current_price = recent_klines[recent_klines.length - 1].close;

    // 计算从最低点到当前的涨幅
    const max_gain_pct = ((current_price - low_24h) / low_24h) * 100;

    return {
      max_gain_pct,
      has_big_move: max_gain_pct >= 10
    };
  }

  /**
   * 根据K线周期获取毫秒数
   */
  private get_interval_ms(interval: string): number {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 5 * 60 * 1000; // 默认5分钟

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }

  /**
   * 计算EMA（指数移动平均线）
   */
  private calc_ema(data: number[], period: number): number {
    if (data.length < period) {
      return data[data.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * 检查均线是否多头排列
   * 条件: EMA30 > EMA60 (短期趋势向上)
   * @param klines K线数据
   * @returns 是否满足短期多头
   */
  private is_bullish_ema_alignment(klines: KlineData[]): boolean {
    const closes = klines.map(k => k.close);

    // 需要至少60根K线才能计算EMA60
    if (closes.length < 60) {
      return false;
    }

    const ema30 = this.calc_ema(closes, 30);
    const ema60 = this.calc_ema(closes, 60);

    // 短期均线多头: EMA30 > EMA60
    return ema30 > ema60;
  }

  /**
   * 检查是否满足连续阳线条件
   * @param klines K线数据
   * @returns 检测结果
   */
  private check_bullish_streak(klines: KlineData[]): {
    is_bullish_streak: boolean;
    total_gain_pct: number;
    max_single_gain_pct: number;
  } {
    const count = this.config.bullish_streak_count;
    const min_gain = this.config.bullish_streak_min_gain_pct;

    if (klines.length < count) {
      return { is_bullish_streak: false, total_gain_pct: 0, max_single_gain_pct: 0 };
    }

    // 取最后 count 根K线
    const recent = klines.slice(-count);

    // 检查是否都是阳线 (close > open)
    const all_bullish = recent.every(k => k.close > k.open);
    if (!all_bullish) {
      return { is_bullish_streak: false, total_gain_pct: 0, max_single_gain_pct: 0 };
    }

    // 计算每根K线的涨幅
    const gains = recent.map(k => ((k.close - k.open) / k.open) * 100);
    const max_single_gain_pct = Math.max(...gains);
    const total_gain_pct = ((recent[recent.length - 1].close - recent[0].open) / recent[0].open) * 100;

    // 检查是否有至少一根涨幅 >= min_gain
    const has_big_candle = gains.some(g => g >= min_gain);

    return {
      is_bullish_streak: has_big_candle,
      total_gain_pct,
      max_single_gain_pct
    };
  }

  /**
   * 检查是否满足回调企稳条件
   *
   * 逻辑流程:
   * 1. 识别最近的波段低点和高点 (Swing Low -> Swing High)
   * 2. 确认主升浪涨幅 >= 阈值 (如 5%)
   * 3. 检查当前回撤是否在斐波那契关键位 (0.236 - 0.618)
   * 4. 检测企稳信号 (连续阳线不创新低 / 量能萎缩 / 突破短期高点)
   *
   * @param klines K线数据
   * @returns 回调企稳检测结果
   */
  private check_pullback_ready(klines: KlineData[]): PullbackResult {
    const default_result: PullbackResult = {
      is_pullback_ready: false,
      swing_low: 0,
      swing_high: 0,
      surge_pct: 0,
      current_retrace: 0,
      fib_level: '',
      stabilize_signal: '',
      volume_shrink_pct: 0
    };

    if (klines.length < 30) {
      return default_result;
    }

    // 1. 识别波段高点和低点
    const swing_points = this.find_swing_points(klines);
    if (swing_points.length < 2) {
      return default_result;
    }

    // 找到最近的 Swing High（波段高点）
    const recent_highs = swing_points.filter(p => p.type === 'HIGH').slice(-3);
    const recent_lows = swing_points.filter(p => p.type === 'LOW').slice(-3);

    if (recent_highs.length === 0 || recent_lows.length === 0) {
      return default_result;
    }

    // 找到有效的上涨波段: Swing Low -> Swing High
    // 条件: High 在 Low 之后，且涨幅 >= 阈值
    let valid_swing_low: SwingPoint | null = null;
    let valid_swing_high: SwingPoint | null = null;

    for (const high of recent_highs.reverse()) {  // 从最近的高点开始
      for (const low of recent_lows.reverse()) {  // 从最近的低点开始
        if (low.index < high.index) {  // Low 必须在 High 之前
          const surge_pct = ((high.price - low.price) / low.price) * 100;
          if (surge_pct >= this.config.pullback_min_surge_pct) {
            valid_swing_low = low;
            valid_swing_high = high;
            break;
          }
        }
      }
      if (valid_swing_low && valid_swing_high) break;
    }

    if (!valid_swing_low || !valid_swing_high) {
      return default_result;
    }

    // 2. 计算主升浪涨幅
    const surge_pct = ((valid_swing_high.price - valid_swing_low.price) / valid_swing_low.price) * 100;

    // 3. 检查当前价格的回撤位置
    const current_price = klines[klines.length - 1].close;
    const current_low = klines[klines.length - 1].low;

    // 确保当前价格低于波段高点（正在回调中）
    if (current_price >= valid_swing_high.price) {
      return default_result;
    }

    // 确保没有跌破波段低点
    if (current_low <= valid_swing_low.price) {
      return default_result;
    }

    // 计算回撤比例 (0-1, 0=高点, 1=低点)
    const swing_range = valid_swing_high.price - valid_swing_low.price;
    const pullback_amount = valid_swing_high.price - current_price;
    const current_retrace = pullback_amount / swing_range;

    // 检查回撤是否在有效范围内
    // - 只要低于前高就算回调 (current_retrace > 0)
    // - 跌破0.618就是反转，不再是回调
    if (current_retrace <= 0 || current_retrace > this.config.pullback_max_retrace) {
      return default_result;
    }

    // 确定斐波那契位置描述
    let fib_level = '';
    if (current_retrace <= 0.236) {
      fib_level = '<0.236';
    } else if (current_retrace <= 0.382) {
      fib_level = '0.382';
    } else if (current_retrace <= 0.5) {
      fib_level = '0.5';
    } else {
      fib_level = '0.618';
    }

    // 4. 检测企稳信号
    const stabilize_check = this.check_stabilize_signal(klines, valid_swing_high.index);
    if (!stabilize_check.is_stabilized) {
      return default_result;
    }

    // 5. 计算成交量萎缩百分比
    const volume_shrink_pct = this.calc_volume_shrink(klines, valid_swing_high.index);

    return {
      is_pullback_ready: true,
      swing_low: valid_swing_low.price,
      swing_high: valid_swing_high.price,
      surge_pct,
      current_retrace,
      fib_level,
      stabilize_signal: stabilize_check.signal_type,
      volume_shrink_pct
    };
  }

  /**
   * 识别波段高低点 (Swing High / Swing Low)
   * 使用左右各N根K线确认
   */
  private find_swing_points(klines: KlineData[]): SwingPoint[] {
    const points: SwingPoint[] = [];
    const lookback = 5;  // 左右各5根K线确认

    for (let i = lookback; i < klines.length - lookback; i++) {
      const current = klines[i];

      // 检查是否为 Swing High
      let is_swing_high = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i && klines[j].high >= current.high) {
          is_swing_high = false;
          break;
        }
      }
      if (is_swing_high) {
        points.push({
          index: i,
          price: current.high,
          time: current.open_time,
          type: 'HIGH'
        });
      }

      // 检查是否为 Swing Low
      let is_swing_low = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i && klines[j].low <= current.low) {
          is_swing_low = false;
          break;
        }
      }
      if (is_swing_low) {
        points.push({
          index: i,
          price: current.low,
          time: current.open_time,
          type: 'LOW'
        });
      }
    }

    return points.sort((a, b) => a.index - b.index);
  }

  /**
   * 检测企稳信号
   *
   * 企稳信号类型:
   * 1. 锤子线形态 (底部反转信号)
   * 2. 靠近前高 (价格接近波段高点，准备突破)
   */
  private check_stabilize_signal(klines: KlineData[], high_index: number): {
    is_stabilized: boolean;
    signal_type: string;
  } {
    const stabilize_bars = this.config.pullback_stabilize_bars;
    const recent = klines.slice(-stabilize_bars);

    if (recent.length < stabilize_bars) {
      return { is_stabilized: false, signal_type: '' };
    }

    const last = klines[klines.length - 1];

    // 1. 检查锤子线形态 (下影线长，实体小)
    const body = Math.abs(last.close - last.open);
    const lower_shadow = Math.min(last.open, last.close) - last.low;
    const upper_shadow = last.high - Math.max(last.open, last.close);
    const total_range = last.high - last.low;

    if (total_range > 0) {
      const body_ratio = body / total_range;
      const lower_shadow_ratio = lower_shadow / total_range;

      // 锤子线特征: 实体小(<30%), 下影线长(>50%), 上影线短(<20%)
      if (body_ratio < 0.3 && lower_shadow_ratio > 0.5 && upper_shadow / total_range < 0.2) {
        return { is_stabilized: true, signal_type: '锤子线' };
      }
    }

    // 2. 检查靠近前高 (价格接近波段高点)
    // 获取波段高点价格
    if (high_index > 0 && high_index < klines.length) {
      const swing_high_price = klines[high_index].high;
      const current_price = last.close;

      // 计算距离高点的百分比
      const distance_to_high_pct = ((swing_high_price - current_price) / swing_high_price) * 100;

      // 靠近前高条件: 距离高点 < 0.5%，且当前K线是阳线
      const is_bullish = last.close > last.open;
      if (distance_to_high_pct > 0 && distance_to_high_pct < 0.5 && is_bullish) {
        return { is_stabilized: true, signal_type: '靠近前高' };
      }
    }

    return { is_stabilized: false, signal_type: '' };
  }

  /**
   * 计算回调期间的成交量萎缩百分比
   */
  private calc_volume_shrink(klines: KlineData[], high_index: number): number {
    // 主升浪期间的平均成交量 (取高点前的5根K线)
    const surge_start = Math.max(0, high_index - 5);
    const surge_klines = klines.slice(surge_start, high_index);
    if (surge_klines.length === 0) return 0;

    const surge_avg_volume = surge_klines.reduce((sum, k) => sum + k.volume, 0) / surge_klines.length;

    // 回调期间的平均成交量 (高点后到最新)
    const pullback_klines = klines.slice(high_index + 1);
    if (pullback_klines.length === 0) return 0;

    const pullback_avg_volume = pullback_klines.reduce((sum, k) => sum + k.volume, 0) / pullback_klines.length;

    // 计算萎缩百分比
    if (surge_avg_volume === 0) return 0;
    return ((surge_avg_volume - pullback_avg_volume) / surge_avg_volume) * 100;
  }

  /**
   * 清除缓存
   */
  clear_cache(symbol?: string, interval?: string): void {
    if (symbol && interval) {
      this.cache.delete(`${symbol}_${interval}`);
    } else {
      this.cache.clear();
    }
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<SRAlertServiceConfig>): void {
    this.config = { ...this.config, ...config };

    // 同步更新检测器配置
    this.detector.update_config({
      pivot_left_bars: this.config.pivot_left_bars,
      pivot_right_bars: this.config.pivot_right_bars,
      cluster_threshold_pct: this.config.cluster_threshold_pct,
      min_touch_count: this.config.min_touch_count,
      min_strength: this.config.min_strength,
      max_levels: this.config.max_levels
    });
  }

  /**
   * 格式化显示支撑阻力位摘要
   */
  format_summary(symbol: string, interval: string, current_price: number): string {
    const nearby = this.get_nearby_levels(symbol, interval, current_price, 5);

    const lines: string[] = [
      `${symbol} 支撑阻力位 (当前价: ${current_price.toFixed(6)})`,
      '─'.repeat(40)
    ];

    if (nearby.resistances.length > 0) {
      lines.push('阻力位:');
      for (const r of nearby.resistances.slice(0, 3)) {
        const dist = ((r.price - current_price) / current_price * 100).toFixed(2);
        lines.push(`  ↑ ${r.price.toFixed(6)} (+${dist}%) 强度:${r.strength}`);
      }
    }

    lines.push(`  ● ${current_price.toFixed(6)} ← 当前价`);

    if (nearby.supports.length > 0) {
      lines.push('支撑位:');
      for (const s of nearby.supports.slice(0, 3)) {
        const dist = ((current_price - s.price) / current_price * 100).toFixed(2);
        lines.push(`  ↓ ${s.price.toFixed(6)} (-${dist}%) 强度:${s.strength}`);
      }
    }

    return lines.join('\n');
  }
}
