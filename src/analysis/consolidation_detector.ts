/**
 * 密集区间检测算法
 *
 * 使用成交量分桶法识别价格密集成交区间：
 * 1. 将价格区间分成 N 个桶（bucket）
 * 2. 将每根K线的成交量按价格位置分配到对应桶
 * 3. 成交量最大的连续桶区域 = 密集区间
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

// 密集区间结果
export interface ConsolidationZone {
  upper_bound: number;      // 密集区上沿
  lower_bound: number;      // 密集区下沿
  center_price: number;     // 密集区中心价格
  total_volume: number;     // 区间总成交量
  volume_pct: number;       // 占总成交量百分比
  price_range_pct: number;  // 区间宽度占总价格范围百分比
}

// 突破信号
export interface BreakoutSignal {
  symbol: string;
  direction: 'UP' | 'DOWN';
  breakout_price: number;
  zone: ConsolidationZone;
  breakout_pct: number;     // 突破幅度百分比
  volume: number;           // 突破K线成交量
  volume_ratio: number;     // 成交量相对平均值倍数
  kline: KlineData;         // 突破K线数据
}

// 配置
export interface ConsolidationConfig {
  bucket_count: number;           // 分桶数量，默认20
  min_consecutive_buckets: number; // 最小连续桶数量，默认3
  min_volume_pct: number;         // 密集区最小成交量占比，默认30%
  volume_ratio_threshold: number; // 放量阈值，默认1.5
  min_breakout_pct: number;       // 最小突破幅度，默认0.3%
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  bucket_count: 20,
  min_consecutive_buckets: 3,
  min_volume_pct: 50,             // 提高到50%：密集区至少要包含一半成交量
  volume_ratio_threshold: 2.5,   // 提高到2.5倍：需要更明显的放量
  min_breakout_pct: 1.0          // 提高到1%：过滤掉正常波动
};

export class ConsolidationDetector {
  private config: ConsolidationConfig;

  constructor(config?: Partial<ConsolidationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测密集区间
   * @param klines K线数据数组（按时间升序）
   */
  detect_consolidation_zone(klines: KlineData[]): ConsolidationZone | null {
    if (klines.length < 10) {
      return null;
    }

    // 1. 计算价格范围
    let min_price = Infinity;
    let max_price = -Infinity;
    let total_volume = 0;

    for (const kline of klines) {
      min_price = Math.min(min_price, kline.low);
      max_price = Math.max(max_price, kline.high);
      total_volume += kline.volume;
    }

    if (max_price <= min_price || total_volume === 0) {
      return null;
    }

    const price_range = max_price - min_price;
    const bucket_size = price_range / this.config.bucket_count;

    // 2. 创建成交量分桶
    const buckets: number[] = new Array(this.config.bucket_count).fill(0);

    for (const kline of klines) {
      // 将K线成交量分配到对应价格桶
      // 简化处理：使用K线的VWAP近似值（开盘+收盘+最高+最低）/4
      const vwap = (kline.open + kline.close + kline.high + kline.low) / 4;
      const bucket_index = Math.min(
        Math.floor((vwap - min_price) / bucket_size),
        this.config.bucket_count - 1
      );

      if (bucket_index >= 0 && bucket_index < this.config.bucket_count) {
        buckets[bucket_index] += kline.volume;
      }
    }

    // 3. 找到成交量最大的连续桶区域
    let best_start = 0;
    let best_volume = 0;
    const consecutive = this.config.min_consecutive_buckets;

    for (let i = 0; i <= this.config.bucket_count - consecutive; i++) {
      let window_volume = 0;
      for (let j = i; j < i + consecutive; j++) {
        window_volume += buckets[j];
      }

      if (window_volume > best_volume) {
        best_volume = window_volume;
        best_start = i;
      }
    }

    // 4. 计算密集区边界
    const lower_bound = min_price + best_start * bucket_size;
    const upper_bound = min_price + (best_start + consecutive) * bucket_size;
    const center_price = (lower_bound + upper_bound) / 2;
    const volume_pct = (best_volume / total_volume) * 100;
    const price_range_pct = ((upper_bound - lower_bound) / min_price) * 100;

    // 检查是否满足最小成交量占比要求
    if (volume_pct < this.config.min_volume_pct) {
      return null;
    }

    return {
      upper_bound,
      lower_bound,
      center_price,
      total_volume: best_volume,
      volume_pct,
      price_range_pct
    };
  }

  /**
   * 检测突破信号
   * @param symbol 交易对
   * @param klines 历史K线（用于计算密集区，不包含当前K线）
   * @param current_kline 当前完结的K线
   *
   * 核心逻辑：只有"刚刚突破"才触发信号
   * - 前一根K线必须在密集区内（或刚触及边界）
   * - 当前K线必须突破到密集区外
   * - 这样避免价格已经在区外运行时重复触发信号
   */
  detect_breakout(
    symbol: string,
    klines: KlineData[],
    current_kline: KlineData
  ): BreakoutSignal | null {
    // 需要至少有前一根K线来判断"刚刚突破"
    if (klines.length < 10) {
      return null;
    }

    // 1. 检测密集区间（不包含当前K线）
    const zone = this.detect_consolidation_zone(klines);
    if (!zone) {
      return null;
    }

    // 2. 获取前一根K线（用于判断是否"刚刚突破"）
    const prev_kline = klines[klines.length - 1];
    const prev_close = prev_kline.close;

    // 3. 计算平均成交量
    const avg_volume = klines.reduce((sum, k) => sum + k.volume, 0) / klines.length;
    const volume_ratio = current_kline.volume / avg_volume;

    // 4. 检测是否放量
    if (volume_ratio < this.config.volume_ratio_threshold) {
      return null; // 未放量，不算有效突破
    }

    // 5. 检测突破方向
    const close = current_kline.close;
    const open = current_kline.open;

    // 向上突破条件：
    // - 前一根K线收盘价在密集区上沿以下（还在区内或刚触及）
    // - 当前K线收盘价突破上沿
    // - 当前K线是阳线
    const prev_was_inside_or_at_upper = prev_close <= zone.upper_bound * 1.005; // 允许0.5%的容差
    if (close > zone.upper_bound && close > open && prev_was_inside_or_at_upper) {
      const breakout_pct = ((close - zone.upper_bound) / zone.upper_bound) * 100;

      if (breakout_pct >= this.config.min_breakout_pct) {
        return {
          symbol,
          direction: 'UP',
          breakout_price: close,
          zone,
          breakout_pct,
          volume: current_kline.volume,
          volume_ratio,
          kline: current_kline
        };
      }
    }

    // 向下突破条件：
    // - 前一根K线收盘价在密集区下沿以上（还在区内或刚触及）
    // - 当前K线收盘价跌破下沿
    // - 当前K线是阴线
    const prev_was_inside_or_at_lower = prev_close >= zone.lower_bound * 0.995; // 允许0.5%的容差
    if (close < zone.lower_bound && close < open && prev_was_inside_or_at_lower) {
      const breakout_pct = ((zone.lower_bound - close) / zone.lower_bound) * 100;

      if (breakout_pct >= this.config.min_breakout_pct) {
        return {
          symbol,
          direction: 'DOWN',
          breakout_price: close,
          zone,
          breakout_pct,
          volume: current_kline.volume,
          volume_ratio,
          kline: current_kline
        };
      }
    }

    return null;
  }

  /**
   * 获取当前配置
   */
  get_config(): ConsolidationConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<ConsolidationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
