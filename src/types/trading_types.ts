/**
 * 交易系统类型定义
 */

import { OIAnomalyRecord } from './oi_types';

// ==================== 交易信号 ====================

/**
 * 信号方向
 */
export enum SignalDirection {
  LONG = 'LONG',   // 做多
  SHORT = 'SHORT', // 做空
  NEUTRAL = 'NEUTRAL' // 中性（不交易）
}

/**
 * 信号强度
 */
export enum SignalStrength {
  WEAK = 'WEAK',       // 弱信号（1-3分）
  MEDIUM = 'MEDIUM',   // 中等信号（4-6分）
  STRONG = 'STRONG'    // 强信号（7-10分）
}

/**
 * 分批止盈目标
 */
export interface TakeProfitTarget {
  percentage: number;       // 仓位百分比（如40表示40%仓位）
  price: number;            // 止盈价格
  target_profit_pct: number;// 目标收益率（如6表示+6%）
  is_trailing: boolean;     // 是否使用跟踪止盈
  trailing_callback_pct?: number; // 跟踪回调百分比（如30表示保留30%利润空间）
}

/**
 * 动态止盈配置
 */
export interface DynamicTakeProfitConfig {
  targets: TakeProfitTarget[];     // 分批止盈目标
  enable_trailing: boolean;         // 是否启用跟踪止盈
  trailing_start_profit_pct: number;// 启动跟踪的最低盈利（如首次止盈达到后）
}

/**
 * 交易信号
 */
export interface TradingSignal {
  symbol: string;                    // 交易对（如BTCUSDT）
  direction: SignalDirection;        // 信号方向
  strength: SignalStrength;          // 信号强度
  score: number;                     // 评分（0-10）
  confidence: number;                // 置信度（0-1）

  // 信号来源
  source_anomaly_id?: number;        // 来源异动记录ID
  triggered_at: Date;                // 信号触发时间

  // 价格信息
  entry_price?: number;              // 建议入场价格
  stop_loss?: number;                // 建议止损价格
  take_profit?: number;              // 建议止盈价格（主要目标）

  // 动态止盈配置（新增）
  dynamic_take_profit?: DynamicTakeProfitConfig;

  // 评分细节
  score_breakdown?: SignalScoreBreakdown;

  // 原始数据
  anomaly_data?: OIAnomalyRecord;
}

/**
 * 信号评分明细
 */
export interface SignalScoreBreakdown {
  oi_score: number;              // OI变化评分（0-3）
  price_score: number;           // 价格变化评分（0-2）
  sentiment_score: number;       // 市场情绪评分（0-3）
  funding_rate_score: number;    // 资金费率评分（0-2）
  total_score: number;           // 总分（0-10）
}

// ==================== 策略配置 ====================

/**
 * 策略类型
 */
export enum StrategyType {
  TREND_FOLLOWING = 'TREND_FOLLOWING',     // 趋势跟随
  MEAN_REVERSION = 'MEAN_REVERSION',       // 均值回归
  SENTIMENT_BASED = 'SENTIMENT_BASED',     // 情绪驱动
  BREAKOUT = 'BREAKOUT'                    // 突破策略
}

/**
 * 策略配置
 */
export interface StrategyConfig {
  strategy_type: StrategyType;
  enabled: boolean;

  // 信号过滤阈值
  min_signal_score: number;          // 最低信号评分（默认6）
  min_confidence: number;            // 最低置信度（默认0.6）
  min_oi_change_percent: number;     // 最低OI变化百分比（默认3%）

  // OI和价格关联性
  require_price_oi_alignment: boolean;  // 是否要求价格和OI同向
  price_oi_divergence_threshold: number; // 背离阈值

  // 市场情绪过滤
  use_sentiment_filter: boolean;     // 是否使用情绪过滤
  min_trader_ratio: number;          // 最小大户多空比

  // 资金费率过滤
  max_funding_rate: number;          // 最大资金费率（防止过热）
  min_funding_rate: number;          // 最小资金费率
}

// ==================== 风险管理 ====================

/**
 * 分批止盈目标配置
 */
export interface TakeProfitTargetConfig {
  percentage: number;              // 仓位百分比（如30表示30%）
  target_profit_pct: number;       // 目标收益率（如8表示+8%）
  is_trailing?: boolean;           // 是否使用跟踪止盈
  trailing_callback_pct?: number;  // 跟踪回调百分比（如15表示回调15%时平仓）
  activation_profit_pct?: number;  // 跟踪止盈激活价格（如5表示涨+5%后才开始跟踪）
}

/**
 * 风险配置
 */
export interface RiskConfig {
  // 资金管理
  max_position_size_percent: number;     // 单笔最大仓位百分比（默认3%）
  max_total_positions: number;           // 最大同时持仓数（默认5）
  max_positions_per_symbol: number;      // 单币种最大持仓数（默认1）

  // 止损止盈
  default_stop_loss_percent: number;     // 默认止损百分比（默认2%）
  default_take_profit_percent: number;   // 默认止盈百分比（默认5%）
  use_trailing_stop: boolean;            // 是否使用移动止损
  trailing_stop_callback_rate: number;   // 移动止损回调率（默认1%）

  // 分批止盈配置（可选，不配置则使用默认的单批止盈）
  take_profit_targets?: TakeProfitTargetConfig[];

  // 熔断机制
  daily_loss_limit_percent: number;      // 每日最大亏损百分比（默认5%）
  consecutive_loss_limit: number;        // 连续亏损次数限制（默认3）
  pause_after_loss_limit: boolean;       // 达到亏损限制后是否暂停

  // 杠杆控制
  max_leverage: number;                  // 最大杠杆倍数（默认3）
  leverage_by_signal_strength: {        // 根据信号强度调整杠杆
    weak: number;
    medium: number;
    strong: number;
  };
}

// ==================== 订单和持仓 ====================

/**
 * 订单类型
 */
export enum OrderType {
  MARKET = 'MARKET',       // 市价单
  LIMIT = 'LIMIT',         // 限价单
  STOP_MARKET = 'STOP_MARKET',   // 止损市价单
  TAKE_PROFIT_MARKET = 'TAKE_PROFIT_MARKET'  // 止盈市价单
}

/**
 * 订单状态
 */
export enum OrderStatus {
  PENDING = 'PENDING',         // 待提交
  SUBMITTED = 'SUBMITTED',     // 已提交
  FILLED = 'FILLED',           // 已成交
  PARTIALLY_FILLED = 'PARTIALLY_FILLED', // 部分成交
  CANCELLED = 'CANCELLED',     // 已取消
  REJECTED = 'REJECTED',       // 被拒绝
  EXPIRED = 'EXPIRED'          // 已过期
}

/**
 * 持仓方向
 */
export enum PositionSide {
  LONG = 'LONG',
  SHORT = 'SHORT'
}

/**
 * 订单记录
 */
export interface OrderRecord {
  id?: number;
  order_id?: string;              // 币安订单ID
  symbol: string;
  order_type: OrderType;
  side: PositionSide;
  quantity: number;
  price?: number;

  status: OrderStatus;
  filled_quantity?: number;
  average_price?: number;

  // 关联信息
  signal_id?: number;
  position_id?: number;

  // 时间戳
  created_at?: Date;
  updated_at?: Date;
  filled_at?: Date;

  // 币安返回的原始数据
  binance_response?: any;

  // 错误信息
  error_message?: string;
}

/**
 * 持仓记录
 */
export interface PositionRecord {
  id?: number;
  symbol: string;
  side: PositionSide;

  // 仓位信息
  entry_price: number;
  current_price: number;
  quantity: number;
  leverage: number;

  // 盈亏信息
  unrealized_pnl: number;        // 未实现盈亏
  unrealized_pnl_percent: number; // 未实现盈亏百分比
  realized_pnl?: number;          // 已实现盈亏

  // 止损止盈
  stop_loss_price?: number;
  take_profit_price?: number;

  // 关联信息
  signal_id?: number;
  entry_order_id?: number;
  exit_order_id?: number;        // 平仓订单ID（用于查询手续费）

  // 状态
  is_open: boolean;

  // 时间戳
  opened_at: Date;
  closed_at?: Date;
  updated_at?: Date;

  // 平仓原因
  close_reason?: 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'MANUAL' | 'RISK_LIMIT' | 'TIMEOUT' | 'SYNC_CLOSED';

  // 保证金（同步用）
  margin?: number;

  // 保本止损标记（盈利达到阈值后是否已下保本止损单）
  breakeven_sl_placed?: boolean;

  // 分批止盈记录（新增）
  take_profit_executions?: TakeProfitExecution[];

  // 新表关联字段
  position_id?: string;           // 持仓周期ID（用于关联 order_records 表）
  legacy_db_id?: number;          // 旧表 trade_records 的 ID（兼容过渡期）
}

/**
 * 分批止盈执行记录
 */
export interface TakeProfitExecution {
  batch_number: number;           // 批次编号（1, 2, 3...）
  type: 'BATCH_TAKE_PROFIT' | 'TRAILING_STOP';  // 止盈类型
  quantity: number;               // 平仓数量
  exit_price: number;             // 平仓价格
  pnl: number;                    // 该批次盈亏
  profit_percent: number;         // 盈利百分比
  executed_at: Date;              // 执行时间
  reason: string;                 // 触发原因
}

// ==================== 交易模式 ====================

/**
 * 交易模式
 */
export enum TradingMode {
  PAPER = 'PAPER',         // 纸面交易（模拟）
  TESTNET = 'TESTNET',     // 测试网
  LIVE = 'LIVE'            // 实盘
}

/**
 * 交易系统配置
 */
export interface TradingSystemConfig {
  mode: TradingMode;
  enabled: boolean;

  // 初始资金（用于计算仓位大小）
  initial_balance?: number;

  // 策略配置
  strategies: StrategyConfig[];
  active_strategy_type: StrategyType;

  // 风险配置
  risk_config: RiskConfig;

  // 交易时段
  trading_hours?: {
    start_hour: number;
    end_hour: number;
    timezone: string;
  };

  // 币种白名单/黑名单
  symbol_whitelist?: string[];
  symbol_blacklist?: string[];

  // 方向过滤（只做多或只做空）
  allowed_directions?: ('LONG' | 'SHORT')[];

  // 最大持仓时间（分钟）
  max_holding_time_minutes?: number;

  // 通知配置
  enable_notifications: boolean;
  notification_channels?: ('email' | 'webhook' | 'telegram')[];
}

// ==================== 统计和回测 ====================

/**
 * 交易统计
 */
export interface TradingStatistics {
  // 基础统计
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;                // 胜率

  // 盈亏统计
  total_pnl: number;               // 总盈亏
  average_win: number;             // 平均盈利
  average_loss: number;            // 平均亏损
  profit_factor: number;           // 盈亏比

  // 手续费统计
  total_commission: number;        // 总手续费
  net_pnl: number;                 // 净盈亏 (total_pnl - total_commission)

  // 回撤统计
  max_drawdown: number;            // 最大回撤
  max_drawdown_percent: number;

  // 时间统计
  average_hold_time: number;       // 平均持仓时间（分钟）
  longest_winning_streak: number;  // 最长连胜
  longest_losing_streak: number;   // 最长连亏

  // 风险指标
  sharpe_ratio?: number;           // 夏普比率

  // 时间范围
  period_start: Date;
  period_end: Date;
}

/**
 * 回测配置
 */
export interface BacktestConfig {
  start_date: Date;                // 回测开始日期
  end_date: Date;                  // 回测结束日期
  initial_balance: number;         // 初始资金

  // 策略和风险配置
  strategy_config: StrategyConfig;
  risk_config: RiskConfig;

  // 分批止盈配置（新增）
  dynamic_take_profit?: DynamicTakeProfitConfig;

  // 回测参数
  max_holding_time_minutes?: number;  // 最大持仓时间（分钟，默认60）
  use_slippage?: boolean;             // 是否模拟滑点（默认true）
  slippage_percent?: number;          // 滑点百分比（默认0.1%）
  commission_percent?: number;        // 手续费百分比（默认0.05%）

  // 过滤条件
  symbols?: string[];                 // 限制回测的币种
  min_anomaly_severity?: 'low' | 'medium' | 'high';  // 最低异动严重程度
  allowed_directions?: ('LONG' | 'SHORT')[];  // 允许的交易方向（默认['LONG', 'SHORT']）

  // 追高阈值配置
  chase_high_threshold?: number;      // 避免追高阈值百分比（默认10%）
}

/**
 * 回测结果
 */
export interface BacktestResult {
  id?: string;                     // 回测ID
  config: BacktestConfig;
  strategy_type: StrategyType;

  statistics: TradingStatistics;

  // 详细记录
  trades: PositionRecord[];
  signals: TradingSignal[];
  rejected_signals: {
    signal: TradingSignal;
    reason: string;
  }[];

  // 资金曲线
  equity_curve: {
    timestamp: Date;
    equity: number;
    drawdown_percent: number;
  }[];

  // 回测元数据
  execution_time_ms: number;       // 执行耗时
  created_at: Date;
}

/**
 * 历史价格快照
 */
export interface HistoricalPriceSnapshot {
  timestamp: Date;
  timestamp_ms: number;
  price: number;
  open_interest?: number;
}
