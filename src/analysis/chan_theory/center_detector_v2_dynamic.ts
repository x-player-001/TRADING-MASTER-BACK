/**
 * 中枢检测器 V2 - 动态边界算法（参考czsc源码）
 * 核心功能: 基于笔序列识别中枢
 *
 * 算法要点（czsc标准）:
 * 1. 向上笔: ZG = max(ZG, bi.low)  - ZG逐渐抬高
 * 2. 向下笔: ZD = min(ZD, bi.high) - ZD逐渐降低
 * 3. 当 ZG > ZD 时，中枢结束（不再有重叠区间）
 * 4. 最少3笔构成中枢
 */

import { Stroke, Center, StrokeDirection } from './chan_types';

export class CenterDetectorV2Dynamic {
  private min_bi_count: number = 3; // 最少笔数

  /**
   * 从笔序列中检测中枢（动态边界算法）
   * @param strokes 笔序列
   * @returns 中枢序列
   */
  public detect(strokes: Stroke[]): Center[] {
    if (strokes.length < this.min_bi_count) {
      return [];
    }

    const centers: Center[] = [];
    let i = 0;

    console.log(`\n[CenterV2Dynamic] 开始检测中枢（动态边界算法），共${strokes.length}条笔`);

    while (i <= strokes.length - this.min_bi_count) {
      // 尝试从当前位置构建中枢
      const result = this.try_build_center(strokes, i);

      if (result) {
        centers.push(result.center);
        console.log(`  ✅ 找到中枢: 笔${i}-${i + result.stroke_count - 1}, 区间[${result.center.low.toFixed(2)}, ${result.center.high.toFixed(2)}], 笔数=${result.stroke_count}`);
        // 跳过已形成中枢的笔
        i += result.stroke_count;
      } else {
        i++;
      }
    }

    console.log(`[CenterV2Dynamic] 检测完成，找到${centers.length}个中枢\n`);
    return centers;
  }

  /**
   * 尝试从指定位置构建中枢（动态边界）
   * @param strokes 笔序列
   * @param start_idx 起始笔索引
   * @returns {center, stroke_count} 或 null
   */
  private try_build_center(strokes: Stroke[], start_idx: number): { center: Center; stroke_count: number } | null {
    let zg: number | null = null; // 中枢上沿
    let zd: number | null = null; // 中枢下沿
    const zs_bis: Stroke[] = [];

    console.log(`\n  尝试从笔${start_idx}开始构建中枢:`);

    // 遍历后续笔，动态更新边界
    for (let i = start_idx; i < strokes.length; i++) {
      const bi = strokes[i];
      const bi_high = Math.max(bi.start_fractal.price, bi.end_fractal.price);
      const bi_low = Math.min(bi.start_fractal.price, bi.end_fractal.price);

      // 判断笔的方向（向上/向下）
      const is_up = bi.direction === StrokeDirection.UP;

      if (is_up) {
        // 向上笔：用低点计算ZG
        const new_low = bi_low;

        if (zg === null) {
          // 初始化ZG
          zg = new_low;
          zs_bis.push(bi);
          console.log(`    笔${i}(↑): low=${new_low.toFixed(2)}, 初始化 ZG=${zg.toFixed(2)}`);
        } else {
          // 更新ZG（取更高的低点）
          const temp_zg = Math.max(zg, new_low);

          // 检查是否仍有重叠
          if (zd === null || temp_zg <= zd) {
            zg = temp_zg;
            zs_bis.push(bi);
            console.log(`    笔${i}(↑): low=${new_low.toFixed(2)}, ZG=${zg.toFixed(2)}, ZD=${zd?.toFixed(2) || 'null'}, 仍有重叠 ✓`);
          } else {
            // temp_zg > zd，没有重叠了
            console.log(`    笔${i}(↑): low=${new_low.toFixed(2)}, temp_ZG=${temp_zg.toFixed(2)} > ZD=${zd.toFixed(2)}, 中枢结束 ✗`);
            break;
          }
        }
      } else {
        // 向下笔：用高点计算ZD
        const new_high = bi_high;

        if (zd === null) {
          // 初始化ZD
          zd = new_high;
          zs_bis.push(bi);
          console.log(`    笔${i}(↓): high=${new_high.toFixed(2)}, 初始化 ZD=${zd.toFixed(2)}`);
        } else {
          // 更新ZD（取更低的高点）
          const temp_zd = Math.min(zd, new_high);

          // 检查是否仍有重叠
          if (zg === null || temp_zd >= zg) {
            zd = temp_zd;
            zs_bis.push(bi);
            console.log(`    笔${i}(↓): high=${new_high.toFixed(2)}, ZD=${zd.toFixed(2)}, ZG=${zg?.toFixed(2) || 'null'}, 仍有重叠 ✓`);
          } else {
            // temp_zd < zg，没有重叠了
            console.log(`    笔${i}(↓): high=${new_high.toFixed(2)}, temp_ZD=${temp_zd.toFixed(2)} < ZG=${zg.toFixed(2)}, 中枢结束 ✗`);
            break;
          }
        }
      }
    }

    // 验证中枢有效性
    if (
      zs_bis.length >= this.min_bi_count &&
      zg !== null &&
      zd !== null &&
      zd >= zg // 必须有重叠区间
    ) {
      const center = this.create_center(zs_bis, zg, zd);
      return { center, stroke_count: zs_bis.length };
    } else {
      const reason = [];
      if (zs_bis.length < this.min_bi_count) reason.push(`笔数${zs_bis.length} < ${this.min_bi_count}`);
      if (zg === null) reason.push('ZG未定义');
      if (zd === null) reason.push('ZD未定义');
      if (zg !== null && zd !== null && zd < zg) reason.push(`ZD(${zd.toFixed(2)}) < ZG(${zg.toFixed(2)})`);
      console.log(`    ❌ 无法形成中枢: ${reason.join(', ')}`);
      return null;
    }
  }

  /**
   * 创建中枢结构
   * @param strokes 构成中枢的笔序列
   * @param ZG 中枢上沿
   * @param ZD 中枢下沿
   * @returns 中枢对象
   */
  private create_center(strokes: Stroke[], ZG: number, ZD: number): Center {
    // 计算中枢特征
    const middle = (ZG + ZD) / 2;
    const height = ZD - ZG; // 注意：ZD >= ZG，所以height是正数
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
    const center_id = `center_${start_index}`;

    // 判断有效性（放宽横盘区间检测的阈值）
    const min_height = 0.3;  // 最小高度0.3%
    const max_duration = 150; // 最大持续150根K线
    const is_valid = height_percent >= min_height && duration_bars <= max_duration;

    // 打印无效原因
    if (!is_valid) {
      const reasons = [];
      if (height_percent < min_height) reasons.push(`高度${height_percent.toFixed(2)}% < ${min_height}%`);
      if (duration_bars > max_duration) reasons.push(`持续${duration_bars}根 > ${max_duration}根`);
      console.log(`      → ⚠️  中枢无效: ${reasons.join(', ')}`);
    }

    return {
      id: center_id,
      high: ZD,  // 注意：在动态边界算法中，ZD是上沿
      low: ZG,   // ZG是下沿
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
