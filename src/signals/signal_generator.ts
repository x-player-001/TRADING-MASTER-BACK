import { KlineData } from '@/types/common';
import { TradingSignal, SignalType, SignalIndicators } from '@/types/signal';
import { TechnicalIndicators } from '@/analysis/technical_indicators';
import { PatternRecognition } from '@/analysis/pattern_recognition';
import { logger } from '@/utils/logger';

// 类型别名
type Kline = KlineData;

/**
 * 信号生成器
 * 整合技术指标和形态识别，生成交易信号
 */
export class SignalGenerator {
  /**
   * 生成交易信号
   */
  static async generate_signal(symbol: string, interval: string, klines: Kline[]): Promise<TradingSignal | null> {
    try {
      if (klines.length < 60) {
        // 至少需要60根K线用于计算MA60
        return null;
      }

      const latest_kline = klines[klines.length - 1];
      const current_price = parseFloat(latest_kline.close as any);

      // 1. 计算技术指标
      const indicators = this.calculate_indicators(klines);
      if (!indicators) return null;

      // 2. 检测形态
      const patterns = PatternRecognition.detect_all_patterns(klines);

      // 3. 生成信号
      const signal_result = this.analyze_signal(indicators, patterns, current_price);
      if (!signal_result) return null;

      // 4. 构建完整信号对象
      const signal: TradingSignal = {
        symbol,
        interval,
        signal_type: signal_result.type,
        strength: signal_result.strength,
        price: current_price,
        indicators: signal_result.indicators,
        description: signal_result.description,
        timestamp: latest_kline.open_time
      };

      return signal;

    } catch (error) {
      logger.error(`Failed to generate signal for ${symbol}:${interval}`, error);
      return null;
    }
  }

  /**
   * 计算所有技术指标
   */
  private static calculate_indicators(klines: Kline[]) {
    try {
      // 计算多周期MA
      const ma_values = TechnicalIndicators.calculate_multiple_ma(klines, [5, 10, 20, 60]);

      // 计算RSI
      const rsi = TechnicalIndicators.calculate_rsi(klines, 14);

      // 计算MACD
      const macd = TechnicalIndicators.calculate_macd(klines);

      // 检测MA交叉
      const ma_cross = TechnicalIndicators.detect_ma_cross(klines, 5, 10);

      return {
        ma5: ma_values.ma5,
        ma10: ma_values.ma10,
        ma20: ma_values.ma20,
        ma60: ma_values.ma60,
        rsi,
        macd,
        ma_cross
      };
    } catch (error) {
      logger.error('Failed to calculate indicators', error);
      return null;
    }
  }

  /**
   * 分析信号
   * 综合技术指标和形态，判断买入/卖出/中性信号
   */
  private static analyze_signal(
    indicators: any,
    patterns: any[],
    current_price: number
  ): { type: SignalType; strength: number; indicators: SignalIndicators; description: string } | null {

    let signal_type: SignalType = SignalType.NEUTRAL;
    let strength = 0;
    let reasons: string[] = [];
    const signal_indicators: SignalIndicators = {};

    // 1. MA交叉信号 (权重: 30分)
    if (indicators.ma_cross) {
      if (indicators.ma_cross === 'golden') {
        strength += 30;
        signal_type = SignalType.BUY;
        reasons.push('MA金叉');
        signal_indicators.ma_cross = {
          type: 'golden',
          fast_ma: indicators.ma5 || 0,
          slow_ma: indicators.ma10 || 0
        };
      } else if (indicators.ma_cross === 'death') {
        strength += 30;
        signal_type = SignalType.SELL;
        reasons.push('MA死叉');
        signal_indicators.ma_cross = {
          type: 'death',
          fast_ma: indicators.ma5 || 0,
          slow_ma: indicators.ma10 || 0
        };
      }
    }

    // 2. RSI超买超卖 (权重: 25分)
    if (indicators.rsi !== null) {
      const rsi_status = TechnicalIndicators.get_rsi_status(indicators.rsi);
      signal_indicators.rsi = {
        value: indicators.rsi,
        status: rsi_status
      };

      if (rsi_status === 'oversold') {
        // RSI超卖，买入信号
        if (signal_type !== SignalType.SELL) {
          strength += 25;
          signal_type = SignalType.BUY;
          reasons.push(`RSI超卖(${indicators.rsi.toFixed(2)})`);
        }
      } else if (rsi_status === 'overbought') {
        // RSI超买，卖出信号
        if (signal_type !== SignalType.BUY) {
          strength += 25;
          signal_type = SignalType.SELL;
          reasons.push(`RSI超买(${indicators.rsi.toFixed(2)})`);
        }
      }
    }

    // 3. MACD信号 (权重: 20分)
    if (indicators.macd) {
      signal_indicators.macd = indicators.macd;

      // MACD金叉/死叉
      if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) {
        if (signal_type === SignalType.BUY || signal_type === SignalType.NEUTRAL) {
          strength += 20;
          signal_type = SignalType.BUY;
          reasons.push('MACD多头');
        }
      } else if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
        if (signal_type === SignalType.SELL || signal_type === SignalType.NEUTRAL) {
          strength += 20;
          signal_type = SignalType.SELL;
          reasons.push('MACD空头');
        }
      }
    }

    // 4. K线形态 (权重: 25分)
    for (const pattern of patterns) {
      signal_indicators.pattern = pattern.pattern_type;

      // 看涨形态
      if (pattern.pattern_type === 'hammer' || pattern.pattern_type === 'bullish_engulfing') {
        if (signal_type === SignalType.BUY || signal_type === SignalType.NEUTRAL) {
          strength += Math.round(25 * pattern.confidence);
          signal_type = SignalType.BUY;
          reasons.push(pattern.description);
        }
      }

      // 看跌形态
      if (pattern.pattern_type === 'shooting_star' || pattern.pattern_type === 'bearish_engulfing') {
        if (signal_type === SignalType.SELL || signal_type === SignalType.NEUTRAL) {
          strength += Math.round(25 * pattern.confidence);
          signal_type = SignalType.SELL;
          reasons.push(pattern.description);
        }
      }
    }

    // 信号强度限制在0-100
    strength = Math.min(strength, 100);

    // 只生成中等强度以上的信号
    if (strength < 40 || signal_type === SignalType.NEUTRAL) {
      return null;
    }

    return {
      type: signal_type,
      strength,
      indicators: signal_indicators,
      description: reasons.join(' + ')
    };
  }
}
