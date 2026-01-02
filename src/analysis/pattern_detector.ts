/**
 * 形态识别算法
 *
 * 支持的形态:
 * - DOUBLE_BOTTOM: 双底 (W底)
 * - TRIPLE_BOTTOM: 三底
 * - PULLBACK: 上涨回调
 * - CONSOLIDATION: 横盘震荡（窄幅区间长时间横盘）
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
  max_distance_to_neckline_pct: number;  // 距颈线最大距离 (%)

  // 回调配置
  min_surge_pct: number;            // 最小涨幅 (%)
  max_retrace_ratio: number;        // 最大回撤比例 (0-1)
  min_retrace_ratio: number;        // 最小回撤比例 (0-1)

  // 横盘震荡配置
  consolidation_max_range_pct: number;   // 横盘最大振幅 (%)
  consolidation_min_bars: number;        // 横盘最少K线数
}

const DEFAULT_CONFIG: PatternDetectorConfig = {
  swing_lookback: 5,
  bottom_tolerance_pct: 1.5,        // 收紧到1.5%
  min_rebound_pct: 5.0,             // 提高到5%
  max_distance_to_neckline_pct: 8,  // 距颈线不超过8%
  min_surge_pct: 15.0,              // 提高到15%
  max_retrace_ratio: 0.618,
  min_retrace_ratio: 0.236,
  consolidation_max_range_pct: 8,   // 横盘振幅不超过8%
  consolidation_min_bars: 20        // 至少20根K线
};

export class PatternDetector {
  private config: PatternDetectorConfig;

  constructor(config?: Partial<PatternDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测所有形态
   * 检测: 双底、三底、上涨回调、横盘震荡
   */
  detect_all(klines: KlineData[]): PatternResult[] {
    if (klines.length < 30) {
      return [];
    }

    const results: PatternResult[] = [];

    // 识别波段点
    const swing_points = this.find_swing_points(klines);

    // 检测四种形态: 双底、三底、上涨回调、横盘震荡
    const double_bottom = this.detect_double_bottom(klines, swing_points);
    if (double_bottom) results.push(double_bottom);

    const triple_bottom = this.detect_triple_bottom(klines, swing_points);
    if (triple_bottom) results.push(triple_bottom);

    const pullback = this.detect_pullback(klines, swing_points);
    if (pullback) results.push(pullback);

    const consolidation = this.detect_consolidation(klines);
    if (consolidation) results.push(consolidation);

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
   *
   * 寻找潜在交易机会：当前价格在颈线下方，接近但未突破颈线
   * 排除已经突破颈线的形态（错过的机会）
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

      // ⚠️ 关键：只识别未突破颈线的形态（潜在交易机会）
      // 当前价格必须低于颈线，已经突破的不算
      if (current_price >= neckline) {
        continue;
      }

      // 当前价格必须高于底部（在第二个底形成后反弹中）
      if (current_price <= bottom_avg) {
        continue;
      }

      // 计算当前价格距离颈线的比例
      const distance_to_neckline_pct = (neckline - current_price) / neckline * 100;

      // 距颈线太远的不算（还没有明确的入场信号）
      if (distance_to_neckline_pct > this.config.max_distance_to_neckline_pct) {
        continue;
      }

      // 评分
      let score = 60;

      // 底部越接近越好（满分15分）
      score += Math.max(0, 15 - price_diff_pct * 10);

      // 反弹幅度越大越好（满分15分）
      score += Math.min(15, (rebound_pct - 5) * 2);

      // 当前价格越接近颈线越好（满分10分）
      if (distance_to_neckline_pct <= 2) {
        score += 10;  // 距离颈线2%以内
      } else if (distance_to_neckline_pct <= 5) {
        score += 6;   // 距离颈线5%以内
      } else {
        score += 3;   // 距离颈线8%以内
      }

      score = Math.min(100, Math.round(score));

      // 根据价格大小决定显示精度
      const decimals = bottom_avg < 0.01 ? 6 : bottom_avg < 1 ? 4 : 2;

      return {
        pattern_type: 'DOUBLE_BOTTOM',
        score,
        description: `双底形态: 底部${bottom_avg.toFixed(decimals)}, 颈线${neckline.toFixed(decimals)}, 距颈线${distance_to_neckline_pct.toFixed(1)}%`,
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
   *
   * 寻找潜在交易机会：当前价格在颈线下方，接近但未突破颈线
   * 排除已经突破颈线的形态（错过的机会）
   */
  private detect_triple_bottom(klines: KlineData[], swing_points: SwingPoint[]): PatternResult | null {
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 3 || highs.length < 2) {
      return null;
    }

    // 找最近的三个低点
    const recent_lows = lows.slice(-4);
    const current_price = klines[klines.length - 1].close;

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

      // 检查反弹幅度（颈线必须明显高于底部）
      const rebound_pct = (neckline - avg_low) / avg_low * 100;
      if (rebound_pct < this.config.min_rebound_pct) {
        continue;
      }

      const target = neckline + (neckline - avg_low);

      // ⚠️ 关键：只识别未突破颈线的形态（潜在交易机会）
      // 当前价格必须低于颈线，已经突破的不算
      if (current_price >= neckline) {
        continue;
      }

      // 当前价格必须高于底部（在第三个底形成后反弹中）
      if (current_price <= avg_low) {
        continue;
      }

      // 计算当前价格距离颈线的比例
      const distance_to_neckline_pct = (neckline - current_price) / neckline * 100;

      // 距颈线太远的不算（还没有明确的入场信号）
      if (distance_to_neckline_pct > this.config.max_distance_to_neckline_pct) {
        continue;
      }

      // 评分
      let score = 65;  // 三底比双底稍强

      // 底部越接近越好（满分15分）
      score += Math.max(0, 15 - diff_pct * 10);

      // 反弹幅度越大越好（满分10分）
      score += Math.min(10, (rebound_pct - 5) * 1.5);

      // 当前价格越接近颈线越好（满分10分）
      if (distance_to_neckline_pct <= 2) {
        score += 10;  // 距离颈线2%以内
      } else if (distance_to_neckline_pct <= 5) {
        score += 6;   // 距离颈线5%以内
      } else {
        score += 3;   // 距离颈线8%以内
      }

      score = Math.min(100, Math.round(score));

      // 根据价格大小决定显示精度
      const decimals = avg_low < 0.01 ? 6 : avg_low < 1 ? 4 : 2;

      return {
        pattern_type: 'TRIPLE_BOTTOM',
        score,
        description: `三底形态: 底部${avg_low.toFixed(decimals)}, 颈线${neckline.toFixed(decimals)}, 距颈线${distance_to_neckline_pct.toFixed(1)}%`,
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
   * 检测横盘震荡形态
   *
   * 识别窄幅区间长时间横盘的币种，等待突破
   * 条件：振幅小、持续时间长、当前价格在区间内
   */
  private detect_consolidation(klines: KlineData[]): PatternResult | null {
    const min_bars = this.config.consolidation_min_bars;

    if (klines.length < min_bars) {
      return null;
    }

    // 取最近的K线分析
    const recent_klines = klines.slice(-min_bars);
    const current_price = klines[klines.length - 1].close;

    // 计算区间高低点
    let range_high = -Infinity;
    let range_low = Infinity;

    for (const k of recent_klines) {
      if (k.high > range_high) range_high = k.high;
      if (k.low < range_low) range_low = k.low;
    }

    // 计算振幅百分比
    const range_pct = (range_high - range_low) / range_low * 100;

    // 振幅必须在阈值内
    if (range_pct > this.config.consolidation_max_range_pct) {
      return null;
    }

    // 当前价格必须在区间内
    if (current_price > range_high || current_price < range_low) {
      return null;
    }

    // 计算当前价格在区间中的位置 (0=底部, 1=顶部)
    const position_ratio = (current_price - range_low) / (range_high - range_low);

    // 计算区间中线
    const mid_price = (range_high + range_low) / 2;

    // 评分
    let score = 60;

    // 振幅越小越好（满分20分）
    score += Math.max(0, 20 - range_pct * 3);

    // 接近区间边缘更好（即将突破，满分15分）
    if (position_ratio >= 0.8 || position_ratio <= 0.2) {
      score += 15;  // 接近突破位
    } else if (position_ratio >= 0.6 || position_ratio <= 0.4) {
      score += 8;   // 接近边缘
    }

    score = Math.min(100, Math.round(score));

    // 根据价格大小决定显示精度
    const decimals = range_low < 0.01 ? 6 : range_low < 1 ? 4 : 2;

    // 判断当前趋向（接近上轨还是下轨）
    const direction = position_ratio >= 0.5 ? '接近上轨' : '接近下轨';

    return {
      pattern_type: 'CONSOLIDATION',
      score,
      description: `横盘震荡: 区间${range_low.toFixed(decimals)}-${range_high.toFixed(decimals)}, 振幅${range_pct.toFixed(1)}%, ${direction}`,
      key_levels: {
        support: range_low,
        resistance: range_high,
        mid: mid_price,
        target_up: range_high * 1.05,    // 向上突破目标 +5%
        target_down: range_low * 0.95,   // 向下突破目标 -5%
        stop_loss: position_ratio >= 0.5 ? range_low * 0.98 : range_high * 1.02
      },
      detected_at: klines[klines.length - 1].open_time
    };
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<PatternDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
