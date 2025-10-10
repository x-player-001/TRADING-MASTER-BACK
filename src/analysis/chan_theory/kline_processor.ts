/**
 * K线预处理器
 * 核心功能: 去除K线包含关系，为分型识别做准备
 */

import { KlineData } from '@/types/common';

/**
 * 处理后的K线（无包含关系）
 */
export interface ProcessedKline {
  symbol: string;
  interval: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
  is_final: boolean;
  merged_count: number;    // 合并的原始K线数量
  direction?: 'up' | 'down'; // 合并时的趋势方向
}

/**
 * K线包含关系处理器
 */
export class KlineProcessor {
  /**
   * 去除包含关系
   * @param klines 原始K线序列（时间正序）
   * @returns 无包含关系的K线序列
   */
  public remove_include(klines: KlineData[]): ProcessedKline[] {
    if (klines.length < 2) {
      return klines.map(k => ({ ...k, merged_count: 1, is_final: k.is_final || true }));
    }

    const processed: ProcessedKline[] = [];
    let merge_count_in_last_150 = 0;

    // 第一根K线直接加入
    processed.push({
      ...klines[0],
      merged_count: 1,
      is_final: klines[0].is_final || true
    });

    for (let i = 1; i < klines.length; i++) {
      const last_processed = processed[processed.length - 1];
      const current_raw = klines[i];

      // 合并包含关系
      const merged = this.merge_if_included(
        processed.length >= 2 ? processed[processed.length - 2] : null,
        last_processed,
        current_raw
      );

      if (merged.is_merged) {
        // 替换最后一根处理后的K线
        processed[processed.length - 1] = merged.kline;
        if (i >= klines.length - 150) {
          merge_count_in_last_150++;
        }
      } else {
        // 添加新K线
        processed.push(merged.kline);
      }
    }

    // 打印后150根K线的合并情况
    const last_150_original = Math.min(150, klines.length);
    const last_150_processed = Math.min(150, processed.length);
    console.log(`[去包含] 后${last_150_original}根原始K线 → ${last_150_processed}根无包含K线 (合并了${merge_count_in_last_150}次)`);

    return processed;
  }

  /**
   * 判断并合并包含关系
   * @param k1 倒数第二根已处理K线（用于判断方向）
   * @param k2 最后一根已处理K线
   * @param k3 当前原始K线
   * @returns 合并结果
   */
  private merge_if_included(
    k1: ProcessedKline | null,
    k2: ProcessedKline,
    k3: KlineData
  ): { is_merged: boolean; kline: ProcessedKline } {
    // 判断趋势方向
    let direction: 'up' | 'down' | undefined;

    if (k1) {
      if (k1.high < k2.high) {
        direction = 'up';
      } else if (k1.high > k2.high) {
        direction = 'down';
      }
      // 相等时不确定方向，使用k2的方向
      else {
        direction = k2.direction;
      }
    } else {
      // 第一根K线，使用k2的方向或默认向上
      direction = k2.direction || 'up';
    }

    // 判断k2和k3是否存在包含关系
    const k2_包含_k3 = k2.high >= k3.high && k2.low <= k3.low;
    const k3_包含_k2 = k3.high >= k2.high && k3.low <= k2.low;
    const has_include = k2_包含_k3 || k3_包含_k2;

    if (!has_include) {
      // 无包含关系，返回新K线
      return {
        is_merged: false,
        kline: {
          ...k3,
          merged_count: 1,
          direction,
          is_final: k3.is_final || true
        }
      };
    }

    // 有包含关系，根据方向合并
    let merged_high: number;
    let merged_low: number;
    let merged_time: number;

    if (direction === 'up') {
      // 向上趋势: 取高位（高点取max，低点也取max）
      merged_high = Math.max(k2.high, k3.high);
      merged_low = Math.max(k2.low, k3.low);
      merged_time = k2.high > k3.high ? k2.open_time : k3.open_time;
    } else {
      // 向下趋势: 取低位（高点取min，低点也取min）
      merged_high = Math.min(k2.high, k3.high);
      merged_low = Math.min(k2.low, k3.low);
      merged_time = k2.low < k3.low ? k2.open_time : k3.open_time;
    }

    // 决定开盘价和收盘价（根据合并后的高低点）
    const merged_open = k3.open > k3.close ? merged_high : merged_low;
    const merged_close = k3.open > k3.close ? merged_low : merged_high;

    // 合并后的K线
    return {
      is_merged: true,
      kline: {
        symbol: k3.symbol,
        interval: k3.interval,
        open_time: merged_time,
        close_time: Math.max(k2.close_time, k3.close_time),
        open: merged_open,
        high: merged_high,
        low: merged_low,
        close: merged_close,
        volume: k2.volume + k3.volume,
        trade_count: k2.trade_count + k3.trade_count,
        merged_count: k2.merged_count + 1,
        direction,
        is_final: k3.is_final || k2.is_final || true
      }
    };
  }
}
