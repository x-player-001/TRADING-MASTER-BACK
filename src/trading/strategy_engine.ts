/**
 * 策略引擎
 * 对交易信号进行过滤和评估
 */

import {
  TradingSignal,
  SignalDirection,
  SignalStrength,
  StrategyConfig,
  StrategyType
} from '../types/trading_types';
import { logger } from '../utils/logger';

export class StrategyEngine {
  private config: StrategyConfig;

  constructor(config?: Partial<StrategyConfig>) {
    // 默认配置
    this.config = {
      strategy_type: StrategyType.TREND_FOLLOWING,
      enabled: true,
      min_signal_score: 6,
      min_confidence: 0.6,
      min_oi_change_percent: 3,
      require_price_oi_alignment: true,
      price_oi_divergence_threshold: 2,
      use_sentiment_filter: true,
      min_trader_ratio: 0.8,
      max_funding_rate: 0.001,
      min_funding_rate: -0.001,
      ...config
    };
  }

  /**
   * 评估信号是否可交易
   * @param signal 交易信号
   * @returns 是否通过过滤
   */
  evaluate_signal(signal: TradingSignal): {
    passed: boolean;
    reason?: string;
    adjusted_signal?: TradingSignal;
  } {
    if (!this.config.enabled) {
      return { passed: false, reason: 'Strategy engine is disabled' };
    }

    // 1. 最低评分检查
    if (signal.score < this.config.min_signal_score) {
      return {
        passed: false,
        reason: `Signal score (${signal.score.toFixed(2)}) below minimum (${this.config.min_signal_score})`
      };
    }

    // 2. 最低置信度检查
    if (signal.confidence < this.config.min_confidence) {
      return {
        passed: false,
        reason: `Confidence (${(signal.confidence * 100).toFixed(1)}%) below minimum (${this.config.min_confidence * 100}%)`
      };
    }

    // 3. OI变化幅度检查
    const oi_change_check = this.check_oi_change(signal);
    if (!oi_change_check.passed) {
      return oi_change_check;
    }

    // 4. 价格OI一致性检查
    if (this.config.require_price_oi_alignment) {
      const alignment_check = this.check_price_oi_alignment(signal);
      if (!alignment_check.passed) {
        return alignment_check;
      }
    }

    // 5. 市场情绪过滤
    if (this.config.use_sentiment_filter) {
      const sentiment_check = this.check_sentiment(signal);
      if (!sentiment_check.passed) {
        return sentiment_check;
      }
    }

    // 6. 根据策略类型进行特定检查
    const strategy_check = this.apply_strategy_specific_rules(signal);
    if (!strategy_check.passed) {
      return strategy_check;
    }

    logger.info(`[StrategyEngine] Signal passed all filters: ${signal.symbol} ${signal.direction} (score: ${signal.score.toFixed(2)})`);

    return {
      passed: true,
      adjusted_signal: signal
    };
  }

  /**
   * 检查OI变化幅度
   */
  private check_oi_change(signal: TradingSignal): { passed: boolean; reason?: string } {
    if (!signal.anomaly_data) {
      return { passed: false, reason: 'Missing anomaly data' };
    }

    const oi_change = Math.abs(parseFloat(signal.anomaly_data.percent_change.toString()));

    if (oi_change < this.config.min_oi_change_percent) {
      return {
        passed: false,
        reason: `OI change (${oi_change.toFixed(2)}%) below minimum (${this.config.min_oi_change_percent}%)`
      };
    }

    return { passed: true };
  }

  /**
   * 检查价格和OI的一致性
   */
  private check_price_oi_alignment(signal: TradingSignal): { passed: boolean; reason?: string } {
    if (!signal.anomaly_data) {
      return { passed: true }; // 没有数据就跳过检查
    }

    const anomaly = signal.anomaly_data;

    // 如果没有价格数据，也跳过
    if (!anomaly.price_change_percent) {
      return { passed: true };
    }

    const oi_change = parseFloat(anomaly.percent_change.toString());
    const price_change = parseFloat(anomaly.price_change_percent.toString());

    // 检查方向是否一致
    const oi_direction = oi_change > 0 ? 1 : -1;
    const price_direction = price_change > 0 ? 1 : -1;

    if (oi_direction !== price_direction) {
      return {
        passed: false,
        reason: `OI and price divergence: OI ${oi_change.toFixed(2)}%, Price ${price_change.toFixed(2)}%`
      };
    }

    // 检查是否背离过大
    const change_diff = Math.abs(Math.abs(oi_change) - Math.abs(price_change));
    if (change_diff > this.config.price_oi_divergence_threshold) {
      return {
        passed: false,
        reason: `OI-Price divergence (${change_diff.toFixed(2)}%) exceeds threshold (${this.config.price_oi_divergence_threshold}%)`
      };
    }

    return { passed: true };
  }

  /**
   * 检查市场情绪
   */
  private check_sentiment(signal: TradingSignal): { passed: boolean; reason?: string } {
    if (!signal.anomaly_data) {
      return { passed: true };
    }

    const anomaly = signal.anomaly_data;

    // 检查大户持仓量多空比
    if (anomaly.top_trader_long_short_ratio) {
      const ratio = parseFloat(anomaly.top_trader_long_short_ratio.toString());

      // 如果做多，大户多空比应该 > min_trader_ratio
      if (signal.direction === SignalDirection.LONG && ratio < this.config.min_trader_ratio) {
        return {
          passed: false,
          reason: `Top trader ratio (${ratio.toFixed(2)}) too low for LONG signal`
        };
      }

      // 如果做空，大户多空比应该 < 1/min_trader_ratio
      if (signal.direction === SignalDirection.SHORT && ratio > (1 / this.config.min_trader_ratio)) {
        return {
          passed: false,
          reason: `Top trader ratio (${ratio.toFixed(2)}) too high for SHORT signal`
        };
      }
    }

    return { passed: true };
  }

  /**
   * 应用策略特定规则
   */
  private apply_strategy_specific_rules(signal: TradingSignal): { passed: boolean; reason?: string } {
    switch (this.config.strategy_type) {
      case StrategyType.TREND_FOLLOWING:
        return this.trend_following_rules(signal);

      case StrategyType.MEAN_REVERSION:
        return this.mean_reversion_rules(signal);

      case StrategyType.SENTIMENT_BASED:
        return this.sentiment_based_rules(signal);

      case StrategyType.BREAKOUT:
        return this.breakout_rules(signal);

      default:
        return { passed: true };
    }
  }

  /**
   * 趋势跟随策略规则
   */
  private trend_following_rules(signal: TradingSignal): { passed: boolean; reason?: string } {
    // 趋势跟随：只接受强信号或中等信号
    if (signal.strength === SignalStrength.WEAK) {
      return {
        passed: false,
        reason: 'Trend following requires at least MEDIUM strength signal'
      };
    }

    // 要求OI和价格必须同向且幅度足够
    if (!signal.anomaly_data?.price_change_percent) {
      return {
        passed: false,
        reason: 'Trend following requires price data'
      };
    }

    const price_change = Math.abs(parseFloat(signal.anomaly_data.price_change_percent.toString()));
    if (price_change < 1) {
      return {
        passed: false,
        reason: `Price change (${price_change.toFixed(2)}%) too small for trend following`
      };
    }

    return { passed: true };
  }

  /**
   * 均值回归策略规则
   */
  private mean_reversion_rules(signal: TradingSignal): { passed: boolean; reason?: string } {
    // 均值回归：寻找过度反应后的回调机会
    // 需要OI和价格出现背离
    if (!signal.anomaly_data?.price_change_percent) {
      return { passed: false, reason: 'Mean reversion requires price data' };
    }

    const oi_change = parseFloat(signal.anomaly_data.percent_change.toString());
    const price_change = parseFloat(signal.anomaly_data.price_change_percent.toString());

    // 寻找背离：OI大涨但价格涨幅小，或OI大跌但价格跌幅小
    const change_ratio = Math.abs(oi_change) / Math.max(Math.abs(price_change), 0.1);
    if (change_ratio < 2) {
      return {
        passed: false,
        reason: 'No sufficient OI-Price divergence for mean reversion'
      };
    }

    return { passed: true };
  }

  /**
   * 情绪驱动策略规则
   */
  private sentiment_based_rules(signal: TradingSignal): { passed: boolean; reason?: string } {
    // 情绪驱动：必须有完整的情绪数据
    if (!signal.anomaly_data) {
      return { passed: false, reason: 'Missing anomaly data' };
    }

    const anomaly = signal.anomaly_data;

    // 至少需要两个情绪指标
    let sentiment_indicators = 0;
    if (anomaly.top_trader_long_short_ratio) sentiment_indicators++;
    if (anomaly.top_account_long_short_ratio) sentiment_indicators++;
    if (anomaly.global_long_short_ratio) sentiment_indicators++;
    if (anomaly.taker_buy_sell_ratio) sentiment_indicators++;

    if (sentiment_indicators < 2) {
      return {
        passed: false,
        reason: 'Sentiment-based strategy requires at least 2 sentiment indicators'
      };
    }

    return { passed: true };
  }

  /**
   * 突破策略规则
   * 优化：放宽限制，允许MEDIUM信号，降低置信度要求
   */
  private breakout_rules(signal: TradingSignal): { passed: boolean; reason?: string } {
    // 突破策略：至少需要MEDIUM信号（允许早期启动阶段的中等信号）
    if (signal.strength === SignalStrength.WEAK) {
      return {
        passed: false,
        reason: 'Breakout strategy requires at least MEDIUM signal'
      };
    }

    // 置信度要求：70%即可（0.75 → 0.70）
    if (signal.confidence < 0.70) {
      return {
        passed: false,
        reason: 'Breakout strategy requires confidence >= 70%'
      };
    }

    return { passed: true };
  }

  /**
   * 批量评估信号
   */
  evaluate_signals_batch(signals: TradingSignal[]): {
    passed_signals: TradingSignal[];
    rejected_signals: { signal: TradingSignal; reason: string }[];
  } {
    const passed_signals: TradingSignal[] = [];
    const rejected_signals: { signal: TradingSignal; reason: string }[] = [];

    for (const signal of signals) {
      const result = this.evaluate_signal(signal);

      if (result.passed && result.adjusted_signal) {
        passed_signals.push(result.adjusted_signal);
      } else if (result.reason) {
        rejected_signals.push({ signal, reason: result.reason });
      }
    }

    logger.info(`[StrategyEngine] Evaluated ${signals.length} signals: ${passed_signals.length} passed, ${rejected_signals.length} rejected`);

    return { passed_signals, rejected_signals };
  }

  /**
   * 更新策略配置
   */
  update_config(new_config: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...new_config };
    logger.info('[StrategyEngine] Config updated:', this.config);
  }

  /**
   * 获取当前配置
   */
  get_config(): StrategyConfig {
    return { ...this.config };
  }
}
