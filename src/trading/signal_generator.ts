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
  // 可配置的追高阈值（默认10%）
  private chase_high_threshold: number = 10;

  /**
   * 设置追高阈值
   * @param threshold 追高阈值百分比（例如：10 表示10%）
   */
  set_chase_high_threshold(threshold: number): void {
    this.chase_high_threshold = threshold;
    logger.info(`[SignalGenerator] Chase high threshold set to ${threshold}%`);
  }

  /**
   * 从异动记录生成交易信号（带拒绝原因）
   * @param anomaly 异动记录
   * @returns 信号生成结果，包含信号或拒绝原因
   */
  generate_signal_with_reason(anomaly: OIAnomalyRecord): {
    signal: TradingSignal | null;
    rejected: boolean;
    reason?: string;
  } {
    try {
      // 1. 【避免追高】检查是否已进入晚期狂欢阶段
      const chase_check = this.check_avoid_chase_high(anomaly);
      if (!chase_check.allowed) {
        return { signal: null, rejected: true, reason: chase_check.reason };
      }

      // 2. 计算各项评分
      const score_breakdown = this.calculate_score_breakdown(anomaly);

      // 3. 如果总分太低，不生成信号
      if (score_breakdown.total_score < 4) {
        return {
          signal: null,
          rejected: true,
          reason: `评分过低 (${score_breakdown.total_score.toFixed(1)}分 < 4分)`
        };
      }

      // 4. 确定信号方向
      const direction = this.determine_direction(anomaly);
      if (direction === SignalDirection.NEUTRAL) {
        return { signal: null, rejected: true, reason: '方向不明确 (NEUTRAL)' };
      }

      // 5-7. 生成信号（后续逻辑）
      const strength = this.determine_strength(score_breakdown.total_score);
      const confidence = this.calculate_confidence(anomaly, score_breakdown);
      const price_suggestions = this.calculate_price_suggestions(anomaly, direction, strength);

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

      return { signal, rejected: false };
    } catch (error) {
      logger.error('[SignalGenerator] Failed to generate signal:', error);
      return { signal: null, rejected: true, reason: '信号生成异常' };
    }
  }

  /**
   * 从异动记录生成交易信号
   * @param anomaly 异动记录
   * @returns 交易信号或null（如果不符合条件）
   * @deprecated 建议使用 generate_signal_with_reason 获取拒绝原因
   */
  generate_signal(anomaly: OIAnomalyRecord): TradingSignal | null {
    const result = this.generate_signal_with_reason(anomaly);
    return result.signal;
  }

  /**
   * 【核心】检查是否避免追高
   * 根据用户逻辑：抓早期启动，避免晚期狂欢
   *
   * 优化策略：先检查其他条件，最后再检查价格极值（减少数据库查询）
   */
  private check_avoid_chase_high(anomaly: OIAnomalyRecord): { allowed: boolean; reason?: string } {
    const oi_change = Math.abs(parseFloat(anomaly.percent_change.toString()));
    const price_change = anomaly.price_change_percent
      ? Math.abs(parseFloat(anomaly.price_change_percent.toString()))
      : 0;

    // ❌ 第一步：检查晚期狂欢信号（无需查询数据库）
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

    // ❌ 第二步：检查背离危险信号（无需查询数据库）
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

    // ❌ 第三步：检查价格极值 - 优先使用2小时低点（更精准的追高判断）
    // 2小时低点能更好地捕捉日内二次启动机会，避免因日内凌晨低点而误判

    // 优先检查2小时低点（如果有数据）
    if (anomaly.price_from_2h_low_pct !== null && anomaly.price_from_2h_low_pct !== undefined) {
      const pct = parseFloat(anomaly.price_from_2h_low_pct.toString());
      if (pct > this.chase_high_threshold) {
        return {
          allowed: false,
          reason: `价格从2h低点已涨${pct.toFixed(1)}% (>${this.chase_high_threshold}%), 避免追高`
        };
      }
    } else if (anomaly.price_from_low_pct !== null && anomaly.price_from_low_pct !== undefined) {
      // 回退到日内低点（兼容历史数据和启动初期数据不足的情况）
      const pct = parseFloat(anomaly.price_from_low_pct.toString());
      if (pct > this.chase_high_threshold) {
        return {
          allowed: false,
          reason: `价格从日内低点已涨${pct.toFixed(1)}% (>${this.chase_high_threshold}%), 避免追高`
        };
      }
    }

    if (anomaly.price_from_high_pct !== null && anomaly.price_from_high_pct !== undefined) {
      const pct = parseFloat(anomaly.price_from_high_pct.toString());
      if (pct > this.chase_high_threshold) {
        return {
          allowed: false,
          reason: `价格从日内高点已跌${pct.toFixed(1)}% (>${this.chase_high_threshold}%), 避免追跌`
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
   * 优化：早期启动(3-5%)给最高分，中期加速次之
   */
  private calculate_oi_score(anomaly: OIAnomalyRecord): number {
    const oi_change = parseFloat(anomaly.percent_change.toString());
    const abs_change = Math.abs(oi_change);

    let score = 0;

    // 基础分：根据变化幅度（优化：3-5%为最佳早期启动区间）
    if (abs_change >= 3 && abs_change <= 5) {
      score = 3;      // 最佳：早期启动阶段 ✨
    } else if (abs_change > 5 && abs_change <= 10) {
      score = 2.5;    // 良好：中期加速阶段
    } else if (abs_change > 10 && abs_change <= 15) {
      score = 2;      // 一般：快速拉升期
    } else if (abs_change > 15 && abs_change <= 20) {
      score = 1.5;    // 警惕：可能过热
    } else if (abs_change > 20) {
      score = 1;      // 危险：晚期狂欢（已被避免追高过滤）
    } else {
      score = 1;      // 变化太小(<3%)
    }

    // 严重程度加成
    if (anomaly.severity === 'high') {
      score += 0.3;   // 高严重性加成
    } else if (anomaly.severity === 'medium') {
      score += 0.2;   // 中等严重性加成
    }

    return Math.min(score, 3); // 最高3分
  }

  /**
   * 价格变化评分（0-2分）
   * 优化：结合OI变化判断是强突破还是追高
   */
  private calculate_price_score(anomaly: OIAnomalyRecord): number {
    if (!anomaly.price_change_percent) {
      return 0;
    }

    const price_change = parseFloat(anomaly.price_change_percent.toString());
    const oi_change = parseFloat(anomaly.percent_change.toString());
    const abs_oi_change = Math.abs(oi_change);

    // 1. OI和价格同向性检查
    const same_direction = (price_change > 0 && oi_change > 0) || (price_change < 0 && oi_change < 0);
    if (!same_direction) {
      return 0; // 背离情况，不给分
    }

    // 2. 价格变化幅度评分（结合OI判断）
    const abs_price_change = Math.abs(price_change);
    let score = 0;

    // 核心逻辑：如果OI刚启动(3-5%)，价格大涨是好事（强突破确认）
    const is_oi_early_stage = abs_oi_change >= 3 && abs_oi_change <= 5;

    if (abs_price_change >= 1.5 && abs_price_change <= 3) {
      score = 2;      // 最佳：温和突破
    } else if (abs_price_change > 3 && abs_price_change <= 6) {
      score = 1.8;    // 良好：加速突破
    } else if (abs_price_change > 6 && abs_price_change <= 10) {
      // 关键判断：6-10%的价格变化
      if (is_oi_early_stage) {
        score = 2;    // OI早期+价格大涨 = 强突破确认 ✨
      } else {
        score = 1.2;  // OI已加速+价格大涨 = 可能追高
      }
    } else if (abs_price_change >= 1 && abs_price_change < 1.5) {
      score = 1.5;    // 一般：刚开始动
    } else if (abs_price_change > 10) {
      score = 0.5;    // 危险：涨太多（已被避免追高过滤）
    } else if (abs_price_change >= 0.5) {
      score = 0.8;    // 太小，可能假突破
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

    // 3. 大户账户数多空比（超级指标 - 反映大户共识度）✨
    if (anomaly.top_account_long_short_ratio) {
      const ratio = parseFloat(anomaly.top_account_long_short_ratio.toString());
      indicators_count++;

      if (is_long_signal) {
        // 做多信号：大户账户数多空比越高越好
        if (ratio > 3.0) {
          score += 2.0;   // 超强：绝大多数大户做多
        } else if (ratio > 2.0) {
          score += 1.5;   // 强：大户高度一致做多
        } else if (ratio > 1.5) {
          score += 1.0;   // 中等：大户偏多
        } else {
          score += 0.3;   // 弱：大户分歧大
        }
      } else {
        // 做空信号：大户账户数多空比越低越好
        if (ratio < 0.5) {
          score += 2.0;   // 超强：绝大多数大户做空
        } else if (ratio < 0.7) {
          score += 1.5;   // 强：大户高度一致做空
        } else if (ratio < 0.8) {
          score += 1.0;   // 中等：大户偏空
        } else {
          score += 0.3;   // 弱：大户分歧大
        }
      }
    }

    // 4. 全市场多空人数比（反向指标，避免过热）
    if (anomaly.global_long_short_ratio) {
      const ratio = parseFloat(anomaly.global_long_short_ratio.toString());
      indicators_count++;

      if (is_long_signal) {
        // 做多时：全市场<1.5为佳（避免过热）
        if (ratio < 1.2) {
          score += 1.2;   // 散户还没疯，最佳
        } else if (ratio < 1.5) {
          score += 0.8;   // 轻微过热
        } else {
          score += 0.3;   // 过热，危险
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
   * 优化：利用负费率信号
   */
  private calculate_funding_rate_score(anomaly: OIAnomalyRecord): number {
    // 使用 funding_rate_after 字段
    if (!anomaly.funding_rate_after) {
      return 1; // 无数据，给中性分
    }

    const funding_rate = parseFloat(anomaly.funding_rate_after.toString());
    const oi_change = parseFloat(anomaly.percent_change.toString());
    const is_long_signal = oi_change > 0;

    let score = 1; // 基础中性分

    if (is_long_signal) {
      // 做多信号：负费率是超级信号（做空的人补贴做多的人）
      if (funding_rate < -0.01) {
        score = 2;      // 超强：深度负费率
      } else if (funding_rate < 0) {
        score = 1.7;    // 强：轻微负费率
      } else if (funding_rate < 0.01) {
        score = 1.3;    // 良好：接近零
      } else if (funding_rate > 0.03) {
        score = 0.5;    // 警惕：正费率过高（做多成本高）
      }
    } else {
      // 做空信号：正费率是好信号（做多的人补贴做空的人）
      if (funding_rate > 0.03) {
        score = 2;      // 超强：高正费率
      } else if (funding_rate > 0.01) {
        score = 1.7;    // 强：中等正费率
      } else if (funding_rate > 0) {
        score = 1.3;    // 良好：轻微正费率
      } else if (funding_rate < -0.01) {
        score = 0.5;    // 警惕：负费率（做空成本高）
      }
    }

    return Math.min(score, 2);
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
