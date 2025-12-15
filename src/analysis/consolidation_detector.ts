/**
 * 密集区间检测算法 v2
 *
 * 使用 ATR（平均真实波幅）+ 价格聚类法识别密集成交区间：
 * 1. 计算 ATR 作为波动率基准
 * 2. 基于收盘价进行 K-means 风格的价格聚类
 * 3. 找出价格停留时间最长的聚类 = 密集区间
 * 4. 用 ATR 动态调整区间宽度
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
  start_time: number;       // 区间开始时间（第一根K线）
  end_time: number;         // 区间结束时间（最后一根K线）
  kline_count: number;      // 区间内K线数量
  atr: number;              // ATR值（波动率参考）
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
  atr_period: number;             // ATR计算周期，默认14
  atr_multiplier: number;         // ATR倍数用于确定区间宽度，默认1.5
  min_cluster_size: number;       // 最小聚类K线数量，默认10
  min_time_in_zone_pct: number;   // 价格在区间内停留的最小时间比例，默认40%
  volume_ratio_threshold: number; // 放量阈值，默认2.0
  min_breakout_pct: number;       // 最小突破幅度（相对ATR），默认0.5
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  atr_period: 14,
  atr_multiplier: 1.5,
  min_cluster_size: 10,
  min_time_in_zone_pct: 40,       // 至少40%的K线在区间内
  volume_ratio_threshold: 2.0,    // 放量2倍
  min_breakout_pct: 0.5           // 突破幅度至少0.5个ATR
};

// 价格聚类结构
interface PriceCluster {
  center: number;           // 聚类中心价格
  klines: KlineData[];      // 属于该聚类的K线
  total_volume: number;     // 聚类总成交量
  start_time: number;       // 最早K线时间
  end_time: number;         // 最晚K线时间
}

export class ConsolidationDetector {
  private config: ConsolidationConfig;

  constructor(config?: Partial<ConsolidationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 计算 ATR（平均真实波幅）
   * @param klines K线数据数组
   */
  calculate_atr(klines: KlineData[]): number {
    if (klines.length < 2) return 0;

    const period = Math.min(this.config.atr_period, klines.length - 1);
    const true_ranges: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const current = klines[i];
      const prev = klines[i - 1];

      // True Range = max(high - low, |high - prev_close|, |low - prev_close|)
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close)
      );
      true_ranges.push(tr);
    }

    // 计算最近 period 个 TR 的平均值
    const recent_trs = true_ranges.slice(-period);
    const atr = recent_trs.reduce((sum, tr) => sum + tr, 0) / recent_trs.length;

    return atr;
  }

  /**
   * 基于价格聚类检测密集区间
   * @param klines K线数据数组（按时间升序）
   */
  detect_consolidation_zone(klines: KlineData[]): ConsolidationZone | null {
    if (klines.length < this.config.min_cluster_size) {
      return null;
    }

    // 1. 计算 ATR
    const atr = this.calculate_atr(klines);
    if (atr <= 0) return null;

    // 2. 计算价格范围
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

    // 3. 使用 ATR 确定聚类半径
    const cluster_radius = atr * this.config.atr_multiplier;

    // 4. 基于收盘价进行简化的聚类
    // 策略：滑动窗口找出价格最密集的区间
    const clusters = this.find_price_clusters(klines, cluster_radius);

    if (clusters.length === 0) {
      return null;
    }

    // 5. 找出K线数量最多的聚类（价格停留时间最长）
    let best_cluster: PriceCluster | null = null;
    let max_kline_count = 0;

    for (const cluster of clusters) {
      if (cluster.klines.length > max_kline_count) {
        max_kline_count = cluster.klines.length;
        best_cluster = cluster;
      }
    }

    if (!best_cluster || best_cluster.klines.length < this.config.min_cluster_size) {
      return null;
    }

    // 6. 检查时间占比
    const time_in_zone_pct = (best_cluster.klines.length / klines.length) * 100;
    if (time_in_zone_pct < this.config.min_time_in_zone_pct) {
      return null;
    }

    // 7. 计算密集区边界（中心 ± ATR * 倍数）
    const center_price = best_cluster.center;
    const half_width = cluster_radius;
    const upper_bound = center_price + half_width;
    const lower_bound = center_price - half_width;

    // 8. 计算区间内的实际成交量
    const zone_volume = best_cluster.total_volume;
    const volume_pct = (zone_volume / total_volume) * 100;
    const price_range_pct = ((upper_bound - lower_bound) / center_price) * 100;

    return {
      upper_bound,
      lower_bound,
      center_price,
      total_volume: zone_volume,
      volume_pct,
      price_range_pct,
      start_time: best_cluster.start_time,
      end_time: best_cluster.end_time,
      kline_count: best_cluster.klines.length,
      atr
    };
  }

  /**
   * 基于价格聚类查找密集区
   * 使用滑动窗口的方式，找出收盘价最集中的区域
   */
  private find_price_clusters(klines: KlineData[], radius: number): PriceCluster[] {
    if (klines.length === 0) return [];

    // 提取所有收盘价并排序
    const prices = klines.map(k => k.close).sort((a, b) => a - b);
    const clusters: PriceCluster[] = [];

    // 使用滑动窗口找出价格密集区
    // 窗口大小 = 2 * radius
    const window_size = radius * 2;

    // 遍历所有可能的聚类中心
    let i = 0;
    while (i < prices.length) {
      const center = prices[i];
      const lower = center - radius;
      const upper = center + radius;

      // 找出所有在此区间内的K线
      const cluster_klines: KlineData[] = [];
      let cluster_volume = 0;
      let start_time = Infinity;
      let end_time = -Infinity;

      for (const kline of klines) {
        // 使用收盘价判断是否在区间内
        if (kline.close >= lower && kline.close <= upper) {
          cluster_klines.push(kline);
          cluster_volume += kline.volume;
          start_time = Math.min(start_time, kline.open_time);
          end_time = Math.max(end_time, kline.close_time);
        }
      }

      if (cluster_klines.length >= this.config.min_cluster_size) {
        // 重新计算聚类中心（使用加权平均）
        const weighted_sum = cluster_klines.reduce((sum, k) => sum + k.close * k.volume, 0);
        const total_weight = cluster_klines.reduce((sum, k) => sum + k.volume, 0);
        const refined_center = total_weight > 0 ? weighted_sum / total_weight : center;

        clusters.push({
          center: refined_center,
          klines: cluster_klines,
          total_volume: cluster_volume,
          start_time,
          end_time
        });
      }

      // 跳到下一个不同的价格区间
      // 找到超出当前窗口的下一个价格
      let j = i + 1;
      while (j < prices.length && prices[j] <= upper) {
        j++;
      }
      i = j > i ? j : i + 1;
    }

    // 合并重叠的聚类
    return this.merge_overlapping_clusters(clusters, radius);
  }

  /**
   * 合并重叠的聚类
   */
  private merge_overlapping_clusters(clusters: PriceCluster[], radius: number): PriceCluster[] {
    if (clusters.length <= 1) return clusters;

    // 按聚类中心排序
    clusters.sort((a, b) => a.center - b.center);

    const merged: PriceCluster[] = [];
    let current = clusters[0];

    for (let i = 1; i < clusters.length; i++) {
      const next = clusters[i];

      // 检查是否重叠（中心距离 < 2 * radius）
      if (next.center - current.center < radius * 2) {
        // 合并：保留K线数量更多的聚类
        if (next.klines.length > current.klines.length) {
          current = next;
        }
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    return merged;
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
   * - 突破幅度必须超过 min_breakout_pct * ATR
   */
  detect_breakout(
    symbol: string,
    klines: KlineData[],
    current_kline: KlineData
  ): BreakoutSignal | null {
    // 需要至少有足够K线来判断"刚刚突破"
    if (klines.length < this.config.min_cluster_size) {
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

    // 使用 ATR 计算最小突破距离
    const min_breakout_distance = zone.atr * this.config.min_breakout_pct;

    // 向上突破条件：
    // - 前一根K线收盘价在密集区上沿以下（还在区内或刚触及）
    // - 当前K线收盘价突破上沿
    // - 当前K线是阳线
    // - 突破距离 >= min_breakout_distance
    const tolerance = zone.atr * 0.1; // 使用 10% ATR 作为容差
    const prev_was_inside_or_at_upper = prev_close <= zone.upper_bound + tolerance;

    if (close > zone.upper_bound && close > open && prev_was_inside_or_at_upper) {
      const breakout_distance = close - zone.upper_bound;
      const breakout_pct = (breakout_distance / zone.center_price) * 100;

      if (breakout_distance >= min_breakout_distance) {
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
    // - 突破距离 >= min_breakout_distance
    const prev_was_inside_or_at_lower = prev_close >= zone.lower_bound - tolerance;

    if (close < zone.lower_bound && close < open && prev_was_inside_or_at_lower) {
      const breakout_distance = zone.lower_bound - close;
      const breakout_pct = (breakout_distance / zone.center_price) * 100;

      if (breakout_distance >= min_breakout_distance) {
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
