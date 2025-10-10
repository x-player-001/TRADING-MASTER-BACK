import { KlineData } from '@/types/common';
import { RangeBox, StructureType } from '@/types/structure';
import { logger } from '@/utils/logger';

/**
 * 回测专用区间检测器
 * 使用更宽松的阈值，方便调试和优化
 */
export class BacktestRangeDetector {

  // 可配置的阈值参数
  private static config = {
    volatility_min: 0.005,      // 波动率下限 0.5%
    volatility_max: 0.15,        // 波动率上限 15%
    price_density: 0.60,         // 价格密度 60%
    min_confidence: 0.40,        // 最小置信度 0.4
    min_touch_count: 3,          // 最小触碰次数 3次
    min_support_touches: 1,      // 支撑最小触碰 1次
    min_resistance_touches: 1,   // 阻力最小触碰 1次
    min_duration_bars: 15,       // 最小持续K线数 15根
    range_percent_min: 0.5,      // 区间范围下限 0.5%
    range_percent_max: 15,       // 区间范围上限 15%
  };

  /**
   * 更新配置（用于调试优化）
   */
  static update_config(new_config: Partial<typeof BacktestRangeDetector.config>) {
    this.config = { ...this.config, ...new_config };
    logger.info('[BacktestRangeDetector] Config updated:', this.config);
  }

  /**
   * 检测交易区间
   * @param klines K线数据 (降序: 最新在前)
   * @param lookback 回溯周期
   * @param debug 是否输出调试日志
   */
  static detect_ranges(klines: KlineData[], lookback: number = 200, debug: boolean = false): RangeBox[] {
    try {
      if (klines.length < 50) {
        return [];
      }

      // 不再限制lookback，使用所有传入的K线数据
      const recent_klines = klines;

      // 第1步: 波动率筛选
      const candidate_regions = this.find_low_volatility_regions(recent_klines, false);

      if (candidate_regions.length === 0) {
        return [];
      }

      // 第2步: 精确分析
      const ranges: RangeBox[] = [];
      let filtered_counts = { too_short: 0, no_boundaries: 0, low_density: 0, invalid: 0 };

      for (const region of candidate_regions) {
        const region_klines = recent_klines.slice(region.start_index, region.end_index + 1);

        if (region_klines.length < 15) {
          filtered_counts.too_short++;
          continue;
        }

        const boundaries = this.detect_boundaries_by_clustering(region_klines);
        if (!boundaries) {
          filtered_counts.no_boundaries++;
          continue;
        }

        const density_valid = this.validate_by_price_density(region_klines, boundaries);
        if (!density_valid) {
          filtered_counts.low_density++;
          continue;
        }

        const touch_score = this.calculate_touch_score(region_klines, boundaries);
        const range = this.build_range_box(region_klines, boundaries, touch_score, region.volatility);

        if (range && this.validate_range(range)) {
          ranges.push(range);
        } else {
          filtered_counts.invalid++;
        }
      }

      // 第3步: 合并重叠
      const merged_ranges = this.merge_overlapping_ranges(ranges);

      // 第4步: 排序返回前3个
      const final_ranges = merged_ranges
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);

      return final_ranges;

    } catch (error) {
      logger.error('[BacktestRangeDetector] 检测失败', error);
      return [];
    }
  }

  /**
   * 波动率筛选
   */
  private static find_low_volatility_regions(
    klines: KlineData[],
    debug: boolean = false
  ): Array<{ start_index: number; end_index: number; volatility: number }> {
    const regions = [];
    const min_duration = 15;
    const max_duration = 150;
    const step = 3;

    let volatility_stats = { min: Infinity, max: -Infinity, count: 0, sum: 0 };

    for (let duration = min_duration; duration <= Math.min(max_duration, klines.length); duration += 5) {
      for (let start = 0; start <= klines.length - duration; start += step) {
        const end = start + duration - 1;
        const window_klines = klines.slice(start, end + 1);

        const highs = window_klines.map(k => parseFloat(k.high as any));
        const lows = window_klines.map(k => parseFloat(k.low as any));
        const closes = window_klines.map(k => parseFloat(k.close as any));

        const highest = Math.max(...highs);
        const lowest = Math.min(...lows);
        const avg_price = closes.reduce((a, b) => a + b, 0) / closes.length;
        const volatility = (highest - lowest) / avg_price;

        volatility_stats.min = Math.min(volatility_stats.min, volatility);
        volatility_stats.max = Math.max(volatility_stats.max, volatility);
        volatility_stats.sum += volatility;
        volatility_stats.count++;

        if (volatility >= this.config.volatility_min && volatility <= this.config.volatility_max) {
          regions.push({ start_index: start, end_index: end, volatility });
        }
      }
    }

    if (debug && volatility_stats.count > 0) {
      const avg = volatility_stats.sum / volatility_stats.count;
      console.log(`[BacktestRangeDetector] 📊 波动率统计:`);
      console.log(`  - 范围: ${(volatility_stats.min * 100).toFixed(2)}% ~ ${(volatility_stats.max * 100).toFixed(2)}%`);
      console.log(`  - 平均: ${(avg * 100).toFixed(2)}%`);
      console.log(`  - 阈值: ${(this.config.volatility_min * 100).toFixed(2)}% ~ ${(this.config.volatility_max * 100).toFixed(2)}%`);
      console.log(`  - 符合: ${regions.length} 个`);
    }

    return regions;
  }

  /**
   * 高低点聚类检测边界
   * (复制自 RangeDetector)
   */
  private static detect_boundaries_by_clustering(klines: KlineData[]): {
    resistance: number;
    support: number;
    resistance_count: number;
    support_count: number;
  } | null {
    const highs = klines.map(k => parseFloat(k.high as any));
    const lows = klines.map(k => parseFloat(k.low as any));

    const local_highs: number[] = [];
    const local_lows: number[] = [];

    for (let i = 1; i < klines.length - 1; i++) {
      if (highs[i] >= highs[i - 1] && highs[i] >= highs[i + 1]) {
        local_highs.push(highs[i]);
      }
      if (lows[i] <= lows[i - 1] && lows[i] <= lows[i + 1]) {
        local_lows.push(lows[i]);
      }
    }

    if (local_highs.length < 2 || local_lows.length < 2) {
      return null;
    }

    const resistance_cluster = this.find_price_cluster(local_highs, 0.03);
    const support_cluster = this.find_price_cluster(local_lows, 0.03);

    if (!resistance_cluster || !support_cluster) {
      return null;
    }

    if (support_cluster.price >= resistance_cluster.price) {
      return null;
    }

    return {
      resistance: resistance_cluster.price,
      support: support_cluster.price,
      resistance_count: resistance_cluster.count,
      support_count: support_cluster.count
    };
  }

  /**
   * 价格聚类
   */
  private static find_price_cluster(
    prices: number[],
    tolerance: number
  ): { price: number; count: number } | null {
    if (prices.length === 0) return null;

    const sorted_prices = [...prices].sort((a, b) => a - b);
    const clusters: { price: number; count: number }[] = [];

    for (const price of sorted_prices) {
      const existing = clusters.find(c => Math.abs(c.price - price) / c.price < tolerance);

      if (existing) {
        existing.count++;
        existing.price = (existing.price * (existing.count - 1) + price) / existing.count;
      } else {
        clusters.push({ price, count: 1 });
      }
    }

    return clusters.sort((a, b) => b.count - a.count)[0] || null;
  }

  /**
   * 价格密度验证
   */
  private static validate_by_price_density(
    klines: KlineData[],
    boundaries: { resistance: number; support: number }
  ): boolean {
    const closes = klines.map(k => parseFloat(k.close as any));
    const { resistance, support } = boundaries;

    const in_range_count = closes.filter(c => c >= support && c <= resistance).length;
    const in_range_ratio = in_range_count / closes.length;

    return in_range_ratio >= this.config.price_density;
  }

  /**
   * 触碰次数评分
   */
  private static calculate_touch_score(
    klines: KlineData[],
    boundaries: { resistance: number; support: number }
  ): {
    support_touches: number;
    resistance_touches: number;
    touch_count: number;
    balance_score: number;
  } {
    const highs = klines.map(k => parseFloat(k.high as any));
    const lows = klines.map(k => parseFloat(k.low as any));
    const { resistance, support } = boundaries;

    const resistance_touches = this.count_level_touches(highs, resistance, 0.02);
    const support_touches = this.count_level_touches(lows, support, 0.02);
    const touch_count = resistance_touches + support_touches;

    const balance_score = touch_count === 0
      ? 0
      : Math.min(resistance_touches, support_touches) / Math.max(resistance_touches, support_touches);

    return {
      support_touches,
      resistance_touches,
      touch_count,
      balance_score
    };
  }

  /**
   * 统计水平位触碰次数
   */
  private static count_level_touches(prices: number[], level: number, tolerance: number): number {
    let count = 0;
    let in_zone = false;
    const threshold_high = level * (1 + tolerance);
    const threshold_low = level * (1 - tolerance);

    for (const price of prices) {
      const is_touching = price >= threshold_low && price <= threshold_high;

      if (is_touching && !in_zone) {
        count++;
        in_zone = true;
      } else if (!is_touching && in_zone) {
        in_zone = false;
      }
    }

    return count;
  }

  /**
   * 构建区间对象
   */
  private static build_range_box(
    klines: KlineData[],
    boundaries: { resistance: number; support: number; resistance_count: number; support_count: number },
    touch_score: { support_touches: number; resistance_touches: number; touch_count: number; balance_score: number },
    volatility: number
  ): RangeBox | null {
    const symbol = klines[0].symbol;
    const interval = klines[0].interval;
    const { resistance, support } = boundaries;
    const { support_touches, resistance_touches, touch_count, balance_score } = touch_score;

    const middle = (resistance + support) / 2;
    const range_size = resistance - support;
    const range_percent = (range_size / middle) * 100;

    const closes = klines.map(k => parseFloat(k.close as any));
    const volumes = klines.map(k => parseFloat(k.volume as any));
    const current_price = closes[0];

    const near_resistance = current_price >= resistance * 0.97;
    const near_support = current_price <= support * 1.03;
    const avg_volume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const volume_trend = this.determine_volume_trend(volumes);

    const confidence = this.calculate_confidence(
      touch_count,
      balance_score,
      klines.length,
      volatility,
      boundaries.resistance_count,
      boundaries.support_count
    );

    const strength = this.calculate_strength(
      touch_count,
      klines.length,
      range_percent,
      balance_score
    );

    return {
      symbol,
      interval,
      type: StructureType.RANGE,
      resistance,
      support,
      middle,
      range_size,
      range_percent,
      touch_count,
      support_touches,
      resistance_touches,
      duration_bars: klines.length,
      near_resistance,
      near_support,
      breakout_direction: null,
      confidence,
      strength: Math.round(strength),
      start_time: klines[klines.length - 1].open_time,
      end_time: klines.length > 1 ? klines[1].close_time : klines[0].close_time,
      avg_volume,
      volume_trend
    };
  }

  private static calculate_confidence(
    touch_count: number,
    balance_score: number,
    duration: number,
    volatility: number,
    resistance_cluster_count: number,
    support_cluster_count: number
  ): number {
    let confidence = 0;
    confidence += Math.min(touch_count / 12, 0.3);
    confidence += balance_score * 0.25;
    confidence += Math.min(duration / 80, 0.2);
    const volatility_score = volatility < 0.05 ? 0.15 : 0.15 * (1 - (volatility - 0.05) / 0.1);
    confidence += Math.max(0, volatility_score);
    const cluster_score = Math.min((resistance_cluster_count + support_cluster_count) / 10, 0.1);
    confidence += cluster_score;
    return Math.min(confidence, 1);
  }

  private static calculate_strength(
    touch_count: number,
    duration: number,
    range_percent: number,
    balance_score: number
  ): number {
    let strength = 0;
    strength += Math.min(touch_count * 5, 40);
    strength += Math.min((duration / 80) * 30, 30);
    strength += Math.max(0, (1 - range_percent / 15) * 20);
    strength += balance_score * 10;
    return Math.min(strength, 100);
  }

  private static determine_volume_trend(volumes: number[]): 'increasing' | 'decreasing' | 'stable' {
    const half = Math.floor(volumes.length / 2);
    const first_half_avg = volumes.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const second_half_avg = volumes.slice(half).reduce((a, b) => a + b, 0) / (volumes.length - half);
    const change = (second_half_avg - first_half_avg) / first_half_avg;

    if (change > 0.2) return 'increasing';
    if (change < -0.2) return 'decreasing';
    return 'stable';
  }

  /**
   * 验证区间有效性（使用可配置阈值）
   */
  private static validate_range(range: RangeBox): boolean {
    if (range.confidence < this.config.min_confidence) return false;
    if (range.touch_count < this.config.min_touch_count) return false;
    if (range.support_touches < this.config.min_support_touches) return false;
    if (range.resistance_touches < this.config.min_resistance_touches) return false;
    if (range.duration_bars < this.config.min_duration_bars) return false;
    if (range.range_percent < this.config.range_percent_min || range.range_percent > this.config.range_percent_max) return false;
    return true;
  }

  /**
   * 合并重叠区间
   */
  private static merge_overlapping_ranges(ranges: RangeBox[]): RangeBox[] {
    if (ranges.length <= 1) return ranges;

    const merged: RangeBox[] = [];
    const used = new Set<number>();

    for (let i = 0; i < ranges.length; i++) {
      if (used.has(i)) continue;

      const current = ranges[i];
      let best_range = current;

      for (let j = i + 1; j < ranges.length; j++) {
        if (used.has(j)) continue;

        const candidate = ranges[j];

        const support_diff = Math.abs(current.support - candidate.support) /
                           Math.max(current.support, candidate.support);
        const resistance_diff = Math.abs(current.resistance - candidate.resistance) /
                              Math.max(current.resistance, candidate.resistance);

        const price_similar = support_diff < 0.05 && resistance_diff < 0.05;

        if (price_similar) {
          const time_overlap =
            (candidate.start_time >= current.start_time && candidate.start_time <= current.end_time) ||
            (candidate.end_time >= current.start_time && candidate.end_time <= current.end_time) ||
            (candidate.start_time <= current.start_time && candidate.end_time >= current.end_time);

          if (time_overlap) {
            used.add(j);
            if (candidate.confidence > best_range.confidence) {
              best_range = candidate;
            }
          }
        }
      }

      merged.push(best_range);
      used.add(i);
    }

    return merged;
  }

  /**
   * 检测区间突破
   */
  static detect_breakout(
    range: RangeBox,
    current_kline: KlineData,
    recent_klines: KlineData[]
  ): 'up' | 'down' | null {
    const close = parseFloat(current_kline.close as any);

    const breakout_up_threshold = range.resistance * 1.02;
    const breakout_down_threshold = range.support * 0.98;

    if (close > breakout_up_threshold) {
      if (this.confirm_breakout(recent_klines, range.resistance, 'up', range.avg_volume)) {
        return 'up';
      }
    }

    if (close < breakout_down_threshold) {
      if (this.confirm_breakout(recent_klines, range.support, 'down', range.avg_volume)) {
        return 'down';
      }
    }

    return null;
  }

  /**
   * 确认突破有效性
   */
  private static confirm_breakout(
    recent_klines: KlineData[],
    level: number,
    direction: 'up' | 'down',
    avg_volume: number
  ): boolean {
    if (recent_klines.length < 2) return false;

    const last_two = recent_klines.slice(-2);
    const closes = last_two.map(k => parseFloat(k.close as any));
    const volumes = last_two.map(k => parseFloat(k.volume as any));

    if (direction === 'up') {
      if (!closes.every(c => c > level)) return false;
    } else {
      if (!closes.every(c => c < level)) return false;
    }

    const has_volume_surge = volumes.some(v => v > avg_volume * 1.3);
    return has_volume_surge;
  }
}
