/**
 * 交易信号生成器
 * 基于OI异动数据生成交易信号
 */

import { OIAnomalyRecord } from '../types/oi_types';
import {
  TradingSignal,
  SignalDirection,
  SignalStrength,
  SignalScoreBreakdown
} from '../types/trading_types';
import { logger } from '../utils/logger';

export class SignalGenerator {
  /**
   * 从异动记录生成交易信号
   * @param anomaly 异动记录
   * @returns 交易信号或null（如果不符合条件）
   */
  generate_signal(anomaly: OIAnomalyRecord): TradingSignal | null {
    try {
      // 1. 【避免追高】检查是否已进入晚期狂欢阶段
      const chase_check = this.check_avoid_chase_high(anomaly);
      if (!chase_check.allowed) {
        logger.debug(`[SignalGenerator] Avoid chasing high: ${chase_check.reason} for ${anomaly.symbol}`);
        return null;
      }

      // 2. 计算各项评分
      const score_breakdown = this.calculate_score_breakdown(anomaly);

      // 3. 如果总分太低，不生成信号
      if (score_breakdown.total_score < 4) {
        logger.debug(`[SignalGenerator] Signal score too low (${score_breakdown.total_score}) for ${anomaly.symbol}`);
        return null;
      }

      // 4. 确定信号方向
      const direction = this.determine_direction(anomaly);
      if (direction === SignalDirection.NEUTRAL) {
        logger.debug(`[SignalGenerator] Neutral signal for ${anomaly.symbol}, skipping`);
        return null;
      }

      // 5. 确定信号强度
      const strength = this.determine_strength(score_breakdown.total_score);

      // 6. 计算置信度
      const confidence = this.calculate_confidence(anomaly, score_breakdown);

      // 6. 计算建议价格
      const price_suggestions = this.calculate_price_suggestions(
        anomaly,
        direction,
        strength
      );

      // 7. 构建信号对象
      const signal: TradingSignal = {
        symbol: anomaly.symbol,
        direction,
        strength,
        score: score_breakdown.total_score,
        confidence,
        source_anomaly_id: anomaly.id,
        triggered_at: new Date(),
        entry_price: price_suggestions.entry,
        stop_loss: price_suggestions.stop_loss,
        take_profit: price_suggestions.take_profit,
        score_breakdown,
        anomaly_data: anomaly
      };

      logger.info(`[SignalGenerator] Generated ${strength} ${direction} signal for ${anomaly.symbol}, score: ${score_breakdown.total_score.toFixed(2)}, confidence: ${(confidence * 100).toFixed(1)}%`);

      return signal;
    } catch (error) {
      logger.error('[SignalGenerator] Failed to generate signal:', error);
      return null;
    }
  }

  /**
   * 【核心】检查是否避免追高
   * 根据用户逻辑：抓早期启动，避免晚期狂欢
   */
  private check_avoid_chase_high(anomaly: OIAnomalyRecord): { allowed: boolean; reason?: string } {
    const oi_change = Math.abs(parseFloat(anomaly.percent_change.toString()));
    const price_change = anomaly.price_change_percent
      ? Math.abs(parseFloat(anomaly.price_change_percent.toString()))
      : 0;

    // ❌ 新增：检查当天价格极值（如果价格已经变化超过10%就不入场）
    // 优化：直接使用异动记录中已计算好的price_from_low_pct和price_from_high_pct字段
    if (anomaly.price_from_low_pct !== undefined && anomaly.price_from_low_pct > 10) {
      return {
        allowed: false,
        reason: `价格从日内低点${anomaly.daily_price_low?.toFixed(4)}已涨${anomaly.price_from_low_pct.toFixed(1)}% (>10%), 避免追高`
      };
    }

    if (anomaly.price_from_high_pct !== undefined && anomaly.price_from_high_pct > 10) {
      return {
        allowed: false,
        reason: `价格从日内高点${anomaly.daily_price_high?.toFixed(4)}已跌${anomaly.price_from_high_pct.toFixed(1)}% (>10%), 避免追跌`
      };
    }

    // ❌ 绝对不能追：晚期狂欢信号
    // OI已增长>20% 或 价格已上涨>15%
    if (oi_change > 20) {
      return {
        allowed: false,
        reason: `OI已涨${oi_change.toFixed(1)}% (>20%), 晚期狂欢，避免接盘`
      };
    }

    if (price_change > 15) {
      return {
        allowed: false,
        reason: `价格已涨${price_change.toFixed(1)}% (>15%), 晚期狂欢，避免接盘`
      };
    }

    // ❌ 背离危险信号：OI增长但价格滞涨
    // OI > 8% 但价格 < 1%，说明资金流入但价格不涨，危险
    if (oi_change > 8 && price_change < 1) {
      return {
        allowed: false,
        reason: `OI涨${oi_change.toFixed(1)}%但价格仅涨${price_change.toFixed(1)}%，背离危险`
      };
    }

    // ❌ 情绪过热检查：大户多空比开始下降
    // 如果有大户数据且比例过低，说明大户在撤退
    if (anomaly.top_trader_long_short_ratio) {
      const trader_ratio = parseFloat(anomaly.top_trader_long_short_ratio.toString());
      const oi_direction = parseFloat(anomaly.percent_change.toString()) > 0 ? 'LONG' : 'SHORT';

      // 做多信号但大户多空比<1.0，说明大户在做空
      if (oi_direction === 'LONG' && trader_ratio < 1.0) {
        return {
          allowed: false,
          reason: `做多信号但大户多空比${trader_ratio.toFixed(2)}<1.0，大户反向`
        };
      }

      // 做空信号但大户多空比>1.0，说明大户在做多
      if (oi_direction === 'SHORT' && trader_ratio > 1.0) {
        return {
          allowed: false,
          reason: `做空信号但大户多空比${trader_ratio.toFixed(2)}>1.0，大户反向`
        };
      }
    }

    // ✅ 早期确认信号：允许入场
    // OI刚开始加速（3-10%），价格刚突破（1-8%）
    if (oi_change >= 3 && oi_change <= 15 && price_change >= 1 && price_change <= 10) {
      return { allowed: true };
    }

    // 🟡 其他情况：保守起见，也允许但会在后续评分中过滤
    return { allowed: true };
  }

  /**
   * 计算评分明细
   */
  private calculate_score_breakdown(anomaly: OIAnomalyRecord): SignalScoreBreakdown {
    const oi_score = this.calculate_oi_score(anomaly);
    const price_score = this.calculate_price_score(anomaly);
    const sentiment_score = this.calculate_sentiment_score(anomaly);
    const funding_rate_score = this.calculate_funding_rate_score(anomaly);

    const total_score = oi_score + price_score + sentiment_score + funding_rate_score;

    return {
      oi_score,
      price_score,
      sentiment_score,
      funding_rate_score,
      total_score
    };
  }

  /**
   * OI变化评分（0-3分）
   * 优化：早期启动给高分，晚期狂欢降分
   */
  private calculate_oi_score(anomaly: OIAnomalyRecord): number {
    const oi_change = parseFloat(anomaly.percent_change.toString());
    const abs_change = Math.abs(oi_change);

    let score = 0;

    // 基础分：根据变化幅度（优化：5-15%为最佳区间）
    if (abs_change >= 5 && abs_change <= 10) {
      score = 3;      // 最佳：早期启动阶段
    } else if (abs_change > 10 && abs_change <= 15) {
      score = 2.5;    // 良好：加速阶段
    } else if (abs_change >= 3 && abs_change < 5) {
      score = 2;      // 一般：刚开始异动
    } else if (abs_change > 15 && abs_change <= 20) {
      score = 1.5;    // 警惕：可能过热
    } else if (abs_change > 20) {
      score = 1;      // 危险：晚期狂欢（已被避免追高过滤）
    } else {
      score = 1;      // 变化太小
    }

    // 严重程度加成
    if (anomaly.severity === 'high') {
      score += 0.3;   // 0.5 → 0.3 (降低加成，避免过度追高)
    } else if (anomaly.severity === 'medium') {
      score += 0.2;   // 0.25 → 0.2
    }

    return Math.min(score, 3); // 最高3分
  }

  /**
   * 价格变化评分（0-2分）
   * 优化：2-6%为最佳区间，过高或过低都降分
   */
  private calculate_price_score(anomaly: OIAnomalyRecord): number {
    if (!anomaly.price_change_percent) {
      return 0;
    }

    const price_change = parseFloat(anomaly.price_change_percent.toString());
    const oi_change = parseFloat(anomaly.percent_change.toString());

    // 1. OI和价格同向性检查
    const same_direction = (price_change > 0 && oi_change > 0) || (price_change < 0 && oi_change < 0);
    if (!same_direction) {
      return 0; // 背离情况，不给分
    }

    // 2. 价格变化幅度评分（优化：2-6%最佳，避免追高）
    const abs_price_change = Math.abs(price_change);
    let score = 0;

    if (abs_price_change >= 2 && abs_price_change <= 4) {
      score = 2;      // 最佳：刚突破关键位
    } else if (abs_price_change > 4 && abs_price_change <= 6) {
      score = 1.5;    // 良好：加速阶段
    } else if (abs_price_change >= 1 && abs_price_change < 2) {
      score = 1;      // 一般：刚开始动
    } else if (abs_price_change > 6 && abs_price_change <= 10) {
      score = 0.8;    // 警惕：可能偏高
    } else if (abs_price_change > 10) {
      score = 0.3;    // 危险：涨太多了（已被避免追高过滤）
    } else if (abs_price_change >= 0.5) {
      score = 0.5;    // 太小，可能假突破
    }

    return Math.min(score, 2); // 最高2分
  }

  /**
   * 市场情绪评分（0-3分）
   * 优化：强化大户多空比>1.2的要求
   */
  private calculate_sentiment_score(anomaly: OIAnomalyRecord): number {
    let score = 0;
    let indicators_count = 0;

    const oi_change = parseFloat(anomaly.percent_change.toString());
    const is_long_signal = oi_change > 0;

    // 1. 大户持仓量多空比（权重最高）
    if (anomaly.top_trader_long_short_ratio) {
      const ratio = parseFloat(anomaly.top_trader_long_short_ratio.toString());
      indicators_count++;

      if (is_long_signal) {
        // 做多信号：大户多空比必须>1.2
        if (ratio > 1.5) {
          score += 1.5;   // 1 → 1.5 (大户强力做多)
        } else if (ratio > 1.2) {
          score += 1.0;   // 0.75 → 1.0 (大户偏多，符合要求)
        } else {
          score += 0.1;   // 0.25 → 0.1 (不符合基础条件，大幅降分)
        }
      } else {
        // 做空信号：大户多空比应该<0.8
        if (ratio < 0.7) {
          score += 1.5;   // 大户强力做空
        } else if (ratio < 0.8) {
          score += 1.0;   // 大户偏空
        } else {
          score += 0.1;   // 不符合基础条件
        }
      }
    }

    // 2. 主动买卖量比
    if (anomaly.taker_buy_sell_ratio) {
      const ratio = parseFloat(anomaly.taker_buy_sell_ratio.toString());
      indicators_count++;

      if (ratio > 1.3) {
        score += 1;    // 主动买入强劲
      } else if (ratio > 1.1) {
        score += 0.75;
      } else if (ratio < 0.8) {
        score += 1;    // 主动卖出强劲
      } else if (ratio < 0.9) {
        score += 0.75;
      } else {
        score += 0.25;
      }
    }

    // 3. 全市场多空人数比（反向指标，避免过热）
    if (anomaly.global_long_short_ratio) {
      const ratio = parseFloat(anomaly.global_long_short_ratio.toString());
      indicators_count++;

      if (is_long_signal) {
        // 做多时：全市场<1.5为佳（避免过热）
        if (ratio < 1.2) {
          score += 1.2;   // 1 → 1.2 (散户还没疯，最佳)
        } else if (ratio < 1.5) {
          score += 0.8;   // 0.5 → 0.8 (轻微过热)
        } else {
          score += 0.3;   // 0.5 → 0.3 (过热，危险)
        }
      } else {
        // 做空时：全市场>1.5为佳
        if (ratio > 1.5) {
          score += 1.2;   // 散户疯狂做多，适合做空
        } else if (ratio > 1.2) {
          score += 0.8;
        } else {
          score += 0.3;
        }
      }
    }

    // 归一化到0-3分
    if (indicators_count > 0) {
      score = (score / indicators_count) * 3;
    }

    return Math.min(score, 3);
  }

  /**
   * 资金费率评分（0-2分）
   */
  private calculate_funding_rate_score(anomaly: OIAnomalyRecord): number {
    // 注意：资金费率在OI快照中，这里从anomaly_data中可能没有
    // 实际使用时需要从币安API实时获取
    // 这里先返回中性分1分
    return 1;
  }

  /**
   * 确定信号方向
   */
  private determine_direction(anomaly: OIAnomalyRecord): SignalDirection {
    const oi_change = parseFloat(anomaly.percent_change.toString());
    const price_change = anomaly.price_change_percent
      ? parseFloat(anomaly.price_change_percent.toString())
      : 0;

    // 1. OI和价格都必须有明确方向
    if (Math.abs(oi_change) < 3 || Math.abs(price_change) < 0.5) {
      return SignalDirection.NEUTRAL;
    }

    // 2. OI和价格必须同向
    const oi_direction = oi_change > 0 ? 1 : -1;
    const price_direction = price_change > 0 ? 1 : -1;

    if (oi_direction !== price_direction) {
      return SignalDirection.NEUTRAL; // 背离，不交易
    }

    // 3. 根据方向返回
    return oi_direction > 0 ? SignalDirection.LONG : SignalDirection.SHORT;
  }

  /**
   * 确定信号强度
   */
  private determine_strength(total_score: number): SignalStrength {
    if (total_score >= 7) {
      return SignalStrength.STRONG;
    } else if (total_score >= 5) {
      return SignalStrength.MEDIUM;
    } else {
      return SignalStrength.WEAK;
    }
  }

  /**
   * 计算置信度（0-1）
   */
  private calculate_confidence(
    anomaly: OIAnomalyRecord,
    score_breakdown: SignalScoreBreakdown
  ): number {
    let confidence = 0;

    // 1. 基于总分的基础置信度（40%权重）
    confidence += (score_breakdown.total_score / 10) * 0.4;

    // 2. 基于数据完整性的置信度（30%权重）
    let data_completeness = 0;
    if (anomaly.price_change_percent) data_completeness += 0.25;
    if (anomaly.top_trader_long_short_ratio) data_completeness += 0.25;
    if (anomaly.global_long_short_ratio) data_completeness += 0.25;
    if (anomaly.taker_buy_sell_ratio) data_completeness += 0.25;
    confidence += data_completeness * 0.3;

    // 3. 基于异动严重程度的置信度（30%权重）
    const severity_confidence = anomaly.severity === 'high' ? 1 : anomaly.severity === 'medium' ? 0.7 : 0.4;
    confidence += severity_confidence * 0.3;

    return Math.min(confidence, 1);
  }

  /**
   * 计算价格建议
   */
  private calculate_price_suggestions(
    anomaly: OIAnomalyRecord,
    direction: SignalDirection,
    strength: SignalStrength
  ): { entry: number; stop_loss: number; take_profit: number } {
    // 使用异动后的价格作为入场参考
    const current_price = anomaly.price_after
      ? parseFloat(anomaly.price_after.toString())
      : 0;

    if (current_price === 0) {
      return { entry: 0, stop_loss: 0, take_profit: 0 };
    }

    // 根据信号强度调整止损止盈比例
    let stop_loss_percent = 0.02;  // 默认2%
    let take_profit_percent = 0.05; // 默认5%

    if (strength === SignalStrength.STRONG) {
      stop_loss_percent = 0.015; // 1.5%
      take_profit_percent = 0.06; // 6%
    } else if (strength === SignalStrength.WEAK) {
      stop_loss_percent = 0.025; // 2.5%
      take_profit_percent = 0.04; // 4%
    }

    // 计算具体价格
    let stop_loss: number;
    let take_profit: number;

    if (direction === SignalDirection.LONG) {
      stop_loss = current_price * (1 - stop_loss_percent);
      take_profit = current_price * (1 + take_profit_percent);
    } else {
      stop_loss = current_price * (1 + stop_loss_percent);
      take_profit = current_price * (1 - take_profit_percent);
    }

    return {
      entry: current_price,
      stop_loss,
      take_profit
    };
  }

  /**
   * 批量生成信号
   */
  generate_signals_batch(anomalies: OIAnomalyRecord[]): TradingSignal[] {
    const signals: TradingSignal[] = [];

    for (const anomaly of anomalies) {
      const signal = this.generate_signal(anomaly);
      if (signal) {
        signals.push(signal);
      }
    }

    logger.info(`[SignalGenerator] Generated ${signals.length} signals from ${anomalies.length} anomalies`);
    return signals;
  }

  /**
   * 仅计算信号评分（用于异动记录存储）
   * 不执行完整的信号生成逻辑，仅计算评分和方向
   * @param anomaly 异动记录
   * @returns 评分数据 { score, confidence, direction, avoid_chase_reason }
   */
  calculate_score_only(anomaly: OIAnomalyRecord): {
    signal_score: number;
    signal_confidence: number;
    signal_direction: 'LONG' | 'SHORT' | 'NEUTRAL';
    avoid_chase_reason: string | null;
  } {
    try {
      // 1. 检查是否需要避免追高
      const chase_check = this.check_avoid_chase_high(anomaly);
      if (!chase_check.allowed) {
        // 不通过避免追高检查，记录原因，但仍然计算评分
        const score_breakdown = this.calculate_score_breakdown(anomaly);
        const direction = this.determine_direction(anomaly);
        const confidence = this.calculate_confidence(anomaly, score_breakdown);

        return {
          signal_score: score_breakdown.total_score,
          signal_confidence: confidence,
          signal_direction: direction,
          avoid_chase_reason: chase_check.reason || '避免追高'
        };
      }

      // 2. 计算评分
      const score_breakdown = this.calculate_score_breakdown(anomaly);

      // 3. 确定方向
      const direction = this.determine_direction(anomaly);

      // 4. 计算置信度
      const confidence = this.calculate_confidence(anomaly, score_breakdown);

      return {
        signal_score: score_breakdown.total_score,
        signal_confidence: confidence,
        signal_direction: direction,
        avoid_chase_reason: null
      };
    } catch (error) {
      logger.error('[SignalGenerator] Failed to calculate score:', error);
      return {
        signal_score: 0,
        signal_confidence: 0,
        signal_direction: 'NEUTRAL',
        avoid_chase_reason: 'calculation_error'
      };
    }
  }
}
