import { BaseStrategy } from '../strategies/base_strategy';
import { TradeSimulator } from './trade_simulator';
import { PerformanceAnalyzer } from './performance_analyzer';
import { BacktestResult, BacktestRequest, BacktestProgress } from '../types/backtest_types';
import { ExitReason, TradeSide } from '../types/trading_types';
import { KlineMultiTableRepository } from '@/database/kline_multi_table_repository';
import { BacktestRepository } from '@/database/quantitative/backtest_repository';
import { TradeRepository } from '@/database/quantitative/trade_repository';
import { StrategyRepository } from '@/database/quantitative/strategy_repository';
import { BacktestTaskManager } from './backtest_task_manager';
import { BacktestTaskStatus } from '../types/task_types';
import { logger } from '@/utils/logger';

/**
 * 回测引擎
 * 负责执行策略回测，生成性能报告
 */
export class BacktestEngine {
  private kline_repository: KlineMultiTableRepository;
  private backtest_repository: BacktestRepository;
  private trade_repository: TradeRepository;
  private strategy_repository: StrategyRepository;
  private task_manager: BacktestTaskManager;

  constructor() {
    this.kline_repository = new KlineMultiTableRepository();
    this.backtest_repository = new BacktestRepository();
    this.trade_repository = new TradeRepository();
    this.strategy_repository = new StrategyRepository();
    this.task_manager = BacktestTaskManager.get_instance();
  }

  /**
   * 运行回测（带任务管理）
   */
  async run_backtest_async(
    strategy: BaseStrategy,
    request: BacktestRequest,
    task_id?: string
  ): Promise<BacktestResult> {
    // 如果有task_id，更新任务状态为running
    if (task_id) {
      await this.task_manager.update_task_status(task_id, BacktestTaskStatus.RUNNING);
    }

    try {
      const result = await this.run_backtest(strategy, request, async (progress) => {
        // 更新任务进度
        if (task_id) {
          await this.task_manager.update_progress(task_id, {
            current_kline: progress.processed_bars,
            total_klines: progress.total_bars,
            trades_count: 0, // 可以从simulator获取
            elapsed_seconds: Math.floor(progress.elapsed_ms / 1000)
          });

          // 检查任务是否被取消
          const is_cancelled = await this.task_manager.is_cancelled(task_id);
          if (is_cancelled) {
            throw new Error('Backtest task cancelled by user');
          }
        }
      });

      // 更新任务状态为completed
      if (task_id) {
        await this.task_manager.update_task_status(
          task_id,
          BacktestTaskStatus.COMPLETED,
          { result }
        );
      }

      return result;
    } catch (error) {
      // 更新任务状态为failed
      if (task_id) {
        await this.task_manager.update_task_status(
          task_id,
          BacktestTaskStatus.FAILED,
          { error: error instanceof Error ? error.message : 'Unknown error' }
        );
      }
      throw error;
    }
  }

  /**
   * 运行回测（内部方法）
   */
  async run_backtest(
    strategy: BaseStrategy,
    request: BacktestRequest,
    on_progress?: (progress: BacktestProgress) => void
  ): Promise<BacktestResult> {
    const start_run_time = Date.now();

    logger.info(`[BacktestEngine] Starting backtest for strategy: ${strategy.get_config().name}`, {
      symbol: request.symbol,
      interval: request.interval,
      start_time: new Date(request.start_time).toISOString(),
      end_time: new Date(request.end_time).toISOString()
    });

    // 1. 获取历史K线数据
    const klines_from_db = await this.fetch_historical_klines(
      request.symbol,
      request.interval,
      request.start_time,
      request.end_time
    );

    if (klines_from_db.length === 0) {
      throw new Error('No historical klines found for the specified period');
    }

    // 数据库返回降序(最新在前)，回测需要升序(最旧在前)，所以反转
    const klines = [...klines_from_db].reverse();

    const first_kline_time = new Date(klines[0].open_time).toISOString();
    const last_kline_time = new Date(klines[klines.length - 1].open_time).toISOString();

    logger.info(`[BacktestEngine] Loaded ${klines.length} klines (reversed from DESC to ASC for backtest)`);
    logger.info(`[BacktestEngine] Time range: ${first_kline_time} → ${last_kline_time}`);

    // 2. 初始化交易模拟器
    const simulator = new TradeSimulator(request.initial_capital);

    // 3. 逐根K线回测
    const total_bars = klines.length;
    let processed_bars = 0;

    for (let i = 0; i < klines.length; i++) {
      const current_kline = klines[i];
      const current_time = current_kline.open_time;
      const current_price = parseFloat(current_kline.close);

      // 获取当前持仓
      const open_positions = simulator.get_open_positions();

      // 检查止损止盈
      for (const position of open_positions) {
        const check_result = simulator.check_stop_loss_take_profit(
          position.symbol,
          position.interval,
          current_price,
          current_time
        );

        if (check_result && check_result.should_exit) {
          simulator.close_position(
            position.symbol,
            position.interval,
            current_price,
            current_time,
            check_result.reason
          );
        }
      }

      // 更新持仓价格
      for (const position of simulator.get_open_positions()) {
        simulator.update_position_price(position.symbol, position.interval, current_price);
      }

      // 分析出场信号（策略信号）
      const current_position = simulator.get_position(request.symbol, request.interval);
      if (current_position) {
        const exit_signal = await strategy.analyze_exit(current_position, current_kline);

        if (exit_signal) {
          simulator.close_position(
            request.symbol,
            request.interval,
            exit_signal.price,
            exit_signal.timestamp,
            exit_signal.reason,
            exit_signal.indicators
          );
        }
      }

      // 分析入场信号（需要足够的历史数据）
      if (i >= 200) { // 确保有足够的历史数据计算指标
        const historical_klines = klines.slice(0, i + 1);

        const entry_signal = await strategy.analyze_entry(
          request.symbol,
          request.interval,
          historical_klines,
          simulator.get_open_positions()
        );

        if (entry_signal) {
          // 计算仓位大小（简化：使用固定比例）
          const position_size_percent = 0.2; // 20% 资金
          const available_capital = simulator.get_available_capital();
          const position_value = available_capital * position_size_percent;
          const quantity = position_value / entry_signal.price;

          // 计算止损止盈（简化：固定百分比）
          const stop_loss_percent = 0.02; // 2%
          const take_profit_percent = 0.05; // 5%

          let stop_loss: number;
          let take_profit: number;

          if (entry_signal.side === TradeSide.LONG) {
            stop_loss = entry_signal.price * (1 - stop_loss_percent);
            take_profit = entry_signal.price * (1 + take_profit_percent);
          } else {
            stop_loss = entry_signal.price * (1 + stop_loss_percent);
            take_profit = entry_signal.price * (1 - take_profit_percent);
          }

          // 开仓
          simulator.open_position(
            entry_signal.symbol,
            entry_signal.interval,
            entry_signal.side,
            entry_signal.price,
            quantity,
            entry_signal.timestamp,
            stop_loss,
            take_profit,
            entry_signal.indicators
          );
        }
      }

      // 报告进度
      processed_bars++;
      if (on_progress && processed_bars % 100 === 0) {
        on_progress({
          total_bars,
          processed_bars,
          current_time,
          current_equity: simulator.get_current_equity(),
          elapsed_ms: Date.now() - start_run_time
        });
      }

      // 每50根K线释放一次事件循环，防止阻塞API响应和WebSocket心跳
      if (processed_bars % 50 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // 4. 强制平仓所有剩余持仓
    const final_kline = klines[klines.length - 1];
    const final_price = parseFloat(final_kline.close);
    const final_time = final_kline.close_time;

    for (const position of simulator.get_open_positions()) {
      simulator.close_position(
        position.symbol,
        position.interval,
        final_price,
        final_time,
        ExitReason.TIMEOUT
      );
    }

    // 5. 回测完成，执行最后一次区间检测（用于日志）
    if (strategy.get_config().type === 'breakout') {
      const reversed_klines = [...klines].reverse();
      const final_ranges = await (strategy as any).get_ranges(request.symbol, request.interval, reversed_klines);

      logger.info(`[BacktestEngine] 最终区间检测: 使用${klines.length}根K线，检测到${final_ranges.length}个有效区间`);

      if (final_ranges.length > 0) {
        final_ranges.forEach((range: any, index: number) => {
          // 使用服务器本地时区（UTC+8）格式化时间
          const start_time = new Date(range.start_time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
          const end_time = new Date(range.end_time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
          const range_size = ((range.resistance - range.support) / range.support * 100).toFixed(2);
          logger.info(`  区间${index + 1}: ${start_time} → ${end_time}, 支撑${range.support.toFixed(2)} 阻力${range.resistance.toFixed(2)} (${range_size}%), 置信度${(range.confidence * 100).toFixed(1)}%`);
        });
      }
    }

    // 6. 计算性能指标
    const final_capital = simulator.get_current_equity();
    const trades = simulator.get_closed_trades();

    const total_return = PerformanceAnalyzer.calculate_total_return(
      request.initial_capital,
      final_capital
    );

    const annual_return = PerformanceAnalyzer.calculate_annual_return(
      request.initial_capital,
      final_capital,
      request.start_time,
      request.end_time
    );

    const performance_data = PerformanceAnalyzer.generate_performance_data(
      request.initial_capital,
      trades,
      request.start_time,
      request.end_time
    );

    const sharpe_ratio = PerformanceAnalyzer.calculate_sharpe_ratio(performance_data.equity_curve);
    const max_drawdown = PerformanceAnalyzer.calculate_max_drawdown(performance_data.equity_curve);
    const win_rate = PerformanceAnalyzer.calculate_win_rate(trades);
    const profit_factor = PerformanceAnalyzer.calculate_profit_factor(trades);
    const avg_trade_duration = PerformanceAnalyzer.calculate_avg_trade_duration(trades);

    // 6. 创建回测结果
    const backtest_result: BacktestResult = {
      strategy_id: request.strategy_id,
      symbol: request.symbol,
      interval: request.interval,
      start_time: request.start_time,
      end_time: request.end_time,
      initial_capital: request.initial_capital,
      final_capital,
      total_return,
      annual_return,
      sharpe_ratio,
      max_drawdown,
      win_rate,
      total_trades: trades.length,
      avg_trade_duration,
      profit_factor,
      performance_data
    };

    // 7. 保存回测结果和交易记录
    const backtest_id = await this.backtest_repository.save(backtest_result);

    // 关联交易记录到回测
    const trades_with_backtest_id = trades.map(t => ({
      ...t,
      strategy_id: request.strategy_id,
      backtest_id
    }));

    await this.trade_repository.save_batch(trades_with_backtest_id);

    // 8. 更新策略性能统计
    await this.update_strategy_performance(request.strategy_id, backtest_result);

    const elapsed_ms = Date.now() - start_run_time;

    logger.info(`[BacktestEngine] Backtest completed in ${(elapsed_ms / 1000).toFixed(2)}s`, {
      total_return: `${total_return.toFixed(2)}%`,
      sharpe_ratio: sharpe_ratio.toFixed(2),
      win_rate: `${win_rate.toFixed(2)}%`,
      total_trades: trades.length
    });

    return {
      ...backtest_result,
      id: backtest_id
    };
  }

  /**
   * 获取历史K线数据
   */
  private async fetch_historical_klines(
    symbol: string,
    interval: string,
    start_time: number,
    end_time: number
  ): Promise<any[]> {
    try {
      const klines = await this.kline_repository.find_by_time_range(
        symbol,
        interval,
        start_time,
        end_time,
        10000 // 最多1万根K线
      );

      return klines;
    } catch (error) {
      logger.error('[BacktestEngine] Failed to fetch historical klines', error);
      throw error;
    }
  }

  /**
   * 更新策略性能统计
   */
  private async update_strategy_performance(
    strategy_id: number,
    result: BacktestResult
  ): Promise<void> {
    try {
      // 获取现有性能数据
      const existing_performance = await this.strategy_repository.get_performance(strategy_id);

      if (!existing_performance) {
        // 首次回测
        await this.strategy_repository.update_performance(strategy_id, {
          total_backtests: 1,
          total_trades: result.total_trades,
          win_trades: Math.round(result.total_trades * result.win_rate / 100),
          loss_trades: result.total_trades - Math.round(result.total_trades * result.win_rate / 100),
          win_rate: result.win_rate,
          avg_return: result.total_return,
          best_return: result.total_return,
          worst_return: result.total_return,
          avg_sharpe: result.sharpe_ratio,
          avg_max_drawdown: result.max_drawdown,
          last_backtest_at: new Date()
        });
      } else {
        // 更新统计
        const new_total_backtests = existing_performance.total_backtests + 1;

        const new_avg_return =
          (existing_performance.avg_return * existing_performance.total_backtests + result.total_return) /
          new_total_backtests;

        const new_avg_sharpe =
          (existing_performance.avg_sharpe * existing_performance.total_backtests + result.sharpe_ratio) /
          new_total_backtests;

        const new_avg_max_drawdown =
          (existing_performance.avg_max_drawdown * existing_performance.total_backtests + result.max_drawdown) /
          new_total_backtests;

        await this.strategy_repository.update_performance(strategy_id, {
          total_backtests: new_total_backtests,
          avg_return: new_avg_return,
          best_return: Math.max(existing_performance.best_return, result.total_return),
          worst_return: Math.min(existing_performance.worst_return, result.total_return),
          avg_sharpe: new_avg_sharpe,
          avg_max_drawdown: new_avg_max_drawdown,
          last_backtest_at: new Date()
        });
      }
    } catch (error) {
      logger.error('[BacktestEngine] Failed to update strategy performance', error);
      // 不抛出错误，性能统计更新失败不影响回测结果
    }
  }
}
