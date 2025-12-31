/**
 * 形态识别算法
 *
 * 支持的形态:
 * - DOUBLE_BOTTOM: 双底 (W底)
 * - TRIPLE_BOTTOM: 三底
 * - PULLBACK: 上涨回调
 * - HEAD_SHOULDERS: 头肩底
 * - TRIANGLE: 收敛三角
 * - ASCENDING_TRIANGLE: 上升三角
 * - BULLISH_FLAG: 牛旗
 * - CUP_HANDLE: 杯柄形态
 */

import { PatternType, KeyLevels } from '@/database/pattern_scan_repository';

/**
 * K线数据接口
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
 * 波段点
 */
interface SwingPoint {
  index: number;
  price: number;
  time: number;
  type: 'HIGH' | 'LOW';
}

/**
 * 形态检测结果
 */
export interface PatternResult {
  pattern_type: PatternType;
  score: number;              // 0-100
  description: string;
  key_levels: KeyLevels;
  detected_at: number;
}

/**
 * 形态检测配置
 */
export interface PatternDetectorConfig {
  // 波段点识别
  swing_lookback: number;     // 左右各看多少根确认波段点

  // 双底/三底配置
  bottom_tolerance_pct: number;     // 底部价差容忍度 (%)
  min_rebound_pct: number;          // 最小反弹幅度 (%)

  // 回调配置
  min_surge_pct: number;            // 最小涨幅 (%)
  max_retrace_ratio: number;        // 最大回撤比例 (0-1)
  min_retrace_ratio: number;        // 最小回撤比例 (0-1)

  // 三角形配置
  min_triangle_points: number;      // 最少需要的点数
  max_convergence_bars: number;     // 最大收敛K线数
}

const DEFAULT_CONFIG: PatternDetectorConfig = {
  swing_lookback: 5,
  bottom_tolerance_pct: 2.0,
  min_rebound_pct: 3.0,
  min_surge_pct: 10.0,
  max_retrace_ratio: 0.618,
  min_retrace_ratio: 0.236,
  min_triangle_points: 4,
  max_convergence_bars: 50
};

export class PatternDetector {
  private config: PatternDetectorConfig;

  constructor(config?: Partial<PatternDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测所有形态
   */
  detect_all(klines: KlineData[]): PatternResult[] {
    if (klines.length < 30) {
      return [];
    }

    const results: PatternResult[] = [];

    // 识别波段点
    const swing_points = this.find_swing_points(klines);

    // 检测各种形态
    const double_bottom = this.detect_double_bottom(klines, swing_points);
    if (double_bottom) results.push(double_bottom);

    const triple_bottom = this.detect_triple_bottom(klines, swing_points);
    if (triple_bottom) results.push(triple_bottom);

    const pullback = this.detect_pullback(klines, swing_points);
    if (pullback) results.push(pullback);

    const head_shoulders = this.detect_head_shoulders_bottom(klines, swing_points);
    if (head_shoulders) results.push(head_shoulders);

    const triangle = this.detect_triangle(klines, swing_points);
    if (triangle) results.push(triangle);

    const ascending_triangle = this.detect_ascending_triangle(klines, swing_points);
    if (ascending_triangle) results.push(ascending_triangle);

    const bullish_flag = this.detect_bullish_flag(klines, swing_points);
    if (bullish_flag) results.push(bullish_flag);

    const cup_handle = this.detect_cup_handle(klines, swing_points);
    if (cup_handle) results.push(cup_handle);

    return results;
  }

  /**
   * 识别波段高低点
   */
  private find_swing_points(klines: KlineData[]): SwingPoint[] {
    const points: SwingPoint[] = [];
    const lookback = this.config.swing_lookback;

    for (let i = lookback; i < klines.length - lookback; i++) {
      const current = klines[i];

      // 检查是否为波段高点
      let is_high = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i && klines[j].high >= current.high) {
          is_high = false;
          break;
        }
      }
      if (is_high) {
        points.push({
          index: i,
          price: current.high,
          time: current.open_time,
          type: 'HIGH'
        });
      }

      // 检查是否为波段低点
      let is_low = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i && klines[j].low <= current.low) {
          is_low = false;
          break;
        }
      }
      if (is_low) {
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
   * 检测双底形态 (W底)
   */
  private detect_double_bottom(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 2 || highs.length < 1) {
      return null;
    }

    // 找最近的两个低点
    const recent_lows = lows.slice(-3);
    const current_price = klines[klines.length - 1].close;

    for (let i = 0; i < recent_lows.length - 1; i++) {
      const low1 = recent_lows[i];
      const low2 = recent_lows[i + 1];

      // 检查两个低点价差
      const price_diff_pct = Math.abs(low1.price - low2.price) / low1.price * 100;
      if (price_diff_pct > this.config.bottom_tolerance_pct) {
        continue;
      }

      // 找两个低点之间的高点（颈线）
      const middle_highs = highs.filter(h => h.index > low1.index && h.index < low2.index);
      if (middle_highs.length === 0) {
        continue;
      }

      const neckline = Math.max(...middle_highs.map(h => h.price));

      // 检查反弹幅度
      const rebound_pct = (neckline - low1.price) / low1.price * 100;
      if (rebound_pct < this.config.min_rebound_pct) {
        continue;
      }

      // 检查当前价格位置
      const bottom_avg = (low1.price + low2.price) / 2;
      const target = neckline + (neckline - bottom_avg);  // 目标价 = 颈线 + (颈线 - 底部)

      // 评分
      let score = 50;

      // 底部越接近越好
      score += Math.max(0, 20 - price_diff_pct * 10);

      // 反弹越大越好
      score += Math.min(20, rebound_pct * 2);

      // 当前价格接近或突破颈线加分
      if (current_price >= neckline) {
        score += 10;
      } else if (current_price >= neckline * 0.98) {
        score += 5;
      }

      score = Math.min(100, Math.round(score));

      return {
        pattern_type: 'DOUBLE_BOTTOM',
        score,
        description: `双底形态: 底部${bottom_avg.toFixed(4)}, 颈线${neckline.toFixed(4)}, 反弹${rebound_pct.toFixed(1)}%`,
        key_levels: {
          support: bottom_avg,
          neckline,
          target,
          stop_loss: bottom_avg * 0.98
        },
        detected_at: klines[klines.length - 1].open_time
      };
    }

    return null;
  }

  /**
   * 检测三底形态
   */
  private detect_triple_bottom(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 3 || highs.length < 2) {
      return null;
    }

    // 找最近的三个低点
    const recent_lows = lows.slice(-4);

    for (let i = 0; i < recent_lows.length - 2; i++) {
      const low1 = recent_lows[i];
      const low2 = recent_lows[i + 1];
      const low3 = recent_lows[i + 2];

      // 检查三个低点在同一水平
      const avg_low = (low1.price + low2.price + low3.price) / 3;
      const max_diff = Math.max(
        Math.abs(low1.price - avg_low),
        Math.abs(low2.price - avg_low),
        Math.abs(low3.price - avg_low)
      );
      const diff_pct = max_diff / avg_low * 100;

      if (diff_pct > this.config.bottom_tolerance_pct) {
        continue;
      }

      // 找颈线（两次反弹的高点）
      const middle_highs = highs.filter(h =>
        (h.index > low1.index && h.index < low2.index) ||
        (h.index > low2.index && h.index < low3.index)
      );

      if (middle_highs.length < 2) {
        continue;
      }

      const neckline = Math.max(...middle_highs.map(h => h.price));
      const current_price = klines[klines.length - 1].close;

      // 评分
      let score = 55;  // 三底比双底稍强

      // 底部越接近越好
      score += Math.max(0, 20 - diff_pct * 10);

      // 当前价格接近或突破颈线加分
      if (current_price >= neckline) {
        score += 15;
      } else if (current_price >= neckline * 0.98) {
        score += 8;
      }

      score = Math.min(100, Math.round(score));

      const target = neckline + (neckline - avg_low);

      return {
        pattern_type: 'TRIPLE_BOTTOM',
        score,
        description: `三底形态: 底部${avg_low.toFixed(4)}, 颈线${neckline.toFixed(4)}`,
        key_levels: {
          support: avg_low,
          neckline,
          target,
          stop_loss: avg_low * 0.98
        },
        detected_at: klines[klines.length - 1].open_time
      };
    }

    return null;
  }

  /**
   * 检测上涨回调形态
   */
  private detect_pullback(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 1 || highs.length < 1) {
      return null;
    }

    // 找最近的波段低点和高点
    const recent_lows = lows.slice(-3);
    const recent_highs = highs.slice(-3);

    for (const low of recent_lows) {
      for (const high of recent_highs) {
        // 高点必须在低点之后
        if (high.index <= low.index) continue;

        // 计算涨幅
        const surge_pct = (high.price - low.price) / low.price * 100;
        if (surge_pct < this.config.min_surge_pct) continue;

        // 检查当前价格的回撤位置
        const current_price = klines[klines.length - 1].close;

        // 必须低于高点
        if (current_price >= high.price) continue;

        // 必须高于低点
        if (current_price <= low.price) continue;

        // 计算回撤比例
        const retrace_ratio = (high.price - current_price) / (high.price - low.price);

        // 检查回撤是否在有效范围
        if (retrace_ratio < this.config.min_retrace_ratio ||
            retrace_ratio > this.config.max_retrace_ratio) {
          continue;
        }

        // 确定斐波那契位置
        let fib_level = '';
        if (retrace_ratio <= 0.236) {
          fib_level = '0.236';
        } else if (retrace_ratio <= 0.382) {
          fib_level = '0.382';
        } else if (retrace_ratio <= 0.5) {
          fib_level = '0.5';
        } else {
          fib_level = '0.618';
        }

        // 评分
        let score = 50;

        // 涨幅越大越好
        score += Math.min(25, surge_pct * 1.5);

        // 回撤越浅越好
        if (retrace_ratio <= 0.382) {
          score += 15;
        } else if (retrace_ratio <= 0.5) {
          score += 10;
        } else {
          score += 5;
        }

        score = Math.min(100, Math.round(score));

        return {
          pattern_type: 'PULLBACK',
          score,
          description: `回调企稳: 涨${surge_pct.toFixed(1)}%, 回撤${(retrace_ratio * 100).toFixed(1)}% (${fib_level})`,
          key_levels: {
            swing_low: low.price,
            swing_high: high.price,
            support: low.price + (high.price - low.price) * (1 - retrace_ratio),
            target: high.price * 1.1,  // 目标突破前高10%
            stop_loss: low.price
          },
          detected_at: klines[klines.length - 1].open_time
        };
      }
    }

    return null;
  }

  /**
   * 检测头肩底形态
   */
  private detect_head_shoulders_bottom(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 3 || highs.length < 2) {
      return null;
    }

    // 找最近的三个低点
    const recent_lows = lows.slice(-4);

    for (let i = 0; i < recent_lows.length - 2; i++) {
      const left_shoulder = recent_lows[i];
      const head = recent_lows[i + 1];
      const right_shoulder = recent_lows[i + 2];

      // 头部必须低于两肩
      if (head.price >= left_shoulder.price || head.price >= right_shoulder.price) {
        continue;
      }

      // 两肩高度相近
      const shoulder_diff_pct = Math.abs(left_shoulder.price - right_shoulder.price) / left_shoulder.price * 100;
      if (shoulder_diff_pct > this.config.bottom_tolerance_pct * 1.5) {
        continue;
      }

      // 找颈线
      const middle_highs = highs.filter(h =>
        (h.index > left_shoulder.index && h.index < head.index) ||
        (h.index > head.index && h.index < right_shoulder.index)
      );

      if (middle_highs.length < 2) {
        continue;
      }

      const neckline = (middle_highs[0].price + middle_highs[middle_highs.length - 1].price) / 2;
      const current_price = klines[klines.length - 1].close;

      // 评分
      let score = 60;  // 头肩底是较强的形态

      // 两肩越对称越好
      score += Math.max(0, 15 - shoulder_diff_pct * 5);

      // 头部深度适中加分
      const head_depth_pct = (left_shoulder.price - head.price) / left_shoulder.price * 100;
      if (head_depth_pct >= 3 && head_depth_pct <= 15) {
        score += 10;
      }

      // 当前价格接近或突破颈线
      if (current_price >= neckline) {
        score += 15;
      } else if (current_price >= neckline * 0.98) {
        score += 8;
      }

      score = Math.min(100, Math.round(score));

      const shoulder_avg = (left_shoulder.price + right_shoulder.price) / 2;
      const target = neckline + (neckline - head.price);

      return {
        pattern_type: 'HEAD_SHOULDERS',
        score,
        description: `头肩底: 头部${head.price.toFixed(4)}, 肩部${shoulder_avg.toFixed(4)}, 颈线${neckline.toFixed(4)}`,
        key_levels: {
          support: head.price,
          neckline,
          target,
          stop_loss: head.price * 0.98
        },
        detected_at: klines[klines.length - 1].open_time
      };
    }

    return null;
  }

  /**
   * 检测收敛三角形
   */
  private detect_triangle(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const recent_points = swing_points.slice(-10);
    const highs = recent_points.filter(p => p.type === 'HIGH');
    const lows = recent_points.filter(p => p.type === 'LOW');

    if (highs.length < 2 || lows.length < 2) {
      return null;
    }

    // 检查高点是否递降
    let highs_descending = true;
    for (let i = 1; i < highs.length; i++) {
      if (highs[i].price >= highs[i - 1].price) {
        highs_descending = false;
        break;
      }
    }

    // 检查低点是否递升
    let lows_ascending = true;
    for (let i = 1; i < lows.length; i++) {
      if (lows[i].price <= lows[i - 1].price) {
        lows_ascending = false;
        break;
      }
    }

    if (!highs_descending || !lows_ascending) {
      return null;
    }

    // 计算收敛程度
    const first_range = highs[0].price - lows[0].price;
    const last_range = highs[highs.length - 1].price - lows[lows.length - 1].price;
    const convergence_ratio = last_range / first_range;

    if (convergence_ratio >= 0.8) {
      return null;  // 收敛不明显
    }

    const current_price = klines[klines.length - 1].close;
    const upper_line = highs[highs.length - 1].price;
    const lower_line = lows[lows.length - 1].price;

    // 评分
    let score = 50;

    // 收敛越紧越好
    score += Math.min(25, (1 - convergence_ratio) * 50);

    // 点数越多越可靠
    score += Math.min(15, (highs.length + lows.length - 4) * 5);

    score = Math.min(100, Math.round(score));

    return {
      pattern_type: 'TRIANGLE',
      score,
      description: `收敛三角: 上轨${upper_line.toFixed(4)}, 下轨${lower_line.toFixed(4)}, 收敛${((1 - convergence_ratio) * 100).toFixed(1)}%`,
      key_levels: {
        resistance: upper_line,
        support: lower_line,
        target: upper_line * 1.05,  // 向上突破目标
        stop_loss: lower_line * 0.98
      },
      detected_at: klines[klines.length - 1].open_time
    };
  }

  /**
   * 检测上升三角形
   */
  private detect_ascending_triangle(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const recent_points = swing_points.slice(-10);
    const highs = recent_points.filter(p => p.type === 'HIGH');
    const lows = recent_points.filter(p => p.type === 'LOW');

    if (highs.length < 2 || lows.length < 2) {
      return null;
    }

    // 检查高点是否在同一水平（水平阻力）
    const high_prices = highs.map(h => h.price);
    const avg_high = high_prices.reduce((a, b) => a + b, 0) / high_prices.length;
    const max_high_diff = Math.max(...high_prices.map(p => Math.abs(p - avg_high)));
    const high_diff_pct = max_high_diff / avg_high * 100;

    if (high_diff_pct > 1.5) {
      return null;  // 高点不在同一水平
    }

    // 检查低点是否递升
    let lows_ascending = true;
    for (let i = 1; i < lows.length; i++) {
      if (lows[i].price <= lows[i - 1].price) {
        lows_ascending = false;
        break;
      }
    }

    if (!lows_ascending) {
      return null;
    }

    const resistance = avg_high;
    const current_price = klines[klines.length - 1].close;
    const last_low = lows[lows.length - 1].price;

    // 评分
    let score = 55;  // 上升三角是看涨形态

    // 阻力位越平越好
    score += Math.max(0, 15 - high_diff_pct * 10);

    // 低点上升幅度
    const low_rise_pct = (lows[lows.length - 1].price - lows[0].price) / lows[0].price * 100;
    score += Math.min(15, low_rise_pct * 2);

    // 当前价格接近阻力位
    const distance_to_resistance = (resistance - current_price) / resistance * 100;
    if (distance_to_resistance <= 1) {
      score += 15;
    } else if (distance_to_resistance <= 3) {
      score += 8;
    }

    score = Math.min(100, Math.round(score));

    return {
      pattern_type: 'ASCENDING_TRIANGLE',
      score,
      description: `上升三角: 阻力${resistance.toFixed(4)}, 低点上升${low_rise_pct.toFixed(1)}%`,
      key_levels: {
        resistance,
        support: last_low,
        target: resistance * 1.05,
        entry: resistance,
        stop_loss: last_low * 0.98
      },
      detected_at: klines[klines.length - 1].open_time
    };
  }

  /**
   * 检测牛旗形态
   */
  private detect_bullish_flag(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    if (klines.length < 30) {
      return null;
    }

    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 2 || highs.length < 1) {
      return null;
    }

    // 找旗杆：快速上涨阶段
    for (let i = 0; i < lows.length - 1; i++) {
      const pole_start = lows[i];

      // 找旗杆顶部
      const pole_top_candidates = highs.filter(h => h.index > pole_start.index);
      if (pole_top_candidates.length === 0) continue;

      const pole_top = pole_top_candidates[0];

      // 计算旗杆涨幅
      const pole_gain_pct = (pole_top.price - pole_start.price) / pole_start.price * 100;
      if (pole_gain_pct < 10) continue;  // 旗杆涨幅至少10%

      // 旗杆应该是快速上涨（K线数较少）
      const pole_bars = pole_top.index - pole_start.index;
      if (pole_bars > 15) continue;  // 旗杆不应太长

      // 找旗帜部分：旗杆顶部之后的回调
      const flag_klines = klines.slice(pole_top.index);
      if (flag_klines.length < 5) continue;

      // 旗帜应该是向下或横向整理
      const flag_low = Math.min(...flag_klines.map(k => k.low));
      const flag_high = Math.max(...flag_klines.map(k => k.high));
      const flag_retrace = (pole_top.price - flag_low) / (pole_top.price - pole_start.price);

      if (flag_retrace > 0.5) continue;  // 回调不应超过50%

      const current_price = klines[klines.length - 1].close;

      // 评分
      let score = 55;

      // 旗杆越陡越好
      const pole_steepness = pole_gain_pct / pole_bars;
      score += Math.min(20, pole_steepness * 5);

      // 旗帜回调越浅越好
      score += Math.min(15, (1 - flag_retrace) * 30);

      // 当前价格接近旗帜上沿
      if (current_price >= flag_high * 0.98) {
        score += 10;
      }

      score = Math.min(100, Math.round(score));

      const target = pole_top.price + (pole_top.price - pole_start.price);  // 目标：旗杆等高

      return {
        pattern_type: 'BULLISH_FLAG',
        score,
        description: `牛旗形态: 旗杆涨${pole_gain_pct.toFixed(1)}%, 回调${(flag_retrace * 100).toFixed(1)}%`,
        key_levels: {
          swing_low: pole_start.price,
          swing_high: pole_top.price,
          support: flag_low,
          resistance: flag_high,
          target,
          stop_loss: flag_low * 0.98
        },
        detected_at: klines[klines.length - 1].open_time
      };
    }

    return null;
  }

  /**
   * 检测杯柄形态
   */
  private detect_cup_handle(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    if (klines.length < 50) {
      return null;
    }

    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 2 || highs.length < 2) {
      return null;
    }

    // 杯子：找两个相近的高点，中间有一个较深的低点
    for (let i = 0; i < highs.length - 1; i++) {
      const left_rim = highs[i];
      const right_rim = highs[i + 1];

      // 两个杯沿高度相近
      const rim_diff_pct = Math.abs(left_rim.price - right_rim.price) / left_rim.price * 100;
      if (rim_diff_pct > 3) continue;

      // 找杯底
      const cup_lows = lows.filter(l => l.index > left_rim.index && l.index < right_rim.index);
      if (cup_lows.length === 0) continue;

      const cup_bottom = cup_lows.reduce((min, l) => l.price < min.price ? l : min, cup_lows[0]);

      // 杯子深度
      const cup_depth_pct = (left_rim.price - cup_bottom.price) / left_rim.price * 100;
      if (cup_depth_pct < 10 || cup_depth_pct > 50) continue;  // 深度10-50%

      // 找杯柄：右侧杯沿之后的小幅回调
      const handle_klines = klines.slice(right_rim.index);
      if (handle_klines.length < 3) continue;

      const handle_low = Math.min(...handle_klines.map(k => k.low));
      const handle_depth_pct = (right_rim.price - handle_low) / right_rim.price * 100;

      // 杯柄回调应该小于杯子深度的一半
      if (handle_depth_pct > cup_depth_pct / 2) continue;

      const current_price = klines[klines.length - 1].close;
      const rim_price = (left_rim.price + right_rim.price) / 2;

      // 评分
      let score = 60;  // 杯柄是较强的形态

      // 杯沿越对称越好
      score += Math.max(0, 15 - rim_diff_pct * 5);

      // 杯柄回调适中
      if (handle_depth_pct >= 5 && handle_depth_pct <= 15) {
        score += 10;
      }

      // 当前价格接近杯沿
      if (current_price >= rim_price * 0.98) {
        score += 15;
      }

      score = Math.min(100, Math.round(score));

      const target = rim_price + (rim_price - cup_bottom.price);

      return {
        pattern_type: 'CUP_HANDLE',
        score,
        description: `杯柄形态: 杯沿${rim_price.toFixed(4)}, 杯深${cup_depth_pct.toFixed(1)}%, 柄深${handle_depth_pct.toFixed(1)}%`,
        key_levels: {
          resistance: rim_price,
          support: cup_bottom.price,
          target,
          entry: rim_price,
          stop_loss: handle_low * 0.98
        },
        detected_at: klines[klines.length - 1].open_time
      };
    }

    return null;
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<PatternDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
