import { Trade } from '../types/trading_types';
import {
  EquityPoint,
  DrawdownPoint,
  MonthlyReturn,
  TradeDistribution,
  PerformanceData
} from '../types/backtest_types';

/**
 * 性能分析器
 * 负责计算各种回测性能指标
 */
export class PerformanceAnalyzer {

  /**
   * 计算总收益率
   */
  static calculate_total_return(initial_capital: number, final_capital: number): number {
    return ((final_capital - initial_capital) / initial_capital) * 100;
  }

  /**
   * 计算年化收益率
   */
  static calculate_annual_return(
    initial_capital: number,
    final_capital: number,
    start_time: number,
    end_time: number
  ): number {
    const days = (end_time - start_time) / (1000 * 60 * 60 * 24);
    const years = days / 365;

    if (years <= 0) {
      return 0;
    }

    const total_return = final_capital / initial_capital;
    const annual_return = (Math.pow(total_return, 1 / years) - 1) * 100;

    return annual_return;
  }

  /**
   * 计算夏普比率
   * 假设无风险利率为0
   */
  static calculate_sharpe_ratio(equity_curve: EquityPoint[]): number {
    if (equity_curve.length < 2) {
      return 0;
    }

    // 计算收益率序列
    const returns: number[] = [];
    for (let i = 1; i < equity_curve.length; i++) {
      const ret = equity_curve[i].return_pct;
      returns.push(ret);
    }

    if (returns.length === 0) {
      return 0;
    }

    // 计算平均收益率
    const avg_return = returns.reduce((sum, r) => sum + r, 0) / returns.length;

    // 计算标准差
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avg_return, 2), 0) / returns.length;
    const std_dev = Math.sqrt(variance);

    if (std_dev === 0) {
      return 0;
    }

    // 夏普比率 = 平均收益 / 标准差
    // 年化: 假设每天一个数据点
    const sharpe = (avg_return / std_dev) * Math.sqrt(252); // 252个交易日

    return sharpe;
  }

  /**
   * 计算最大回撤
   */
  static calculate_max_drawdown(equity_curve: EquityPoint[]): number {
    if (equity_curve.length === 0) {
      return 0;
    }

    let max_equity = equity_curve[0].equity;
    let max_drawdown = 0;

    for (const point of equity_curve) {
      if (point.equity > max_equity) {
        max_equity = point.equity;
      }

      const drawdown = ((point.equity - max_equity) / max_equity) * 100;
      if (drawdown < max_drawdown) {
        max_drawdown = drawdown;
      }
    }

    return max_drawdown;
  }

  /**
   * 计算胜率
   */
  static calculate_win_rate(trades: Trade[]): number {
    if (trades.length === 0) {
      return 0;
    }

    const win_count = trades.filter(t => t.pnl > 0).length;
    return (win_count / trades.length) * 100;
  }

  /**
   * 计算盈亏比 (Profit Factor)
   */
  static calculate_profit_factor(trades: Trade[]): number {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    const total_profit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const total_loss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

    if (total_loss === 0) {
      return total_profit > 0 ? 999 : 0;
    }

    return total_profit / total_loss;
  }

  /**
   * 计算平均持仓时长(秒)
   */
  static calculate_avg_trade_duration(trades: Trade[]): number {
    if (trades.length === 0) {
      return 0;
    }

    const total_duration = trades.reduce((sum, t) => sum + t.holding_duration, 0);
    return total_duration / trades.length;
  }

  /**
   * 生成资金曲线
   */
  static generate_equity_curve(
    initial_capital: number,
    trades: Trade[],
    start_time: number,
    end_time: number
  ): EquityPoint[] {
    const equity_curve: EquityPoint[] = [];

    // 起点
    equity_curve.push({
      timestamp: start_time,
      equity: initial_capital,
      return_pct: 0
    });

    if (trades.length === 0) {
      equity_curve.push({
        timestamp: end_time,
        equity: initial_capital,
        return_pct: 0
      });
      return equity_curve;
    }

    // 按时间排序交易
    const sorted_trades = [...trades].sort((a, b) => a.exit_time - b.exit_time);

    let current_equity = initial_capital;

    for (const trade of sorted_trades) {
      const prev_equity = current_equity;
      current_equity += trade.pnl;

      const return_pct = (trade.pnl / prev_equity) * 100;

      equity_curve.push({
        timestamp: trade.exit_time,
        equity: current_equity,
        return_pct
      });
    }

    return equity_curve;
  }

  /**
   * 生成回撤曲线
   */
  static generate_drawdown_curve(equity_curve: EquityPoint[]): DrawdownPoint[] {
    const drawdown_curve: DrawdownPoint[] = [];

    if (equity_curve.length === 0) {
      return drawdown_curve;
    }

    let max_equity = equity_curve[0].equity;

    for (const point of equity_curve) {
      if (point.equity > max_equity) {
        max_equity = point.equity;
      }

      const drawdown_pct = ((point.equity - max_equity) / max_equity) * 100;

      drawdown_curve.push({
        timestamp: point.timestamp,
        drawdown_pct
      });
    }

    return drawdown_curve;
  }

  /**
   * 计算月度收益
   */
  static calculate_monthly_returns(trades: Trade[]): MonthlyReturn[] {
    if (trades.length === 0) {
      return [];
    }

    // 按月份分组
    const monthly_map = new Map<string, { pnl: number; count: number }>();

    for (const trade of trades) {
      const date = new Date(trade.exit_time);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const key = `${year}-${month}`;

      if (!monthly_map.has(key)) {
        monthly_map.set(key, { pnl: 0, count: 0 });
      }

      const data = monthly_map.get(key)!;
      data.pnl += trade.pnl;
      data.count += 1;
    }

    // 转换为数组
    const monthly_returns: MonthlyReturn[] = [];

    for (const [key, data] of monthly_map.entries()) {
      const [year, month] = key.split('-').map(Number);

      // 简化：假设平均每月初始资金相同
      // 实际应该根据当月初的权益计算
      const return_pct = data.pnl;

      monthly_returns.push({
        year,
        month,
        return_pct,
        trades: data.count
      });
    }

    return monthly_returns.sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });
  }

  /**
   * 计算交易分布
   */
  static calculate_trade_distribution(trades: Trade[]): TradeDistribution {
    if (trades.length === 0) {
      return {
        win_count: 0,
        loss_count: 0,
        avg_win: 0,
        avg_loss: 0,
        max_win: 0,
        max_loss: 0,
        avg_holding_time: 0
      };
    }

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    const total_win = wins.reduce((sum, t) => sum + t.pnl, 0);
    const total_loss = losses.reduce((sum, t) => sum + t.pnl, 0);

    const avg_win = wins.length > 0 ? total_win / wins.length : 0;
    const avg_loss = losses.length > 0 ? total_loss / losses.length : 0;

    const max_win = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
    const max_loss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;

    const total_holding_time = trades.reduce((sum, t) => sum + t.holding_duration, 0);
    const avg_holding_time = total_holding_time / trades.length;

    return {
      win_count: wins.length,
      loss_count: losses.length,
      avg_win,
      avg_loss,
      max_win,
      max_loss,
      avg_holding_time
    };
  }

  /**
   * 生成完整的性能数据
   */
  static generate_performance_data(
    initial_capital: number,
    trades: Trade[],
    start_time: number,
    end_time: number
  ): PerformanceData {
    const equity_curve = this.generate_equity_curve(initial_capital, trades, start_time, end_time);
    const drawdown_curve = this.generate_drawdown_curve(equity_curve);
    const monthly_returns = this.calculate_monthly_returns(trades);
    const trade_distribution = this.calculate_trade_distribution(trades);

    return {
      equity_curve,
      drawdown_curve,
      monthly_returns,
      trade_distribution
    };
  }
}
