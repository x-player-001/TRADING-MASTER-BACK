/**
 * 支撑阻力位检测器
 *
 * 核心算法:
 * 1. 局部极值检测 (Swing High/Low) - 找出 N 根 K 线内的最高点/最低点
 * 2. 价格聚类 (Clustering) - 将相近的极值点聚合成一个"价位"
 * 3. 有效性评分 (Touch Count + Recency) - 触碰次数越多、最近被触碰的越重要
 *
 * 参考:
 * - https://github.com/day0market/support_resistance (ZigZag + AgglomerativeClustering)
 * - https://github.com/BatuhanUsluel/Algorithmic-Support-and-Resistance (reversal points)
 * - https://github.com/albertsl/support-resistance_trading-bot (MeanShift clustering)
 */

import { logger } from '@/utils/logger';

/**
 * K线数据
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
 * 局部极值点
 */
export interface PivotPoint {
  index: number;              // K线索引
  time: number;               // 时间戳
  price: number;              // 价格
  type: 'HIGH' | 'LOW';       // 高点或低点
  strength: number;           // 强度 (基于前后K线数量)
}

/**
 * 支撑阻力位
 */
export interface SRLevel {
  price: number;              // 价格
  type: 'SUPPORT' | 'RESISTANCE';
  touch_count: number;        // 触碰次数
  first_touch_time: number;   // 首次触碰时间
  last_touch_time: number;    // 最近触碰时间
  strength: number;           // 综合强度 (0-100)
  pivot_points: PivotPoint[]; // 组成该价位的极值点
}

/**
 * 检测配置
 */
export interface SRDetectorConfig {
  // 极值点检测
  pivot_left_bars: number;    // 左侧比较的K线数量，默认5
  pivot_right_bars: number;   // 右侧比较的K线数量，默认5

  // 价格聚类
  cluster_threshold_pct: number;  // 聚类阈值百分比，默认0.3%

  // 过滤条件
  min_touch_count: number;    // 最小触碰次数，默认2
  min_strength: number;       // 最小强度，默认30
  max_levels: number;         // 最大返回数量，默认10
}

const DEFAULT_CONFIG: SRDetectorConfig = {
  pivot_left_bars: 5,
  pivot_right_bars: 5,
  cluster_threshold_pct: 0.3,
  min_touch_count: 2,
  min_strength: 30,
  max_levels: 10
};

export class SupportResistanceDetector {
  private config: SRDetectorConfig;

  constructor(config?: Partial<SRDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测支撑阻力位 (主入口)
   * @param klines K线数据 (时间升序)
   */
  detect(klines: KlineData[]): SRLevel[] {
    if (klines.length < this.config.pivot_left_bars + this.config.pivot_right_bars + 1) {
      return [];
    }

    // 1. 检测局部极值点
    const pivots = this.find_pivot_points(klines);

    if (pivots.length === 0) {
      return [];
    }

    // 2. 计算动态聚类阈值 (基于币种波动率)
    const avg_amplitude = this.calculate_avg_amplitude(klines);
    const dynamic_threshold = Math.max(
      this.config.cluster_threshold_pct,
      avg_amplitude * 0.5  // 聚类阈值 = 平均振幅的一半
    );

    // 3. 聚类相近的极值点
    const clusters = this.cluster_pivots(pivots, dynamic_threshold);

    // 4. 转换为支撑阻力位
    const levels = this.clusters_to_levels(clusters, klines);

    // 5. 计算强度评分
    this.calculate_strength(levels, klines);

    // 6. 过滤和排序
    const filtered = levels.filter(l =>
      l.touch_count >= this.config.min_touch_count &&
      l.strength >= this.config.min_strength
    );

    // 按强度排序，取前N个
    filtered.sort((a, b) => b.strength - a.strength);
    return filtered.slice(0, this.config.max_levels);
  }

  /**
   * 找出价格附近的支撑阻力位
   * @param levels 所有支撑阻力位
   * @param current_price 当前价格
   * @param range_pct 范围百分比
   */
  find_nearby_levels(
    levels: SRLevel[],
    current_price: number,
    range_pct: number = 2.0
  ): { supports: SRLevel[]; resistances: SRLevel[] } {
    const range = current_price * (range_pct / 100);
    const min_price = current_price - range;
    const max_price = current_price + range;

    const nearby = levels.filter(l => l.price >= min_price && l.price <= max_price);

    const supports = nearby
      .filter(l => l.price < current_price)
      .sort((a, b) => b.price - a.price); // 离当前价格最近的排前面

    const resistances = nearby
      .filter(l => l.price > current_price)
      .sort((a, b) => a.price - b.price); // 离当前价格最近的排前面

    return { supports, resistances };
  }

  /**
   * 检测局部极值点 (Swing High/Low)
   */
  private find_pivot_points(klines: KlineData[]): PivotPoint[] {
    const pivots: PivotPoint[] = [];
    const left = this.config.pivot_left_bars;
    const right = this.config.pivot_right_bars;

    for (let i = left; i < klines.length - right; i++) {
      const current = klines[i];

      // 检测 Swing High
      let is_swing_high = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j !== i && klines[j].high >= current.high) {
          is_swing_high = false;
          break;
        }
      }

      if (is_swing_high) {
        pivots.push({
          index: i,
          time: current.open_time,
          price: current.high,
          type: 'HIGH',
          strength: left + right  // 强度 = 左右K线数量
        });
      }

      // 检测 Swing Low
      let is_swing_low = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j !== i && klines[j].low <= current.low) {
          is_swing_low = false;
          break;
        }
      }

      if (is_swing_low) {
        pivots.push({
          index: i,
          time: current.open_time,
          price: current.low,
          type: 'LOW',
          strength: left + right
        });
      }
    }

    return pivots;
  }

  /**
   * 聚类相近的极值点
   * 使用简单的贪婪算法，不依赖 sklearn
   */
  private cluster_pivots(pivots: PivotPoint[], threshold_pct: number): PivotPoint[][] {
    if (pivots.length === 0) return [];

    // 按价格排序
    const sorted = [...pivots].sort((a, b) => a.price - b.price);

    const clusters: PivotPoint[][] = [];
    let current_cluster: PivotPoint[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      // 计算价格差异百分比
      const diff_pct = Math.abs(curr.price - prev.price) / prev.price * 100;

      if (diff_pct <= threshold_pct) {
        // 价格相近，加入当前聚类
        current_cluster.push(curr);
      } else {
        // 价格差异大，开始新聚类
        clusters.push(current_cluster);
        current_cluster = [curr];
      }
    }

    // 添加最后一个聚类
    clusters.push(current_cluster);

    return clusters;
  }

  /**
   * 将聚类转换为支撑阻力位
   */
  private clusters_to_levels(clusters: PivotPoint[][], klines: KlineData[]): SRLevel[] {
    return clusters.map(cluster => {
      // 计算该聚类的中位价格
      const prices = cluster.map(p => p.price);
      prices.sort((a, b) => a - b);
      const median_price = prices[Math.floor(prices.length / 2)];

      // 确定类型：根据极值点本身的类型判断
      // HIGH 点聚类 = 阻力位，LOW 点聚类 = 支撑位
      const high_count = cluster.filter(p => p.type === 'HIGH').length;
      const low_count = cluster.filter(p => p.type === 'LOW').length;
      const type: 'SUPPORT' | 'RESISTANCE' = high_count >= low_count ? 'RESISTANCE' : 'SUPPORT';

      // 时间信息
      const times = cluster.map(p => p.time);
      const first_touch = Math.min(...times);
      const last_touch = Math.max(...times);

      return {
        price: median_price,
        type,
        touch_count: cluster.length,
        first_touch_time: first_touch,
        last_touch_time: last_touch,
        strength: 0,  // 稍后计算
        pivot_points: cluster
      };
    });
  }

  /**
   * 计算支撑阻力位强度
   * 综合考虑: 触碰次数、时间跨度、最近性、价格附近的成交量
   */
  private calculate_strength(levels: SRLevel[], klines: KlineData[]): void {
    const now = klines[klines.length - 1].open_time;
    const total_duration = now - klines[0].open_time;

    for (const level of levels) {
      let strength = 0;

      // 1. 触碰次数得分 (0-40分)
      // 2次 = 20分, 3次 = 30分, 4次+ = 40分
      const touch_score = Math.min(40, level.touch_count * 10);
      strength += touch_score;

      // 2. 时间跨度得分 (0-30分)
      // 跨越时间越长，说明该位置越有效
      const level_duration = level.last_touch_time - level.first_touch_time;
      const duration_ratio = level_duration / total_duration;
      const duration_score = Math.min(30, duration_ratio * 60);
      strength += duration_score;

      // 3. 最近性得分 (0-20分)
      // 最近被触碰的位置更重要
      const recency = (level.last_touch_time - klines[0].open_time) / total_duration;
      const recency_score = recency * 20;
      strength += recency_score;

      // 4. 极值点强度加成 (0-10分)
      // 考虑组成该价位的极值点的平均强度
      const avg_pivot_strength = level.pivot_points.reduce((sum, p) => sum + p.strength, 0) / level.pivot_points.length;
      const pivot_score = Math.min(10, avg_pivot_strength);
      strength += pivot_score;

      level.strength = Math.round(Math.min(100, strength));
    }
  }

  /**
   * 计算平均振幅
   */
  private calculate_avg_amplitude(klines: KlineData[]): number {
    let total = 0;
    for (const k of klines) {
      total += (k.high - k.low) / k.low * 100;
    }
    return total / klines.length;
  }

  /**
   * 检测价格是否接近某个支撑阻力位
   * @returns 最近的价位信息，如果没有接近的返回null
   */
  check_price_near_level(
    price: number,
    levels: SRLevel[],
    threshold_pct: number = 0.5
  ): {
    level: SRLevel;
    distance_pct: number;
    is_support: boolean;
  } | null {
    let nearest: SRLevel | null = null;
    let min_distance_pct = Infinity;

    for (const level of levels) {
      const distance_pct = Math.abs(price - level.price) / level.price * 100;

      if (distance_pct <= threshold_pct && distance_pct < min_distance_pct) {
        nearest = level;
        min_distance_pct = distance_pct;
      }
    }

    if (nearest) {
      return {
        level: nearest,
        distance_pct: min_distance_pct,
        is_support: nearest.type === 'SUPPORT'
      };
    }

    return null;
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<SRDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  get_config(): SRDetectorConfig {
    return { ...this.config };
  }

  /**
   * 格式化支撑阻力位信息
   */
  format_level(level: SRLevel): string {
    const type_text = level.type === 'SUPPORT' ? '支撑' : '阻力';
    const first_time = new Date(level.first_touch_time).toISOString().slice(0, 16);
    const last_time = new Date(level.last_touch_time).toISOString().slice(0, 16);

    return [
      `${type_text}位: ${level.price.toFixed(6)}`,
      `强度: ${level.strength}分, 触碰: ${level.touch_count}次`,
      `时间: ${first_time} ~ ${last_time}`
    ].join('\n');
  }
}
