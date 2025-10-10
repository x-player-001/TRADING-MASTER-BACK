/**
 * 结构性形态类型定义
 */

import { KlineData } from './common';

/**
 * 结构形态类型
 */
export enum StructureType {
  RANGE = 'range',                          // 交易区间
  DOUBLE_BOTTOM = 'double_bottom',          // 双底
  DOUBLE_TOP = 'double_top',                // 双顶
  HEAD_SHOULDERS_TOP = 'head_shoulders_top', // 头肩顶
  HEAD_SHOULDERS_BOTTOM = 'head_shoulders_bottom', // 头肩底
  ASCENDING_TRIANGLE = 'ascending_triangle', // 上升三角
  DESCENDING_TRIANGLE = 'descending_triangle', // 下降三角
  SYMMETRICAL_TRIANGLE = 'symmetrical_triangle', // 对称三角
  BULL_FLAG = 'bull_flag',                  // 牛市旗形
  BEAR_FLAG = 'bear_flag'                   // 熊市旗形
}

/**
 * 突破状态
 */
export enum BreakoutStatus {
  FORMING = 'forming',       // 形态形成中
  BROKEN_UP = 'broken_up',   // 向上突破
  BROKEN_DOWN = 'broken_down', // 向下突破
  FAILED = 'failed'          // 突破失败
}

/**
 * 交易区间结构
 */
export interface RangeBox {
  id?: number;
  symbol: string;
  interval: string;
  type: StructureType.RANGE;

  // 区间边界
  resistance: number;          // 阻力位 (区间顶部)
  support: number;             // 支撑位 (区间底部)
  middle: number;              // 中轴

  // 区间统计
  range_size: number;          // 区间宽度 (阻力-支撑)
  range_percent: number;       // 区间百分比 (宽度/中轴 * 100)
  touch_count: number;         // 触碰次数 (支撑+阻力)
  support_touches: number;     // 支撑触碰次数
  resistance_touches: number;  // 阻力触碰次数
  duration_bars: number;       // 持续K线数

  // 突破预警
  near_resistance: boolean;    // 接近阻力位 (97%以上)
  near_support: boolean;       // 接近支撑位 (103%以下)
  breakout_direction: null | 'up' | 'down'; // 突破方向

  // 可靠性
  confidence: number;          // 0-1, 基于触碰次数和持续时间
  strength: number;            // 0-100

  // 时间范围
  start_time: number;          // 区间开始时间(毫秒)
  end_time: number;            // 区间结束时间(毫秒)

  // 成交量特征
  avg_volume: number;          // 区间内平均成交量
  volume_trend: 'increasing' | 'decreasing' | 'stable'; // 成交量趋势

  // 元数据
  pattern_data?: any;          // 详细形态数据(JSON)
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 双底/双顶结构
 */
export interface DoublePattern {
  id?: number;
  symbol: string;
  interval: string;
  type: StructureType.DOUBLE_BOTTOM | StructureType.DOUBLE_TOP;

  // 两个底/顶的位置
  first_point: {
    price: number;
    time: number;
    index: number;            // K线索引
  };
  second_point: {
    price: number;
    time: number;
    index: number;
  };

  // 颈线位
  neckline: number;           // 颈线价格
  neckline_time: number;      // 颈线时间

  // 形态特征
  symmetry: number;           // 对称性 0-1 (1表示完全对称)
  spacing_bars: number;       // 两个点的间距 (K线数)
  depth: number;              // 形态深度 (颈线到底部的距离)
  depth_percent: number;      // 深度百分比

  // 突破信号
  breakout_status: BreakoutStatus;
  breakout_time?: number;
  breakout_price?: number;
  breakout_volume_ratio?: number; // 突破量/平均量

  // 目标和止损
  target_price: number;       // 目标价 = 颈线 ± 深度
  stop_loss: number;          // 止损价
  risk_reward_ratio: number;  // 风险收益比

  confidence: number;
  strength: number;

  start_time: number;
  end_time: number;
  duration_bars: number;

  pattern_data?: any;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 突破信号
 */
export interface BreakoutSignal {
  id?: number;
  structure_id?: number;      // 关联的结构形态ID
  symbol: string;
  interval: string;

  // 突破信息
  breakout_direction: 'up' | 'down';
  breakout_price: number;
  previous_range_high: number;
  previous_range_low: number;
  breakout_strength: number;  // 0-100

  // 成交量确认
  breakout_volume: number;
  avg_volume: number;
  volume_ratio: number;       // 突破量/平均量

  // 目标和止损
  target_price: number;
  stop_loss: number;
  risk_reward_ratio: number;

  // 结果追踪
  result: 'pending' | 'hit_target' | 'hit_stop' | 'failed';
  result_time?: number;
  max_profit_percent?: number;
  max_loss_percent?: number;

  breakout_time: number;
  created_at?: Date;
}

/**
 * 结构识别结果
 */
export interface StructureDetectionResult {
  ranges: RangeBox[];
  double_patterns: DoublePattern[];
  breakout_signals: BreakoutSignal[];
}
