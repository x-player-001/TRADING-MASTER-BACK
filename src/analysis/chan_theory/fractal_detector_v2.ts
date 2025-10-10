/**
 * 分型识别器 V2 - 标准缠论算法
 * 核心功能: 从无包含关系K线中识别顶底分型
 *
 * 算法要求:
 * 1. 顶分型: k2.high > k1.high AND k2.high > k3.high
 *           AND k2.low > k1.low AND k2.low > k3.low
 * 2. 底分型: k2.high < k1.high AND k2.high < k3.high
 *           AND k2.low < k1.low AND k2.low < k3.low
 * 3. 分型必须顶底交替
 */

import { Fractal, FractalType } from './chan_types';
import { ProcessedKline } from './kline_processor';

export class FractalDetectorV2 {
  /**
   * 检测无包含关系K线序列中的所有分型
   * @param klines 无包含关系的K线序列
   * @returns 顶底交替的分型序列
   */
  public detect(klines: ProcessedKline[]): Fractal[] {
    if (klines.length < 3) {
      return [];
    }

    const fractals: Fractal[] = [];
    let reject_count_in_last_50 = 0;
    let fractal_count_in_last_50 = 0;

    // 从第2根K线开始遍历(索引1), 到倒数第2根结束
    for (let i = 1; i < klines.length - 1; i++) {
      const k1 = klines[i - 1];
      const k2 = klines[i];
      const k3 = klines[i + 1];

      const fractal = this.check_fractal(k1, k2, k3, i);

      // 统计后50根K线的分型情况
      if (i > klines.length - 50) {
        if (fractal) {
          fractal_count_in_last_50++;
        } else {
          // 检查是否接近分型但被拒绝
          const almost_top = k1.high < k2.high && k2.high > k3.high;
          const almost_bottom = k1.low > k2.low && k2.low < k3.low;
          if (almost_top || almost_bottom) {
            reject_count_in_last_50++;
          }
        }
      }

      if (fractal) {
        // 强制顶底交替
        if (fractals.length > 0 && fractals[fractals.length - 1].type === fractal.type) {
          console.log(`[FractalV2] 警告: 索引${i}出现连续${fractal.type}分型，跳过`);
          continue;
        }

        fractals.push(fractal);
      }
    }

    // 统计后50根K线的分型类型分布
    const last_50_fractals = fractals.filter(f => f.kline_index > klines.length - 50);
    const top_count = last_50_fractals.filter(f => f.type === FractalType.TOP).length;
    const bottom_count = last_50_fractals.filter(f => f.type === FractalType.BOTTOM).length;

    console.log(`[FractalV2] 检测完成: ${klines.length}根K线 → ${fractals.length}个分型`);
    console.log(`[FractalV2] 后50根K线: 识别${fractal_count_in_last_50}个分型, ${reject_count_in_last_50}个因high/low同时满足失败`);
    console.log(`[FractalV2] 后50根K线分型分布: 顶分型${top_count}个, 底分型${bottom_count}个`);

    // 打印最后10个分型的详细信息
    const last_10_fractals = fractals.slice(-10);
    console.log(`[FractalV2] 最后10个分型详情:`);
    last_10_fractals.forEach((f, idx) => {
      const type_str = f.type === FractalType.TOP ? '顶分' : '底分';
      console.log(`  分型${fractals.length - 10 + idx}: 索引${f.kline_index}, ${type_str}, 价格${f.price.toFixed(2)}, 强度${f.strength.toFixed(2)}`);
    });

    return fractals;
  }

  /**
   * 检查3根K线是否构成分型
   * @param k1 前一根K线
   * @param k2 中间K线（分型点）
   * @param k3 后一根K线
   * @param index 中间K线索引
   * @returns 分型对象或null
   */
  private check_fractal(
    k1: ProcessedKline,
    k2: ProcessedKline,
    k3: ProcessedKline,
    index: number
  ): Fractal | null {
    // 顶分型: k2的high和low都高于k1和k3
    const is_top = k1.high < k2.high && k2.high > k3.high &&
                   k1.low < k2.low && k2.low > k3.low;

    if (is_top) {
      const strength = this.calculate_strength(k1, k2, k3, 'top');
      return {
        type: FractalType.TOP,
        price: k2.high,
        kline_index: index,
        time: k2.open_time,
        open: k2.open,
        high: k2.high,
        low: k2.low,
        close: k2.close,
        strength,
        gap_percent: 0, // 后续计算
        is_confirmed: false,
        confirmed_bars: 0
      };
    }

    // 底分型: k2的high和low都低于k1和k3
    const is_bottom = k1.high > k2.high && k2.high < k3.high &&
                      k1.low > k2.low && k2.low < k3.low;

    if (is_bottom) {
      const strength = this.calculate_strength(k1, k2, k3, 'bottom');
      return {
        type: FractalType.BOTTOM,
        price: k2.low,
        kline_index: index,
        time: k2.open_time,
        open: k2.open,
        high: k2.high,
        low: k2.low,
        close: k2.close,
        strength,
        gap_percent: 0,
        is_confirmed: false,
        confirmed_bars: 0
      };
    }

    return null;
  }

  /**
   * 计算分型强度
   * @param k1 前一根K线
   * @param k2 中间K线
   * @param k3 后一根K线
   * @param type 分型类型
   * @returns 强度值 0-1
   */
  private calculate_strength(
    k1: ProcessedKline,
    k2: ProcessedKline,
    k3: ProcessedKline,
    type: 'top' | 'bottom'
  ): number {
    if (type === 'top') {
      const gap_left = (k2.high - k1.high) / k1.high;
      const gap_right = (k2.high - k3.high) / k3.high;
      const min_gap = Math.min(gap_left, gap_right);
      return Math.min(min_gap * 10, 1); // 归一化到0-1
    } else {
      const gap_left = (k1.low - k2.low) / k2.low;
      const gap_right = (k3.low - k2.low) / k2.low;
      const min_gap = Math.min(gap_left, gap_right);
      return Math.min(min_gap * 10, 1);
    }
  }

  /**
   * 确认分型（检查后续K线是否破坏分型）
   * @param fractals 分型序列
   * @param klines 原始K线序列
   * @returns 确认后的分型序列
   */
  public confirm_fractals(fractals: Fractal[], klines: ProcessedKline[]): Fractal[] {
    return fractals.map(fractal => {
      const confirmed_bars = klines.length - 1 - fractal.kline_index;

      // 检查后续K线是否破坏分型
      let is_broken = false;
      for (let i = fractal.kline_index + 1; i < klines.length; i++) {
        const kline = klines[i];

        if (fractal.type === FractalType.TOP) {
          // 顶分型被破坏: 后续K线high超过分型价格
          if (kline.high > fractal.price) {
            is_broken = true;
            break;
          }
        } else {
          // 底分型被破坏: 后续K线low低于分型价格
          if (kline.low < fractal.price) {
            is_broken = true;
            break;
          }
        }
      }

      return {
        ...fractal,
        is_confirmed: !is_broken,
        confirmed_bars
      };
    });
  }
}
