import { KlineData } from '@/types/common';
import { TradingSignal, SignalType, SignalIndicators } from '@/types/signal';
import { TechnicalIndicators } from '@/analysis/technical_indicators';
import { PatternRecognition } from '@/analysis/pattern_recognition';
import { logger } from '@/utils/logger';

type Kline = KlineData;

/**
 * 高级信号生成器 - 显著提升准确度
 *
 * 核心改进:
 * 1. 趋势确认机制
 * 2. 多指标共振验证
 * 3. 成交量确认
 * 4. 风险收益比计算
 * 5. 多周期验证
 */
export class AdvancedSignalGenerator {

  /**
   * 生成高质量交易信号
   */
  static async generate_signal(symbol: string, interval: string, klines: Kline[]): Promise<TradingSignal | null> {
    try {
      if (klines.length < 200) {
        return null; // 至少需要200根K线以计算MA200
      }

      const latest_kline = klines[klines.length - 1];
      const current_price = parseFloat(latest_kline.close as any);

      // 1. 计算技术指标
      const indicators = this.calculate_advanced_indicators(klines);
      if (!indicators) return null;

      // 2. 判断主趋势
      const trend = this.detect_trend(klines, indicators);

      // 3. 成交量分析
      const volume_signal = this.analyze_volume(klines);

      // 4. 检测形态
      const patterns = PatternRecognition.detect_all_patterns(klines);

      // 5. 支撑阻力位
      const sr_levels = PatternRecognition.detect_support_resistance(klines, 50);

      // 6. 综合分析生成信号
      const signal_result = this.analyze_advanced_signal(
        indicators,
        trend,
        volume_signal,
        patterns,
        sr_levels,
        current_price
      );

      if (!signal_result) return null;

      // 7. 计算止损止盈
      const risk_reward = this.calculate_risk_reward(
        current_price,
        signal_result.type,
        sr_levels,
        indicators
      );

      // 8. 构建完整信号
      const signal: TradingSignal = {
        symbol,
        interval,
        signal_type: signal_result.type,
        strength: signal_result.strength,
        price: current_price,
        indicators: {
          ...signal_result.indicators,
          stop_loss: risk_reward.stop_loss,
          take_profit: risk_reward.take_profit,
          risk_reward_ratio: risk_reward.ratio
        } as any,
        description: signal_result.description,
        timestamp: latest_kline.open_time
      };

      return signal;

    } catch (error) {
      logger.error(`Failed to generate advanced signal for ${symbol}:${interval}`, error);
      return null;
    }
  }

  /**
   * 计算高级技术指标
   */
  private static calculate_advanced_indicators(klines: Kline[]) {
    try {
      const closes = klines.map(k => parseFloat(k.close as any));

      // 多周期MA
      const ma_values = TechnicalIndicators.calculate_multiple_ma(klines, [5, 10, 20, 50, 100, 200]);

      // RSI
      const rsi = TechnicalIndicators.calculate_rsi(klines, 14);

      // MACD (修正版本)
      const macd = this.calculate_correct_macd(closes);

      // 布林带
      const bollinger = TechnicalIndicators.calculate_bollinger(klines, 20, 2);

      // ATR (平均真实波幅) - 用于止损
      const atr = this.calculate_atr(klines, 14);

      // MA交叉检测
      const ma_cross_5_10 = TechnicalIndicators.detect_ma_cross(klines, 5, 10);
      const ma_cross_10_20 = TechnicalIndicators.detect_ma_cross(klines, 10, 20);

      return {
        ma5: ma_values.ma5,
        ma10: ma_values.ma10,
        ma20: ma_values.ma20,
        ma50: ma_values.ma50,
        ma100: ma_values.ma100,
        ma200: ma_values.ma200,
        rsi,
        macd,
        bollinger,
        atr,
        ma_cross_5_10,
        ma_cross_10_20
      };
    } catch (error) {
      logger.error('Failed to calculate advanced indicators', error);
      return null;
    }
  }

  /**
   * 正确的MACD计算
   */
  private static calculate_correct_macd(closes: number[]): any {
    if (closes.length < 35) return null;

    const ema12 = this.calculate_ema_array(closes, 12);
    const ema26 = this.calculate_ema_array(closes, 26);

    const macd_line = ema12.map((val, i) => val - ema26[i]);
    const signal_line = this.calculate_ema_array(macd_line, 9);

    const latest_index = macd_line.length - 1;
    const macd = macd_line[latest_index];
    const signal = signal_line[latest_index];

    // 检测金叉死叉
    const prev_macd = macd_line[latest_index - 1];
    const prev_signal = signal_line[latest_index - 1];

    let cross = null;
    if (prev_macd <= prev_signal && macd > signal) {
      cross = 'bullish'; // 金叉
    } else if (prev_macd >= prev_signal && macd < signal) {
      cross = 'bearish'; // 死叉
    }

    return {
      macd,
      signal,
      histogram: macd - signal,
      cross
    };
  }

  /**
   * EMA数组计算
   */
  private static calculate_ema_array(values: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);

    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(ema);

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
      result.push(ema);
    }

    return result;
  }

  /**
   * 计算ATR (Average True Range)
   */
  private static calculate_atr(klines: Kline[], period: number = 14): number | null {
    if (klines.length < period + 1) return null;

    const true_ranges: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i].high as any);
      const low = parseFloat(klines[i].low as any);
      const prev_close = parseFloat(klines[i - 1].close as any);

      const tr = Math.max(
        high - low,
        Math.abs(high - prev_close),
        Math.abs(low - prev_close)
      );

      true_ranges.push(tr);
    }

    const recent_tr = true_ranges.slice(-period);
    return recent_tr.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * 检测主趋势
   */
  private static detect_trend(klines: Kline[], indicators: any): 'uptrend' | 'downtrend' | 'sideways' {
    const current_price = parseFloat(klines[klines.length - 1].close as any);

    // 方法1: MA排列
    const ma_uptrend = indicators.ma5 > indicators.ma10 &&
                       indicators.ma10 > indicators.ma20 &&
                       indicators.ma20 > indicators.ma50;

    const ma_downtrend = indicators.ma5 < indicators.ma10 &&
                         indicators.ma10 < indicators.ma20 &&
                         indicators.ma20 < indicators.ma50;

    // 方法2: 价格与MA200关系
    const above_ma200 = indicators.ma200 && current_price > indicators.ma200;
    const below_ma200 = indicators.ma200 && current_price < indicators.ma200;

    // 方法3: 最近20根K线的高低点
    const recent_highs = klines.slice(-20).map(k => parseFloat(k.high as any));
    const recent_lows = klines.slice(-20).map(k => parseFloat(k.low as any));
    const is_making_higher_highs = recent_highs[recent_highs.length - 1] > Math.max(...recent_highs.slice(0, 10));
    const is_making_lower_lows = recent_lows[recent_lows.length - 1] < Math.min(...recent_lows.slice(0, 10));

    // 综合判断
    if ((ma_uptrend || above_ma200) && is_making_higher_highs) {
      return 'uptrend';
    } else if ((ma_downtrend || below_ma200) && is_making_lower_lows) {
      return 'downtrend';
    } else {
      return 'sideways';
    }
  }

  /**
   * 成交量分析
   */
  private static analyze_volume(klines: Kline[]): {
    trend: 'increasing' | 'decreasing' | 'normal';
    strength: number;
  } {
    const volumes = klines.slice(-20).map(k => parseFloat(k.volume as any));
    const avg_volume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const latest_volume = volumes[volumes.length - 1];

    const volume_ratio = latest_volume / avg_volume;

    if (volume_ratio > 1.5) {
      return { trend: 'increasing', strength: Math.min(volume_ratio / 2, 1) };
    } else if (volume_ratio < 0.5) {
      return { trend: 'decreasing', strength: 0.3 };
    } else {
      return { trend: 'normal', strength: 0.5 };
    }
  }

  /**
   * 高级信号分析 - 多指标共振
   */
  private static analyze_advanced_signal(
    indicators: any,
    trend: string,
    volume_signal: any,
    patterns: any[],
    sr_levels: any[],
    current_price: number
  ): { type: SignalType; strength: number; indicators: SignalIndicators; description: string } | null {

    let buy_score = 0;
    let sell_score = 0;
    const reasons: string[] = [];
    const signal_indicators: SignalIndicators = {};

    // === 1. 趋势过滤 (最重要) ===
    // 只在上涨趋势中寻找买入信号，下跌趋势中寻找卖出信号
    const trend_filter_enabled = true;

    // === 2. MA交叉信号 (权重: 20分) ===
    if (indicators.ma_cross_5_10 === 'golden' && indicators.ma_cross_10_20 === 'golden') {
      if (!trend_filter_enabled || trend === 'uptrend') {
        buy_score += 20;
        reasons.push('双MA金叉');
        signal_indicators.ma_cross = {
          type: 'golden',
          fast_ma: indicators.ma5,
          slow_ma: indicators.ma10
        };
      }
    } else if (indicators.ma_cross_5_10 === 'death' && indicators.ma_cross_10_20 === 'death') {
      if (!trend_filter_enabled || trend === 'downtrend') {
        sell_score += 20;
        reasons.push('双MA死叉');
        signal_indicators.ma_cross = {
          type: 'death',
          fast_ma: indicators.ma5,
          slow_ma: indicators.ma10
        };
      }
    }

    // === 3. RSI超买超卖 (权重: 15分，需趋势确认) ===
    if (indicators.rsi !== null) {
      signal_indicators.rsi = {
        value: indicators.rsi,
        status: TechnicalIndicators.get_rsi_status(indicators.rsi)
      };

      // RSI超卖 + 上涨趋势 = 强买入信号
      if (indicators.rsi < 30 && trend === 'uptrend') {
        buy_score += 15;
        reasons.push(`RSI超卖(${indicators.rsi.toFixed(1)})+上升趋势`);
      }
      // RSI超买 + 下跌趋势 = 强卖出信号
      else if (indicators.rsi > 70 && trend === 'downtrend') {
        sell_score += 15;
        reasons.push(`RSI超买(${indicators.rsi.toFixed(1)})+下降趋势`);
      }
    }

    // === 4. MACD信号 (权重: 20分) ===
    if (indicators.macd && indicators.macd.cross) {
      signal_indicators.macd = indicators.macd;

      if (indicators.macd.cross === 'bullish' && indicators.macd.histogram > 0) {
        if (!trend_filter_enabled || trend !== 'downtrend') {
          buy_score += 20;
          reasons.push('MACD金叉');
        }
      } else if (indicators.macd.cross === 'bearish' && indicators.macd.histogram < 0) {
        if (!trend_filter_enabled || trend !== 'uptrend') {
          sell_score += 20;
          reasons.push('MACD死叉');
        }
      }
    }

    // === 5. 布林带突破 (权重: 15分) ===
    if (indicators.bollinger) {
      const { upper, middle, lower } = indicators.bollinger;

      // 价格触及下轨 + 上涨趋势
      if (current_price <= lower * 1.01 && trend === 'uptrend') {
        buy_score += 15;
        reasons.push('布林带下轨反弹');
      }
      // 价格触及上轨 + 下跌趋势
      else if (current_price >= upper * 0.99 && trend === 'downtrend') {
        sell_score += 15;
        reasons.push('布林带上轨回落');
      }
    }

    // === 6. K线形态 (权重: 15分) ===
    for (const pattern of patterns) {
      signal_indicators.pattern = pattern.pattern_type;

      // 看涨形态 + 上涨趋势
      if ((pattern.pattern_type === 'hammer' || pattern.pattern_type === 'bullish_engulfing') &&
          trend === 'uptrend') {
        buy_score += Math.round(15 * pattern.confidence);
        reasons.push(pattern.description);
      }
      // 看跌形态 + 下跌趋势
      else if ((pattern.pattern_type === 'shooting_star' || pattern.pattern_type === 'bearish_engulfing') &&
               trend === 'downtrend') {
        sell_score += Math.round(15 * pattern.confidence);
        reasons.push(pattern.description);
      }
    }

    // === 7. 成交量确认 (权重: 15分) ===
    if (volume_signal.trend === 'increasing' && volume_signal.strength > 0.7) {
      if (buy_score > sell_score) {
        buy_score += 15;
        reasons.push('放量确认');
      } else if (sell_score > buy_score) {
        sell_score += 15;
        reasons.push('放量确认');
      }
    }

    // === 8. 支撑阻力位确认 (加成) ===
    const near_support = sr_levels.find(l =>
      l.type === 'support' && Math.abs(current_price - l.price) / current_price < 0.02
    );
    const near_resistance = sr_levels.find(l =>
      l.type === 'resistance' && Math.abs(current_price - l.price) / current_price < 0.02
    );

    if (near_support && buy_score > 0) {
      buy_score += 10;
      reasons.push(`接近支撑位${near_support.price.toFixed(2)}`);
    }
    if (near_resistance && sell_score > 0) {
      sell_score += 10;
      reasons.push(`接近阻力位${near_resistance.price.toFixed(2)}`);
    }

    // === 决策逻辑 ===
    const total_score = Math.max(buy_score, sell_score);

    // 必须达到60分以上才生成信号 (提高阈值)
    if (total_score < 60) {
      return null;
    }

    // 买卖分数差距必须明显 (避免混乱信号)
    if (Math.abs(buy_score - sell_score) < 20) {
      return null;
    }

    const signal_type = buy_score > sell_score ? SignalType.BUY : SignalType.SELL;
    const strength = Math.min(total_score, 100);

    return {
      type: signal_type,
      strength,
      indicators: signal_indicators,
      description: reasons.join(' + ')
    };
  }

  /**
   * 计算止损止盈
   */
  private static calculate_risk_reward(
    current_price: number,
    signal_type: SignalType,
    sr_levels: any[],
    indicators: any
  ): { stop_loss: number; take_profit: number; ratio: number } {

    const atr = indicators.atr || current_price * 0.02; // ATR或2%

    let stop_loss: number;
    let take_profit: number;

    if (signal_type === SignalType.BUY) {
      // 买入止损: 找最近的支撑位或ATR*2
      const nearest_support = sr_levels
        .filter(l => l.type === 'support' && l.price < current_price)
        .sort((a, b) => b.price - a.price)[0];

      stop_loss = nearest_support ? nearest_support.price : current_price - atr * 2;

      // 买入止盈: 找最近的阻力位或风险的2倍
      const nearest_resistance = sr_levels
        .filter(l => l.type === 'resistance' && l.price > current_price)
        .sort((a, b) => a.price - b.price)[0];

      const risk = current_price - stop_loss;
      take_profit = nearest_resistance ? nearest_resistance.price : current_price + risk * 2;

    } else {
      // 卖出止损: 找最近的阻力位
      const nearest_resistance = sr_levels
        .filter(l => l.type === 'resistance' && l.price > current_price)
        .sort((a, b) => a.price - b.price)[0];

      stop_loss = nearest_resistance ? nearest_resistance.price : current_price + atr * 2;

      // 卖出止盈: 找最近的支撑位
      const nearest_support = sr_levels
        .filter(l => l.type === 'support' && l.price < current_price)
        .sort((a, b) => b.price - a.price)[0];

      const risk = stop_loss - current_price;
      take_profit = nearest_support ? nearest_support.price : current_price - risk * 2;
    }

    const risk = Math.abs(current_price - stop_loss);
    const reward = Math.abs(take_profit - current_price);
    const ratio = reward / risk;

    return {
      stop_loss: Number(stop_loss.toFixed(2)),
      take_profit: Number(take_profit.toFixed(2)),
      ratio: Number(ratio.toFixed(2))
    };
  }
}
