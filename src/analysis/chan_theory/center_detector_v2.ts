/**
 * 中枢检测器 V2 - 标准缠论算法
 * 核心功能: 基于笔序列识别中枢
 *
 * 算法要点:
 * 1. 中枢边界 = 前3笔的固定区间
 *    ZG (上沿) = min(BI₁.high, BI₂.high, BI₃.high)
 *    ZD (下沿) = max(BI₁.low, BI₂.low, BI₃.low)
 * 2. 必须满足: ZG > ZD
 * 3. 后续笔必须与[ZD, ZG]有交集才能加入中枢
 */

import { Stroke, Center } from './chan_types';

export class CenterDetectorV2 {
  /**
   * 从笔序列中检测中枢
   * @param strokes 笔序列
   * @returns 中枢序列
   */
  public detect(strokes: Stroke[]): Center[] {
    if (strokes.length < 3) {
      return [];
    }

    const centers: Center[] = [];
    let i = 0;

    console.log(`\n[CenterV2] 开始检测中枢，共${strokes.length}条笔`);

    while (i <= strokes.length - 3) {
      // 尝试从当前位置构建中枢
      const center = this.try_build_center(strokes, i);

      if (center) {
        centers.push(center);
        console.log(`  ✅ 找到中枢: 笔${i}-${i + center.stroke_count - 1}, 区间[${center.low.toFixed(2)}, ${center.high.toFixed(2)}], 笔数=${center.stroke_count}`);
        // 跳过已形成中枢的笔
        i += center.stroke_count;
      } else {
        i++;
      }
    }

    console.log(`[CenterV2] 检测完成，找到${centers.length}个中枢\n`);
    return centers;
  }

  /**
   * 尝试从指定位置构建中枢
   * @param strokes 笔序列
   * @param start_idx 起始笔索引
   * @returns 中枢对象或null
   */
  private try_build_center(strokes: Stroke[], start_idx: number): Center | null {
    if (start_idx + 3 > strokes.length) {
      return null;
    }

    // 取前3笔
    const bi1 = strokes[start_idx];
    const bi2 = strokes[start_idx + 1];
    const bi3 = strokes[start_idx + 2];

    // 计算每笔的high和low
    const bi1_high = Math.max(bi1.start_fractal.price, bi1.end_fractal.price);
    const bi1_low = Math.min(bi1.start_fractal.price, bi1.end_fractal.price);
    const bi2_high = Math.max(bi2.start_fractal.price, bi2.end_fractal.price);
    const bi2_low = Math.min(bi2.start_fractal.price, bi2.end_fractal.price);
    const bi3_high = Math.max(bi3.start_fractal.price, bi3.end_fractal.price);
    const bi3_low = Math.min(bi3.start_fractal.price, bi3.end_fractal.price);

    // 计算中枢边界 (固定边界，只用前3笔)
    // ZG = min(前3笔的high)
    // ZD = max(前3笔的low)
    const ZG = Math.min(bi1_high, bi2_high, bi3_high);
    const ZD = Math.max(bi1_low, bi2_low, bi3_low);

    // 必须满足: ZG > ZD
    if (ZG <= ZD) {
      console.log(`    ❌ 笔${start_idx}-${start_idx + 2}: ZG=${ZG.toFixed(2)} <= ZD=${ZD.toFixed(2)}，无法形成中枢`);
      return null;
    }

    console.log(`    笔${start_idx}-${start_idx + 2}: 初始中枢区间[${ZD.toFixed(2)}, ${ZG.toFixed(2)}]`);

    // 验证前3笔是否都与中枢有交集
    const initial_strokes = [bi1, bi2, bi3];
    for (const bi of initial_strokes) {
      if (!this.is_intersect(bi, ZD, ZG)) {
        console.log(`      → ❌ 笔${bi.start_index}-${bi.end_index}不与中枢交集`);
        return null;
      }
    }

    // 尝试扩展中枢 (后续笔只要与[ZD, ZG]相交即可加入)
    const center_strokes = [...initial_strokes];
    let next_idx = start_idx + 3;

    while (next_idx < strokes.length && center_strokes.length < 12) { // 最多12笔
      const next_bi = strokes[next_idx];

      // 判断下一笔是否与中枢区间有交集
      if (this.is_intersect(next_bi, ZD, ZG)) {
        center_strokes.push(next_bi);
        next_idx++;
      } else {
        // 不相交，中枢结束
        break;
      }
    }

    // 构建中枢对象
    return this.create_center(center_strokes, ZD, ZG);
  }

  /**
   * 判断笔是否与中枢区间有交集
   * @param bi 笔对象
   * @param ZD 中枢下沿
   * @param ZG 中枢上沿
   * @returns 是否有交集
   */
  private is_intersect(bi: Stroke, ZD: number, ZG: number): boolean {
    const bi_high = Math.max(bi.start_fractal.price, bi.end_fractal.price);
    const bi_low = Math.min(bi.start_fractal.price, bi.end_fractal.price);

    // 笔与中枢有交集的三种情况:
    // 1. 笔的高点在中枢内
    const high_in_center = ZG >= bi_high && bi_high >= ZD;
    // 2. 笔的低点在中枢内
    const low_in_center = ZG >= bi_low && bi_low >= ZD;
    // 3. 笔完全穿越中枢
    const cross_center = bi_high >= ZG && ZD >= bi_low;

    return high_in_center || low_in_center || cross_center;
  }

  /**
   * 创建中枢结构
   * @param strokes 构成中枢的笔序列
   * @param ZD 中枢下沿
   * @param ZG 中枢上沿
   * @returns 中枢对象
   */
  private create_center(strokes: Stroke[], ZD: number, ZG: number): Center {
    // 计算中枢特征
    const middle = (ZG + ZD) / 2;
    const height = ZG - ZD;
    const height_percent = (height / middle) * 100;

    // 时间范围
    const start_index = strokes[0].start_index;
    const end_index = strokes[strokes.length - 1].end_index;
    const start_time = strokes[0].start_time;
    const end_time = strokes[strokes.length - 1].end_time;
    const duration_bars = end_index - start_index;

    // 计算GG (最高点) 和 DD (最低点)
    const gg = Math.max(...strokes.map(s => Math.max(s.start_fractal.price, s.end_fractal.price)));
    const dd = Math.min(...strokes.map(s => Math.min(s.start_fractal.price, s.end_fractal.price)));

    // 计算成交量
    const avg_volume = strokes.reduce((sum, s) => sum + s.avg_volume, 0) / strokes.length;

    // 计算强度
    const strength = this.calculate_center_strength(strokes, duration_bars, height_percent);

    // 生成ID
    const symbol = strokes[0]?.start_fractal.price ? 'unknown' : 'unknown';
    const center_id = `center_${symbol}_${start_index}`;

    // 判断有效性 (放宽横盘区间检测的阈值)
    const min_height = 0.3;  // 最小高度0.3% (横盘波动小)
    const max_duration = 150; // 最大持续150根K线
    const is_valid = height_percent >= min_height && duration_bars <= max_duration;

    // 打印无效原因
    if (!is_valid) {
      const reasons = [];
      if (height_percent < min_height) reasons.push(`高度${height_percent.toFixed(2)}% < ${min_height}%`);
      if (duration_bars > max_duration) reasons.push(`持续${duration_bars}根 > ${max_duration}根`);
      console.log(`      → ❌ 中枢无效: ${reasons.join(', ')}`);
    }

    return {
      id: center_id,
      high: ZG,
      low: ZD,
      middle,
      height,
      height_percent,
      strokes,
      stroke_count: strokes.length,
      start_index,
      end_index,
      start_time,
      end_time,
      duration_bars,
      strength,
      is_extending: false,
      extension_count: strokes.length - 3,
      avg_volume,
      volume_trend: 'stable',
      is_valid,
      is_completed: false
    };
  }

  /**
   * 计算中枢强度
   * @param strokes 笔序列
   * @param duration_bars 持续K线数
   * @param height_percent 中枢高度百分比
   * @returns 强度值 0-100
   */
  private calculate_center_strength(
    strokes: Stroke[],
    duration_bars: number,
    height_percent: number
  ): number {
    // 基于笔数 (40分)
    const stroke_score = Math.min((strokes.length / 9) * 40, 40);

    // 基于持续时间 (30分)
    const duration_score = Math.min((duration_bars / 50) * 30, 30);

    // 基于笔的平均振幅 (30分) - 振幅越小，中枢越稳定
    const avg_amplitude = strokes.reduce((sum, s) => sum + s.amplitude_percent, 0) / strokes.length;
    const amplitude_score = Math.max(30 - avg_amplitude * 2, 0);

    return Math.min(stroke_score + duration_score + amplitude_score, 100);
  }
}
