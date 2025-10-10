/**
 * 缠论分析总控制器 V2 - 标准缠论算法
 * 核心功能: 整合去包含-分型-笔-中枢的完整缠论分析
 *
 * 分析流程:
 * 原始K线 → 去包含处理 → 无包含K线 → 分型识别 → 笔构建 → 中枢检测
 */

import { KlineData } from '@/types/common';
import { ChanAnalysisResult } from './chan_types';
import { KlineProcessor } from './kline_processor';
import { FractalDetectorV2 } from './fractal_detector_v2';
import { StrokeBuilderV2 } from './stroke_builder_v2';
import { CenterDetectorV2 } from './center_detector_v2';
import { CenterDetectorV2Dynamic } from './center_detector_v2_dynamic';

export interface ChanAnalyzerV2Options {
  use_dynamic_center?: boolean;
}

export class ChanAnalyzerV2 {
  private kline_processor: KlineProcessor;
  private fractal_detector: FractalDetectorV2;
  private stroke_builder: StrokeBuilderV2;
  private center_detector: CenterDetectorV2 | CenterDetectorV2Dynamic;
  private use_dynamic_center: boolean;

  constructor(options?: ChanAnalyzerV2Options) {
    this.kline_processor = new KlineProcessor();
    this.fractal_detector = new FractalDetectorV2();
    this.stroke_builder = new StrokeBuilderV2();
    this.use_dynamic_center = options?.use_dynamic_center ?? true;
    this.center_detector = this.use_dynamic_center
      ? new CenterDetectorV2Dynamic()
      : new CenterDetectorV2();
  }

  /**
   * 完整缠论分析
   * @param klines 原始K线数据（时间正序）
   * @returns 完整的分型-笔-中枢分析结果
   */
  public analyze(klines: KlineData[]): ChanAnalysisResult {
    const start_time = Date.now();

    // 验证输入
    if (!klines || klines.length < 3) {
      return this.create_empty_result(klines);
    }

    const symbol = klines[0]?.symbol || 'UNKNOWN';
    const interval = klines[0]?.interval || 'unknown';

    console.log(`\n[ChanAnalyzerV2] 开始分析 ${symbol}:${interval}, K线数: ${klines.length}`);

    // 第一步: 去包含关系处理
    console.log(`[ChanAnalyzerV2] Step 1: 去包含处理...`);
    const processed_klines = this.kline_processor.remove_include(klines);
    console.log(`  → 原始${klines.length}根K线 → 无包含${processed_klines.length}根K线`);

    // 第二步: 识别分型
    console.log(`[ChanAnalyzerV2] Step 2: 识别分型...`);
    const fractals = this.fractal_detector.detect(processed_klines);

    // 确认分型
    const confirmed_fractals = this.fractal_detector.confirm_fractals(fractals, processed_klines);

    // 第三步: 构建笔
    console.log(`[ChanAnalyzerV2] Step 3: 构建笔...`);
    const strokes = this.stroke_builder.build(confirmed_fractals, processed_klines);

    // 第四步: 检测中枢
    console.log(`[ChanAnalyzerV2] Step 4: 检测中枢...`);
    const centers = this.center_detector.detect(strokes);

    // 过滤有效中枢
    const valid_centers = centers.filter(c => c.is_valid);

    const analysis_time = Date.now() - start_time;

    // 打印分析结果
    this.print_analysis_summary(symbol, interval, klines.length, processed_klines.length,
      fractals.length, strokes.length, centers.length, valid_centers.length, analysis_time);

    return {
      symbol,
      interval,
      fractals: confirmed_fractals,
      strokes,
      centers: valid_centers,
      current_center: valid_centers.find(c => !c.is_completed),
      last_stroke: strokes[strokes.length - 1],
      last_fractal: confirmed_fractals[confirmed_fractals.length - 1],
      analysis_time: Date.now(),
      kline_count: klines.length,
      valid_fractal_count: confirmed_fractals.filter(f => f.is_confirmed).length,
      valid_stroke_count: strokes.filter(s => s.is_valid).length,
      valid_center_count: valid_centers.length
    };
  }

  /**
   * 创建空结果
   */
  private create_empty_result(klines: KlineData[]): ChanAnalysisResult {
    return {
      symbol: klines[0]?.symbol || 'UNKNOWN',
      interval: klines[0]?.interval || 'unknown',
      fractals: [],
      strokes: [],
      centers: [],
      analysis_time: Date.now(),
      kline_count: klines?.length || 0,
      valid_fractal_count: 0,
      valid_stroke_count: 0,
      valid_center_count: 0
    };
  }

  /**
   * 打印分析摘要
   */
  private print_analysis_summary(
    symbol: string,
    interval: string,
    raw_kline_count: number,
    processed_kline_count: number,
    fractal_count: number,
    stroke_count: number,
    center_count: number,
    valid_center_count: number,
    analysis_time: number
  ): void {
    console.log(`\n========== 缠论分析V2完成 ==========`);
    console.log(`标的: ${symbol}:${interval}`);
    console.log(`中枢算法: ${this.use_dynamic_center ? '动态边界' : '固定边界'}`);
    console.log(`耗时: ${analysis_time}ms`);
    console.log(`\n数据流转:`);
    console.log(`  原始K线: ${raw_kline_count}根`);
    console.log(`    ↓ 去包含处理`);
    console.log(`  无包含K线: ${processed_kline_count}根 (合并率: ${((1 - processed_kline_count / raw_kline_count) * 100).toFixed(1)}%)`);
    console.log(`    ↓ 分型识别`);
    console.log(`  分型: ${fractal_count}个 (顶底交替)`);
    console.log(`    ↓ 笔构建`);
    console.log(`  笔: ${stroke_count}条`);
    console.log(`    ↓ 中枢检测`);
    console.log(`  中枢: ${center_count}个 (有效: ${valid_center_count}个)`);
    console.log(`====================================\n`);
  }
}
