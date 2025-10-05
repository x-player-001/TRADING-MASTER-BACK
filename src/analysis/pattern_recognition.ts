import { KlineData } from '@/types/common';
import { PatternDetection, SupportResistance } from '@/types/signal';

// 类型别名，方便使用
type Kline = KlineData;

/**
 * K线形态识别器
 */
export class PatternRecognition {
  /**
   * 识别锤子线 (Hammer)
   * 特征：下影线长，实体小，上影线短或无
   */
  static detect_hammer(kline: Kline): boolean {
    const open = parseFloat(kline.open as any);
    const high = parseFloat(kline.high as any);
    const low = parseFloat(kline.low as any);
    const close = parseFloat(kline.close as any);

    const body = Math.abs(close - open);
    const upper_shadow = high - Math.max(open, close);
    const lower_shadow = Math.min(open, close) - low;
    const total_range = high - low;

    if (total_range === 0) return false;

    // 锤子线特征：
    // 1. 下影线长度至少是实体的2倍
    // 2. 上影线很短或没有
    // 3. 实体在K线上半部分
    return (
      lower_shadow >= body * 2 &&
      upper_shadow <= body * 0.3 &&
      body / total_range <= 0.3 &&
      lower_shadow / total_range >= 0.6
    );
  }

  /**
   * 识别吞没形态 (Engulfing)
   * 看涨吞没：前阴后阳，后K线完全吞没前K线
   * 看跌吞没：前阳后阴，后K线完全吞没前K线
   */
  static detect_engulfing(prev_kline: Kline, current_kline: Kline): 'bullish' | 'bearish' | null {
    const prev_open = parseFloat(prev_kline.open as any);
    const prev_close = parseFloat(prev_kline.close as any);
    const curr_open = parseFloat(current_kline.open as any);
    const curr_close = parseFloat(current_kline.close as any);

    const prev_body = Math.abs(prev_close - prev_open);
    const curr_body = Math.abs(curr_close - curr_open);

    // 看涨吞没：前阴后阳，后K线实体完全吞没前K线
    if (prev_close < prev_open && curr_close > curr_open) {
      if (curr_open <= prev_close && curr_close >= prev_open && curr_body > prev_body * 1.2) {
        return 'bullish';
      }
    }

    // 看跌吞没：前阳后阴，后K线实体完全吞没前K线
    if (prev_close > prev_open && curr_close < curr_open) {
      if (curr_open >= prev_close && curr_close <= prev_open && curr_body > prev_body * 1.2) {
        return 'bearish';
      }
    }

    return null;
  }

  /**
   * 识别十字星 (Doji)
   * 特征：开盘价和收盘价非常接近
   */
  static detect_doji(kline: Kline): boolean {
    const open = parseFloat(kline.open as any);
    const high = parseFloat(kline.high as any);
    const low = parseFloat(kline.low as any);
    const close = parseFloat(kline.close as any);

    const body = Math.abs(close - open);
    const total_range = high - low;

    if (total_range === 0) return false;

    // 十字星：实体很小，接近开盘价
    return body / total_range <= 0.1;
  }

  /**
   * 识别射击之星 (Shooting Star)
   * 特征：上影线长，实体小，下影线短或无
   */
  static detect_shooting_star(kline: Kline): boolean {
    const open = parseFloat(kline.open as any);
    const high = parseFloat(kline.high as any);
    const low = parseFloat(kline.low as any);
    const close = parseFloat(kline.close as any);

    const body = Math.abs(close - open);
    const upper_shadow = high - Math.max(open, close);
    const lower_shadow = Math.min(open, close) - low;
    const total_range = high - low;

    if (total_range === 0) return false;

    // 射击之星特征（与锤子线相反）
    return (
      upper_shadow >= body * 2 &&
      lower_shadow <= body * 0.3 &&
      body / total_range <= 0.3 &&
      upper_shadow / total_range >= 0.6
    );
  }

  /**
   * 识别支撑阻力位
   */
  static detect_support_resistance(klines: Kline[], lookback: number = 50): SupportResistance[] {
    if (klines.length < lookback) return [];

    const recent_klines = klines.slice(-lookback);
    const levels: Map<number, { count: number; type: 'support' | 'resistance' }> = new Map();

    // 收集高点和低点
    for (let i = 1; i < recent_klines.length - 1; i++) {
      const prev_high = parseFloat(recent_klines[i - 1].high as any);
      const curr_high = parseFloat(recent_klines[i].high as any);
      const next_high = parseFloat(recent_klines[i + 1].high as any);

      const prev_low = parseFloat(recent_klines[i - 1].low as any);
      const curr_low = parseFloat(recent_klines[i].low as any);
      const next_low = parseFloat(recent_klines[i + 1].low as any);

      // 局部高点（阻力位）
      if (curr_high > prev_high && curr_high > next_high) {
        const price = Math.round(curr_high);
        const existing = levels.get(price);
        if (existing && existing.type === 'resistance') {
          levels.set(price, { count: existing.count + 1, type: 'resistance' });
        } else {
          levels.set(price, { count: 1, type: 'resistance' });
        }
      }

      // 局部低点（支撑位）
      if (curr_low < prev_low && curr_low < next_low) {
        const price = Math.round(curr_low);
        const existing = levels.get(price);
        if (existing && existing.type === 'support') {
          levels.set(price, { count: existing.count + 1, type: 'support' });
        } else {
          levels.set(price, { count: 1, type: 'support' });
        }
      }
    }

    // 转换为数组并计算强度
    const results: SupportResistance[] = [];
    levels.forEach((value, price) => {
      if (value.count >= 2) {  // 至少被触碰2次
        results.push({
          type: value.type,
          price: price,
          strength: Math.min(value.count / 5, 1),  // 归一化到0-1
          touch_count: value.count
        });
      }
    });

    return results.sort((a, b) => b.strength - a.strength).slice(0, 5);  // 返回前5个最强的位置
  }

  /**
   * 综合形态检测
   */
  static detect_all_patterns(klines: Kline[]): PatternDetection[] {
    if (klines.length < 2) return [];

    const patterns: PatternDetection[] = [];
    const latest = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    const symbol = latest.symbol;
    const interval = latest.interval;
    const timestamp = latest.open_time;

    // 检测锤子线
    if (this.detect_hammer(latest)) {
      patterns.push({
        symbol,
        interval,
        pattern_type: 'hammer',
        confidence: 0.7,
        description: '锤子线形态，可能反转信号',
        detected_at: timestamp
      });
    }

    // 检测射击之星
    if (this.detect_shooting_star(latest)) {
      patterns.push({
        symbol,
        interval,
        pattern_type: 'shooting_star',
        confidence: 0.7,
        description: '射击之星形态，可能见顶信号',
        detected_at: timestamp
      });
    }

    // 检测吞没形态
    const engulfing = this.detect_engulfing(prev, latest);
    if (engulfing) {
      patterns.push({
        symbol,
        interval,
        pattern_type: `${engulfing}_engulfing`,
        confidence: 0.8,
        description: `${engulfing === 'bullish' ? '看涨' : '看跌'}吞没形态`,
        detected_at: timestamp
      });
    }

    // 检测十字星
    if (this.detect_doji(latest)) {
      patterns.push({
        symbol,
        interval,
        pattern_type: 'doji',
        confidence: 0.6,
        description: '十字星形态，市场犹豫',
        detected_at: timestamp
      });
    }

    return patterns;
  }
}
