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
  min_bars_from_high: number;       // 距离高点最少K线数

  // 横盘震荡配置
  consolidation_max_range_pct: number;   // 横盘最大振幅 (%)
  consolidation_min_bars: number;        // 横盘最少K线数
}

const DEFAULT_CONFIG: PatternDetectorConfig = {
  swing_lookback: 5,
  bottom_tolerance_pct: 1.5,        // 收紧到1.5%
  min_rebound_pct: 5.0,             // 提高到5%
  max_distance_to_neckline_pct: 8,  // 距颈线不超过8%
  min_surge_pct: 20.0,              // 最小涨幅20%
  max_retrace_ratio: 0.618,
  min_retrace_ratio: 0.236,
  min_bars_from_high: 20,           // 距离高点最少20根K线
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

    const current_index = klines.length - 1;

    for (const low of recent_lows) {
      for (const high of recent_highs) {
        // 高点必须在低点之后
        if (high.index <= low.index) continue;

        // 计算涨幅
        const surge_pct = (high.price - low.price) / low.price * 100;
        if (surge_pct < this.config.min_surge_pct) continue;

        // 检查当前K线距离高点的距离
        const bars_from_high = current_index - high.index;
        if (bars_from_high < this.config.min_bars_from_high) continue;

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

  /**
   * 自定义参数检测上涨回调形态
   *
   * @param klines K线数据
   * @param min_surge_pct 最小上涨幅度 (%)
   * @param max_retrace_pct 最大回调幅度 (%)，回调小于此值即识别
   * @returns 检测结果，未检测到返回 null
   */
  detect_pullback_custom(
    klines: KlineData[],
    min_surge_pct: number,
    max_retrace_pct: number
  ): PatternResult | null {
    if (klines.length < 30) {
      return null;
    }

    // 识别波段点
    const swing_points = this.find_swing_points(klines);
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 1 || highs.length < 1) {
      return null;
    }

    // 找最近的波段低点和高点
    const recent_lows = lows.slice(-5);
    const recent_highs = highs.slice(-5);

    const current_index = klines.length - 1;
    const current_price = klines[klines.length - 1].close;

    // 将 max_retrace_pct 转换为比例
    const max_retrace_ratio = max_retrace_pct / 100;

    for (const low of recent_lows) {
      for (const high of recent_highs) {
        // 高点必须在低点之后
        if (high.index <= low.index) continue;

        // 计算涨幅
        const surge_pct = (high.price - low.price) / low.price * 100;
        if (surge_pct < min_surge_pct) continue;

        // 检查当前K线距离高点的距离（至少5根K线）
        const bars_from_high = current_index - high.index;
        if (bars_from_high < 5) continue;

        // 必须低于高点
        if (current_price >= high.price) continue;

        // 必须高于低点
        if (current_price <= low.price) continue;

        // 计算回撤比例
        const retrace_ratio = (high.price - current_price) / (high.price - low.price);
        const retrace_pct = retrace_ratio * 100;

        // 回调必须小于指定的最大幅度
        if (retrace_pct > max_retrace_pct) {
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
        } else if (retrace_ratio <= 0.618) {
          fib_level = '0.618';
        } else {
          fib_level = '>0.618';
        }

        // 评分
        let score = 50;

        // 涨幅越大越好（满分25分）
        score += Math.min(25, surge_pct / min_surge_pct * 15);

        // 回撤越浅越好（满分25分）
        const retrace_score = (1 - retrace_ratio / max_retrace_ratio) * 25;
        score += Math.max(0, retrace_score);

        score = Math.min(100, Math.round(score));

        return {
          pattern_type: 'PULLBACK',
          score,
          description: `回调企稳: 涨${surge_pct.toFixed(1)}%, 回撤${retrace_pct.toFixed(1)}% (${fib_level})`,
          key_levels: {
            swing_low: low.price,
            swing_high: high.price,
            support: current_price,
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
   * 自定义参数检测横盘震荡形态
   *
   * @param klines K线数据
   * @param min_bars 最小横盘K线数量
   * @param max_range_pct 最大震荡幅度 (%)
   * @param require_fake_breakdown 是否要求有向下假突破
   * @returns 检测结果，未检测到返回 null
   */
  detect_consolidation_custom(
    klines: KlineData[],
    min_bars: number,
    max_range_pct: number,
    require_fake_breakdown: boolean = false
  ): PatternResult | null {
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
    if (range_pct > max_range_pct) {
      return null;
    }

    // 当前价格必须在区间内
    if (current_price > range_high || current_price < range_low) {
      return null;
    }

    // 检测向下假突破
    let has_fake_breakdown = false;
    let fake_breakdown_info = '';

    if (require_fake_breakdown) {
      // 计算区间下轨（排除最低点后的次低点作为参考）
      const sorted_lows = recent_klines.map(k => k.low).sort((a, b) => a - b);
      const support_level = sorted_lows.length >= 3 ? sorted_lows[2] : sorted_lows[1] || range_low;

      // 检查是否有K线最低价跌破支撑位，但收盘价回到支撑位上方
      for (let i = Math.floor(min_bars * 0.3); i < recent_klines.length; i++) {
        const k = recent_klines[i];
        // 最低价跌破支撑位
        if (k.low < support_level * 0.99) {
          // 收盘价回到支撑位上方
          if (k.close > support_level) {
            has_fake_breakdown = true;
            const breakdown_pct = ((support_level - k.low) / support_level * 100).toFixed(2);
            fake_breakdown_info = `, 假突破${breakdown_pct}%`;
            break;
          }
        }
      }

      if (!has_fake_breakdown) {
        return null;
      }
    }

    // 计算当前价格在区间中的位置 (0=底部, 1=顶部)
    const position_ratio = (current_price - range_low) / (range_high - range_low);

    // 计算区间中线
    const mid_price = (range_high + range_low) / 2;

    // 评分
    let score = 55;

    // 振幅越小越好（满分20分）
    score += Math.max(0, 20 - range_pct * 2);

    // 横盘时间越长越好（满分10分）
    score += Math.min(10, (min_bars - 20) * 0.5);

    // 接近区间边缘更好（满分10分）
    if (position_ratio >= 0.8 || position_ratio <= 0.2) {
      score += 10;
    } else if (position_ratio >= 0.6 || position_ratio <= 0.4) {
      score += 5;
    }

    // 有假突破加分（满分10分）
    if (has_fake_breakdown) {
      score += 10;
    }

    score = Math.min(100, Math.round(score));

    // 根据价格大小决定显示精度
    const decimals = range_low < 0.01 ? 6 : range_low < 1 ? 4 : 2;

    // 判断当前趋向
    const direction = position_ratio >= 0.5 ? '接近上轨' : '接近下轨';

    return {
      pattern_type: 'CONSOLIDATION',
      score,
      description: `横盘震荡: 区间${range_low.toFixed(decimals)}-${range_high.toFixed(decimals)}, 振幅${range_pct.toFixed(1)}%, ${min_bars}根K线, ${direction}${fake_breakdown_info}`,
      key_levels: {
        support: range_low,
        resistance: range_high,
        mid: mid_price,
        target_up: range_high * 1.05,
        target_down: range_low * 0.95,
        stop_loss: position_ratio >= 0.5 ? range_low * 0.98 : range_high * 1.02,
        has_fake_breakdown
      },
      detected_at: klines[klines.length - 1].open_time
    };
  }

  /**
   * 自定义参数检测上涨后W底形态
   *
   * 形态特征:
   * 1. 先有一段明显上涨（涨幅 >= min_surge_pct）
   * 2. 上涨后回调形成W底（双底）
   * 3. 当前价格接近W底的底部（距离底部 <= max_distance_to_bottom_pct）
   *
   * @param klines K线数据
   * @param min_surge_pct 上涨前的最小涨幅 (%)
   * @param max_retrace_pct 从高点回调的最大幅度 (%)
   * @param max_distance_to_bottom_pct 当前价格距W底底部的最大距离 (%)
   * @returns 检测结果，未检测到返回 null
   */
  detect_surge_w_bottom_custom(
    klines: KlineData[],
    min_surge_pct: number,
    max_retrace_pct: number,
    max_distance_to_bottom_pct: number
  ): PatternResult | null {
    if (klines.length < 50) {
      return null;
    }

    // 识别波段点
    const swing_points = this.find_swing_points(klines);
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 2 || highs.length < 2) {
      return null;
    }

    const current_price = klines[klines.length - 1].close;

    // 遍历寻找：先上涨 → 再形成W底
    // 需要找到：起涨点(low0) → 高点(high1) → 第一个底(low1) → 反弹高点(high2) → 第二个底(low2)
    for (let i = 0; i < lows.length - 2; i++) {
      const low0 = lows[i];  // 起涨点

      // 找起涨点之后的高点
      const high1_candidates = highs.filter(h => h.index > low0.index);
      if (high1_candidates.length < 1) continue;

      for (const high1 of high1_candidates) {
        // 计算上涨幅度
        const surge_pct = (high1.price - low0.price) / low0.price * 100;
        if (surge_pct < min_surge_pct) continue;

        // 找高点之后的两个低点（W底的两个底）
        const w_lows = lows.filter(l => l.index > high1.index);
        if (w_lows.length < 2) continue;

        for (let j = 0; j < w_lows.length - 1; j++) {
          const low1 = w_lows[j];      // W底第一个底
          const low2 = w_lows[j + 1];  // W底第二个底

          // 检查两个低点价差（W底的两个底应该在相近水平）
          const bottom_diff_pct = Math.abs(low1.price - low2.price) / Math.min(low1.price, low2.price) * 100;
          if (bottom_diff_pct > 3) continue;  // 两个底价差不超过3%

          // 找两个低点之间的反弹高点（W底的中间高点/颈线）
          const middle_highs = highs.filter(h => h.index > low1.index && h.index < low2.index);
          if (middle_highs.length === 0) continue;

          const neckline = Math.max(...middle_highs.map(h => h.price));
          const bottom_avg = (low1.price + low2.price) / 2;

          // W底底部必须高于起涨点（不能跌破起涨点）
          if (bottom_avg <= low0.price) continue;

          // 检查回调幅度（回调了这波涨幅的多少）
          const surge_amount = high1.price - low0.price;
          const retrace_amount = high1.price - bottom_avg;
          const retrace_pct = (retrace_amount / surge_amount) * 100;
          if (retrace_pct > max_retrace_pct) continue;

          // 检查W底的反弹幅度（颈线相对底部至少要有一定反弹）
          const w_rebound_pct = (neckline - bottom_avg) / bottom_avg * 100;
          if (w_rebound_pct < 2) continue;  // 至少2%反弹

          // 检查当前价格位置
          // 1. 必须低于颈线（未突破）
          if (current_price >= neckline) continue;

          // 2. 必须高于底部
          if (current_price < bottom_avg) continue;

          // 3. 当前价格必须高于起涨点（不能跌破起涨点）
          if (current_price <= low0.price) continue;

          // 4. 距离底部不能太远
          const distance_to_bottom_pct = (current_price - bottom_avg) / bottom_avg * 100;
          if (distance_to_bottom_pct > max_distance_to_bottom_pct) continue;

          // 5. 第二个底必须是最近的（确保W底刚形成）
          if (low2.index < klines.length - 30) continue;

          // 计算距颈线的距离
          const distance_to_neckline_pct = (neckline - current_price) / neckline * 100;

          // 评分
          let score = 55;

          // 上涨幅度越大越好（满分15分）
          score += Math.min(15, (surge_pct - min_surge_pct) / min_surge_pct * 10);

          // 两个底越接近越好（满分15分）
          score += Math.max(0, 15 - bottom_diff_pct * 5);

          // W底反弹幅度越大越好（满分10分）
          score += Math.min(10, w_rebound_pct * 1.5);

          // 当前价格越接近底部越好（满分10分）
          if (distance_to_bottom_pct <= 2) {
            score += 10;
          } else if (distance_to_bottom_pct <= 5) {
            score += 7;
          } else {
            score += 3;
          }

          score = Math.min(100, Math.round(score));

          // 根据价格大小决定显示精度
          const decimals = bottom_avg < 0.01 ? 6 : bottom_avg < 1 ? 4 : 2;

          const target = neckline + (neckline - bottom_avg);  // 目标价 = 颈线 + (颈线 - 底部)

          return {
            pattern_type: 'SURGE_W_BOTTOM',
            score,
            description: `上涨后W底: 涨${surge_pct.toFixed(1)}%, 底部${bottom_avg.toFixed(decimals)}, 颈线${neckline.toFixed(decimals)}, 距底${distance_to_bottom_pct.toFixed(1)}%`,
            key_levels: {
              surge_start: low0.price,
              surge_high: high1.price,
              surge_pct,
              support: bottom_avg,
              neckline,
              target,
              stop_loss: bottom_avg * 0.98,
              low1_price: low1.price,
              low2_price: low2.price,
              distance_to_bottom_pct,
              distance_to_neckline_pct
            },
            detected_at: klines[klines.length - 1].open_time
          };
        }
      }
    }

    return null;
  }

  /**
   * 自定义参数检测双底形态
   *
   * @param klines K线数据
   * @param min_bars_between 两个底之间最小K线数量
   * @param bottom_tolerance_pct 底部价差容忍度 (%)
   * @returns 检测结果，未检测到返回 null
   */
  detect_double_bottom_custom(
    klines: KlineData[],
    min_bars_between: number,
    bottom_tolerance_pct: number = 2.0
  ): PatternResult | null {
    if (klines.length < 30) {
      return null;
    }

    // 识别波段点
    const swing_points = this.find_swing_points(klines);
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 2 || highs.length < 1) {
      return null;
    }

    // 找最近的低点
    const recent_lows = lows.slice(-4);
    const current_price = klines[klines.length - 1].close;

    for (let i = 0; i < recent_lows.length - 1; i++) {
      const low1 = recent_lows[i];
      const low2 = recent_lows[i + 1];

      // 检查两个低点之间的K线数量
      const bars_between = low2.index - low1.index;
      if (bars_between < min_bars_between) {
        continue;
      }

      // 检查两个低点价差
      const price_diff_pct = Math.abs(low1.price - low2.price) / low1.price * 100;
      if (price_diff_pct > bottom_tolerance_pct) {
        continue;
      }

      // 找两个低点之间的高点（颈线）
      const middle_highs = highs.filter(h => h.index > low1.index && h.index < low2.index);
      if (middle_highs.length === 0) {
        continue;
      }

      const neckline = Math.max(...middle_highs.map(h => h.price));

      // 检查反弹幅度（至少3%）
      const rebound_pct = (neckline - low1.price) / low1.price * 100;
      if (rebound_pct < 3) {
        continue;
      }

      // 检查当前价格位置
      const bottom_avg = (low1.price + low2.price) / 2;
      const target = neckline + (neckline - bottom_avg);

      // 当前价格必须低于颈线（未突破）
      if (current_price >= neckline) {
        continue;
      }

      // 当前价格必须高于底部
      if (current_price <= bottom_avg) {
        continue;
      }

      // 计算当前价格距离颈线的比例
      const distance_to_neckline_pct = (neckline - current_price) / neckline * 100;

      // 距颈线太远的不算（超过15%）
      if (distance_to_neckline_pct > 15) {
        continue;
      }

      // 评分
      let score = 55;

      // 底部越接近越好（满分15分）
      score += Math.max(0, 15 - price_diff_pct * 7);

      // 反弹幅度越大越好（满分15分）
      score += Math.min(15, (rebound_pct - 3) * 2);

      // 两底间隔越大越好（满分10分）
      score += Math.min(10, (bars_between - min_bars_between) * 0.3);

      // 当前价格越接近颈线越好（满分10分）
      if (distance_to_neckline_pct <= 3) {
        score += 10;
      } else if (distance_to_neckline_pct <= 8) {
        score += 6;
      } else {
        score += 3;
      }

      score = Math.min(100, Math.round(score));

      // 根据价格大小决定显示精度
      const decimals = bottom_avg < 0.01 ? 6 : bottom_avg < 1 ? 4 : 2;

      return {
        pattern_type: 'DOUBLE_BOTTOM',
        score,
        description: `双底形态: 底部${bottom_avg.toFixed(decimals)}, 颈线${neckline.toFixed(decimals)}, 间隔${bars_between}根K线, 距颈线${distance_to_neckline_pct.toFixed(1)}%`,
        key_levels: {
          support: bottom_avg,
          neckline,
          target,
          stop_loss: bottom_avg * 0.98,
          bars_between,
          low1_price: low1.price,
          low2_price: low2.price
        },
        detected_at: klines[klines.length - 1].open_time
      };
    }

    return null;
  }

  /**
   * 计算EMA (Exponential Moving Average)
   *
   * @param klines K线数据
   * @param period EMA周期
   * @returns EMA值数组
   */
  private calculate_ema(klines: KlineData[], period: number): number[] {
    const ema: number[] = [];
    const multiplier = 2 / (period + 1);

    for (let i = 0; i < klines.length; i++) {
      if (i === 0) {
        ema.push(klines[i].close);
      } else if (i < period) {
        // 前period根使用SMA作为初始值
        const sum = klines.slice(0, i + 1).reduce((acc, k) => acc + k.close, 0);
        ema.push(sum / (i + 1));
      } else {
        ema.push((klines[i].close - ema[i - 1]) * multiplier + ema[i - 1]);
      }
    }

    return ema;
  }

  /**
   * 自定义参数检测上涨回调靠近EMA形态
   *
   * 形态特征:
   * 1. 先有一段明显上涨（涨幅 >= min_surge_pct）
   * 2. 上涨后回调（回调幅度 <= max_retrace_pct）
   * 3. 回调持续一定时间（回调K线数 >= min_retrace_bars）
   * 4. 当前价格靠近EMA均线（距离 <= max_distance_to_ema_pct）
   *
   * @param klines K线数据
   * @param min_surge_pct 最小上涨幅度 (%)
   * @param max_retrace_pct 最大回调幅度 (%)
   * @param min_retrace_bars 最小回调K线数
   * @param max_distance_to_ema_pct 当前价格距EMA的最大距离 (%)
   * @param ema_period EMA周期，默认120
   * @returns 检测结果，未检测到返回 null
   */
  detect_surge_ema_pullback_custom(
    klines: KlineData[],
    min_surge_pct: number,
    max_retrace_pct: number,
    min_retrace_bars: number,
    max_distance_to_ema_pct: number,
    ema_period: number = 120
  ): PatternResult | null {
    // 需要足够的K线数据计算EMA
    if (klines.length < ema_period + 20) {
      return null;
    }

    // 计算EMA
    const ema_values = this.calculate_ema(klines, ema_period);
    const current_ema = ema_values[ema_values.length - 1];
    const current_price = klines[klines.length - 1].close;

    // 当前价格必须在EMA上方（上涨趋势）
    if (current_price < current_ema) {
      return null;
    }

    // 计算当前价格距EMA的距离
    const distance_to_ema_pct = (current_price - current_ema) / current_ema * 100;

    // 距离EMA必须在指定范围内
    if (distance_to_ema_pct > max_distance_to_ema_pct) {
      return null;
    }

    // 识别波段点
    const swing_points = this.find_swing_points(klines);
    const lows = swing_points.filter(p => p.type === 'LOW');
    const highs = swing_points.filter(p => p.type === 'HIGH');

    if (lows.length < 1 || highs.length < 1) {
      return null;
    }

    const current_index = klines.length - 1;

    // 找最近的波段低点和高点
    const recent_lows = lows.slice(-5);
    const recent_highs = highs.slice(-5);

    for (const low of recent_lows) {
      for (const high of recent_highs) {
        // 高点必须在低点之后
        if (high.index <= low.index) continue;

        // 高点必须在当前K线之前
        if (high.index >= current_index) continue;

        // 计算上涨幅度
        const surge_pct = (high.price - low.price) / low.price * 100;
        if (surge_pct < min_surge_pct) continue;

        // 检查回调持续时间
        const retrace_bars = current_index - high.index;
        if (retrace_bars < min_retrace_bars) continue;

        // 当前价格必须低于高点（处于回调中）
        if (current_price >= high.price) continue;

        // 当前价格必须高于起涨点
        if (current_price <= low.price) continue;

        // 计算回调幅度（相对于涨幅）
        const surge_amount = high.price - low.price;
        const retrace_amount = high.price - current_price;
        const retrace_pct = (retrace_amount / surge_amount) * 100;

        // 回调幅度必须在指定范围内
        if (retrace_pct > max_retrace_pct) continue;

        // 确定斐波那契位置
        const retrace_ratio = retrace_pct / 100;
        let fib_level = '';
        if (retrace_ratio <= 0.236) {
          fib_level = '0.236';
        } else if (retrace_ratio <= 0.382) {
          fib_level = '0.382';
        } else if (retrace_ratio <= 0.5) {
          fib_level = '0.5';
        } else if (retrace_ratio <= 0.618) {
          fib_level = '0.618';
        } else {
          fib_level = '>0.618';
        }

        // 评分
        let score = 50;

        // 涨幅越大越好（满分20分）
        score += Math.min(20, (surge_pct - min_surge_pct) / min_surge_pct * 15);

        // 回调越浅越好（满分15分）
        score += Math.max(0, 15 - retrace_pct / max_retrace_pct * 15);

        // 距离EMA越近越好（满分15分）
        score += Math.max(0, 15 - distance_to_ema_pct / max_distance_to_ema_pct * 15);

        // 回调时间适中加分（满分10分）
        if (retrace_bars >= min_retrace_bars && retrace_bars <= min_retrace_bars * 3) {
          score += 10;
        } else if (retrace_bars <= min_retrace_bars * 5) {
          score += 5;
        }

        score = Math.min(100, Math.round(score));

        // 根据价格大小决定显示精度
        const decimals = current_price < 0.01 ? 6 : current_price < 1 ? 4 : 2;

        return {
          pattern_type: 'SURGE_EMA_PULLBACK',
          score,
          description: `上涨回调靠近EMA${ema_period}: 涨${surge_pct.toFixed(1)}%, 回调${retrace_pct.toFixed(1)}% (${fib_level}), 距EMA${distance_to_ema_pct.toFixed(1)}%`,
          key_levels: {
            swing_low: low.price,
            swing_high: high.price,
            surge_pct,
            ema_value: current_ema,
            distance_to_ema_pct,
            retrace_pct,
            retrace_bars,
            support: current_ema,
            target: high.price * 1.1,  // 目标突破前高10%
            stop_loss: current_ema * 0.98
          },
          detected_at: klines[klines.length - 1].open_time
        };
      }
    }

    return null;
  }

  /**
   * 自定义参数检测单根K线形态
   *
   * 分析最后一根K线的形态特征：
   * - 上影线占比
   * - 下影线占比
   * - 实体占比
   * - 是否为阳线/阴线
   * - K线振幅（最高-最低的涨幅）
   *
   * @param klines K线数据
   * @param min_upper_shadow_pct 最小上影线占比 (%)，可选
   * @param max_upper_shadow_pct 最大上影线占比 (%)，可选
   * @param min_lower_shadow_pct 最小下影线占比 (%)，可选
   * @param max_lower_shadow_pct 最大下影线占比 (%)，可选
   * @param min_body_pct 最小实体占比 (%)，可选
   * @param max_body_pct 最大实体占比 (%)，可选
   * @param is_bullish 是否要求阳线，null表示不限
   * @param min_range_pct 最小振幅 (%)，可选
   * @param max_range_pct 最大振幅 (%)，可选
   * @returns 检测结果，未检测到返回 null
   */
  detect_single_candle_custom(
    klines: KlineData[],
    min_upper_shadow_pct?: number,
    max_upper_shadow_pct?: number,
    min_lower_shadow_pct?: number,
    max_lower_shadow_pct?: number,
    min_body_pct?: number,
    max_body_pct?: number,
    is_bullish?: boolean | null,
    min_range_pct?: number,
    max_range_pct?: number
  ): PatternResult | null {
    if (klines.length < 1) {
      return null;
    }

    // 获取最后一根K线
    const candle = klines[klines.length - 1];

    // 计算K线各部分
    const { open, high, low, close } = candle;
    const range = high - low;

    // 防止除零
    if (range <= 0) {
      return null;
    }

    // 判断阳线/阴线
    const bullish = close >= open;
    const body_top = Math.max(open, close);
    const body_bottom = Math.min(open, close);
    const body = body_top - body_bottom;

    // 计算各部分占比
    const upper_shadow = high - body_top;
    const lower_shadow = body_bottom - low;

    const upper_shadow_pct = (upper_shadow / range) * 100;
    const lower_shadow_pct = (lower_shadow / range) * 100;
    const body_pct = (body / range) * 100;

    // 计算振幅（相对于最低价的涨幅）
    const range_pct = (range / low) * 100;

    // 验证条件
    // 上影线占比
    if (min_upper_shadow_pct !== undefined && upper_shadow_pct < min_upper_shadow_pct) {
      return null;
    }
    if (max_upper_shadow_pct !== undefined && upper_shadow_pct > max_upper_shadow_pct) {
      return null;
    }

    // 下影线占比
    if (min_lower_shadow_pct !== undefined && lower_shadow_pct < min_lower_shadow_pct) {
      return null;
    }
    if (max_lower_shadow_pct !== undefined && lower_shadow_pct > max_lower_shadow_pct) {
      return null;
    }

    // 实体占比
    if (min_body_pct !== undefined && body_pct < min_body_pct) {
      return null;
    }
    if (max_body_pct !== undefined && body_pct > max_body_pct) {
      return null;
    }

    // 阳线/阴线
    if (is_bullish !== undefined && is_bullish !== null && bullish !== is_bullish) {
      return null;
    }

    // 振幅
    if (min_range_pct !== undefined && range_pct < min_range_pct) {
      return null;
    }
    if (max_range_pct !== undefined && range_pct > max_range_pct) {
      return null;
    }

    // 评分计算
    let score = 60;

    // 振幅越大加分（最多15分）
    if (min_range_pct !== undefined) {
      score += Math.min(15, (range_pct - min_range_pct) / min_range_pct * 10);
    }

    // 形态特征加分
    // 长下影线（锤子线特征）加分
    if (lower_shadow_pct >= 50) {
      score += 10;
    } else if (lower_shadow_pct >= 30) {
      score += 5;
    }

    // 长上影线（流星线特征）加分
    if (upper_shadow_pct >= 50) {
      score += 10;
    } else if (upper_shadow_pct >= 30) {
      score += 5;
    }

    // 小实体（十字星特征）加分
    if (body_pct <= 10) {
      score += 5;
    }

    score = Math.min(100, Math.round(score));

    // 识别形态名称
    let pattern_name = '';
    if (body_pct <= 10) {
      pattern_name = '十字星';
    } else if (lower_shadow_pct >= 60 && upper_shadow_pct <= 10) {
      pattern_name = bullish ? '锤子线' : '上吊线';
    } else if (upper_shadow_pct >= 60 && lower_shadow_pct <= 10) {
      pattern_name = bullish ? '倒锤头' : '流星线';
    } else if (body_pct >= 70) {
      pattern_name = bullish ? '大阳线' : '大阴线';
    } else {
      pattern_name = bullish ? '阳线' : '阴线';
    }

    // 根据价格大小决定显示精度
    const decimals = close < 0.01 ? 6 : close < 1 ? 4 : 2;

    return {
      pattern_type: 'SINGLE_CANDLE',
      score,
      description: `${pattern_name}: 上影${upper_shadow_pct.toFixed(1)}%, 下影${lower_shadow_pct.toFixed(1)}%, 实体${body_pct.toFixed(1)}%, 振幅${range_pct.toFixed(2)}%`,
      key_levels: {
        upper_shadow_pct,
        lower_shadow_pct,
        body_pct,
        is_bullish: bullish,
        candle_range_pct: range_pct,
        open_price: open,
        close_price: close,
        high_price: high,
        low_price: low,
        support: low,
        resistance: high
      },
      detected_at: candle.open_time
    };
  }
}
