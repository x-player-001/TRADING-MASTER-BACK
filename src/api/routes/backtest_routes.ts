/**
 * 回测API路由
 */

import { Router, Request, Response } from 'express';
import { BacktestEngine } from '../../trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../../types/trading_types';
import { logger } from '../../utils/logger';

export class BacktestRoutes {
  public router: Router;
  private backtest_engine: BacktestEngine;
  private backtest_results: Map<string, any> = new Map(); // 存储回测结果

  constructor() {
    this.router = Router();
    this.backtest_engine = new BacktestEngine();
    this.initialize_routes();
  }

  private initialize_routes(): void {
    // 运行回测
    this.router.post('/run', this.run_backtest.bind(this));

    // 获取回测结果
    this.router.get('/results/:id', this.get_result.bind(this));

    // 获取所有回测列表
    this.router.get('/list', this.list_backtests.bind(this));

    // 快速回测（预设配置）
    this.router.post('/quick', this.quick_backtest.bind(this));
  }

  /**
   * 运行回测
   */
  private async run_backtest(req: Request, res: Response): Promise<void> {
    try {
      const {
        start_date,
        end_date,
        initial_balance = 10000,
        strategy_type = 'TREND_FOLLOWING',
        min_signal_score = 6,
        min_confidence = 0.6,
        max_position_size_percent = 3,
        max_leverage = 3,
        symbols,
        max_holding_time_minutes = 60
      } = req.body;

      // 参数验证
      if (!start_date || !end_date) {
        res.status(400).json({
          success: false,
          error: 'Missing required parameters: start_date, end_date'
        });
        return;
      }

      // 构建回测配置
      const config: BacktestConfig = {
        start_date: new Date(start_date),
        end_date: new Date(end_date),
        initial_balance,
        strategy_config: {
          strategy_type: strategy_type as StrategyType,
          enabled: true,
          min_signal_score,
          min_confidence,
          min_oi_change_percent: 3,
          require_price_oi_alignment: true,
          price_oi_divergence_threshold: 2,
          use_sentiment_filter: true,
          min_trader_ratio: 0.8,
          max_funding_rate: 0.001,
          min_funding_rate: -0.001
        },
        risk_config: {
          max_position_size_percent,
          max_total_positions: 5,
          max_positions_per_symbol: 1,
          default_stop_loss_percent: 2,
          default_take_profit_percent: 5,
          use_trailing_stop: true,
          trailing_stop_callback_rate: 1,
          daily_loss_limit_percent: 5,
          consecutive_loss_limit: 3,
          pause_after_loss_limit: true,
          max_leverage,
          leverage_by_signal_strength: {
            weak: 1,
            medium: 2,
            strong: max_leverage
          }
        },
        max_holding_time_minutes,
        use_slippage: true,
        slippage_percent: 0.1,
        commission_percent: 0.05,
        symbols: symbols || undefined
      };

      logger.info('[BacktestRoutes] Starting backtest...');

      // 运行回测
      const result = await this.backtest_engine.run_backtest(config);

      // 生成回测ID并存储结果
      const backtest_id = `bt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      result.id = backtest_id;
      this.backtest_results.set(backtest_id, result);

      // 限制存储数量（保留最近20个）
      if (this.backtest_results.size > 20) {
        const first_key = this.backtest_results.keys().next().value;
        if (first_key) {
          this.backtest_results.delete(first_key);
        }
      }

      res.json({
        success: true,
        data: {
          backtest_id,
          statistics: result.statistics,
          summary: {
            total_trades: result.statistics.total_trades,
            win_rate: `${result.statistics.win_rate.toFixed(2)}%`,
            total_pnl: result.statistics.total_pnl.toFixed(2),
            profit_factor: result.statistics.profit_factor.toFixed(2),
            max_drawdown: `${result.statistics.max_drawdown_percent.toFixed(2)}%`,
            execution_time: `${result.execution_time_ms}ms`
          },
          config: {
            period: `${config.start_date.toISOString()} - ${config.end_date.toISOString()}`,
            initial_balance: config.initial_balance,
            strategy_type: config.strategy_config.strategy_type
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[BacktestRoutes] Backtest failed:', error);
      res.status(500).json({
        success: false,
        error: 'Backtest failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取回测结果详情
   */
  private async get_result(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = this.backtest_results.get(id);
      if (!result) {
        res.status(404).json({
          success: false,
          error: 'Backtest result not found',
          message: `No backtest result with ID: ${id}`
        });
        return;
      }

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[BacktestRoutes] Failed to get backtest result:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get backtest result',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取所有回测列表
   */
  private async list_backtests(req: Request, res: Response): Promise<void> {
    try {
      const backtests = Array.from(this.backtest_results.entries()).map(([id, result]) => ({
        id,
        strategy_type: result.strategy_type,
        period: {
          start: result.config.start_date,
          end: result.config.end_date
        },
        statistics: {
          total_trades: result.statistics.total_trades,
          win_rate: result.statistics.win_rate,
          total_pnl: result.statistics.total_pnl,
          max_drawdown_percent: result.statistics.max_drawdown_percent
        },
        created_at: result.created_at,
        execution_time_ms: result.execution_time_ms
      }));

      // 按创建时间倒序排列
      backtests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

      res.json({
        success: true,
        data: backtests,
        count: backtests.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[BacktestRoutes] Failed to list backtests:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list backtests',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 快速回测（预设配置）
   */
  private async quick_backtest(req: Request, res: Response): Promise<void> {
    try {
      const { days = 7 } = req.body;

      // 计算日期范围（最近N天）
      const end_date = new Date();
      const start_date = new Date();
      start_date.setDate(start_date.getDate() - days);

      // 使用默认配置运行回测
      const config: BacktestConfig = {
        start_date,
        end_date,
        initial_balance: 10000,
        strategy_config: {
          strategy_type: StrategyType.TREND_FOLLOWING,
          enabled: true,
          min_signal_score: 6,
          min_confidence: 0.6,
          min_oi_change_percent: 3,
          require_price_oi_alignment: true,
          price_oi_divergence_threshold: 2,
          use_sentiment_filter: true,
          min_trader_ratio: 0.8,
          max_funding_rate: 0.001,
          min_funding_rate: -0.001
        },
        risk_config: {
          max_position_size_percent: 3,
          max_total_positions: 5,
          max_positions_per_symbol: 1,
          default_stop_loss_percent: 2,
          default_take_profit_percent: 5,
          use_trailing_stop: true,
          trailing_stop_callback_rate: 1,
          daily_loss_limit_percent: 5,
          consecutive_loss_limit: 3,
          pause_after_loss_limit: true,
          max_leverage: 3,
          leverage_by_signal_strength: {
            weak: 1,
            medium: 2,
            strong: 3
          }
        },
        max_holding_time_minutes: 60,
        use_slippage: true,
        slippage_percent: 0.1,
        commission_percent: 0.05
      };

      logger.info(`[BacktestRoutes] Running quick backtest for last ${days} days...`);

      const result = await this.backtest_engine.run_backtest(config);

      const backtest_id = `bt_quick_${Date.now()}`;
      result.id = backtest_id;
      this.backtest_results.set(backtest_id, result);

      res.json({
        success: true,
        data: {
          backtest_id,
          statistics: result.statistics,
          trades_count: result.trades.length,
          signals_count: result.signals.length,
          rejected_signals_count: result.rejected_signals.length,
          summary: {
            win_rate: `${result.statistics.win_rate.toFixed(2)}%`,
            total_pnl: result.statistics.total_pnl.toFixed(2),
            profit_factor: result.statistics.profit_factor.toFixed(2),
            max_drawdown: `${result.statistics.max_drawdown_percent.toFixed(2)}%`
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[BacktestRoutes] Quick backtest failed:', error);
      res.status(500).json({
        success: false,
        error: 'Quick backtest failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
