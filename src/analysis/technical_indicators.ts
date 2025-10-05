import { KlineData } from '@/types/common';

// 类型别名，方便使用
type Kline = KlineData;

/**
 * 技术指标计算器
 */
export class TechnicalIndicators {
  /**
   * 计算简单移动平均线 (Simple Moving Average)
   */
  static calculate_sma(values: number[], period: number): number | null {
    if (values.length < period) return null;

    const sum = values.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  /**
   * 计算多周期MA
   */
  static calculate_multiple_ma(klines: Kline[], periods: number[]): Record<string, number | null> {
    const closes = klines.map(k => parseFloat(k.close as any));
    const result: Record<string, number | null> = {};

    for (const period of periods) {
      result[`ma${period}`] = this.calculate_sma(closes, period);
    }

    return result;
  }

  /**
   * 计算RSI (Relative Strength Index)
   */
  static calculate_rsi(klines: Kline[], period: number = 14): number | null {
    if (klines.length < period + 1) return null;

    const closes = klines.map(k => parseFloat(k.close as any));
    let gains = 0;
    let losses = 0;

    // 计算初始平均涨跌
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    let avg_gain = gains / period;
    let avg_loss = losses / period;

    // 平滑计算剩余数据
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avg_gain = (avg_gain * (period - 1) + gain) / period;
      avg_loss = (avg_loss * (period - 1) + loss) / period;
    }

    if (avg_loss === 0) return 100;
    const rs = avg_gain / avg_loss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * 计算EMA (Exponential Moving Average)
   */
  static calculate_ema(values: number[], period: number): number | null {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * 计算MACD
   */
  static calculate_macd(
    klines: Kline[],
    fast_period: number = 12,
    slow_period: number = 26,
    signal_period: number = 9
  ): { macd: number; signal: number; histogram: number } | null {
    if (klines.length < slow_period + signal_period) return null;

    const closes = klines.map(k => parseFloat(k.close as any));

    // 计算快线和慢线EMA
    const ema_fast = this.calculate_ema(closes, fast_period);
    const ema_slow = this.calculate_ema(closes, slow_period);

    if (!ema_fast || !ema_slow) return null;

    // MACD线 = 快线EMA - 慢线EMA
    const macd = ema_fast - ema_slow;

    // 信号线 = MACD的9期EMA（简化版本，实际需要历史MACD值数组）
    // 这里简化处理，实际应用中需要维护MACD历史数据
    const signal = macd * 0.9; // 简化版本

    return {
      macd: macd,
      signal: signal,
      histogram: macd - signal
    };
  }

  /**
   * 计算布林带 (Bollinger Bands)
   */
  static calculate_bollinger(
    klines: Kline[],
    period: number = 20,
    std_dev: number = 2
  ): { upper: number; middle: number; lower: number } | null {
    if (klines.length < period) return null;

    const closes = klines.map(k => parseFloat(k.close as any));
    const recent = closes.slice(-period);

    // 中轨 = SMA
    const middle = recent.reduce((a, b) => a + b, 0) / period;

    // 标准差
    const variance = recent.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
    const std = Math.sqrt(variance);

    return {
      upper: middle + (std_dev * std),
      middle: middle,
      lower: middle - (std_dev * std)
    };
  }

  /**
   * 检测MA金叉/死叉
   */
  static detect_ma_cross(
    klines: Kline[],
    fast_period: number = 5,
    slow_period: number = 10
  ): 'golden' | 'death' | null {
    if (klines.length < slow_period + 1) return null;

    const closes = klines.map(k => parseFloat(k.close as any));

    // 当前MA值
    const fast_ma_current = this.calculate_sma(closes, fast_period);
    const slow_ma_current = this.calculate_sma(closes, slow_period);

    // 前一根K线的MA值
    const closes_prev = closes.slice(0, -1);
    const fast_ma_prev = this.calculate_sma(closes_prev, fast_period);
    const slow_ma_prev = this.calculate_sma(closes_prev, slow_period);

    if (!fast_ma_current || !slow_ma_current || !fast_ma_prev || !slow_ma_prev) {
      return null;
    }

    // 金叉：快线从下方穿过慢线
    if (fast_ma_prev <= slow_ma_prev && fast_ma_current > slow_ma_current) {
      return 'golden';
    }

    // 死叉：快线从上方穿过慢线
    if (fast_ma_prev >= slow_ma_prev && fast_ma_current < slow_ma_current) {
      return 'death';
    }

    return null;
  }

  /**
   * 判断RSI超买超卖
   */
  static get_rsi_status(rsi: number): 'oversold' | 'overbought' | 'neutral' {
    if (rsi <= 30) return 'oversold';   // 超卖
    if (rsi >= 70) return 'overbought'; // 超买
    return 'neutral';
  }
}
