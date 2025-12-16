/**
 * 窄幅震荡区间检测算法 v1
 *
 * 专门识别像 BRUSDT 05:10-08:55 这样的典型横盘区间:
 * - 价格在狭窄范围内反复震荡
 * - 收盘价高度聚集 (变异系数 < 0.5%)
 * - 多次触碰上下边界后回归
 * - 能识别假突破 vs 真突破
 *
 * 核心思路:
 * 1. 滑动窗口扫描，寻找波动率收敛的区域
 * 2. 使用百分位数确定区间边界 (更稳健)
 * 3. 边界触碰次数验证区间有效性
 * 4. 突破确认需要收盘价+后续K线验证
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

// 窄幅区间结果
export interface TightRange {
  upper_bound: number;        // 区间上沿 (P95 of highs)
  lower_bound: number;        // 区间下沿 (P5 of lows)
  center_price: number;       // 区间中心 (收盘价均值)
  range_width_pct: number;    // 区间宽度百分比

  // 统计特征
  close_std_dev: number;      // 收盘价标准差
  close_cv: number;           // 收盘价变异系数 (std/mean)
  atr: number;                // ATR
  range_atr_ratio: number;    // 区间宽度/ATR 比值

  // 边界触碰
  upper_touches: number;      // 上沿触碰次数
  lower_touches: number;      // 下沿触碰次数

  // 时间信息
  start_time: number;
  end_time: number;
  kline_count: number;

  // 质量评分
  quality_score: number;      // 0-100 区间质量评分
}

// 突破信号
export interface RangeBreakout {
  direction: 'UP' | 'DOWN';
  breakout_price: number;     // 突破价格 (收盘价)
  breakout_time: number;      // 突破时间
  range: TightRange;          // 被突破的区间

  // 突破特征
  breakout_pct: number;       // 突破幅度 (超出边界的百分比)
  is_confirmed: boolean;      // 是否已确认 (需要下一根K线验证)
  volume_ratio: number;       // 成交量比率
}

// 配置
export interface TightRangeConfig {
  // 窗口设置
  min_window_size: number;    // 最小窗口大小 (K线数)，默认20
  max_window_size: number;    // 最大窗口大小，默认60

  // 区间识别条件
  max_range_width_pct: number;  // 最大区间宽度百分比，默认2%
  max_close_cv: number;         // 最大收盘价变异系数，默认0.5%
  min_touches: number;          // 最小边界触碰次数 (上+下)，默认4

  // 边界计算
  upper_percentile: number;   // 上沿百分位，默认95
  lower_percentile: number;   // 下沿百分位，默认5
  touch_tolerance_pct: number; // 触碰容差百分比，默认0.15%

  // 突破确认
  min_breakout_pct: number;   // 最小突破幅度百分比，默认0.2%
  confirm_bars: number;       // 确认需要的K线数，默认1
}

const DEFAULT_CONFIG: TightRangeConfig = {
  min_window_size: 20,
  max_window_size: 60,
  max_range_width_pct: 2.0,
  max_close_cv: 0.5,
  min_touches: 4,
  upper_percentile: 95,
  lower_percentile: 5,
  touch_tolerance_pct: 0.15,
  min_breakout_pct: 0.2,
  confirm_bars: 1
};

export class TightRangeDetector {
  private config: TightRangeConfig;

  constructor(config?: Partial<TightRangeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测窄幅震荡区间
   * @param klines K线数据 (时间升序)
   * @returns 识别到的区间，按质量评分降序
   */
  detect_ranges(klines: KlineData[]): TightRange[] {
    if (klines.length < this.config.min_window_size) {
      return [];
    }

    const ranges: TightRange[] = [];

    // 滑动窗口扫描
    for (let window_size = this.config.min_window_size;
         window_size <= Math.min(this.config.max_window_size, klines.length);
         window_size += 5) {

      for (let start = 0; start <= klines.length - window_size; start += 5) {
        const window_klines = klines.slice(start, start + window_size);
        const range = this.analyze_window(window_klines);

        if (range && range.quality_score >= 60) {
          // 检查是否与已有区间重叠
          const overlaps = ranges.some(r => this.ranges_overlap(r, range));
          if (!overlaps) {
            ranges.push(range);
          } else {
            // 如果重叠，保留质量更高的
            const idx = ranges.findIndex(r => this.ranges_overlap(r, range));
            if (idx >= 0 && range.quality_score > ranges[idx].quality_score) {
              ranges[idx] = range;
            }
          }
        }
      }
    }

    // 按质量评分降序排序
    return ranges.sort((a, b) => b.quality_score - a.quality_score);
  }

  /**
   * 分析单个窗口是否形成有效区间
   */
  private analyze_window(klines: KlineData[]): TightRange | null {
    if (klines.length < this.config.min_window_size) {
      return null;
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);

    // 1. 计算基础统计
    const center_price = this.mean(closes);
    const close_std_dev = this.std_dev(closes);
    const close_cv = (close_std_dev / center_price) * 100;

    // 2. 使用百分位数计算边界 (更稳健，避免异常值影响)
    const upper_bound = this.percentile(highs, this.config.upper_percentile);
    const lower_bound = this.percentile(lows, this.config.lower_percentile);
    const range_width_pct = ((upper_bound - lower_bound) / center_price) * 100;

    // 3. 计算 ATR
    const atr = this.calculate_atr(klines);
    const range_atr_ratio = (upper_bound - lower_bound) / atr;

    // 4. 检查是否满足窄幅条件
    if (range_width_pct > this.config.max_range_width_pct) {
      return null;
    }
    if (close_cv > this.config.max_close_cv) {
      return null;
    }

    // 5. 计算边界触碰次数
    const touch_tolerance = center_price * (this.config.touch_tolerance_pct / 100);
    const { upper_touches, lower_touches } = this.count_touches(
      klines, upper_bound, lower_bound, touch_tolerance
    );

    // 6. 检查触碰次数
    if (upper_touches + lower_touches < this.config.min_touches) {
      return null;
    }

    // 7. 计算质量评分
    const quality_score = this.calculate_quality_score({
      close_cv,
      range_width_pct,
      upper_touches,
      lower_touches,
      range_atr_ratio,
      kline_count: klines.length
    });

    return {
      upper_bound,
      lower_bound,
      center_price,
      range_width_pct,
      close_std_dev,
      close_cv,
      atr,
      range_atr_ratio,
      upper_touches,
      lower_touches,
      start_time: klines[0].open_time,
      end_time: klines[klines.length - 1].close_time,
      kline_count: klines.length,
      quality_score
    };
  }

  /**
   * 计算边界触碰次数
   * 触碰定义: 价格进入边界容差范围，然后离开
   */
  private count_touches(
    klines: KlineData[],
    upper: number,
    lower: number,
    tolerance: number
  ): { upper_touches: number; lower_touches: number } {
    let upper_touches = 0;
    let lower_touches = 0;
    let in_upper_zone = false;
    let in_lower_zone = false;

    for (const k of klines) {
      // 检查上沿触碰
      const touching_upper = k.high >= upper - tolerance;
      if (touching_upper && !in_upper_zone) {
        upper_touches++;
      }
      in_upper_zone = touching_upper;

      // 检查下沿触碰
      const touching_lower = k.low <= lower + tolerance;
      if (touching_lower && !in_lower_zone) {
        lower_touches++;
      }
      in_lower_zone = touching_lower;
    }

    return { upper_touches, lower_touches };
  }

  /**
   * 计算区间质量评分 (0-100)
   */
  private calculate_quality_score(params: {
    close_cv: number;
    range_width_pct: number;
    upper_touches: number;
    lower_touches: number;
    range_atr_ratio: number;
    kline_count: number;
  }): number {
    let score = 0;

    // 1. 收盘价聚集度 (最高30分)
    // CV越小越好，0.1% = 30分，0.5% = 0分
    const cv_score = Math.max(0, 30 - (params.close_cv - 0.1) * 75);
    score += cv_score;

    // 2. 区间宽度 (最高20分)
    // 宽度越窄越好，0.5% = 20分，2% = 0分
    const width_score = Math.max(0, 20 - (params.range_width_pct - 0.5) * 13.3);
    score += width_score;

    // 3. 边界触碰平衡 (最高20分)
    const total_touches = params.upper_touches + params.lower_touches;
    const balance = Math.min(params.upper_touches, params.lower_touches) /
                    Math.max(params.upper_touches, params.lower_touches, 1);
    const touch_score = Math.min(20, total_touches * 2 * balance);
    score += touch_score;

    // 4. 区间/ATR比值 (最高15分)
    // 理想比值在2-5之间
    let atr_score = 0;
    if (params.range_atr_ratio >= 2 && params.range_atr_ratio <= 5) {
      atr_score = 15;
    } else if (params.range_atr_ratio < 2) {
      atr_score = params.range_atr_ratio * 7.5;
    } else {
      atr_score = Math.max(0, 15 - (params.range_atr_ratio - 5) * 3);
    }
    score += atr_score;

    // 5. 持续时间 (最高15分)
    // K线数量越多越稳定
    const duration_score = Math.min(15, params.kline_count * 0.5);
    score += duration_score;

    return Math.round(score);
  }

  /**
   * 检测突破
   * @param range 已识别的区间
   * @param current_kline 当前K线
   * @param prev_klines 之前的K线 (用于计算成交量比率)
   */
  detect_breakout(
    range: TightRange,
    current_kline: KlineData,
    prev_klines: KlineData[]
  ): RangeBreakout | null {
    const close = current_kline.close;

    // 计算成交量比率
    const avg_volume = this.mean(prev_klines.map(k => k.volume));
    const volume_ratio = current_kline.volume / avg_volume;

    // 检测向上突破
    if (close > range.upper_bound) {
      const breakout_pct = ((close - range.upper_bound) / range.upper_bound) * 100;

      if (breakout_pct >= this.config.min_breakout_pct) {
        return {
          direction: 'UP',
          breakout_price: close,
          breakout_time: current_kline.open_time,
          range,
          breakout_pct,
          is_confirmed: false,
          volume_ratio
        };
      }
    }

    // 检测向下突破
    if (close < range.lower_bound) {
      const breakout_pct = ((range.lower_bound - close) / range.lower_bound) * 100;

      if (breakout_pct >= this.config.min_breakout_pct) {
        return {
          direction: 'DOWN',
          breakout_price: close,
          breakout_time: current_kline.open_time,
          range,
          breakout_pct,
          is_confirmed: false,
          volume_ratio
        };
      }
    }

    return null;
  }

  /**
   * 确认突破 (检查后续K线是否维持在区间外)
   */
  confirm_breakout(
    breakout: RangeBreakout,
    confirm_klines: KlineData[]
  ): boolean {
    if (confirm_klines.length < this.config.confirm_bars) {
      return false;
    }

    const check_klines = confirm_klines.slice(0, this.config.confirm_bars);

    if (breakout.direction === 'UP') {
      // 向上突破: 确认K线收盘价都在上沿之上
      return check_klines.every(k => k.close > breakout.range.upper_bound);
    } else {
      // 向下突破: 确认K线收盘价都在下沿之下
      return check_klines.every(k => k.close < breakout.range.lower_bound);
    }
  }

  /**
   * 判断假突破
   * 假突破特征: 突破后立即回到区间内
   */
  is_fake_breakout(
    breakout: RangeBreakout,
    next_kline: KlineData
  ): boolean {
    if (breakout.direction === 'UP') {
      // 向上假突破: 下一根K线收盘回到上沿以下
      return next_kline.close <= breakout.range.upper_bound;
    } else {
      // 向下假突破: 下一根K线收盘回到下沿以上
      return next_kline.close >= breakout.range.lower_bound;
    }
  }

  // ========== 工具函数 ==========

  private mean(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private std_dev(values: number[]): number {
    const avg = this.mean(values);
    const squared_diffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(this.mean(squared_diffs));
  }

  private percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);

    if (lower === upper) {
      return sorted[lower];
    }

    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  private calculate_atr(klines: KlineData[], period: number = 14): number {
    if (klines.length < 2) return 0;

    const trs: number[] = [];
    for (let i = 1; i < klines.length; i++) {
      const tr = Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i - 1].close),
        Math.abs(klines[i].low - klines[i - 1].close)
      );
      trs.push(tr);
    }

    const recent = trs.slice(-Math.min(period, trs.length));
    return this.mean(recent);
  }

  private ranges_overlap(r1: TightRange, r2: TightRange): boolean {
    // 时间重叠超过50%认为是同一区间
    const overlap_start = Math.max(r1.start_time, r2.start_time);
    const overlap_end = Math.min(r1.end_time, r2.end_time);

    if (overlap_end <= overlap_start) return false;

    const overlap_duration = overlap_end - overlap_start;
    const r1_duration = r1.end_time - r1.start_time;
    const r2_duration = r2.end_time - r2.start_time;

    return overlap_duration > r1_duration * 0.5 ||
           overlap_duration > r2_duration * 0.5;
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<TightRangeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  get_config(): TightRangeConfig {
    return { ...this.config };
  }
}
