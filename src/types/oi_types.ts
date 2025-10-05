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
  created_at?: Date;
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
  avg_oi_24h: number;
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