/**
 * 笔构建器 V2 - 标准缠论算法
 * 核心功能: 从分型序列构建笔
 *
 * 成笔条件:
 * 1. 价格突破: 向上笔 fx_b.price > fx_a.price, 向下笔 fx_b.price < fx_a.price
 * 2. 无包含关系: fx_a和fx_b的价格区间不能有包含关系
 * 3. 最小长度: 至少5根K线 (czsc_min_bi_len)
 */

import { Fractal, FractalType, Stroke, StrokeDirection } from './chan_types';
import { ProcessedKline } from './kline_processor';

export class StrokeBuilderV2 {
  private min_bi_len: number = 5; // 最小笔长度

  /**
   * 从分型序列构建笔序列
   * @param fractals 顶底交替的分型序列
   * @param klines 无包含关系的K线序列
   * @returns 笔序列
   */
  public build(fractals: Fractal[], klines: ProcessedKline[]): Stroke[] {
    if (fractals.length < 2) {
      return [];
    }

    const strokes: Stroke[] = [];

    // 从第一个分型开始尝试成笔
    for (let i = 0; i < fractals.length - 1; i++) {
      const fx_a = fractals[i];

      // 寻找下一个异性分型，判断是否能成笔
      const result = this.find_next_stroke(fx_a, fractals.slice(i + 1), klines);

      if (result) {
        strokes.push(result.stroke);
        // 跳到下一笔的起点
        i = result.next_index + i;
      }
    }

    console.log(`[StrokeV2] 构建完成: ${fractals.length}个分型 → ${strokes.length}条笔`);

    // 打印最后5条笔的索引范围
    if (strokes.length > 0) {
      const last_strokes = strokes.slice(-Math.min(5, strokes.length));
      console.log(`[StrokeV2] 最后${last_strokes.length}条笔:`);
      last_strokes.forEach((s, idx) => {
        const actual_idx = strokes.length - last_strokes.length + idx;
        console.log(`  笔${actual_idx}: K线索引${s.start_index}-${s.end_index} (${s.direction}, 振幅${s.amplitude_percent.toFixed(2)}%)`);
      });
    }

    return strokes;
  }

  /**
   * 寻找下一条笔 - czsc贪婪策略
   * @param fx_a 起始分型
   * @param remaining_fractals 剩余分型序列
   * @param klines K线序列
   * @returns 笔对象和下一个起点索引
   */
  private find_next_stroke(
    fx_a: Fractal,
    remaining_fractals: Fractal[],
    klines: ProcessedKline[]
  ): { stroke: Stroke; next_index: number } | null {
    // 确定方向
    const direction = fx_a.type === FractalType.BOTTOM ? StrokeDirection.UP : StrokeDirection.DOWN;

    // 收集所有满足成笔条件的候选分型
    const candidates: Array<{ fx: Fractal; index: number }> = [];

    for (let j = 0; j < remaining_fractals.length; j++) {
      const fx_b = remaining_fractals[j];

      // 必须是异性分型
      if (fx_a.type === fx_b.type) {
        continue;
      }

      // 条件1: 价格突破
      const price_break = direction === StrokeDirection.UP
        ? fx_b.price > fx_a.price
        : fx_b.price < fx_a.price;

      if (!price_break) {
        continue;
      }

      // 条件2: 无包含关系
      const fx_a_high = fx_a.high;
      const fx_a_low = fx_a.low;
      const fx_b_high = fx_b.high;
      const fx_b_low = fx_b.low;

      const has_include =
        (fx_a_high >= fx_b_high && fx_a_low <= fx_b_low) || // fx_a包含fx_b
        (fx_b_high >= fx_a_high && fx_b_low <= fx_a_low);   // fx_b包含fx_a

      if (has_include) {
        console.log(`    笔${fx_a.kline_index}-${fx_b.kline_index}: 存在包含关系，跳过`);
        continue;
      }

      // 条件3: 最小K线数
      const bi_length = fx_b.kline_index - fx_a.kline_index + 1;
      if (bi_length < this.min_bi_len) {
        console.log(`    笔${fx_a.kline_index}-${fx_b.kline_index}: K线数${bi_length} < ${this.min_bi_len}，跳过`);
        continue;
      }

      // 满足所有条件，加入候选列表
      candidates.push({ fx: fx_b, index: j });
    }

    // 如果没有候选分型，返回null
    if (candidates.length === 0) {
      return null;
    }

    // czsc贪婪策略: 找最极端的分型
    let best_candidate = candidates[0];

    if (direction === StrokeDirection.UP) {
      // 向上笔: 找最高的顶分型
      for (const candidate of candidates) {
        if (candidate.fx.high > best_candidate.fx.high) {
          best_candidate = candidate;
        }
      }
    } else {
      // 向下笔: 找最低的底分型
      for (const candidate of candidates) {
        if (candidate.fx.low < best_candidate.fx.low) {
          best_candidate = candidate;
        }
      }
    }

    // 打印贪婪策略选择信息
    if (candidates.length > 1) {
      console.log(`    [贪婪策略] 从${candidates.length}个候选中选择: fx_a=${fx_a.kline_index}, fx_b=${best_candidate.fx.kline_index} (${direction === StrokeDirection.UP ? '最高' : '最低'})`);
    }

    const stroke = this.create_stroke(fx_a, best_candidate.fx, klines, direction);
    return { stroke, next_index: best_candidate.index };
  }

  /**
   * 创建笔对象
   * @param fx_a 起始分型
   * @param fx_b 结束分型
   * @param klines K线序列
   * @param direction 方向
   * @returns 笔对象
   */
  private create_stroke(
    fx_a: Fractal,
    fx_b: Fractal,
    klines: ProcessedKline[],
    direction: StrokeDirection
  ): Stroke {
    // 计算振幅
    const amplitude = Math.abs(fx_b.price - fx_a.price);
    const amplitude_percent = (amplitude / fx_a.price) * 100;

    // 计算持续K线数
    const duration_bars = fx_b.kline_index - fx_a.kline_index + 1;

    // 调试：打印超长笔的信息
    if (duration_bars > 100) {
      console.log(`    [超长笔] K线${fx_a.kline_index}-${fx_b.kline_index} (${duration_bars}根):`);
      console.log(`      起点分型: ${fx_a.type} price=${fx_a.price.toFixed(2)} (high=${fx_a.high.toFixed(2)}, low=${fx_a.low.toFixed(2)})`);
      console.log(`      终点分型: ${fx_b.type} price=${fx_b.price.toFixed(2)} (high=${fx_b.high.toFixed(2)}, low=${fx_b.low.toFixed(2)})`);
      console.log(`      振幅: ${amplitude.toFixed(2)} (${amplitude_percent.toFixed(2)}%)`);
    }

    // 提取笔内K线
    const bars_between = klines.slice(fx_a.kline_index, fx_b.kline_index + 1);

    // 计算平均成交量
    const avg_volume = bars_between.reduce((sum, k) => sum + k.volume, 0) / bars_between.length;

    // 计算最大回撤
    const max_retracement = this.calculate_max_retracement(bars_between, direction, fx_a.price, fx_b.price);

    // 生成ID
    const id = `stroke_${fx_a.kline_index}_${fx_b.kline_index}`;

    return {
      id,
      direction,
      start_fractal: fx_a,
      end_fractal: fx_b,
      amplitude,
      amplitude_percent,
      duration_bars,
      start_time: fx_a.time,
      end_time: fx_b.time,
      start_index: fx_a.kline_index,
      end_index: fx_b.kline_index,
      max_retracement,
      avg_volume,
      is_valid: true,
      invalid_reason: undefined
    };
  }

  /**
   * 计算最大回撤
   * @param bars K线序列
   * @param direction 笔方向
   * @param start_price 起始价格
   * @param end_price 结束价格
   * @returns 最大回撤百分比
   */
  private calculate_max_retracement(
    bars: ProcessedKline[],
    direction: StrokeDirection,
    start_price: number,
    end_price: number
  ): number {
    let max_retracement = 0;
    const total_move = Math.abs(end_price - start_price);

    if (total_move === 0) return 0;

    if (direction === StrokeDirection.UP) {
      // 向上笔: 计算最大下跌回撤
      let current_high = start_price;
      for (const bar of bars) {
        if (bar.high > current_high) {
          current_high = bar.high;
        }
        const retracement = (current_high - bar.low) / total_move;
        max_retracement = Math.max(max_retracement, retracement);
      }
    } else {
      // 向下笔: 计算最大上涨回撤
      let current_low = start_price;
      for (const bar of bars) {
        if (bar.low < current_low) {
          current_low = bar.low;
        }
        const retracement = (bar.high - current_low) / total_move;
        max_retracement = Math.max(max_retracement, retracement);
      }
    }

    return max_retracement;
  }
}
