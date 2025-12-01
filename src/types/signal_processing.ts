/**
 * 信号处理记录类型定义
 */

export enum SignalProcessingResult {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED'
}

export enum RejectionCategory {
  DAILY_LOSS_LIMIT = 'DAILY_LOSS_LIMIT',              // 达到日亏损限制
  MAX_POSITIONS_LIMIT = 'MAX_POSITIONS_LIMIT',        // 达到最大持仓数量
  POSITION_EXISTS = 'POSITION_EXISTS',                // 已有该币种持仓
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',      // 余额不足
  SIGNAL_SCORE_TOO_LOW = 'SIGNAL_SCORE_TOO_LOW',      // 信号评分过低
  MARKET_CONDITIONS = 'MARKET_CONDITIONS',            // 市场条件不满足
  RISK_MANAGEMENT = 'RISK_MANAGEMENT',                // 风控拒绝
  SYSTEM_ERROR = 'SYSTEM_ERROR',                      // 系统错误
  OTHER = 'OTHER'                                     // 其他原因
}

export enum SignalDirection {
  LONG = 'LONG',
  SHORT = 'SHORT'
}

export interface SignalProcessingRecord {
  id?: number;

  // 信号基本信息
  signal_id?: string;
  anomaly_id?: number;
  symbol: string;
  signal_direction: SignalDirection;
  signal_score?: number;
  signal_source?: string;

  // 处理结果
  processing_result: SignalProcessingResult;
  rejection_reason?: string;
  rejection_category?: RejectionCategory;

  // 交易执行信息（如果接受）
  order_id?: string;
  position_id?: string;
  entry_price?: number;
  quantity?: number;
  position_value_usd?: number;

  // 风控信息
  current_daily_loss?: number;
  current_open_positions?: number;
  available_balance?: number;

  // 时间信息
  signal_received_at: Date;
  processed_at?: Date;

  // 额外信息
  error_message?: string;
  metadata?: Record<string, any>;
}

/**
 * 创建信号处理记录的输入参数
 */
export interface CreateSignalProcessingRecordInput {
  // 信号信息
  signal_id?: string;
  anomaly_id?: number;
  symbol: string;
  signal_direction: SignalDirection;
  signal_score?: number;
  signal_source?: string;

  // 处理结果
  processing_result: SignalProcessingResult;
  rejection_reason?: string;
  rejection_category?: RejectionCategory;

  // 交易执行信息（如果接受）
  order_id?: string;
  position_id?: string;
  entry_price?: number;
  quantity?: number;
  position_value_usd?: number;

  // 风控信息
  current_daily_loss?: number;
  current_open_positions?: number;
  available_balance?: number;

  // 时间信息
  signal_received_at?: Date;

  // 额外信息
  error_message?: string;
  metadata?: Record<string, any>;
}
