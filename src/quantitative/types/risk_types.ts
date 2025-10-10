/**
 * 风险管理相关类型定义
 */

/**
 * 风控配置
 */
export interface RiskConfig {
  id?: number;
  strategy_id: number;
  max_positions: number;              // 最大持仓数
  max_position_size_percent: number;  // 单仓最大占比%
  max_total_risk_percent: number;     // 总风险敞口%
  stop_loss_percent: number;          // 止损百分比%
  take_profit_percent: number;        // 止盈百分比%
  max_daily_loss_percent: number;     // 单日最大亏损%
  blacklist_symbols: string[];        // 黑名单币种
  updated_at?: Date;
}

/**
 * 风险检查结果
 */
export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  current_positions?: number;
  max_positions?: number;
  position_size?: number;
  max_position_size?: number;
  total_risk?: number;
  max_total_risk?: number;
  daily_loss?: number;
  max_daily_loss?: number;
  is_blacklisted?: boolean;
}

/**
 * 仓位计算结果
 */
export interface PositionSizeResult {
  quantity: number;              // 交易数量
  position_value: number;        // 仓位价值
  position_percent: number;      // 仓位占比%
  risk_amount: number;           // 风险金额
  stop_loss_price: number;       // 止损价格
  take_profit_price: number;     // 止盈价格
}

/**
 * 风险敞口
 */
export interface RiskExposure {
  strategy_id: number;
  total_positions: number;
  total_position_value: number;
  total_risk_amount: number;
  risk_percent: number;
  available_capital: number;
  daily_pnl: number;
  daily_loss_percent: number;
  positions_by_symbol: SymbolExposure[];
}

/**
 * 按币种的风险敞口
 */
export interface SymbolExposure {
  symbol: string;
  position_count: number;
  total_value: number;
  risk_amount: number;
  unrealized_pnl: number;
}

/**
 * 止损止盈计算参数
 */
export interface StopLossTakeProfitParams {
  entry_price: number;
  side: 'LONG' | 'SHORT';
  stop_loss_percent: number;
  take_profit_percent: number;
}

/**
 * 止损止盈结果
 */
export interface StopLossTakeProfitResult {
  stop_loss: number;
  take_profit: number;
  risk_amount: number;
  reward_amount: number;
  risk_reward_ratio: number;
}
