/**
 * 缠论核心类型定义
 * 包含: 分型、笔、中枢的完整结构定义
 */

import { KlineData } from '@/types/common';

/**
 * 分型类型
 */
export enum FractalType {
  TOP = 'top',      // 顶分型: 中间K线高点最高
  BOTTOM = 'bottom' // 底分型: 中间K线低点最低
}

/**
 * 分型结构
 * 由连续3根K线构成，中间K线为关键点
 */
export interface Fractal {
  type: FractalType;

  // 核心价格
  price: number;           // 分型价格(顶取high,底取low)

  // K线信息
  kline_index: number;     // 中间K线的索引位置
  time: number;            // 分型时间戳

  // 完整OHLC(用于后续验证)
  open: number;
  high: number;
  low: number;
  close: number;

  // 分型强度指标
  strength: number;        // 0-1, 基于三根K线的价格差异
  gap_percent: number;     // 与相邻分型的价格差异百分比

  // 验证标记
  is_confirmed: boolean;   // 是否已确认(后续K线未破坏)
  confirmed_bars: number;  // 确认后经过的K线数
}

/**
 * 笔的方向
 */
export enum StrokeDirection {
  UP = 'up',       // 向上笔: 从底分型到顶分型
  DOWN = 'down'    // 向下笔: 从顶分型到底分型
}

/**
 * 笔结构
 * 由起始分型到结束分型构成
 */
export interface Stroke {
  id: string;              // 唯一标识: "stroke_{symbol}_{start_index}_{end_index}"
  direction: StrokeDirection;

  // 起止分型
  start_fractal: Fractal;  // 起始分型
  end_fractal: Fractal;    // 结束分型

  // 笔的统计特征
  amplitude: number;       // 振幅(绝对值): |end_price - start_price|
  amplitude_percent: number; // 振幅百分比
  duration_bars: number;   // 持续K线数

  // 时间范围
  start_time: number;
  end_time: number;
  start_index: number;     // 起始K线索引
  end_index: number;       // 结束K线索引

  // 笔内统计
  max_retracement: number; // 最大回撤百分比(验证笔的单向性)
  avg_volume: number;      // 平均成交量

  // 验证标记
  is_valid: boolean;       // 是否有效笔
  invalid_reason?: string; // 无效原因: "amplitude_too_small" | "too_many_retracement"
}

/**
 * 中枢结构
 * 至少3笔价格重叠区域
 */
export interface Center {
  id: string;              // 唯一标识: "center_{symbol}_{start_index}"

  // 中枢边界 (最关键)
  high: number;            // 中枢上沿: 前3笔重叠区的最高点
  low: number;             // 中枢下沿: 前3笔重叠区的最低点
  middle: number;          // 中枢中轴: (high + low) / 2
  height: number;          // 中枢高度: high - low
  height_percent: number;  // 中枢高度百分比: height / middle * 100

  // 构成笔
  strokes: Stroke[];       // 组成中枢的所有笔(至少3笔)
  stroke_count: number;    // 笔数量

  // 时间范围
  start_index: number;     // 中枢开始K线索引
  end_index: number;       // 中枢结束K线索引
  start_time: number;
  end_time: number;
  duration_bars: number;   // 持续K线数

  // 中枢特征
  strength: number;        // 中枢强度 0-100: 基于笔数、持续时间、触碰次数
  is_extending: boolean;   // 是否在扩展中
  extension_count: number; // 扩展次数 (缠论: 最多9段)

  // 成交量特征
  avg_volume: number;      // 中枢内平均成交量
  volume_trend: 'increasing' | 'decreasing' | 'stable'; // 成交量趋势

  // 趋势判断
  trend_before?: 'up' | 'down' | 'none'; // 进入中枢前的趋势
  trend_after?: 'up' | 'down' | 'none';  // 离开中枢后的趋势

  // 验证标记
  is_valid: boolean;
  is_completed: boolean;   // 是否已完成(价格已离开中枢)
}

/**
 * 缠论分析结果
 * 完整的分型-笔-中枢数据
 */
export interface ChanAnalysisResult {
  symbol: string;
  interval: string;

  // 核心数据
  fractals: Fractal[];     // 所有分型
  strokes: Stroke[];       // 所有笔
  centers: Center[];       // 所有中枢

  // 当前状态
  current_center?: Center;   // 当前活跃中枢(未完成的)
  last_stroke?: Stroke;      // 最新笔
  last_fractal?: Fractal;    // 最新分型

  // 统计信息
  analysis_time: number;     // 分析时间戳
  kline_count: number;       // 分析的K线数量
  valid_fractal_count: number;
  valid_stroke_count: number;
  valid_center_count: number;

  // 缓存标记
  cache_key?: string;
}

/**
 * 缠论配置
 */
export interface ChanConfig {
  fractal?: FractalConfig;
  stroke?: StrokeConfig;
  center?: CenterConfig;
}

/**
 * 分型识别配置
 */
export interface FractalConfig {
  strict_mode: boolean;        // 严格模式: 要求明显高低点差异
  min_gap_percent: number;     // 最小价格差异百分比 (默认0.3%)
  allow_equal: boolean;        // 是否允许相等K线
  merge_nearby: boolean;       // 合并相邻分型 (默认true, 5根K线内)
  merge_distance: number;      // 合并距离(K线数)
}

/**
 * 笔构建配置
 */
export interface StrokeConfig {
  min_amplitude: number;       // 最小振幅百分比 (默认1.5%)
  min_klines: number;          // 最少K线数 (默认5根)
  max_retracement: number;     // 最大回撤百分比 (默认0.3, 即30%)
  require_volume_confirm: boolean; // 是否需要成交量确认
}

/**
 * 中枢识别配置
 */
export interface CenterConfig {
  min_strokes: number;         // 最少笔数 (默认3)
  overlap_threshold: number;   // 重叠度阈值 (默认0.7, 即70%)
  max_duration: number;        // 最大持续K线数 (默认100)
  min_height_percent: number;  // 最小高度百分比 (默认1%)

  // 扩展配置
  extension_mode: 'strict' | 'loose'; // 严格/宽松扩展
  max_extensions: number;      // 最多扩展次数 (默认9)

  // 成交量配置
  require_volume_decline: boolean; // 是否要求成交量递减
  volume_decline_threshold: number; // 成交量递减阈值
}

/**
 * 默认配置
 */
export const DEFAULT_CHAN_CONFIG: Required<ChanConfig> = {
  fractal: {
    strict_mode: true,
    min_gap_percent: 0.3,
    allow_equal: false,
    merge_nearby: true,
    merge_distance: 5
  },
  stroke: {
    min_amplitude: 1.5,
    min_klines: 5,
    max_retracement: 0.3,
    require_volume_confirm: false
  },
  center: {
    min_strokes: 3,
    overlap_threshold: 0.7,
    max_duration: 100,
    min_height_percent: 1.0,
    extension_mode: 'strict',
    max_extensions: 9,
    require_volume_decline: false,
    volume_decline_threshold: 0.2
  }
};
