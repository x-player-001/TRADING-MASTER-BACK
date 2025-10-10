/**
 * 回测相关类型定义
 */

/**
 * 回测结果
 */
export interface BacktestResult {
  id?: number;
  strategy_id: number;
  symbol: string;
  interval: string;
  start_time: number;
  end_time: number;
  initial_capital: number;
  final_capital: number;
  total_return: number;
  annual_return: number;
  sharpe_ratio: number;
  max_drawdown: number;
  win_rate: number;
  total_trades: number;
  avg_trade_duration: number;
  profit_factor: number;
  performance_data: PerformanceData;
  created_at?: Date;
}

/**
 * 性能数据（详细指标）
 */
export interface PerformanceData {
  equity_curve: EquityPoint[];           // 资金曲线
  drawdown_curve: DrawdownPoint[];       // 回撤曲线
  monthly_returns: MonthlyReturn[];      // 月度收益
  trade_distribution: TradeDistribution; // 交易分布
}

/**
 * 资金曲线点
 */
export interface EquityPoint {
  timestamp: number;
  equity: number;
  return_pct: number;
}

/**
 * 回撤曲线点
 */
export interface DrawdownPoint {
  timestamp: number;
  drawdown_pct: number;
}

/**
 * 月度收益
 */
export interface MonthlyReturn {
  year: number;
  month: number;
  return_pct: number;
  trades: number;
}

/**
 * 交易分布
 */
export interface TradeDistribution {
  win_count: number;
  loss_count: number;
  avg_win: number;
  avg_loss: number;
  max_win: number;
  max_loss: number;
  avg_holding_time: number;
}

/**
 * 回测请求参数
 */
export interface BacktestRequest {
  strategy_id: number;
  symbol: string;
  interval: string;
  start_time: number;
  end_time: number;
  initial_capital: number;
}

/**
 * 回测对比请求
 */
export interface BacktestCompareRequest {
  backtest_ids: number[];
}

/**
 * 回测进度
 */
export interface BacktestProgress {
  total_bars: number;
  processed_bars: number;
  current_time: number;
  current_equity: number;
  elapsed_ms: number;
}
