/**
 * 交易区间检测器 - 基于缠论中枢
 * 核心思路: 利用缠论中枢作为横盘区间的识别基础
 */

import { KlineData } from '@/types/common';
import { RangeBox, StructureType } from '@/types/structure';
import { logger } from '@/utils/logger';
import { ChanAnalyzerV2, Center } from './chan_theory';

export class RangeDetector {
  private chan_analyzer: ChanAnalyzerV2;

  constructor() {
    // 使用V2版本 - 标准缠论算法
    console.log('[RangeDetector] 使用 ChanAnalyzerV2 (标准缠论算法)');
    this.chan_analyzer = new ChanAnalyzerV2();
  }

  /**
   * 检测交易区间
   * @param klines K线数据 (降序: 最新在前)
   * @param lookback 回溯周期
   * @returns 识别到的区间数组
   */
  public detect_ranges(klines: KlineData[], lookback: number = 200): RangeBox[] {
    try {
      if (klines.length < 50) {
        return [];
      }

      const actual_lookback = Math.min(lookback, klines.length);
      // 数据库返回降序，需要反转为时间正序
      const recent_klines = klines.slice(0, actual_lookback).reverse();

      const symbol = klines[0]?.symbol || 'UNKNOWN';
      const interval = klines[0]?.interval || 'UNKNOWN';

      // ========== 核心: 缠论分析 ==========
      const chan_result = this.chan_analyzer.analyze(recent_klines);

      // ========== 中枢转换为区间 ==========
      const ranges = this.convert_centers_to_ranges(
        chan_result.centers,
        recent_klines,
        symbol,
        interval
      );

      // ========== 过滤有效区间 ==========
      const valid_ranges = ranges.filter(r => this.validate_range(r));

      // ========== 按置信度排序，返回前3个 ==========
      const final_ranges = valid_ranges
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);

      // ========== 打印检测摘要 ==========
      this.print_detection_summary(
        symbol,
        interval,
        klines.length,
        actual_lookback,
        chan_result,
        ranges,
        valid_ranges,
        final_ranges
      );

      return final_ranges;

    } catch (error) {
      logger.error('Failed to detect ranges', error);
      return [];
    }
  }

  /**
   * 将缠论中枢转换为交易区间
   */
  private convert_centers_to_ranges(
    centers: Center[],
    klines: KlineData[],
    symbol: string,
    interval: string
  ): RangeBox[] {
    return centers
      .filter(center => center.is_valid)
      .map(center => {
        // 提取中枢对应的K线
        const center_klines = klines.slice(center.start_index, center.end_index + 1);

        // 计算触碰次数
        const touch_score = this.calculate_touch_score(center_klines, center);

        // 计算当前价格位置
        const current_price = klines[klines.length - 1].close;
        const near_resistance = current_price >= center.high * 0.97;
        const near_support = current_price <= center.low * 1.03;

        // 计算置信度
        const confidence = this.calculate_confidence_from_center(center, touch_score);

        // 计算强度
        const strength = this.calculate_strength_from_center(center, touch_score);

        return {
          symbol,
          interval,
          type: StructureType.RANGE,

          // 区间边界 (直接使用中枢边界)
          resistance: center.high,
          support: center.low,
          middle: center.middle,

          // 区间统计
          range_size: center.height,
          range_percent: center.height_percent,
          touch_count: touch_score.touch_count,
          support_touches: touch_score.support_touches,
          resistance_touches: touch_score.resistance_touches,
          duration_bars: center.duration_bars,

          // 突破预警
          near_resistance,
          near_support,
          breakout_direction: null,

          // 可靠性
          confidence,
          strength: Math.round(strength),

          // 时间范围
          start_time: center.start_time,
          end_time: center.end_time,

          // 成交量特征
          avg_volume: center.avg_volume,
          volume_trend: center.volume_trend,

          // 元数据
          pattern_data: {
            chan_center_id: center.id,
            stroke_count: center.stroke_count,
            center_strength: center.strength,
            is_extending: center.is_extending,
            extension_count: center.extension_count
          }
        };
      });
  }

  /**
   * 计算触碰次数
   */
  private calculate_touch_score(
    klines: KlineData[],
    center: Center
  ): {
    support_touches: number;
    resistance_touches: number;
    touch_count: number;
    balance_score: number;
  } {
    const { high: resistance, low: support } = center;

    // 动态容差: 中枢高度的10%
    const tolerance = (resistance - support) / support * 0.1;

    // 统计触碰
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);

    const resistance_touches = this.count_level_touches(highs, resistance, tolerance);
    const support_touches = this.count_level_touches(lows, support, tolerance);
    const touch_count = resistance_touches + support_touches;

    // 平衡度
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
   * 统计价格触碰水平位的次数
   */
  private count_level_touches(prices: number[], level: number, tolerance: number): number {
    let count = 0;
    let in_zone = false;
    const threshold_high = level * (1 + tolerance);
    const threshold_low = level * (1 - tolerance);

    for (const price of prices) {
      const is_touching = price >= threshold_low && price <= threshold_high;

      if (is_touching && !in_zone) {
        count++;
        in_zone = true;
      } else if (!is_touching) {
        in_zone = false;
      }
    }

    return count;
  }

  /**
   * 基于中枢计算置信度
   */
  private calculate_confidence_from_center(
    center: Center,
    touch_score: { touch_count: number; balance_score: number }
  ): number {
    let confidence = 0;

    // 1. 中枢强度 (0-0.4)
    confidence += (center.strength / 100) * 0.4;

    // 2. 触碰次数 (0-0.3)
    confidence += Math.min(touch_score.touch_count / 12, 0.3);

    // 3. 触碰平衡度 (0-0.2)
    confidence += touch_score.balance_score * 0.2;

    // 4. 笔数量 (0-0.1) - 笔越多，中枢越稳定
    confidence += Math.min(center.stroke_count / 9, 0.1);

    return Math.min(confidence, 1);
  }

  /**
   * 基于中枢计算强度
   */
  private calculate_strength_from_center(
    center: Center,
    touch_score: { touch_count: number; balance_score: number }
  ): number {
    let strength = 0;

    // 1. 中枢强度 (0-40分)
    strength += (center.strength / 100) * 40;

    // 2. 触碰次数 (0-30分)
    strength += Math.min(touch_score.touch_count * 3, 30);

    // 3. 持续时间 (0-20分)
    strength += Math.min((center.duration_bars / 80) * 20, 20);

    // 4. 平衡度 (0-10分)
    strength += touch_score.balance_score * 10;

    return Math.min(strength, 100);
  }

  /**
   * 验证区间有效性
   */
  private validate_range(range: RangeBox): boolean {
    // 1. 置信度至少0.3
    if (range.confidence < 0.3) return false;

    // 2. 至少3次触碰
    if (range.touch_count < 3) return false;

    // 3. 支撑和阻力都至少触碰1次
    if (range.support_touches < 1 || range.resistance_touches < 1) return false;

    // 4. 持续至少20根K线
    if (range.duration_bars < 20) return false;

    // 5. 区间高度合理 (0.5%-12%)
    if (range.range_percent < 0.5 || range.range_percent > 12) return false;

    return true;
  }

  /**
   * 打印检测摘要
   */
  private print_detection_summary(
    symbol: string,
    interval: string,
    total_klines: number,
    lookback: number,
    chan_result: any,
    ranges: RangeBox[],
    valid_ranges: RangeBox[],
    final_ranges: RangeBox[]
  ): void {
    logger.info(`[RangeDetector] ${symbol}:${interval} - 检测完成`, {
      total_klines,
      lookback,
      chan_stats: {
        fractals: chan_result.fractals.length,
        strokes: chan_result.strokes.length,
        centers: chan_result.centers.length
      },
      range_stats: {
        total_ranges: ranges.length,
        valid_ranges: valid_ranges.length,
        final_ranges: final_ranges.length
      },
      results: final_ranges.map(r => {
        const start_date = new Date(r.start_time).toISOString().slice(5, 16).replace('T', ' ');
        const end_date = new Date(r.end_time).toISOString().slice(5, 16).replace('T', ' ');
        return {
          time_range: `${start_date} ~ ${end_date}`,
          support: r.support.toFixed(2),
          resistance: r.resistance.toFixed(2),
          range_pct: r.range_percent.toFixed(2) + '%',
          confidence: (r.confidence * 100).toFixed(1) + '%',
          strength: r.strength,
          touches: r.touch_count,
          duration: r.duration_bars,
          chan_strokes: r.pattern_data?.stroke_count
        };
      })
    });
  }

  /**
   * 检测区间突破
   */
  public detect_breakout(
    range: RangeBox,
    current_kline: KlineData,
    recent_klines: KlineData[]
  ): 'up' | 'down' | null {
    const close = current_kline.close;
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
  private confirm_breakout(
    recent_klines: KlineData[],
    level: number,
    direction: 'up' | 'down',
    avg_volume: number
  ): boolean {
    if (recent_klines.length < 2) return false;

    const last_two = recent_klines.slice(-2);
    const closes = last_two.map(k => k.close);
    const volumes = last_two.map(k => k.volume);

    // 价格确认: 连续2根K线站稳
    if (direction === 'up') {
      if (!closes.every(c => c > level)) return false;
    } else {
      if (!closes.every(c => c < level)) return false;
    }

    // 成交量确认: 至少有一根放量
    const has_volume_surge = volumes.some(v => v > avg_volume * 1.3);
    return has_volume_surge;
  }

}
