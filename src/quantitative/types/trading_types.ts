/**
 * 交易相关类型定义
 */

/**
 * 交易方向
 */
export enum TradeSide {
  LONG = 'LONG',   // 做多
  SHORT = 'SHORT'  // 做空
}

/**
 * 平仓原因
 */
export enum ExitReason {
  STOP_LOSS = 'stop_loss',       // 止损
  TAKE_PROFIT = 'take_profit',   // 止盈
  SIGNAL = 'signal',             // 信号反转
  TRAILING_STOP = 'trailing_stop', // 追踪止损
  TIMEOUT = 'timeout',           // 超时
  MANUAL = 'manual'              // 手动平仓
}

/**
 * 持仓状态
 */
export enum PositionStatus {
  OPEN = 'open',
  CLOSED = 'closed'
}

/**
 * 交易记录
 */
export interface Trade {
  id?: number;
  strategy_id: number;
  backtest_id?: number;
  symbol: string;
  interval: string;
  side: TradeSide;
  entry_price: number;
  exit_price: number;
  quantity: number;
  entry_time: number;
  exit_time: number;
  holding_duration: number;
  pnl: number;
  pnl_percent: number;
  commission: number;
  exit_reason: ExitReason;
  trade_data?: TradeData;
  created_at?: Date;
}

/**
 * 交易详情数据
 */
export interface TradeData {
  entry_indicators?: Record<string, any>;  // 入场时的指标
  exit_indicators?: Record<string, any>;   // 出场时的指标
  stop_loss?: number;
  take_profit?: number;
  max_favorable_excursion?: number;        // 最大有利偏移(MFE)
  max_adverse_excursion?: number;          // 最大不利偏移(MAE)
}

/**
 * 持仓
 */
export interface Position {
  id?: number;
  strategy_id: number;
  symbol: string;
  interval: string;
  side: TradeSide;
  entry_price: number;
  quantity: number;
  current_price?: number;
  stop_loss?: number;
  take_profit?: number;
  unrealized_pnl?: number;
  unrealized_pnl_percent?: number;
  status: PositionStatus;
  entry_time: number;
  close_time?: number;
  entry_indicators?: Record<string, any>;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 交易统计
 */
export interface TradeStatistics {
  total_trades: number;
  win_trades: number;
  loss_trades: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  avg_win: number;
  avg_loss: number;
  max_win: number;
  max_loss: number;
  profit_factor: number;
  avg_holding_duration: number;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
}

/**
 * 开仓信号
 */
export interface EntrySignal {
  symbol: string;
  interval: string;
  side: TradeSide;
  price: number;
  timestamp: number;
  indicators: Record<string, any>;
  confidence: number;
}

/**
 * 平仓信号
 */
export interface ExitSignal {
  position_id: number;
  reason: ExitReason;
  price: number;
  timestamp: number;
  indicators?: Record<string, any>;
}
