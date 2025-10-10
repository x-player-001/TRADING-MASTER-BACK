/**
 * 量化策略相关类型定义
 */

/**
 * 策略类型枚举
 */
export enum StrategyType {
  BREAKOUT = 'breakout',              // 突破策略
  TREND_FOLLOWING = 'trend_following' // 趋势跟踪策略
}

/**
 * 运行模式枚举
 */
export enum StrategyMode {
  BACKTEST = 'backtest', // 回测模式
  PAPER = 'paper',       // 模拟交易
  LIVE = 'live'          // 实盘交易
}

/**
 * 策略配置接口
 */
export interface StrategyConfig {
  id?: number;
  name: string;
  type: StrategyType;
  description?: string;
  parameters: Record<string, any>;
  enabled: boolean;
  mode: StrategyMode;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 突破策略参数
 */
export interface BreakoutStrategyParams {
  lookback_period: number;      // 回看周期
  min_range_touches: number;    // 最小触碰次数
  min_confidence: number;       // 最小置信度
  min_volume_surge: number;     // 最小成交量倍数
  min_strength: number;         // 最小强度
  min_risk_reward: number;      // 最小风险回报比
}

/**
 * 趋势跟踪策略参数
 */
export interface TrendFollowingStrategyParams {
  fast_ma_period: number;       // 快速均线周期
  slow_ma_period: number;       // 慢速均线周期
  trend_ma_period: number;      // 趋势均线周期
  rsi_period: number;           // RSI周期
  rsi_oversold: number;         // RSI超卖阈值
  rsi_overbought: number;       // RSI超买阈值
  min_trend_strength: number;   // 最小趋势强度
}

/**
 * 策略性能统计
 */
export interface StrategyPerformance {
  id?: number;
  strategy_id: number;
  total_backtests: number;
  total_trades: number;
  win_trades: number;
  loss_trades: number;
  win_rate: number;
  avg_return: number;
  best_return: number;
  worst_return: number;
  avg_sharpe: number;
  avg_max_drawdown: number;
  last_backtest_at?: Date;
  updated_at?: Date;
}

/**
 * 创建策略请求
 */
export interface CreateStrategyRequest {
  name: string;
  type: StrategyType;
  description?: string;
  parameters: Record<string, any>;
  mode?: StrategyMode;
}

/**
 * 更新策略请求
 */
export interface UpdateStrategyRequest {
  name?: string;
  description?: string;
  parameters?: Record<string, any>;
  enabled?: boolean;
  mode?: StrategyMode;
}
