/**
 * 订单簿监控相关类型定义
 */

/**
 * 币安订单簿深度更新数据格式
 */
export interface BinanceDepthUpdate {
  e: 'depthUpdate';           // 事件类型
  E: number;                   // 事件时间 (ms)
  T: number;                   // 交易时间 (ms)
  s: string;                   // 交易对 (BTCUSDT)
  U: number;                   // 首次更新ID
  u: number;                   // 末次更新ID
  pu: number;                  // 上次末次更新ID
  b: [string, string][];       // 买盘 [[价格, 数量], ...]
  a: [string, string][];       // 卖盘 [[价格, 数量], ...]
}

/**
 * 订单簿档位数据
 */
export interface OrderBookLevel {
  price: number;
  qty: number;
  value: number;               // 挂单价值 = price * qty (USDT)
}

/**
 * 订单簿快照
 */
export interface OrderBookSnapshot {
  symbol: string;
  timestamp: number;
  bids: OrderBookLevel[];      // 买盘 (价格降序)
  asks: OrderBookLevel[];      // 卖盘 (价格升序)
  bid_total_qty: number;       // 买盘总量
  ask_total_qty: number;       // 卖盘总量
  bid_total_value: number;     // 买盘总价值 (USDT)
  ask_total_value: number;     // 卖盘总价值 (USDT)
  current_price: number;       // 当前价格 (买一价)
}

/**
 * 报警类型枚举
 */
export enum OrderBookAlertType {
  BIG_ORDER = 'BIG_ORDER',           // 大单检测 (买单墙/卖单墙)
  IMBALANCE = 'IMBALANCE',           // 买卖失衡
  WITHDRAWAL = 'WITHDRAWAL'          // 大单撤销
}

/**
 * 报警严重程度
 */
export enum AlertSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH'
}

/**
 * 订单簿报警记录
 */
export interface OrderBookAlert {
  id?: number;
  symbol: string;
  alert_time: number;
  alert_type: OrderBookAlertType;
  side?: 'BID' | 'ASK';

  // 大单检测相关字段
  order_price?: number;
  order_qty?: number;
  order_value_usdt?: number;
  avg_order_qty?: number;
  order_ratio?: number;

  // 买卖失衡相关字段
  bid_total_qty?: number;
  ask_total_qty?: number;
  imbalance_ratio?: number;

  // 撤单检测相关字段
  prev_qty?: number;
  curr_qty?: number;
  withdrawn_qty?: number;
  withdrawn_value_usdt?: number;

  // 通用字段
  current_price: number;
  severity: AlertSeverity;
  is_important: boolean;
  created_at?: Date;
}

/**
 * 订单簿监控配置
 */
export interface OrderBookMonitorConfig {
  // 大单检测配置
  big_order_multiplier: number;        // 大单倍数阈值 (相对平均值，默认 10x)
  big_order_min_value_usdt: number;    // 最小大单价值 (USDT，默认 50000)

  // 买卖失衡配置
  imbalance_ratio_high: number;        // 高失衡阈值 (买/卖 > 2.0)
  imbalance_ratio_low: number;         // 低失衡阈值 (买/卖 < 0.5)
  imbalance_min_total_value: number;   // 最小总挂单价值 (防止小币种误报)

  // 撤单检测配置
  withdrawal_min_ratio: number;        // 最小撤单比例 (默认 80%)
  withdrawal_min_value_usdt: number;   // 最小撤单价值 (USDT，默认 100000)

  // 限频配置
  cooldown_ms: number;                 // 同一币种同类型报警冷却时间 (默认 5分钟)

  // 冷启动配置
  warmup_snapshots: number;            // 冷启动所需快照数 (默认 3)
}

/**
 * 默认配置
 */
export const DEFAULT_ORDERBOOK_CONFIG: OrderBookMonitorConfig = {
  big_order_multiplier: 15,
  big_order_min_value_usdt: 200000,
  imbalance_ratio_high: 3.0,
  imbalance_ratio_low: 0.33,
  imbalance_min_total_value: 1000000,
  withdrawal_min_ratio: 0.8,
  withdrawal_min_value_usdt: 500000,
  cooldown_ms: 5 * 60 * 1000,
  warmup_snapshots: 3
};

/**
 * 报警查询参数
 */
export interface OrderBookAlertQueryOptions {
  symbol?: string;
  date?: string;                       // YYYY-MM-DD (北京时间)
  alert_type?: OrderBookAlertType;
  side?: 'BID' | 'ASK';
  severity?: AlertSeverity;
  is_important?: boolean;
  start_time?: number;
  end_time?: number;
  limit?: number;
}

/**
 * 监控统计数据
 */
export interface OrderBookMonitorStatistics {
  total_alerts: number;
  big_order_alerts: number;
  imbalance_alerts: number;
  withdrawal_alerts: number;
  important_alerts: number;
  symbols_with_alerts: number;
}
