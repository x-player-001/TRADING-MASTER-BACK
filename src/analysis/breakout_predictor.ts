/**
 * 爆发预测器 - 基于多维度特征评估突破概率
 *
 * 核心特征:
 * 1. 波动收敛度 - 布林带宽度/ATR降低
 * 2. 成交量萎缩 - 相对历史均量的缩量程度
 * 3. 均线收敛度 - MA5/MA10/MA20的靠拢程度
 * 4. 位置接近度 - 距支撑阻力位的距离
 * 5. 形态特征 - K线实体缩小、影线变短
 */

import { logger } from '@/utils/logger';

/**
 * K线数据结构
 */
export interface KlineData {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 支撑阻力位数据
 */
export interface SRLevelInfo {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strength: number;
}

/**
 * 各维度评分详情
 */
export interface FeatureScores {
  volatility_score: number;      // 波动收敛度评分 (0-100)
  volume_score: number;          // 成交量萎缩评分 (0-100)
  ma_convergence_score: number;  // 均线收敛度评分 (0-100)
  position_score: number;        // 位置接近度评分 (0-100)
  pattern_score: number;         // 形态特征评分 (0-100)
}

/**
 * 爆发预测结果
 */
export interface BreakoutPrediction {
  symbol: string;
  timestamp: number;
  total_score: number;           // 综合评分 (0-100)
  alert_level: 'NONE' | 'WATCH' | 'WARNING' | 'CRITICAL';
  feature_scores: FeatureScores;
  nearest_level: SRLevelInfo | null;  // 最近的支撑阻力位
  distance_to_level_pct: number;      // 距离最近位置的百分比
  predicted_direction: 'UP' | 'DOWN' | 'UNKNOWN';  // 预测突破方向
  description: string;
}

/**
 * 爆发预测器配置
 */
export interface BreakoutPredictorConfig {
  // 权重配置
  volatility_weight: number;     // 波动收敛权重 (默认 0.25)
  volume_weight: number;         // 成交量权重 (默认 0.20)
  ma_convergence_weight: number; // 均线收敛权重 (默认 0.20)
  position_weight: number;       // 位置接近权重 (默认 0.20)
  pattern_weight: number;        // 形态特征权重 (默认 0.15)

  // 阈值配置
  watch_threshold: number;       // 观察阈值 (默认 60)
  warning_threshold: number;     // 预警阈值 (默认 75)
  critical_threshold: number;    // 临界阈值 (默认 85)

  // 计算参数
  bb_period: number;             // 布林带周期 (默认 20)
  atr_period: number;            // ATR周期 (默认 14)
  volume_period: number;         // 成交量对比周期 (默认 20)
  ma_short: number;              // 短期均线 (默认 5)
  ma_mid: number;                // 中期均线 (默认 10)
  ma_long: number;               // 长期均线 (默认 20)
}

const DEFAULT_CONFIG: BreakoutPredictorConfig = {
  volatility_weight: 0.25,
  volume_weight: 0.20,
  ma_convergence_weight: 0.20,
  position_weight: 0.20,
  pattern_weight: 0.15,

  watch_threshold: 60,
  warning_threshold: 75,
  critical_threshold: 85,

  bb_period: 20,
  atr_period: 14,
  volume_period: 20,
  ma_short: 5,
  ma_mid: 10,
  ma_long: 20
};

/**
 * 爆发预测器
 */
export class BreakoutPredictor {
  private config: BreakoutPredictorConfig;

  constructor(config: Partial<BreakoutPredictorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 预测爆发概率
   */
  predict(
    symbol: string,
    klines: KlineData[],
    sr_levels: SRLevelInfo[] = []
  ): BreakoutPrediction | null {
    if (klines.length < this.config.bb_period + 10) {
      return null;
    }

    const current_price = klines[klines.length - 1].close;
    const timestamp = klines[klines.length - 1].close_time;

    // 计算各维度评分
    const volatility_score = this.calc_volatility_score(klines);
    const volume_score = this.calc_volume_score(klines);
    const ma_convergence_score = this.calc_ma_convergence_score(klines);
    const { position_score, nearest_level, distance_pct } =
      this.calc_position_score(current_price, sr_levels);
    const pattern_score = this.calc_pattern_score(klines);

    // 计算综合评分
    const total_score =
      volatility_score * this.config.volatility_weight +
      volume_score * this.config.volume_weight +
      ma_convergence_score * this.config.ma_convergence_weight +
      position_score * this.config.position_weight +
      pattern_score * this.config.pattern_weight;

    // 确定报警级别
    let alert_level: BreakoutPrediction['alert_level'] = 'NONE';
    if (total_score >= this.config.critical_threshold) {
      alert_level = 'CRITICAL';
    } else if (total_score >= this.config.warning_threshold) {
      alert_level = 'WARNING';
    } else if (total_score >= this.config.watch_threshold) {
      alert_level = 'WATCH';
    }

    // 预测突破方向
    const predicted_direction = this.predict_direction(klines, sr_levels, current_price);

    // 生成描述
    const description = this.generate_description({
      volatility_score,
      volume_score,
      ma_convergence_score,
      position_score,
      pattern_score
    }, total_score, alert_level, predicted_direction);

    return {
      symbol,
      timestamp,
      total_score: Math.round(total_score * 10) / 10,
      alert_level,
      feature_scores: {
        volatility_score: Math.round(volatility_score),
        volume_score: Math.round(volume_score),
        ma_convergence_score: Math.round(ma_convergence_score),
        position_score: Math.round(position_score),
        pattern_score: Math.round(pattern_score)
      },
      nearest_level,
      distance_to_level_pct: Math.round(distance_pct * 100) / 100,
      predicted_direction,
      description
    };
  }

  /**
   * 计算波动收敛度评分
   * 布林带宽度相对历史的缩窄程度 + ATR下降程度
   */
  private calc_volatility_score(klines: KlineData[]): number {
    const closes = klines.map(k => k.close);
    const period = this.config.bb_period;

    // 计算当前布林带宽度
    const recent_closes = closes.slice(-period);
    const sma = this.calc_sma(recent_closes, period);
    const std = this.calc_std(recent_closes, sma);
    const current_bb_width = (std * 2) / sma * 100; // 百分比宽度

    // 计算历史布林带宽度（用于对比）
    const history_start = Math.max(0, closes.length - period * 3);
    const history_closes = closes.slice(history_start, -period);
    if (history_closes.length < period) {
      return 50; // 历史数据不足，返回中性分数
    }

    const history_widths: number[] = [];
    for (let i = period; i <= history_closes.length; i++) {
      const slice = history_closes.slice(i - period, i);
      const hist_sma = this.calc_sma(slice, period);
      const hist_std = this.calc_std(slice, hist_sma);
      history_widths.push((hist_std * 2) / hist_sma * 100);
    }

    if (history_widths.length === 0) {
      return 50;
    }

    const avg_width = history_widths.reduce((a, b) => a + b, 0) / history_widths.length;

    // 当前宽度相对历史均值的比例（越小说明越收敛）
    const width_ratio = current_bb_width / avg_width;

    // 计算ATR收敛
    const atr_score = this.calc_atr_convergence(klines);

    // 综合评分：宽度越小得分越高
    // width_ratio < 0.5 时得分 100，> 1.5 时得分 0
    let bb_score = 100 - (width_ratio - 0.3) * 100;
    bb_score = Math.max(0, Math.min(100, bb_score));

    return (bb_score * 0.6 + atr_score * 0.4);
  }

  /**
   * 计算ATR收敛程度
   */
  private calc_atr_convergence(klines: KlineData[]): number {
    const period = this.config.atr_period;
    if (klines.length < period * 2) {
      return 50;
    }

    // 计算True Range
    const calc_tr = (k: KlineData, prev_close: number): number => {
      return Math.max(
        k.high - k.low,
        Math.abs(k.high - prev_close),
        Math.abs(k.low - prev_close)
      );
    };

    // 当前ATR
    let current_atr = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
      current_atr += calc_tr(klines[i], klines[i - 1].close);
    }
    current_atr /= period;

    // 历史ATR（前一个周期）
    let history_atr = 0;
    for (let i = klines.length - period * 2; i < klines.length - period; i++) {
      history_atr += calc_tr(klines[i], klines[i - 1].close);
    }
    history_atr /= period;

    // ATR下降比例
    const atr_ratio = current_atr / history_atr;

    // 比例越小得分越高
    let score = 100 - (atr_ratio - 0.3) * 100;
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 计算成交量萎缩评分
   * 近期成交量相对历史均量的缩量程度
   */
  private calc_volume_score(klines: KlineData[]): number {
    const period = this.config.volume_period;
    if (klines.length < period * 2) {
      return 50;
    }

    const volumes = klines.map(k => k.volume);

    // 近期平均成交量（最近5根）
    const recent_vol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

    // 历史平均成交量
    const history_vol = volumes.slice(-period - 5, -5).reduce((a, b) => a + b, 0) / period;

    if (history_vol === 0) {
      return 50;
    }

    // 成交量比例
    const vol_ratio = recent_vol / history_vol;

    // 检查是否连续缩量
    let consecutive_shrink = 0;
    for (let i = volumes.length - 1; i >= Math.max(0, volumes.length - 5); i--) {
      if (volumes[i] < history_vol * 0.8) {
        consecutive_shrink++;
      } else {
        break;
      }
    }

    // 成交量越低得分越高
    // vol_ratio < 0.3 时得分 100，> 1.0 时得分 0
    let base_score = (1 - vol_ratio) * 100 + 20;
    base_score = Math.max(0, Math.min(100, base_score));

    // 连续缩量加分
    const consecutive_bonus = consecutive_shrink * 5;

    return Math.min(100, base_score + consecutive_bonus);
  }

  /**
   * 计算均线收敛度评分
   * MA5/MA10/MA20的靠拢程度
   */
  private calc_ma_convergence_score(klines: KlineData[]): number {
    const closes = klines.map(k => k.close);

    if (closes.length < this.config.ma_long) {
      return 50;
    }

    // 计算各周期均线
    const ma5 = this.calc_sma(closes.slice(-this.config.ma_short), this.config.ma_short);
    const ma10 = this.calc_sma(closes.slice(-this.config.ma_mid), this.config.ma_mid);
    const ma20 = this.calc_sma(closes.slice(-this.config.ma_long), this.config.ma_long);

    const current_price = closes[closes.length - 1];

    // 计算均线之间的距离（相对价格的百分比）
    const dist_5_10 = Math.abs(ma5 - ma10) / current_price * 100;
    const dist_10_20 = Math.abs(ma10 - ma20) / current_price * 100;
    const dist_5_20 = Math.abs(ma5 - ma20) / current_price * 100;

    // 总距离
    const total_dist = dist_5_10 + dist_10_20 + dist_5_20;

    // 计算历史均线距离用于对比
    if (closes.length < this.config.ma_long + 10) {
      // 绝对距离评分：距离越小得分越高
      // 总距离 < 1% 时得分 100，> 5% 时得分 0
      let score = 100 - (total_dist - 0.5) * 25;
      return Math.max(0, Math.min(100, score));
    }

    // 计算10根K线前的均线距离
    const prev_closes = closes.slice(0, -10);
    const prev_ma5 = this.calc_sma(prev_closes.slice(-this.config.ma_short), this.config.ma_short);
    const prev_ma10 = this.calc_sma(prev_closes.slice(-this.config.ma_mid), this.config.ma_mid);
    const prev_ma20 = this.calc_sma(prev_closes.slice(-this.config.ma_long), this.config.ma_long);

    const prev_price = prev_closes[prev_closes.length - 1];
    const prev_total_dist =
      Math.abs(prev_ma5 - prev_ma10) / prev_price * 100 +
      Math.abs(prev_ma10 - prev_ma20) / prev_price * 100 +
      Math.abs(prev_ma5 - prev_ma20) / prev_price * 100;

    // 距离缩小的比例
    const shrink_ratio = total_dist / (prev_total_dist + 0.001);

    // 综合评分
    let abs_score = 100 - (total_dist - 0.5) * 25;
    abs_score = Math.max(0, Math.min(100, abs_score));

    let relative_score = (1 - shrink_ratio) * 100 + 50;
    relative_score = Math.max(0, Math.min(100, relative_score));

    return (abs_score * 0.6 + relative_score * 0.4);
  }

  /**
   * 计算位置接近度评分
   * 距离支撑阻力位的距离
   */
  private calc_position_score(
    current_price: number,
    sr_levels: SRLevelInfo[]
  ): { position_score: number; nearest_level: SRLevelInfo | null; distance_pct: number } {
    if (sr_levels.length === 0) {
      return { position_score: 50, nearest_level: null, distance_pct: 0 };
    }

    // 找到最近的支撑阻力位
    let nearest_level: SRLevelInfo | null = null;
    let min_distance = Infinity;

    for (const level of sr_levels) {
      const distance = Math.abs(current_price - level.price) / current_price;
      if (distance < min_distance) {
        min_distance = distance;
        nearest_level = level;
      }
    }

    if (!nearest_level) {
      return { position_score: 50, nearest_level: null, distance_pct: 0 };
    }

    const distance_pct = min_distance * 100;

    // 距离越近得分越高，同时考虑强度
    // 距离 < 0.5% 时得分 100，> 3% 时得分 0
    let distance_score = 100 - (distance_pct - 0.3) * 40;
    distance_score = Math.max(0, Math.min(100, distance_score));

    // 强度加权
    const strength_factor = nearest_level.strength / 100;
    const final_score = distance_score * 0.7 + distance_score * strength_factor * 0.3;

    return {
      position_score: Math.min(100, final_score),
      nearest_level,
      distance_pct
    };
  }

  /**
   * 计算形态特征评分
   * K线实体缩小、影线变短、整体振幅收窄
   */
  private calc_pattern_score(klines: KlineData[]): number {
    if (klines.length < 20) {
      return 50;
    }

    const recent = klines.slice(-5);
    const history = klines.slice(-20, -5);

    // 计算K线实体占比（实体/振幅）
    const calc_body_ratio = (k: KlineData): number => {
      const range = k.high - k.low;
      if (range === 0) return 0;
      return Math.abs(k.close - k.open) / range;
    };

    // 计算振幅（相对价格）
    const calc_range_pct = (k: KlineData): number => {
      return (k.high - k.low) / k.close * 100;
    };

    // 近期平均
    const recent_body_ratio = recent.reduce((sum, k) => sum + calc_body_ratio(k), 0) / recent.length;
    const recent_range = recent.reduce((sum, k) => sum + calc_range_pct(k), 0) / recent.length;

    // 历史平均
    const history_body_ratio = history.reduce((sum, k) => sum + calc_body_ratio(k), 0) / history.length;
    const history_range = history.reduce((sum, k) => sum + calc_range_pct(k), 0) / history.length;

    // 实体缩小得分（实体占比降低表示犹豫）
    let body_score = 50;
    if (recent_body_ratio < history_body_ratio) {
      body_score = 50 + (1 - recent_body_ratio / history_body_ratio) * 50;
    }

    // 振幅缩小得分
    let range_score = 50;
    if (history_range > 0) {
      const range_ratio = recent_range / history_range;
      range_score = 100 - (range_ratio - 0.3) * 100;
    }
    range_score = Math.max(0, Math.min(100, range_score));

    // 检查是否形成收敛形态（高点降低 + 低点抬高）
    let convergence_score = 50;
    if (recent.length >= 3) {
      const highs = recent.map(k => k.high);
      const lows = recent.map(k => k.low);

      let high_declining = true;
      let low_rising = true;

      for (let i = 1; i < highs.length; i++) {
        if (highs[i] > highs[i - 1] * 1.001) high_declining = false;
        if (lows[i] < lows[i - 1] * 0.999) low_rising = false;
      }

      if (high_declining && low_rising) {
        convergence_score = 90; // 明显的三角收敛
      } else if (high_declining || low_rising) {
        convergence_score = 70; // 部分收敛
      }
    }

    return (body_score * 0.3 + range_score * 0.4 + convergence_score * 0.3);
  }

  /**
   * 预测突破方向
   */
  private predict_direction(
    klines: KlineData[],
    sr_levels: SRLevelInfo[],
    current_price: number
  ): 'UP' | 'DOWN' | 'UNKNOWN' {
    // 找最近的支撑和阻力
    let nearest_support: SRLevelInfo | null = null;
    let nearest_resistance: SRLevelInfo | null = null;
    let min_support_dist = Infinity;
    let min_resistance_dist = Infinity;

    for (const level of sr_levels) {
      const dist = Math.abs(current_price - level.price);
      if (level.type === 'SUPPORT' && level.price < current_price) {
        if (dist < min_support_dist) {
          min_support_dist = dist;
          nearest_support = level;
        }
      } else if (level.type === 'RESISTANCE' && level.price > current_price) {
        if (dist < min_resistance_dist) {
          min_resistance_dist = dist;
          nearest_resistance = level;
        }
      }
    }

    // 计算趋势（简单的价格动量）
    if (klines.length < 10) {
      return 'UNKNOWN';
    }

    const recent_close = klines[klines.length - 1].close;
    const prev_close = klines[klines.length - 10].close;
    const momentum = (recent_close - prev_close) / prev_close;

    // 综合判断
    if (nearest_resistance && nearest_support) {
      const to_resistance = (nearest_resistance.price - current_price) / current_price;
      const to_support = (current_price - nearest_support.price) / current_price;

      // 距离哪个更近，结合动量判断
      if (to_resistance < to_support && momentum > 0) {
        return 'UP';
      } else if (to_support < to_resistance && momentum < 0) {
        return 'DOWN';
      }
    }

    // 仅根据动量判断
    if (Math.abs(momentum) > 0.01) {
      return momentum > 0 ? 'UP' : 'DOWN';
    }

    return 'UNKNOWN';
  }

  /**
   * 生成描述文本
   */
  private generate_description(
    scores: FeatureScores,
    total_score: number,
    alert_level: string,
    direction: string
  ): string {
    const parts: string[] = [];

    // 找出高分特征
    const high_features: string[] = [];
    if (scores.volatility_score >= 70) high_features.push('波动收敛');
    if (scores.volume_score >= 70) high_features.push('成交量萎缩');
    if (scores.ma_convergence_score >= 70) high_features.push('均线靠拢');
    if (scores.position_score >= 70) high_features.push('临近关键位');
    if (scores.pattern_score >= 70) high_features.push('K线收敛');

    if (high_features.length > 0) {
      parts.push(`特征: ${high_features.join('+')}`);
    }

    parts.push(`评分: ${Math.round(total_score)}`);

    if (direction !== 'UNKNOWN') {
      parts.push(`方向: ${direction === 'UP' ? '向上' : '向下'}`);
    }

    return parts.join(' | ');
  }

  // ==================== 工具方法 ====================

  /**
   * 计算简单移动平均
   */
  private calc_sma(data: number[], period: number): number {
    if (data.length < period) {
      return data.reduce((a, b) => a + b, 0) / data.length;
    }
    const slice = data.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * 计算标准差
   */
  private calc_std(data: number[], mean: number): number {
    if (data.length === 0) return 0;
    const squareDiffs = data.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / data.length;
    return Math.sqrt(avgSquareDiff);
  }
}
