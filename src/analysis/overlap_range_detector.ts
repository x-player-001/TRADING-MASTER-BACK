/**
 * K线重叠区间检测算法 v2
 *
 * 核心思路: 基于「K线重叠度」而非「收盘价波动」来识别区间
 *
 * 评分体系 (总分100分):
 * 1. 重叠度得分 (30分) - K线覆盖度越高越好
 * 2. 边界触碰得分 (25分) - 上下沿触碰次数越多越好
 * 3. 持续时间得分 (20分) - 区间持续越久越稳定
 * 4. 成交量得分 (15分) - 区间内成交量集中度
 * 5. 形态得分 (10分) - 区间宽度合理性
 *
 * 适用场景:
 * - 高波动币种 (如 JELLYJELLYUSDT)
 * - K线实体大但重叠度高的情况
 * - 传统CV方法失效的场景
 */

import { logger } from '@/utils/logger';

// K线数据结构
export interface KlineData {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 边界触碰统计
export interface BoundaryTouches {
  upper_touches: number;      // 上沿触碰次数
  lower_touches: number;      // 下沿触碰次数
  total_touches: number;      // 总触碰次数
  balance_ratio: number;      // 平衡度 (0-1, 1表示上下触碰完全均衡)
}

// 成交量特征
export interface VolumeProfile {
  total_volume: number;       // 区间总成交量
  avg_volume: number;         // 平均成交量
  volume_concentration: number; // 成交量集中度 (区间内/总体)
  high_volume_bars: number;   // 放量K线数量
}

// 评分详情
export interface ScoreBreakdown {
  overlap_score: number;      // 重叠度得分 (0-30)
  touch_score: number;        // 触碰得分 (0-25)
  duration_score: number;     // 持续时间得分 (0-30)
  volume_score: number;       // 成交量得分 (0-15)
  shape_score: number;        // 形态得分 (0-10)
  total_score: number;        // 总分 (0-100，超过100按100计)
}

// 重叠区间结果
export interface OverlapRange {
  // 核心边界
  upper_bound: number;        // 区间上沿
  lower_bound: number;        // 区间下沿
  center_price: number;       // 中心价格
  range_width_pct: number;    // 区间宽度百分比

  // 重叠特征
  kline_coverage: number;     // K线覆盖度 (0-1)
  strict_overlap: boolean;    // 是否严格重叠 (所有K线都经过)

  // 边界触碰
  boundary_touches: BoundaryTouches;

  // 成交量特征
  volume_profile: VolumeProfile;

  // 时间信息
  start_time: number;
  end_time: number;
  kline_count: number;
  duration_minutes: number;

  // 评分
  score: ScoreBreakdown;

  // 扩展边界 (用于突破判断)
  extended_high: number;      // P95 高点
  extended_low: number;       // P5 低点
}

// 突破确认详情
export interface BreakoutConfirmation {
  // 幅度确认
  amplitude_confirmed: boolean;    // 突破幅度是否达标
  amplitude_pct: number;           // 突破幅度占区间宽度的百分比

  // 连续K线确认
  bars_confirmed: boolean;         // 连续K线是否确认
  confirming_bars: number;         // 确认方向的K线数量
  total_confirm_bars: number;      // 总确认K线数量

  // 成交量确认
  volume_confirmed: boolean;       // 成交量是否放大
  volume_ratio: number;            // 成交量相对平均的倍数
  avg_volume_lookback: number;     // 平均成交量计算的回看K线数

  // 持续性确认 (需要后续K线)
  persistence_confirmed: boolean;  // 突破是否持续
  max_retracement_pct: number;     // 最大回撤百分比

  // 综合确认
  confirmation_score: number;      // 确认得分 (0-100)
  is_strong_breakout: boolean;     // 是否强势突破 (得分>=70)
}

// 突破信号
export interface OverlapBreakout {
  direction: 'UP' | 'DOWN';
  breakout_price: number;
  breakout_time: number;
  range: OverlapRange;
  breakout_pct: number;
  volume_ratio: number;
  is_confirmed: boolean;

  // 新增: 详细确认信息
  confirmation?: BreakoutConfirmation;
}

// 突破确认配置
export interface BreakoutConfirmConfig {
  // 幅度阈值
  min_breakout_pct: number;         // 最小突破幅度(相对区间宽度)，默认0.3

  // 连续K线确认
  confirm_bars: number;             // 需要连续几根K线确认，默认2
  confirm_close_ratio: number;      // 确认K线中收盘价在突破方向的比例，默认0.7

  // 成交量确认
  volume_multiplier: number;        // 突破K线成交量需达到平均的倍数，默认1.5
  volume_lookback: number;          // 计算平均成交量的回看K线数，默认20

  // 突破持续性
  persistence_bars: number;         // 突破后检查持续性的K线数，默认3
  persistence_threshold: number;    // 持续性阈值(不回撤超过突破幅度的X%)，默认0.5
}

// 趋势检测结果
export interface TrendAnalysis {
  is_trending: boolean;           // 是否有明显趋势
  trend_direction: 'UP' | 'DOWN' | 'SIDEWAYS';  // 趋势方向
  trend_strength: number;         // 趋势强度 (0-1)
  slope_per_bar: number;          // 每根K线的斜率 (价格变化)
  r_squared: number;              // 线性回归R²值 (趋势拟合度)
  price_change_pct: number;       // 总价格变化百分比
}

// 配置
export interface OverlapRangeConfig {
  // 窗口设置
  min_window_size: number;      // 最小窗口大小，默认12
  max_window_size: number;      // 最大窗口大小，默认80

  // 重叠条件
  min_kline_coverage: number;   // 最小K线覆盖度，默认0.6 (60%)

  // 边界触碰
  touch_tolerance_pct: number;  // 触碰容差百分比，默认0.15%

  // 区间合并
  merge_price_tolerance: number;  // 价格合并容差，默认0.5%
  merge_time_gap_bars: number;    // 时间间隔容差(K线数)，默认5

  // 突破判断
  breakout_threshold_pct: number;  // 突破阈值百分比，默认0.3%

  // 最低分数
  min_total_score: number;      // 最低总分，默认40

  // 突破确认配置
  breakout_confirm: BreakoutConfirmConfig;

  // 趋势过滤配置 (新增)
  trend_filter: {
    enabled: boolean;               // 是否启用趋势过滤，默认true
    min_r_squared: number;          // 最小R²阈值，超过此值认为有趋势，默认0.6
    min_price_change_pct: number;   // 最小价格变化百分比，默认1.0%
    min_slope_per_bar_pct: number;  // 每根K线最小斜率百分比，默认0.02%
  };

  // 区间分割配置 (新增)
  segment_split: {
    enabled: boolean;               // 是否启用分割检测，默认true
    price_gap_pct: number;          // 价格跳空阈值百分比，默认0.8%
    time_gap_bars: number;          // 时间间隔阈值(K线数)，默认10
  };
}

// 默认突破确认配置
const DEFAULT_BREAKOUT_CONFIRM: BreakoutConfirmConfig = {
  min_breakout_pct: 0.3,
  confirm_bars: 2,
  confirm_close_ratio: 0.7,
  volume_multiplier: 1.5,
  volume_lookback: 20,
  persistence_bars: 3,
  persistence_threshold: 0.5
};

// 默认趋势过滤配置
const DEFAULT_TREND_FILTER = {
  enabled: true,
  min_r_squared: 0.6,
  min_price_change_pct: 1.0,
  min_slope_per_bar_pct: 0.02
};

// 默认区间分割配置
const DEFAULT_SEGMENT_SPLIT = {
  enabled: true,
  price_gap_pct: 0.8,
  time_gap_bars: 10
};

const DEFAULT_CONFIG: OverlapRangeConfig = {
  min_window_size: 12,
  max_window_size: 80,
  min_kline_coverage: 0.6,
  touch_tolerance_pct: 0.15,
  merge_price_tolerance: 0.5,
  merge_time_gap_bars: 5,
  breakout_threshold_pct: 0.3,
  min_total_score: 40,
  breakout_confirm: DEFAULT_BREAKOUT_CONFIRM,
  trend_filter: DEFAULT_TREND_FILTER,
  segment_split: DEFAULT_SEGMENT_SPLIT
};

/**
 * 滑动窗口缓存 - 用于增量计算优化
 */
interface WindowCache {
  // 排序后的高低点数组 (用于快速百分位数计算)
  sorted_highs: number[];
  sorted_lows: number[];
  // 最值
  min_high: number;
  max_low: number;
  // 成交量
  total_volume: number;
  // 窗口边界索引
  start_idx: number;
  end_idx: number;
}

export class OverlapRangeDetector {
  private config: OverlapRangeConfig;

  // 滑动窗口缓存
  private window_cache: WindowCache | null = null;

  constructor(config?: Partial<OverlapRangeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config?.breakout_confirm) {
      this.config.breakout_confirm = { ...DEFAULT_BREAKOUT_CONFIRM, ...config.breakout_confirm };
    }
    if (config?.trend_filter) {
      this.config.trend_filter = { ...DEFAULT_TREND_FILTER, ...config.trend_filter };
    }
    if (config?.segment_split) {
      this.config.segment_split = { ...DEFAULT_SEGMENT_SPLIT, ...config.segment_split };
    }
  }

  /**
   * 检测重叠区间 (主入口)
   * @param klines K线数据 (时间升序)
   */
  detect_ranges(klines: KlineData[]): OverlapRange[] {
    if (klines.length < this.config.min_window_size) {
      return [];
    }

    // 0. 先进行整体趋势分段 - 将数据按趋势变化点分割
    const trend_segments = this.split_by_trend_changes(klines);

    // 对每个趋势分段独立检测区间
    let all_candidates: OverlapRange[] = [];

    for (const segment of trend_segments) {
      if (segment.length < this.config.min_window_size) {
        continue;
      }

      // 检查该分段是否整体为趋势
      const segment_trend = this.analyze_trend(segment);
      if (segment_trend.is_trending && segment_trend.trend_strength > 0.5) {
        // 该分段是明显趋势，跳过
        continue;
      }

      // 1. 检测价格跳空，进一步分段
      const gap_indices = this.detect_price_gaps(segment);
      const sub_segments = this.split_klines_by_gaps(segment, gap_indices);

      for (const sub_segment of sub_segments) {
        if (sub_segment.length < this.config.min_window_size) {
          continue;
        }

        // 2. 滑动窗口扫描，收集所有候选区间
        const candidates = this.scan_candidates(sub_segment);
        all_candidates = all_candidates.concat(candidates);
      }
    }

    if (all_candidates.length === 0) {
      return [];
    }

    // 3. 合并重叠的区间 (只在同一价格区域内合并)
    const merged = this.merge_overlapping_ranges(all_candidates);

    // 4. 过滤低分区间
    const filtered = merged.filter(r => r.score.total_score >= this.config.min_total_score);

    // 5. 按开始时间排序 (便于理解时间顺序)
    return filtered.sort((a, b) => a.start_time - b.start_time);
  }

  /**
   * 按趋势变化点和价格层级分割K线数据
   * 使用滑动窗口检测趋势变化，同时检测价格层级跳跃
   */
  private split_by_trend_changes(klines: KlineData[]): KlineData[][] {
    if (klines.length < this.config.min_window_size * 2) {
      return [klines];
    }

    const change_points: number[] = [];
    const window_size = Math.min(20, Math.floor(klines.length / 4));

    // 计算每个位置的局部趋势和价格中心
    const local_info: {
      direction: 'UP' | 'DOWN' | 'SIDEWAYS';
      strength: number;
      price_center: number;
    }[] = [];

    for (let i = 0; i <= klines.length - window_size; i++) {
      const window = klines.slice(i, i + window_size);
      const trend = this.analyze_trend(window);
      const highs = window.map(k => k.high);
      const lows = window.map(k => k.low);
      const price_center = (Math.max(...highs) + Math.min(...lows)) / 2;

      local_info.push({
        direction: trend.trend_direction,
        strength: trend.trend_strength,
        price_center
      });
    }

    // 检测趋势方向变化点和价格层级跳跃
    for (let i = 1; i < local_info.length; i++) {
      const prev = local_info[i - 1];
      const curr = local_info[i];

      let is_change_point = false;

      // 条件1: 趋势方向发生显著变化
      if (prev.direction !== curr.direction &&
          (prev.strength > 0.3 || curr.strength > 0.3)) {
        is_change_point = true;
      }

      // 条件2: 价格中心发生显著跳跃 (超过0.5%)
      const price_shift_pct = Math.abs(curr.price_center - prev.price_center) / prev.price_center * 100;
      if (price_shift_pct > 0.5) {
        is_change_point = true;
      }

      if (is_change_point) {
        const change_idx = i + Math.floor(window_size / 2);
        if (change_points.length === 0 ||
            change_idx - change_points[change_points.length - 1] >= this.config.min_window_size) {
          change_points.push(change_idx);
        }
      }
    }

    // 按变化点分割
    if (change_points.length === 0) {
      return [klines];
    }

    const segments: KlineData[][] = [];
    let start = 0;

    for (const change_idx of change_points) {
      if (change_idx > start && change_idx < klines.length) {
        segments.push(klines.slice(start, change_idx));
        start = change_idx;
      }
    }

    if (start < klines.length) {
      segments.push(klines.slice(start));
    }

    return segments.filter(seg => seg.length >= this.config.min_window_size);
  }

  /**
   * 滑动窗口扫描候选区间 (优化版 - 使用增量计算 + 趋势过滤)
   */
  private scan_candidates(klines: KlineData[]): OverlapRange[] {
    const candidates: OverlapRange[] = [];

    // 预计算所有K线的高低点和成交量
    const all_highs = klines.map(k => k.high);
    const all_lows = klines.map(k => k.low);
    const all_volumes = klines.map(k => k.volume);

    // 动态步长: 窗口越大，步长越大
    for (let window_size = this.config.min_window_size;
         window_size <= Math.min(this.config.max_window_size, klines.length);
         window_size += Math.max(2, Math.floor(window_size / 10))) {

      const step = Math.max(1, Math.floor(window_size / 5));

      // 初始化该窗口大小的缓存
      this.window_cache = null;

      for (let start = 0; start <= klines.length - window_size; start += step) {
        const end = start + window_size;

        // 使用增量计算更新缓存
        this.update_window_cache(
          all_highs, all_lows, all_volumes,
          start, end, step
        );

        // 获取窗口K线
        const window_klines = klines.slice(start, end);

        // ===== 趋势过滤 =====
        // 如果窗口内存在明显趋势，跳过该窗口（不是盘整区间）
        if (this.config.trend_filter.enabled) {
          const trend = this.analyze_trend(window_klines);
          if (trend.is_trending) {
            // 跳过有明显趋势的窗口
            continue;
          }
        }

        // 使用缓存进行分析
        const range = this.analyze_window_cached(window_klines, klines);

        if (range && range.score.total_score >= this.config.min_total_score * 0.8) {
          candidates.push(range);
        }
      }
    }

    // 清理缓存
    this.window_cache = null;

    return candidates;
  }

  /**
   * 更新滑动窗口缓存 (增量计算)
   */
  private update_window_cache(
    all_highs: number[],
    all_lows: number[],
    all_volumes: number[],
    start: number,
    end: number,
    step: number
  ): void {
    const window_highs = all_highs.slice(start, end);
    const window_lows = all_lows.slice(start, end);

    // 如果没有缓存或窗口不连续，重新计算
    if (!this.window_cache ||
        start !== this.window_cache.start_idx + step ||
        end - start !== this.window_cache.end_idx - this.window_cache.start_idx) {

      // 完全重新计算
      const sorted_highs = [...window_highs].sort((a, b) => a - b);
      const sorted_lows = [...window_lows].sort((a, b) => a - b);

      this.window_cache = {
        sorted_highs,
        sorted_lows,
        min_high: sorted_highs[0],
        max_low: sorted_lows[sorted_lows.length - 1],
        total_volume: all_volumes.slice(start, end).reduce((a, b) => a + b, 0),
        start_idx: start,
        end_idx: end
      };
      return;
    }

    // 增量更新: 移除旧数据，添加新数据
    const cache = this.window_cache;

    // 移除滑出窗口的数据点
    for (let i = 0; i < step; i++) {
      const old_idx = cache.start_idx + i;
      const old_high = all_highs[old_idx];
      const old_low = all_lows[old_idx];

      // 从排序数组中移除 (二分查找)
      this.remove_from_sorted(cache.sorted_highs, old_high);
      this.remove_from_sorted(cache.sorted_lows, old_low);

      cache.total_volume -= all_volumes[old_idx];
    }

    // 添加滑入窗口的新数据点
    for (let i = 0; i < step; i++) {
      const new_idx = cache.end_idx + i;
      if (new_idx >= all_highs.length) break;

      const new_high = all_highs[new_idx];
      const new_low = all_lows[new_idx];

      // 插入到排序数组 (二分查找位置)
      this.insert_sorted(cache.sorted_highs, new_high);
      this.insert_sorted(cache.sorted_lows, new_low);

      cache.total_volume += all_volumes[new_idx];
    }

    // 更新最值
    cache.min_high = cache.sorted_highs[0];
    cache.max_low = cache.sorted_lows[cache.sorted_lows.length - 1];
    cache.start_idx = start;
    cache.end_idx = end;
  }

  /**
   * 二分查找并移除元素
   */
  private remove_from_sorted(arr: number[], value: number): void {
    const idx = this.binary_search(arr, value);
    if (idx !== -1) {
      arr.splice(idx, 1);
    }
  }

  /**
   * 二分查找并插入元素
   */
  private insert_sorted(arr: number[], value: number): void {
    let left = 0;
    let right = arr.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (arr[mid] < value) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    arr.splice(left, 0, value);
  }

  /**
   * 二分查找
   */
  private binary_search(arr: number[], value: number): number {
    let left = 0;
    let right = arr.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (arr[mid] === value) {
        return mid;
      } else if (arr[mid] < value) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return -1;
  }

  /**
   * 使用缓存分析窗口 (优化版)
   */
  private analyze_window_cached(window_klines: KlineData[], all_klines: KlineData[]): OverlapRange | null {
    if (window_klines.length < this.config.min_window_size || !this.window_cache) {
      return null;
    }

    const cache = this.window_cache;

    // 使用缓存的排序数组计算百分位数
    const highs = cache.sorted_highs;
    const lows = cache.sorted_lows;

    // 1. 计算重叠区间 (使用缓存的最值)
    const overlap_result = this.find_overlap_zone_cached(window_klines, highs, lows, cache);
    if (!overlap_result) {
      return null;
    }

    const { upper_bound, lower_bound, coverage, strict_overlap } = overlap_result;
    const center_price = (upper_bound + lower_bound) / 2;
    const range_width_pct = ((upper_bound - lower_bound) / center_price) * 100;

    // 2. 计算边界触碰
    const boundary_touches = this.count_boundary_touches(window_klines, upper_bound, lower_bound);

    // 3. 计算成交量特征 (使用缓存的总成交量)
    const volume_profile = this.analyze_volume_cached(window_klines, all_klines, cache);

    // 4. 计算时间信息
    const start_time = window_klines[0].open_time;
    const end_time = window_klines[window_klines.length - 1].close_time;
    const duration_minutes = (end_time - start_time) / 60000;

    // 5. 计算扩展边界 (使用缓存的排序数组)
    const extended_high = this.percentile_from_sorted(highs, 95);
    const extended_low = this.percentile_from_sorted(lows, 5);

    // 6. 计算评分
    const score = this.calculate_score({
      coverage,
      strict_overlap,
      boundary_touches,
      volume_profile,
      kline_count: window_klines.length,
      duration_minutes,
      range_width_pct,
      center_price
    });

    return {
      upper_bound,
      lower_bound,
      center_price,
      range_width_pct,
      kline_coverage: coverage,
      strict_overlap,
      boundary_touches,
      volume_profile,
      start_time,
      end_time,
      kline_count: window_klines.length,
      duration_minutes,
      score,
      extended_high,
      extended_low
    };
  }

  /**
   * 使用缓存查找重叠区域
   */
  private find_overlap_zone_cached(
    klines: KlineData[],
    sorted_highs: number[],
    sorted_lows: number[],
    cache: WindowCache
  ): { upper_bound: number; lower_bound: number; coverage: number; strict_overlap: boolean } | null {

    // 方法1: 尝试严格重叠 (使用缓存的最值)
    const strict_upper = cache.min_high;
    const strict_lower = cache.max_low;

    if (strict_upper > strict_lower) {
      return {
        upper_bound: strict_upper,
        lower_bound: strict_lower,
        coverage: 1.0,
        strict_overlap: true
      };
    }

    // 方法2: 使用覆盖度方法
    const price_min = sorted_lows[0];
    const price_max = sorted_highs[sorted_highs.length - 1];
    const steps = 100;
    const step_size = (price_max - price_min) / steps;

    const coverage_map: { price: number; coverage: number }[] = [];

    for (let i = 0; i <= steps; i++) {
      const price = price_min + i * step_size;
      const covered = klines.filter(k => k.low <= price && k.high >= price).length;
      const coverage = covered / klines.length;
      coverage_map.push({ price, coverage });
    }

    const best = coverage_map.reduce((a, b) => a.coverage > b.coverage ? a : b);

    if (best.coverage >= this.config.min_kline_coverage) {
      const threshold = Math.max(this.config.min_kline_coverage, best.coverage * 0.85);
      const covered_prices = coverage_map.filter(p => p.coverage >= threshold).map(p => p.price);

      if (covered_prices.length > 0) {
        return {
          upper_bound: Math.max(...covered_prices),
          lower_bound: Math.min(...covered_prices),
          coverage: best.coverage,
          strict_overlap: false
        };
      }
    }

    // 方法3: 边界约束法 (使用缓存的排序数组)
    const boundary_result = this.find_boundary_constrained_zone_cached(klines, sorted_highs, sorted_lows);
    if (boundary_result) {
      return boundary_result;
    }

    return null;
  }

  /**
   * 边界约束法 (使用缓存的排序数组)
   */
  private find_boundary_constrained_zone_cached(
    klines: KlineData[],
    sorted_highs: number[],
    sorted_lows: number[]
  ): { upper_bound: number; lower_bound: number; coverage: number; strict_overlap: boolean } | null {

    // 使用缓存的排序数组快速计算百分位数
    const p5_low = this.percentile_from_sorted(sorted_lows, 5);
    const p95_high = this.percentile_from_sorted(sorted_highs, 95);
    const p10_low = this.percentile_from_sorted(sorted_lows, 10);
    const p90_high = this.percentile_from_sorted(sorted_highs, 90);

    const p90_range = p90_high - p10_low;
    const center_price = (p90_high + p10_low) / 2;
    const range_pct = (p90_range / center_price) * 100;

    if (range_pct < 0.5 || range_pct > 3) {
      return null;
    }

    const inside_count = klines.filter(k => k.high <= p95_high && k.low >= p5_low).length;
    const inside_ratio = inside_count / klines.length;

    if (inside_ratio < 0.7) {
      return null;
    }

    const upper_tolerance = p90_range * 0.1;
    const lower_tolerance = p90_range * 0.1;

    let upper_touches = 0;
    let lower_touches = 0;

    for (const kline of klines) {
      if (kline.high >= p90_high - upper_tolerance && kline.high <= p95_high) {
        upper_touches++;
      }
      if (kline.low <= p10_low + lower_tolerance && kline.low >= p5_low) {
        lower_touches++;
      }
    }

    const min_touches = Math.max(5, Math.floor(klines.length * 0.1));
    if (upper_touches < min_touches || lower_touches < min_touches) {
      return null;
    }

    const simulated_coverage = inside_ratio * 0.8;

    return {
      upper_bound: p90_high,
      lower_bound: p10_low,
      coverage: simulated_coverage,
      strict_overlap: false
    };
  }

  /**
   * 从排序数组计算百分位数 (O(1) 复杂度)
   */
  private percentile_from_sorted(sorted: number[], p: number): number {
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);

    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  /**
   * 分析成交量特征 (使用缓存)
   */
  private analyze_volume_cached(
    window_klines: KlineData[],
    all_klines: KlineData[],
    cache: WindowCache
  ): VolumeProfile {
    const total_volume = cache.total_volume;
    const avg_volume = total_volume / window_klines.length;

    const global_avg_volume = all_klines.reduce((sum, k) => sum + k.volume, 0) / all_klines.length;
    const volume_concentration = global_avg_volume > 0 ? avg_volume / global_avg_volume : 1;

    const high_volume_bars = window_klines.filter(k => k.volume > avg_volume * 1.5).length;

    return {
      total_volume,
      avg_volume,
      volume_concentration,
      high_volume_bars
    };
  }

  /**
   * 分析单个窗口 (公开方法，用于外部单独分析)
   * @param window_klines 窗口内的K线数据
   * @param all_klines 全部K线数据 (用于计算成交量集中度)
   */
  analyze_window(window_klines: KlineData[], all_klines?: KlineData[]): OverlapRange | null {
    const reference_klines = all_klines || window_klines;
    if (window_klines.length < this.config.min_window_size) {
      return null;
    }

    const highs = window_klines.map(k => k.high);
    const lows = window_klines.map(k => k.low);

    // 1. 计算重叠区间
    const overlap_result = this.find_overlap_zone(window_klines, highs, lows);
    if (!overlap_result) {
      return null;
    }

    const { upper_bound, lower_bound, coverage, strict_overlap } = overlap_result;
    const center_price = (upper_bound + lower_bound) / 2;
    const range_width_pct = ((upper_bound - lower_bound) / center_price) * 100;

    // 2. 计算边界触碰
    const boundary_touches = this.count_boundary_touches(window_klines, upper_bound, lower_bound);

    // 3. 计算成交量特征
    const volume_profile = this.analyze_volume(window_klines, reference_klines);

    // 4. 计算时间信息
    const start_time = window_klines[0].open_time;
    const end_time = window_klines[window_klines.length - 1].close_time;
    const duration_minutes = (end_time - start_time) / 60000;

    // 5. 计算扩展边界
    const extended_high = this.percentile(highs, 95);
    const extended_low = this.percentile(lows, 5);

    // 6. 计算评分
    const score = this.calculate_score({
      coverage,
      strict_overlap,
      boundary_touches,
      volume_profile,
      kline_count: window_klines.length,
      duration_minutes,
      range_width_pct,
      center_price
    });

    return {
      upper_bound,
      lower_bound,
      center_price,
      range_width_pct,
      kline_coverage: coverage,
      strict_overlap,
      boundary_touches,
      volume_profile,
      start_time,
      end_time,
      kline_count: window_klines.length,
      duration_minutes,
      score,
      extended_high,
      extended_low
    };
  }

  /**
   * 查找重叠区域
   */
  private find_overlap_zone(
    klines: KlineData[],
    highs: number[],
    lows: number[]
  ): { upper_bound: number; lower_bound: number; coverage: number; strict_overlap: boolean } | null {

    // 方法1: 尝试严格重叠
    const strict_upper = Math.min(...highs);
    const strict_lower = Math.max(...lows);

    if (strict_upper > strict_lower) {
      // 存在严格重叠区间
      return {
        upper_bound: strict_upper,
        lower_bound: strict_lower,
        coverage: 1.0,
        strict_overlap: true
      };
    }

    // 方法2: 使用覆盖度方法
    const price_min = Math.min(...lows);
    const price_max = Math.max(...highs);
    const steps = 100;
    const step_size = (price_max - price_min) / steps;

    // 计算每个价格点的覆盖度
    const coverage_map: { price: number; coverage: number }[] = [];

    for (let i = 0; i <= steps; i++) {
      const price = price_min + i * step_size;
      const covered = klines.filter(k => k.low <= price && k.high >= price).length;
      const coverage = covered / klines.length;
      coverage_map.push({ price, coverage });
    }

    // 找出最佳覆盖点
    const best = coverage_map.reduce((a, b) => a.coverage > b.coverage ? a : b);

    if (best.coverage >= this.config.min_kline_coverage) {
      // 找出覆盖度超过阈值的连续区域
      const threshold = Math.max(this.config.min_kline_coverage, best.coverage * 0.85);
      const covered_prices = coverage_map.filter(p => p.coverage >= threshold).map(p => p.price);

      if (covered_prices.length > 0) {
        return {
          upper_bound: Math.max(...covered_prices),
          lower_bound: Math.min(...covered_prices),
          coverage: best.coverage,
          strict_overlap: false
        };
      }
    }

    // 方法3: 边界约束法 - 检测「宽幅震荡区间」
    // 特点: 价格被上下边界约束，但单根K线振幅大，覆盖度不高
    const boundary_result = this.find_boundary_constrained_zone(klines, highs, lows);
    if (boundary_result) {
      return boundary_result;
    }

    return null;
  }

  /**
   * 边界约束法 - 检测宽幅震荡区间
   * 特点: 价格在一定范围内反复震荡，虽然覆盖度不高，但边界稳定
   */
  private find_boundary_constrained_zone(
    klines: KlineData[],
    highs: number[],
    lows: number[]
  ): { upper_bound: number; lower_bound: number; coverage: number; strict_overlap: boolean } | null {

    // 使用百分位数确定区间边界 (排除极端值)
    const p5_low = this.percentile(lows, 5);
    const p95_high = this.percentile(highs, 95);
    const p10_low = this.percentile(lows, 10);
    const p90_high = this.percentile(highs, 90);

    // 计算价格范围
    const p90_range = p90_high - p10_low;
    const center_price = (p90_high + p10_low) / 2;

    // 区间宽度百分比
    const range_pct = (p90_range / center_price) * 100;

    // 条件: 区间宽度在合理范围内 (0.5% - 3%)
    if (range_pct < 0.5 || range_pct > 3) {
      return null;
    }

    // 计算有多少K线「完全在区间内」(高低点都在边界内)
    const inside_count = klines.filter(k => k.high <= p95_high && k.low >= p5_low).length;
    const inside_ratio = inside_count / klines.length;

    // 条件: 至少70%的K线在区间内
    if (inside_ratio < 0.7) {
      return null;
    }

    // 计算边界触碰次数 (作为额外验证)
    const upper_tolerance = p90_range * 0.1;
    const lower_tolerance = p90_range * 0.1;

    let upper_touches = 0;
    let lower_touches = 0;

    for (const kline of klines) {
      if (kline.high >= p90_high - upper_tolerance && kline.high <= p95_high) {
        upper_touches++;
      }
      if (kline.low <= p10_low + lower_tolerance && kline.low >= p5_low) {
        lower_touches++;
      }
    }

    // 条件: 上下沿都有足够的触碰 (至少各5次或10%的K线)
    const min_touches = Math.max(5, Math.floor(klines.length * 0.1));
    if (upper_touches < min_touches || lower_touches < min_touches) {
      return null;
    }

    // 计算「模拟覆盖度」: 基于边界内K线比例
    const simulated_coverage = inside_ratio * 0.8; // 打8折，因为不是真正的重叠

    return {
      upper_bound: p90_high,
      lower_bound: p10_low,
      coverage: simulated_coverage,
      strict_overlap: false
    };
  }

  /**
   * 统计边界触碰次数
   */
  private count_boundary_touches(
    klines: KlineData[],
    upper_bound: number,
    lower_bound: number
  ): BoundaryTouches {
    const tolerance = (upper_bound - lower_bound) * (this.config.touch_tolerance_pct / 100);
    const upper_zone_low = upper_bound - tolerance;
    const lower_zone_high = lower_bound + tolerance;

    let upper_touches = 0;
    let lower_touches = 0;
    let in_upper_zone = false;
    let in_lower_zone = false;

    for (const kline of klines) {
      // 检测上沿触碰 (K线高点进入上沿区域)
      const touches_upper = kline.high >= upper_zone_low && kline.high <= upper_bound * 1.005;
      if (touches_upper && !in_upper_zone) {
        upper_touches++;
        in_upper_zone = true;
      } else if (!touches_upper) {
        in_upper_zone = false;
      }

      // 检测下沿触碰 (K线低点进入下沿区域)
      const touches_lower = kline.low <= lower_zone_high && kline.low >= lower_bound * 0.995;
      if (touches_lower && !in_lower_zone) {
        lower_touches++;
        in_lower_zone = true;
      } else if (!touches_lower) {
        in_lower_zone = false;
      }
    }

    const total_touches = upper_touches + lower_touches;
    const balance_ratio = total_touches > 0
      ? Math.min(upper_touches, lower_touches) / Math.max(upper_touches, lower_touches, 1)
      : 0;

    return {
      upper_touches,
      lower_touches,
      total_touches,
      balance_ratio
    };
  }

  /**
   * 分析成交量特征
   */
  private analyze_volume(window_klines: KlineData[], all_klines: KlineData[]): VolumeProfile {
    const window_volumes = window_klines.map(k => k.volume);
    const total_volume = window_volumes.reduce((a, b) => a + b, 0);
    const avg_volume = total_volume / window_klines.length;

    // 计算全局平均成交量
    const global_avg_volume = all_klines.reduce((sum, k) => sum + k.volume, 0) / all_klines.length;

    // 成交量集中度: 区间内平均成交量 / 全局平均成交量
    const volume_concentration = global_avg_volume > 0 ? avg_volume / global_avg_volume : 1;

    // 放量K线数量 (成交量 > 1.5倍平均)
    const high_volume_bars = window_volumes.filter(v => v > avg_volume * 1.5).length;

    return {
      total_volume,
      avg_volume,
      volume_concentration,
      high_volume_bars
    };
  }

  /**
   * 计算综合评分
   */
  private calculate_score(params: {
    coverage: number;
    strict_overlap: boolean;
    boundary_touches: BoundaryTouches;
    volume_profile: VolumeProfile;
    kline_count: number;
    duration_minutes: number;
    range_width_pct: number;
    center_price: number;
  }): ScoreBreakdown {

    // ========== 1. 重叠度得分 (0-30分) ==========
    // 严格重叠: 30分
    // 覆盖度 >= 90%: 27分
    // 覆盖度 >= 80%: 24分
    // 覆盖度 >= 70%: 20分
    // 覆盖度 >= 60%: 15分
    let overlap_score = 0;
    if (params.strict_overlap) {
      overlap_score = 30;
    } else if (params.coverage >= 0.9) {
      overlap_score = 27;
    } else if (params.coverage >= 0.8) {
      overlap_score = 24;
    } else if (params.coverage >= 0.7) {
      overlap_score = 20;
    } else if (params.coverage >= 0.6) {
      overlap_score = 15;
    } else {
      overlap_score = params.coverage * 25;
    }

    // ========== 2. 边界触碰得分 (0-25分) ==========
    // 总触碰次数: 最高15分 (每次1.5分，上限10次)
    // 平衡度: 最高10分 (上下触碰均衡)
    const touch_count_score = Math.min(15, params.boundary_touches.total_touches * 1.5);
    const touch_balance_score = params.boundary_touches.balance_ratio * 10;
    const touch_score = touch_count_score + touch_balance_score;

    // ========== 3. 持续时间得分 (0-30分) ==========
    // K线数量: 最高20分 (30根起步，每多10根+2分，上限100根)
    // 时间跨度: 最高10分 (150分钟起步，每多60分钟+2分)
    let kline_score = 0;
    if (params.kline_count >= 30) {
      kline_score = Math.min(20, 6 + (params.kline_count - 30) / 10 * 2);
    } else if (params.kline_count >= 20) {
      kline_score = 3;
    } else {
      kline_score = 0;  // 不足20根不得分
    }

    let time_score = 0;
    if (params.duration_minutes >= 150) {
      time_score = Math.min(10, 4 + (params.duration_minutes - 150) / 60 * 2);
    } else if (params.duration_minutes >= 100) {
      time_score = 2;
    }

    const duration_score = kline_score + time_score;

    // ========== 4. 成交量得分 (0-15分) ==========
    // 成交量集中度: 最高10分 (1.0为基准，越高越好，但不超过2.0)
    // 放量K线占比: 最高5分
    let concentration_score = 0;
    if (params.volume_profile.volume_concentration >= 1.5) {
      concentration_score = 10;
    } else if (params.volume_profile.volume_concentration >= 1.2) {
      concentration_score = 8;
    } else if (params.volume_profile.volume_concentration >= 1.0) {
      concentration_score = 6;
    } else if (params.volume_profile.volume_concentration >= 0.8) {
      concentration_score = 4;
    } else {
      concentration_score = params.volume_profile.volume_concentration * 5;
    }

    const high_vol_ratio = params.volume_profile.high_volume_bars / params.kline_count;
    const high_vol_score = Math.min(5, high_vol_ratio * 20);

    const volume_score = concentration_score + high_vol_score;

    // ========== 5. 形态得分 (0-10分) ==========
    // 区间宽度合理性: 0.3% - 3% 最佳
    let shape_score = 0;
    if (params.range_width_pct >= 0.3 && params.range_width_pct <= 3) {
      shape_score = 10;
    } else if (params.range_width_pct >= 0.1 && params.range_width_pct <= 5) {
      shape_score = 7;
    } else if (params.range_width_pct < 0.1) {
      shape_score = params.range_width_pct * 50; // 太窄扣分
    } else {
      shape_score = Math.max(0, 10 - (params.range_width_pct - 5) * 2); // 太宽扣分
    }

    // ========== 总分 ==========
    const total_score = Math.round(
      overlap_score + touch_score + duration_score + volume_score + shape_score
    );

    return {
      overlap_score: Math.round(overlap_score),
      touch_score: Math.round(touch_score),
      duration_score: Math.round(duration_score),
      volume_score: Math.round(volume_score),
      shape_score: Math.round(shape_score),
      total_score: Math.min(100, total_score)
    };
  }

  /**
   * 合并重叠的区间
   */
  private merge_overlapping_ranges(ranges: OverlapRange[]): OverlapRange[] {
    if (ranges.length <= 1) {
      return ranges;
    }

    // 按开始时间排序
    const sorted = [...ranges].sort((a, b) => a.start_time - b.start_time);

    // 第一轮: 去重 - 移除被完全包含的低分区间
    const deduplicated = this.remove_contained_ranges(sorted);

    // 第二轮: 合并相邻的同价格区域区间
    const merged: OverlapRange[] = [];
    let current = deduplicated[0];

    for (let i = 1; i < deduplicated.length; i++) {
      const next = deduplicated[i];

      // 检查是否应该合并
      if (this.should_merge(current, next)) {
        // 保留分数更高的那个，但扩展时间范围
        if (next.score.total_score > current.score.total_score) {
          current = this.extend_range(next, current);
        } else {
          current = this.extend_range(current, next);
        }
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    // 第三轮: 再次去重，保留每个时间段的最高分区间
    return this.select_best_non_overlapping(merged);
  }

  /**
   * 移除被完全包含的区间（价格维度）
   * 当一个区间的价格范围完全在另一个区间内时，只保留其中一个
   */
  private remove_contained_ranges(ranges: OverlapRange[]): OverlapRange[] {
    const result: OverlapRange[] = [];
    const removed = new Set<number>();

    for (let i = 0; i < ranges.length; i++) {
      if (removed.has(i)) continue;

      const current = ranges[i];

      for (let j = i + 1; j < ranges.length; j++) {
        if (removed.has(j)) continue;

        const other = ranges[j];

        // 检查价格包含关系（任一方向）
        // current 包含 other
        const current_contains_other =
          current.lower_bound <= other.lower_bound * 1.002 &&
          current.upper_bound >= other.upper_bound * 0.998;

        // other 包含 current
        const other_contains_current =
          other.lower_bound <= current.lower_bound * 1.002 &&
          other.upper_bound >= current.upper_bound * 0.998;

        if (current_contains_other || other_contains_current) {
          // 有包含关系，保留分数更高的那个
          if (current.score.total_score >= other.score.total_score) {
            removed.add(j);
          } else {
            removed.add(i);
            break;  // current 被移除，跳出内层循环
          }
        }
      }
    }

    for (let i = 0; i < ranges.length; i++) {
      if (!removed.has(i)) {
        result.push(ranges[i]);
      }
    }

    return result;
  }

  /**
   * 选择非重叠的最佳区间
   * 当两个区间有显著时间重叠时，保留得分更高的那个
   */
  private select_best_non_overlapping(ranges: OverlapRange[]): OverlapRange[] {
    if (ranges.length <= 1) return ranges;

    // 按分数降序排列
    const sorted_by_score = [...ranges].sort((a, b) => b.score.total_score - a.score.total_score);
    const selected: OverlapRange[] = [];

    for (const range of sorted_by_score) {
      // 检查是否与已选区间有显著时间重叠
      let has_significant_overlap = false;

      for (const selected_range of selected) {
        const time_overlap = this.calculate_time_overlap(range, selected_range);

        // 如果时间重叠超过60%，认为是重复区间
        if (time_overlap > 0.6) {
          has_significant_overlap = true;
          break;
        }
      }

      if (!has_significant_overlap) {
        selected.push(range);
      }
    }

    // 按时间排序返回
    return selected.sort((a, b) => a.start_time - b.start_time);
  }

  /**
   * 判断两个区间是否应该合并
   * 更严格的合并条件，避免合并不相关的区间
   */
  private should_merge(r1: OverlapRange, r2: OverlapRange): boolean {
    // 1. 价格重叠检查 (必须有足够的价格重叠)
    const price_overlap = this.calculate_price_overlap(r1, r2);
    if (price_overlap < 0.7) {
      // 价格重叠不足70%，不合并
      return false;
    }

    // 2. 时间重叠检查
    const time_overlap = this.calculate_time_overlap(r1, r2);
    if (time_overlap > 0.5) {
      // 时间重叠超过50%，且价格重叠足够，合并
      return true;
    }

    // 3. 时间间隔检查 (如果时间不重叠)
    const time_gap = Math.abs(r2.start_time - r1.end_time);
    const bar_duration = (r1.end_time - r1.start_time) / r1.kline_count;
    const gap_bars = time_gap / bar_duration;

    // 时间间隔必须在3根K线以内 (更严格)
    if (gap_bars <= Math.min(3, this.config.merge_time_gap_bars)) {
      // 额外检查：中心价格差异不能太大
      const center_diff_pct = Math.abs(r1.center_price - r2.center_price) / r1.center_price * 100;
      if (center_diff_pct <= this.config.merge_price_tolerance) {
        return true;
      }
    }

    return false;
  }

  /**
   * 计算时间重叠度
   */
  private calculate_time_overlap(r1: OverlapRange, r2: OverlapRange): number {
    const overlap_start = Math.max(r1.start_time, r2.start_time);
    const overlap_end = Math.min(r1.end_time, r2.end_time);

    if (overlap_end <= overlap_start) return 0;

    const overlap_duration = overlap_end - overlap_start;
    const min_duration = Math.min(r1.end_time - r1.start_time, r2.end_time - r2.start_time);

    return overlap_duration / min_duration;
  }

  /**
   * 计算价格重叠度
   */
  private calculate_price_overlap(r1: OverlapRange, r2: OverlapRange): number {
    const overlap_upper = Math.min(r1.upper_bound, r2.upper_bound);
    const overlap_lower = Math.max(r1.lower_bound, r2.lower_bound);

    if (overlap_upper <= overlap_lower) return 0;

    const overlap_width = overlap_upper - overlap_lower;
    const min_width = Math.min(
      r1.upper_bound - r1.lower_bound,
      r2.upper_bound - r2.lower_bound
    );

    return overlap_width / min_width;
  }

  /**
   * 扩展区间时间范围
   */
  private extend_range(primary: OverlapRange, secondary: OverlapRange): OverlapRange {
    return {
      ...primary,
      start_time: Math.min(primary.start_time, secondary.start_time),
      end_time: Math.max(primary.end_time, secondary.end_time),
      kline_count: primary.kline_count + Math.round(
        (Math.max(primary.end_time, secondary.end_time) - Math.min(primary.start_time, secondary.start_time)) /
        ((primary.end_time - primary.start_time) / primary.kline_count)
      ) - primary.kline_count
    };
  }

  /**
   * 检测突破 (增强版 - 多维度确认)
   * @param range 区间
   * @param current_kline 当前K线
   * @param prev_klines 前N根K线 (用于计算平均成交量和连续确认)
   * @param next_klines 后续K线 (可选，用于持续性确认)
   */
  detect_breakout(
    range: OverlapRange,
    current_kline: KlineData,
    prev_klines: KlineData[],
    next_klines: KlineData[] = []
  ): OverlapBreakout | null {
    const config = this.config.breakout_confirm;
    const range_width = range.upper_bound - range.lower_bound;
    const threshold = range_width * config.min_breakout_pct;

    // 检测突破方向
    let direction: 'UP' | 'DOWN' | null = null;
    let breakout_price = 0;
    let breakout_pct = 0;

    if (current_kline.close > range.extended_high + threshold) {
      direction = 'UP';
      breakout_price = current_kline.close;
      breakout_pct = ((current_kline.close - range.extended_high) / range.extended_high) * 100;
    } else if (current_kline.close < range.extended_low - threshold) {
      direction = 'DOWN';
      breakout_price = current_kline.close;
      breakout_pct = ((range.extended_low - current_kline.close) / range.extended_low) * 100;
    }

    if (!direction) {
      return null;
    }

    // ========== 1. 幅度确认 ==========
    const amplitude_pct = (Math.abs(
      direction === 'UP'
        ? current_kline.close - range.extended_high
        : range.extended_low - current_kline.close
    ) / range_width) * 100;
    const amplitude_confirmed = amplitude_pct >= config.min_breakout_pct * 100;

    // ========== 2. 成交量确认 ==========
    const lookback = Math.min(config.volume_lookback, prev_klines.length);
    const lookback_klines = prev_klines.slice(-lookback);
    const avg_volume = lookback_klines.length > 0
      ? lookback_klines.reduce((sum, k) => sum + k.volume, 0) / lookback_klines.length
      : current_kline.volume;
    const volume_ratio = current_kline.volume / avg_volume;
    const volume_confirmed = volume_ratio >= config.volume_multiplier;

    // ========== 3. 连续K线确认 ==========
    const confirm_klines = [current_kline, ...next_klines.slice(0, config.confirm_bars - 1)];
    let confirming_bars = 0;

    for (const k of confirm_klines) {
      if (direction === 'UP' && k.close > range.extended_high) {
        confirming_bars++;
      } else if (direction === 'DOWN' && k.close < range.extended_low) {
        confirming_bars++;
      }
    }

    const bars_confirmed = confirming_bars >= Math.ceil(config.confirm_bars * config.confirm_close_ratio);

    // ========== 4. 持续性确认 ==========
    let persistence_confirmed = false;
    let max_retracement_pct = 0;

    if (next_klines.length >= config.persistence_bars) {
      const check_klines = next_klines.slice(0, config.persistence_bars);
      const breakout_distance = direction === 'UP'
        ? current_kline.close - range.extended_high
        : range.extended_low - current_kline.close;

      let max_retracement = 0;
      for (const k of check_klines) {
        const retracement = direction === 'UP'
          ? Math.max(0, current_kline.close - k.low)
          : Math.max(0, k.high - current_kline.close);
        max_retracement = Math.max(max_retracement, retracement);
      }

      max_retracement_pct = breakout_distance > 0 ? (max_retracement / breakout_distance) * 100 : 0;
      persistence_confirmed = max_retracement_pct <= config.persistence_threshold * 100;
    }

    // ========== 5. 计算综合确认得分 ==========
    let confirmation_score = 0;

    // 幅度得分 (0-30分)
    if (amplitude_confirmed) {
      confirmation_score += Math.min(30, amplitude_pct * 10);
    } else {
      confirmation_score += amplitude_pct * 5;
    }

    // 成交量得分 (0-30分)
    if (volume_confirmed) {
      confirmation_score += Math.min(30, (volume_ratio - 1) * 20 + 15);
    } else {
      confirmation_score += Math.min(15, volume_ratio * 10);
    }

    // 连续K线得分 (0-20分)
    confirmation_score += (confirming_bars / config.confirm_bars) * 20;

    // 持续性得分 (0-20分)
    if (next_klines.length >= config.persistence_bars) {
      if (persistence_confirmed) {
        confirmation_score += 20;
      } else {
        confirmation_score += Math.max(0, 20 - max_retracement_pct * 0.4);
      }
    }

    confirmation_score = Math.round(Math.min(100, confirmation_score));

    // ========== 构建确认信息 ==========
    const confirmation: BreakoutConfirmation = {
      amplitude_confirmed,
      amplitude_pct,
      bars_confirmed,
      confirming_bars,
      total_confirm_bars: confirm_klines.length,
      volume_confirmed,
      volume_ratio,
      avg_volume_lookback: lookback,
      persistence_confirmed,
      max_retracement_pct,
      confirmation_score,
      is_strong_breakout: confirmation_score >= 70
    };

    // 综合判断是否确认
    const is_confirmed = amplitude_confirmed && volume_confirmed && bars_confirmed;

    return {
      direction,
      breakout_price,
      breakout_time: current_kline.open_time,
      range,
      breakout_pct,
      volume_ratio,
      is_confirmed,
      confirmation
    };
  }

  /**
   * 简化版突破检测 (兼容旧接口)
   */
  detect_breakout_simple(
    range: OverlapRange,
    current_kline: KlineData,
    prev_klines: KlineData[]
  ): OverlapBreakout | null {
    return this.detect_breakout(range, current_kline, prev_klines, []);
  }

  /**
   * 更新突破持续性确认 (当有新K线到来时调用)
   */
  update_breakout_persistence(
    breakout: OverlapBreakout,
    new_klines: KlineData[]
  ): BreakoutConfirmation | null {
    if (!breakout.confirmation) {
      return null;
    }

    const config = this.config.breakout_confirm;
    const check_klines = new_klines.slice(0, config.persistence_bars);

    if (check_klines.length === 0) {
      return breakout.confirmation;
    }

    const breakout_distance = breakout.direction === 'UP'
      ? breakout.breakout_price - breakout.range.extended_high
      : breakout.range.extended_low - breakout.breakout_price;

    let max_retracement = 0;
    for (const k of check_klines) {
      const retracement = breakout.direction === 'UP'
        ? Math.max(0, breakout.breakout_price - k.low)
        : Math.max(0, k.high - breakout.breakout_price);
      max_retracement = Math.max(max_retracement, retracement);
    }

    const max_retracement_pct = breakout_distance > 0 ? (max_retracement / breakout_distance) * 100 : 0;
    const persistence_confirmed = max_retracement_pct <= config.persistence_threshold * 100;

    // 重新计算综合得分
    let confirmation_score = breakout.confirmation.confirmation_score;

    // 更新持续性得分部分 (原本没有计入持续性，现在补上)
    if (persistence_confirmed) {
      confirmation_score = Math.min(100, confirmation_score + 10);
    } else {
      confirmation_score = Math.max(0, confirmation_score - max_retracement_pct * 0.2);
    }

    return {
      ...breakout.confirmation,
      persistence_confirmed,
      max_retracement_pct,
      confirmation_score: Math.round(confirmation_score),
      is_strong_breakout: confirmation_score >= 70
    };
  }

  /**
   * 判断假突破
   */
  is_fake_breakout(breakout: OverlapBreakout, next_klines: KlineData[]): boolean {
    if (next_klines.length === 0) return false;

    const check_klines = next_klines.slice(0, 3); // 检查后3根K线

    if (breakout.direction === 'UP') {
      // 如果后续K线回到区间内，判定为假突破
      return check_klines.some(k => k.close <= breakout.range.upper_bound);
    } else {
      return check_klines.some(k => k.close >= breakout.range.lower_bound);
    }
  }

  // ========== 趋势检测 ==========

  /**
   * 分析窗口内的趋势特征
   * 使用线性回归和价格变化来判断是否存在明显趋势
   */
  analyze_trend(klines: KlineData[]): TrendAnalysis {
    if (klines.length < 3) {
      return {
        is_trending: false,
        trend_direction: 'SIDEWAYS',
        trend_strength: 0,
        slope_per_bar: 0,
        r_squared: 0,
        price_change_pct: 0
      };
    }

    // 使用收盘价中点进行趋势分析
    const prices = klines.map(k => (k.high + k.low) / 2);
    const n = prices.length;

    // 计算线性回归 y = ax + b
    // a = (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
    // b = (Σy - a*Σx) / n
    let sum_x = 0;
    let sum_y = 0;
    let sum_xy = 0;
    let sum_xx = 0;

    for (let i = 0; i < n; i++) {
      sum_x += i;
      sum_y += prices[i];
      sum_xy += i * prices[i];
      sum_xx += i * i;
    }

    const denominator = n * sum_xx - sum_x * sum_x;
    if (denominator === 0) {
      return {
        is_trending: false,
        trend_direction: 'SIDEWAYS',
        trend_strength: 0,
        slope_per_bar: 0,
        r_squared: 0,
        price_change_pct: 0
      };
    }

    const slope = (n * sum_xy - sum_x * sum_y) / denominator;
    const intercept = (sum_y - slope * sum_x) / n;

    // 计算R² (决定系数)
    const mean_y = sum_y / n;
    let ss_tot = 0;  // 总平方和
    let ss_res = 0;  // 残差平方和

    for (let i = 0; i < n; i++) {
      const predicted = slope * i + intercept;
      ss_tot += (prices[i] - mean_y) ** 2;
      ss_res += (prices[i] - predicted) ** 2;
    }

    const r_squared = ss_tot > 0 ? 1 - (ss_res / ss_tot) : 0;

    // 计算价格变化百分比
    const start_price = prices[0];
    const end_price = prices[n - 1];
    const price_change_pct = Math.abs((end_price - start_price) / start_price) * 100;

    // 每根K线的斜率百分比
    const avg_price = sum_y / n;
    const slope_per_bar_pct = Math.abs(slope / avg_price) * 100;

    // 判断趋势方向
    let trend_direction: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';
    if (slope > 0) {
      trend_direction = 'UP';
    } else if (slope < 0) {
      trend_direction = 'DOWN';
    }

    // 综合判断是否有趋势
    const config = this.config.trend_filter;
    const is_trending = config.enabled && (
      r_squared >= config.min_r_squared &&
      price_change_pct >= config.min_price_change_pct &&
      slope_per_bar_pct >= config.min_slope_per_bar_pct
    );

    // 趋势强度 (0-1)
    const trend_strength = Math.min(1, (
      (r_squared * 0.4) +
      (Math.min(price_change_pct / 5, 1) * 0.3) +
      (Math.min(slope_per_bar_pct / 0.1, 1) * 0.3)
    ));

    return {
      is_trending,
      trend_direction,
      trend_strength,
      slope_per_bar: slope,
      r_squared,
      price_change_pct
    };
  }

  /**
   * 检测数据中的价格跳空/断裂点
   * 返回分割点的索引数组
   */
  private detect_price_gaps(klines: KlineData[]): number[] {
    if (!this.config.segment_split.enabled || klines.length < 2) {
      return [];
    }

    const gap_indices: number[] = [];
    const config = this.config.segment_split;

    for (let i = 1; i < klines.length; i++) {
      const prev = klines[i - 1];
      const curr = klines[i];

      // 检测价格跳空
      const gap_up = curr.low > prev.high;
      const gap_down = curr.high < prev.low;

      if (gap_up || gap_down) {
        const gap_size = gap_up
          ? curr.low - prev.high
          : prev.low - curr.high;
        const avg_price = (prev.close + curr.open) / 2;
        const gap_pct = (gap_size / avg_price) * 100;

        if (gap_pct >= config.price_gap_pct) {
          gap_indices.push(i);
        }
      }

      // 检测价格剧烈变化 (非跳空但价格变化很大)
      const price_change = Math.abs(curr.close - prev.close);
      const change_pct = (price_change / prev.close) * 100;
      if (change_pct >= config.price_gap_pct * 1.5) {
        if (!gap_indices.includes(i)) {
          gap_indices.push(i);
        }
      }
    }

    return gap_indices;
  }

  /**
   * 根据分割点将K线数据分段
   */
  private split_klines_by_gaps(klines: KlineData[], gap_indices: number[]): KlineData[][] {
    if (gap_indices.length === 0) {
      return [klines];
    }

    const segments: KlineData[][] = [];
    let start = 0;

    for (const gap_idx of gap_indices) {
      if (gap_idx > start) {
        segments.push(klines.slice(start, gap_idx));
      }
      start = gap_idx;
    }

    // 添加最后一段
    if (start < klines.length) {
      segments.push(klines.slice(start));
    }

    // 过滤掉太短的段
    return segments.filter(seg => seg.length >= this.config.min_window_size);
  }

  // ========== 工具函数 ==========

  private percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);

    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  update_config(config: Partial<OverlapRangeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get_config(): OverlapRangeConfig {
    return { ...this.config };
  }

  /**
   * 格式化区间信息 (用于日志输出)
   */
  format_range(range: OverlapRange): string {
    const start = new Date(range.start_time).toISOString().slice(11, 16);
    const end = new Date(range.end_time).toISOString().slice(11, 16);

    return [
      `时间: ${start} - ${end} (${range.kline_count}根K线, ${range.duration_minutes.toFixed(0)}分钟)`,
      `区间: ${range.lower_bound.toFixed(5)} - ${range.upper_bound.toFixed(5)} (${range.range_width_pct.toFixed(2)}%)`,
      `覆盖度: ${(range.kline_coverage * 100).toFixed(1)}% ${range.strict_overlap ? '(严格重叠)' : ''}`,
      `触碰: 上沿${range.boundary_touches.upper_touches}次, 下沿${range.boundary_touches.lower_touches}次, 平衡度${(range.boundary_touches.balance_ratio * 100).toFixed(0)}%`,
      `成交量: 集中度${range.volume_profile.volume_concentration.toFixed(2)}, 放量K线${range.volume_profile.high_volume_bars}根`,
      `评分: 总分${range.score.total_score} (重叠${range.score.overlap_score}+触碰${range.score.touch_score}+时长${range.score.duration_score}+量能${range.score.volume_score}+形态${range.score.shape_score})`
    ].join('\n');
  }

  /**
   * 格式化突破信息 (用于日志输出)
   */
  format_breakout(breakout: OverlapBreakout): string {
    const time = new Date(breakout.breakout_time).toISOString().slice(11, 19);
    const direction_text = breakout.direction === 'UP' ? '向上突破 ↑' : '向下突破 ↓';

    const lines = [
      `${direction_text} @ ${time}`,
      `突破价格: ${breakout.breakout_price.toFixed(5)} (${breakout.breakout_pct.toFixed(2)}%)`,
      `成交量倍数: ${breakout.volume_ratio.toFixed(2)}x`,
      `是否确认: ${breakout.is_confirmed ? '✓ 已确认' : '✗ 未确认'}`
    ];

    if (breakout.confirmation) {
      const c = breakout.confirmation;
      lines.push('--- 确认详情 ---');
      lines.push(`幅度: ${c.amplitude_pct.toFixed(1)}% ${c.amplitude_confirmed ? '✓' : '✗'}`);
      lines.push(`成交量: ${c.volume_ratio.toFixed(2)}x (回看${c.avg_volume_lookback}根) ${c.volume_confirmed ? '✓' : '✗'}`);
      lines.push(`连续K线: ${c.confirming_bars}/${c.total_confirm_bars} ${c.bars_confirmed ? '✓' : '✗'}`);
      lines.push(`持续性: 最大回撤${c.max_retracement_pct.toFixed(1)}% ${c.persistence_confirmed ? '✓' : '✗'}`);
      lines.push(`确认得分: ${c.confirmation_score}分 ${c.is_strong_breakout ? '【强势突破】' : ''}`);
    }

    return lines.join('\n');
  }
}
