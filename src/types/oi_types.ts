/**
 * OI (Open Interest) 相关类型定义
 */

// 合约币种配置
export interface ContractSymbolConfig {
  id?: number;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  contract_type: 'PERPETUAL' | 'FUTURES';
  status: 'TRADING' | 'BREAK';
  enabled: boolean;
  priority: number;
  created_at?: Date;
  updated_at?: Date;
}

// OI快照数据
export interface OpenInterestSnapshot {
  id?: number;
  symbol: string;
  open_interest: number;
  timestamp_ms: number;
  snapshot_time: Date;
  data_source: string;

  // 资金费率相关字段（可选，向后兼容）
  mark_price?: number;          // 标记价格
  funding_rate?: number;        // 资金费率
  next_funding_time?: number;   // 下次资金费时间（毫秒时间戳）

  created_at?: Date;
}

// OI异动记录
export interface OIAnomalyRecord {
  id?: number;
  symbol: string;
  period_seconds: number;
  percent_change: number;
  oi_before: number;
  oi_after: number;
  oi_change: number;
  threshold_value: number;
  anomaly_time: Date;
  severity: 'low' | 'medium' | 'high';
  anomaly_type: 'oi' | 'funding_rate' | 'both';  // 异动类型
  created_at?: Date;

  // 价格变化相关字段
  price_before?: number;
  price_after?: number;
  price_change?: number;
  price_change_percent?: number;

  // 资金费率变化相关字段
  funding_rate_before?: number;
  funding_rate_after?: number;
  funding_rate_change?: number;
  funding_rate_change_percent?: number;

  // 市场情绪相关字段
  top_trader_long_short_ratio?: number;    // 大户持仓量多空比
  top_account_long_short_ratio?: number;   // 大户账户数多空比
  global_long_short_ratio?: number;        // 全市场多空人数比
  taker_buy_sell_ratio?: number;           // 主动买卖量比

  // 交易信号评分相关字段
  signal_score?: number;                   // 信号总分 (0-10)
  signal_confidence?: number;              // 信号置信度 (0-1)
  signal_direction?: 'LONG' | 'SHORT' | 'NEUTRAL';  // 信号方向
  avoid_chase_reason?: string;             // 避免追高原因（如果被拒绝）

  // 每日价格极值相关字段
  daily_price_low?: number;                // 触发时的日内最低价
  daily_price_high?: number;               // 触发时的日内最高价
  price_from_low_pct?: number;             // 相对日内低点的涨幅(%)
  price_from_high_pct?: number;            // 相对日内高点的跌幅(%)
}

// OI监控配置
export interface OIMonitoringConfig {
  id?: number;
  config_key: string;
  config_value: string;
  description?: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

// 币安开放利息API响应
export interface BinanceOpenInterestResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

// 币安交易信息API响应
export interface BinanceExchangeInfoSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
}

export interface BinanceExchangeInfoResponse {
  symbols: BinanceExchangeInfoSymbol[];
}

// 币安标记价格和资金费率API响应
export interface BinancePremiumIndexResponse {
  symbol: string;                // "BTCUSDT"
  markPrice: string;             // "89234.56" 标记价格
  indexPrice: string;            // "89123.45" 指数价格
  estimatedSettlePrice: string;  // "89100.00" 预估结算价
  lastFundingRate: string;       // "0.00010000" 最近更新的资金费率
  interestRate: string;          // "0.00010000" 标的资产基础利率
  nextFundingTime: number;       // 1597392000000 下次资金费时间
  time: number;                  // 1597370495002 更新时间
}

// 币安市场情绪API响应 - 大户持仓量多空比
export interface BinanceTopLongShortPositionRatioResponse {
  symbol: string;
  longShortRatio: string;   // 大户多空持仓量比值
  longAccount: string;      // 大户多仓持仓量比例
  shortAccount: string;     // 大户空仓持仓量比例
  timestamp: number;
}

// 币安市场情绪API响应 - 大户账户数多空比
export interface BinanceTopLongShortAccountRatioResponse {
  symbol: string;
  longShortRatio: string;   // 大户多空账户数比值
  longAccount: string;      // 大户多仓账户数比例
  shortAccount: string;     // 大户空仓账户数比例
  timestamp: number;
}

// 币安市场情绪API响应 - 全市场多空人数比
export interface BinanceGlobalLongShortAccountRatioResponse {
  symbol: string;
  longShortRatio: string;   // 多空人数比值
  longAccount: string;      // 多仓人数比例
  shortAccount: string;     // 空仓人数比例
  timestamp: number;
}

// 币安市场情绪API响应 - 主动买卖量
export interface BinanceTakerBuySellVolumeResponse {
  symbol: string;
  buySellRatio: string;     // 买卖比值
  buyVol: string;           // 主动买入量
  sellVol: string;          // 主动卖出量
  timestamp: number;
}

// 市场情绪数据聚合
export interface MarketSentimentData {
  symbol: string;
  top_trader_long_short_ratio: number;    // 大户持仓量多空比
  top_account_long_short_ratio: number;   // 大户账户数多空比
  global_long_short_ratio: number;        // 全市场多空人数比
  taker_buy_sell_ratio: number;           // 主动买卖量比
  timestamp: number;                       // 数据时间戳
  fetched_at: number;                     // 获取时间戳（用于缓存判断）
}

// OI数据轮询结果
export interface OIPollingResult {
  symbol: string;
  open_interest: number;
  timestamp_ms: number;
}

// OI异动检测结果
export interface OIAnomalyDetectionResult {
  symbol: string;
  period_minutes: number;
  percent_change: number;
  oi_before: number;
  oi_after: number;
  threshold: number;
  severity: 'low' | 'medium' | 'high';
  anomaly_type: 'oi' | 'funding_rate' | 'both';  // 异动类型

  // 价格变化相关字段
  price_before?: number;           // 变化前价格
  price_after?: number;            // 变化后价格
  price_change?: number;           // 价格绝对变化量
  price_change_percent?: number;   // 价格变化百分比

  // 资金费率变化相关字段
  funding_rate_before?: number;
  funding_rate_after?: number;
  funding_rate_change?: number;
  funding_rate_change_percent?: number;
}

// 阈值配置
export interface ThresholdConfig {
  [periodSeconds: number]: number; // 时间周期(秒) -> 阈值(%)
}

// 非交易时段配置
export interface OffHoursConfig {
  start: number;    // 开始小时 (0-23)
  end: number;      // 结束小时 (0-23)
  interval_ms: number; // 轮询间隔(毫秒)
}

// OI监控系统配置
export interface OIMonitoringSystemConfig {
  polling_interval_ms: number;
  max_concurrent_requests: number;
  max_monitored_symbols: number | 'max'; // 最大监控币种数量，'max'表示不限制
  thresholds: ThresholdConfig;
  symbol_refresh_interval_ms: number;
  off_hours_config: OffHoursConfig;
}

// API查询参数
export interface OISnapshotQueryParams {
  symbol?: string;
  start_time?: Date;
  end_time?: Date;
  order?: 'ASC' | 'DESC';
}

export interface OIAnomalyQueryParams {
  symbol?: string;
  period_seconds?: number;
  date?: string; // 查询日期，格式: YYYY-MM-DD，如 2024-01-15。不传则返回最近数据
  start_time?: Date; // 内部使用，从date计算得出
  end_time?: Date;   // 内部使用，从date计算得出
  severity?: 'low' | 'medium' | 'high';
  order?: 'ASC' | 'DESC';
}

export interface OIStatisticsQueryParams {
  symbol?: string;
  date?: string; // 查询日期，格式: YYYY-MM-DD，如 2024-01-15。不传则返回最近24小时数据
}

// 统计数据类型
export interface OIStatistics {
  symbol: string;
  latest_oi: number;
  daily_change_pct: number;
  anomaly_count_24h: number;
  last_anomaly_time?: Date;
  first_anomaly_time?: Date;
}

// 错误类型
export interface OIMonitoringError {
  code: string;
  message: string;
  symbol?: string;
  timestamp: Date;
  details?: any;
}

// 系统状态
export interface OIMonitoringStatus {
  is_running: boolean;
  last_poll_time?: Date;
  active_symbols_count: number;
  total_snapshots_today: number;
  total_anomalies_today: number;
  error_count_today: number;
  uptime_ms: number;
}