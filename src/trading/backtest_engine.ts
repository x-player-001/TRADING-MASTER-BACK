/**
 * 回测引擎
 * 基于历史异动数据进行策略回测
 */

import { OIAnomalyRecord } from '../types/oi_types';
import {
  BacktestConfig,
  BacktestResult,
  TradingSignal,
  PositionRecord,
  PositionSide,
  TradingStatistics,
  HistoricalPriceSnapshot
} from '../types/trading_types';
import { OIRepository } from '../database/oi_repository';
import { SignalGenerator } from './signal_generator';
import { StrategyEngine } from './strategy_engine';
import { RiskManager } from './risk_manager';
import { TrailingStopManager, TakeProfitAction } from './trailing_stop_manager';
import { logger } from '../utils/logger';

export class BacktestEngine {
  private oi_repository: OIRepository;
  private signal_generator: SignalGenerator;
  private strategy_engine: StrategyEngine;
  private risk_manager: RiskManager;
  private trailing_stop_manager: TrailingStopManager;

  constructor(oi_repository?: OIRepository) {
    this.oi_repository = oi_repository || new OIRepository();
    this.signal_generator = new SignalGenerator();
    this.strategy_engine = new StrategyEngine();
    this.risk_manager = new RiskManager();
    this.trailing_stop_manager = new TrailingStopManager();
  }

  /**
   * 运行回测
   */
  async run_backtest(config: BacktestConfig): Promise<BacktestResult> {
    const start_time = Date.now();
    logger.info(`[BacktestEngine] Starting backtest from ${config.start_date.toISOString()} to ${config.end_date.toISOString()}`);

    // 应用配置
    this.strategy_engine.update_config(config.strategy_config);
    this.risk_manager.update_config(config.risk_config);

    // 设置追高阈值（如果有配置）
    if (config.chase_high_threshold !== undefined) {
      this.signal_generator.set_chase_high_threshold(config.chase_high_threshold);
      logger.info(`[BacktestEngine] Chase high threshold set to ${config.chase_high_threshold}%`);
    }

    // ⚠️ 设置初始资金（用于固定比例保证金计算）
    this.risk_manager.set_initial_balance(config.initial_balance);

    // ⚠️ 初始化回测模式（设置起始时间，用于每日PnL重置）
    this.risk_manager.initialize_backtest_mode(config.start_date);

    // 1. 获取历史异动记录
    const anomalies = await this.get_historical_anomalies(config);
    logger.info(`[BacktestEngine] Loaded ${anomalies.length} historical anomalies`);

    if (anomalies.length === 0) {
      logger.warn('[BacktestEngine] No anomalies found in the specified period');
      return this.create_empty_result(config, start_time);
    }

    // 2. 初始化回测状态
    let balance = config.initial_balance;
    const open_positions: PositionRecord[] = [];
    const closed_positions: PositionRecord[] = [];
    const all_signals: TradingSignal[] = [];
    const rejected_signals: { signal: TradingSignal; reason: string }[] = [];
    const equity_curve: { timestamp: Date; equity: number; drawdown_percent: number }[] = [];

    let peak_equity = balance;
    let position_id_counter = 1;

    // 3. 按时间顺序处理每个异动
    for (const anomaly of anomalies) {
      // 生成交易信号
      const signal = this.signal_generator.generate_signal(anomaly);
      if (!signal) {
        continue;
      }

      all_signals.push(signal);

      // 策略评估
      const strategy_result = this.strategy_engine.evaluate_signal(signal);
      if (!strategy_result.passed) {
        rejected_signals.push({ signal, reason: strategy_result.reason || 'Unknown' });
        continue;
      }

      // 方向过滤（只做多或只做空）
      if (config.allowed_directions && config.allowed_directions.length > 0) {
        if (!config.allowed_directions.includes(signal.direction as any)) {
          rejected_signals.push({
            signal,
            reason: `Direction filter: ${signal.direction} not in allowed directions [${config.allowed_directions.join(', ')}]`
          });
          continue;
        }
      }

      // 风险检查（传入回测当前时间 + 所有仓位包括已平仓）✨
      const risk_check = this.risk_manager.can_open_position(
        signal,
        [...open_positions, ...closed_positions],  // 传入所有仓位以检查时间重叠
        balance,
        anomaly.anomaly_time  // 回测模式：使用异动发生的时间
      );

      if (!risk_check.allowed) {
        rejected_signals.push({ signal, reason: risk_check.reason || 'Risk check failed' });
        continue;
      }

      // ⚠️ 防止同一时间重复开仓（多周期异动触发）
      // 检查是否在极短时间内（10秒内）已有同一币种的开仓或平仓
      const recent_time_window = 10 * 1000; // 10秒
      const has_recent_position = [...open_positions, ...closed_positions].some(pos => {
        if (pos.symbol !== signal.symbol) return false;
        const time_diff = Math.abs(anomaly.anomaly_time.getTime() - pos.opened_at.getTime());
        return time_diff < recent_time_window;
      });

      if (has_recent_position) {
        rejected_signals.push({
          signal,
          reason: `Duplicate signal: already have position for ${signal.symbol} within ${recent_time_window / 1000}s`
        });
        logger.debug(`[BacktestEngine] Skipped duplicate signal for ${signal.symbol} at ${anomaly.anomaly_time.toISOString()}`);
        continue;
      }

      // 4. 模拟开仓
      const entry_price = this.apply_slippage(
        signal.entry_price || 0,
        signal.direction as 'LONG' | 'SHORT',
        config
      );

      const position_size = risk_check.position_size!;
      const leverage = risk_check.leverage!;
      const quantity = position_size / entry_price;

      // 计算止损止盈
      const { stop_loss, take_profit } = this.risk_manager.calculate_stop_loss_take_profit(signal);

      const position: PositionRecord = {
        id: position_id_counter++,
        symbol: signal.symbol,
        side: signal.direction === 'LONG' ? PositionSide.LONG : PositionSide.SHORT,
        entry_price,
        current_price: entry_price,
        quantity,
        leverage,
        unrealized_pnl: 0,
        unrealized_pnl_percent: 0,
        stop_loss_price: stop_loss,
        take_profit_price: take_profit,
        signal_id: signal.source_anomaly_id,
        is_open: true,
        opened_at: anomaly.anomaly_time,
        updated_at: anomaly.anomaly_time,
        realized_pnl: 0  // 初始化已实现盈亏
      };

      open_positions.push(position);
      balance -= position_size / leverage; // 扣除保证金

      logger.debug(`[BacktestEngine] Position opened: ${position.symbol} ${position.side} @ ${entry_price}`);

      // 如果配置了动态止盈，启动跟踪
      if (config.dynamic_take_profit) {
        // 计算实际的止盈价格
        const tp_config = {
          ...config.dynamic_take_profit,
          targets: config.dynamic_take_profit.targets.map(target => {
            if (target.is_trailing) {
              // 跟踪止盈不需要固定价格
              return { ...target };
            } else {
              // 计算固定批次的目标价格
              const target_price = position.side === PositionSide.LONG
                ? entry_price * (1 + target.target_profit_pct / 100)
                : entry_price * (1 - target.target_profit_pct / 100);
              return { ...target, price: target_price };
            }
          })
        };

        this.trailing_stop_manager.start_tracking(
          position.id!,
          position.symbol,
          position.side,
          entry_price,
          quantity,
          tp_config
        );
        logger.debug(`[BacktestEngine] Started dynamic take profit tracking for position ${position.id}`);
      }

      // 5. 获取后续价格并检查止损/止盈
      const exit_result = await this.simulate_position_holding(
        position,
        anomaly.anomaly_time,
        config
      );

      if (exit_result) {
        // 平仓（可能是全部平仓或剩余仓位平仓）
        position.is_open = false;
        position.current_price = exit_result.exit_price;
        position.closed_at = exit_result.exit_time;
        position.close_reason = exit_result.reason;

        // 计算最终盈亏
        let final_pnl: number;

        if (config.dynamic_take_profit && position.realized_pnl !== undefined && position.realized_pnl !== 0) {
          // 分批止盈模式：已经有部分已实现盈亏，只需要计算剩余仓位的盈亏
          const exit_price = this.apply_slippage(exit_result.exit_price, position.side, config, true);

          if (position.quantity > 0.0001) {  // 还有剩余仓位
            const remaining_commission = this.calculate_partial_commission(position, exit_price, position.quantity, config);
            const remaining_pnl = this.calculate_partial_pnl(position, exit_price, position.quantity) - remaining_commission;
            final_pnl = position.realized_pnl + remaining_pnl;

            logger.debug(`[BacktestEngine] Remaining position closed: ${position.symbol} ${position.quantity.toFixed(4)} @ ${exit_price.toFixed(6)}, remaining PnL=${remaining_pnl.toFixed(2)}`);
          } else {
            // 已经全部通过分批止盈平仓
            final_pnl = position.realized_pnl;
          }
        } else {
          // 标准模式：一次性平仓
          const exit_price = this.apply_slippage(exit_result.exit_price, position.side, config, true);
          const commission = this.calculate_commission(position, exit_price, config);
          final_pnl = this.calculate_pnl(position, exit_price) - commission;
        }

        position.realized_pnl = final_pnl;
        balance += (position_size / leverage) + final_pnl; // 返还保证金 + 盈亏

        // 更新风险管理器
        const is_win = final_pnl > 0;
        this.risk_manager.record_trade_result(final_pnl, is_win);

        // 移到已平仓列表
        const index = open_positions.indexOf(position);
        if (index > -1) {
          open_positions.splice(index, 1);
        }
        closed_positions.push(position);

        logger.debug(`[BacktestEngine] Position fully closed: ${position.symbol} @ ${exit_result.exit_price.toFixed(6)}, Total PnL=${final_pnl.toFixed(2)} (${exit_result.reason})`);
      }

      // 记录资金曲线
      const current_equity = balance + this.calculate_unrealized_pnl(open_positions);
      if (current_equity > peak_equity) {
        peak_equity = current_equity;
      }
      const drawdown_percent = peak_equity > 0 ? ((peak_equity - current_equity) / peak_equity) * 100 : 0;

      equity_curve.push({
        timestamp: anomaly.anomaly_time,
        equity: current_equity,
        drawdown_percent
      });
    }

    // 6. 强制平仓所有未平仓位（回测结束）
    for (const position of open_positions) {
      const final_price = position.current_price;
      position.is_open = false;
      position.closed_at = config.end_date;
      position.close_reason = 'TIMEOUT';

      const pnl = this.calculate_pnl(position, final_price);
      position.realized_pnl = pnl;
      balance += (position.entry_price * position.quantity / position.leverage) + pnl;

      closed_positions.push(position);
    }

    // 7. 计算统计数据
    const statistics = this.calculate_statistics(closed_positions, config);

    const execution_time = Date.now() - start_time;
    logger.info(`[BacktestEngine] Backtest completed in ${execution_time}ms: ${closed_positions.length} trades, Win rate: ${statistics.win_rate.toFixed(2)}%`);

    return {
      config,
      strategy_type: config.strategy_config.strategy_type,
      statistics,
      trades: closed_positions,
      signals: all_signals,
      rejected_signals,
      equity_curve,
      execution_time_ms: execution_time,
      created_at: new Date()
    };
  }

  /**
   * 获取历史异动记录
   */
  private async get_historical_anomalies(config: BacktestConfig): Promise<OIAnomalyRecord[]> {
    // ⚠️ 优化：只加载有价格极值字段的数据（从2025-11-15开始）
    // 这样可以避免在回测时查询数据库计算价格极值
    const price_extreme_start_date = new Date('2025-11-15T00:00:00Z');
    const actual_start_date = config.start_date > price_extreme_start_date
      ? config.start_date
      : price_extreme_start_date;

    logger.info(`[BacktestEngine] Loading anomalies with price extremes from ${actual_start_date.toISOString()}`);

    const anomalies = await this.oi_repository.get_anomaly_records({
      start_time: actual_start_date, // 使用调整后的开始时间
      end_time: config.end_date,
      symbol: config.symbols?.[0], // TODO: 支持多币种
      severity: config.min_anomaly_severity,
      order: 'ASC' // 按时间升序
    });

    // 过滤掉没有价格极值字段的数据（双重保险）
    let filtered_anomalies = anomalies.filter(a =>
      a.daily_price_low !== null &&
      a.daily_price_high !== null &&
      a.price_from_low_pct !== null &&
      a.price_from_high_pct !== null
    );

    logger.info(`[BacktestEngine] Filtered ${anomalies.length} -> ${filtered_anomalies.length} anomalies with complete price extremes`);

    // 应用黑名单过滤
    const blacklist = await this.get_symbol_blacklist();
    if (blacklist.length > 0) {
      const before_blacklist = filtered_anomalies.length;
      filtered_anomalies = filtered_anomalies.filter(a => {
        // 检查symbol是否包含黑名单中的任何关键词
        return !blacklist.some(blocked => a.symbol.includes(blocked));
      });
      const filtered_count = before_blacklist - filtered_anomalies.length;
      if (filtered_count > 0) {
        logger.info(`[BacktestEngine] Filtered ${filtered_count} anomalies by blacklist: ${blacklist.join(', ')}`);
      }
    }

    // 过滤币种
    if (config.symbols && config.symbols.length > 0) {
      return filtered_anomalies.filter(a => config.symbols!.includes(a.symbol));
    }

    return filtered_anomalies;
  }

  /**
   * 获取币种黑名单（从OI监控配置表读取）
   */
  private async get_symbol_blacklist(): Promise<string[]> {
    try {
      const configs = await this.oi_repository.get_monitoring_config('symbol_blacklist');
      if (configs.length === 0) {
        return [];
      }

      const config_value = configs[0].config_value;
      const blacklist = JSON.parse(config_value) as string[];

      if (Array.isArray(blacklist) && blacklist.length > 0) {
        logger.info(`[BacktestEngine] Loaded blacklist: ${blacklist.join(', ')}`);
        return blacklist;
      }

      return [];
    } catch (error) {
      logger.error('[BacktestEngine] Failed to get blacklist config:', error);
      return [];
    }
  }

  /**
   * 模拟持仓期间的价格变化，检查止损/止盈/爆仓/分批止盈
   */
  private async simulate_position_holding(
    position: PositionRecord,
    entry_time: Date,
    config: BacktestConfig
  ): Promise<{ exit_price: number; exit_time: Date; reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'TIMEOUT' } | null> {
    const max_holding_ms = (config.max_holding_time_minutes || 60) * 60 * 1000;
    const end_time = new Date(entry_time.getTime() + max_holding_ms);

    // 获取该时间段的价格数据
    const prices = await this.get_historical_prices(
      position.symbol,
      entry_time,
      end_time
    );

    if (prices.length === 0) {
      // 没有价格数据，按超时处理
      if (config.dynamic_take_profit) {
        this.trailing_stop_manager.stop_tracking(position.id!);
      }
      return {
        exit_price: position.entry_price,
        exit_time: end_time,
        reason: 'TIMEOUT'
      };
    }

    // 计算逐仓爆仓价格
    const liquidation_price = this.calculate_liquidation_price(position);

    // 检查是否使用动态止盈
    const use_dynamic_tp = config.dynamic_take_profit !== undefined;
    let remaining_quantity = position.quantity;

    // 遍历价格，检查是否触发止损/止盈/爆仓/分批止盈
    for (const price_point of prices) {
      // 1. 检查分批止盈（如果启用）
      if (use_dynamic_tp && remaining_quantity > 0) {
        const tp_actions = this.trailing_stop_manager.update_price(position.id!, price_point.price);

        for (const action of tp_actions) {
          // 执行分批平仓
          const exit_price = this.apply_slippage(action.price, position.side, config, true);
          const commission = this.calculate_partial_commission(position, exit_price, action.quantity, config);

          // 计算该批次盈亏
          const partial_pnl = this.calculate_partial_pnl(position, exit_price, action.quantity) - commission;
          position.realized_pnl = (position.realized_pnl || 0) + partial_pnl;

          // 计算盈利百分比
          const profit_percent = ((exit_price - position.entry_price) / position.entry_price) * 100 * (position.side === PositionSide.SHORT ? -1 : 1);

          // 记录分批止盈执行 ✨
          if (!position.take_profit_executions) {
            position.take_profit_executions = [];
          }
          position.take_profit_executions.push({
            batch_number: position.take_profit_executions.length + 1,
            type: action.type,
            quantity: action.quantity,
            exit_price,
            pnl: partial_pnl,
            profit_percent,
            executed_at: price_point.timestamp,
            reason: action.reason
          });

          // 更新剩余仓位
          remaining_quantity -= action.quantity;
          position.quantity = remaining_quantity;

          logger.info(`[BacktestEngine] ${action.type}: ${position.symbol} closed ${action.quantity.toFixed(4)} @ ${exit_price.toFixed(6)}, PnL=${partial_pnl.toFixed(2)} (${action.reason})`);

          // 如果全部平仓，返回
          if (remaining_quantity <= 0.0001) {  // 处理浮点数精度
            this.trailing_stop_manager.stop_tracking(position.id!);
            return {
              exit_price,
              exit_time: price_point.timestamp,
              reason: 'TAKE_PROFIT'
            };
          }
        }
      }

      // 2. 检查爆仓（针对剩余仓位）
      if (position.side === PositionSide.LONG) {
        // ⚠️ 优先检查爆仓（逐仓模式）
        if (liquidation_price && price_point.price <= liquidation_price) {
          if (use_dynamic_tp) {
            this.trailing_stop_manager.stop_tracking(position.id!);
          }
          logger.warn(`[BacktestEngine] LIQUIDATION! ${position.symbol} @ ${price_point.price.toFixed(6)} (entry: ${position.entry_price.toFixed(6)}, liq: ${liquidation_price.toFixed(6)})`);
          return {
            exit_price: liquidation_price,
            exit_time: price_point.timestamp,
            reason: 'LIQUIDATION'
          };
        }

        // 3. 检查止损（针对剩余仓位）
        if (position.stop_loss_price && price_point.price <= position.stop_loss_price) {
          if (use_dynamic_tp) {
            this.trailing_stop_manager.stop_tracking(position.id!);
          }
          return {
            exit_price: position.stop_loss_price,
            exit_time: price_point.timestamp,
            reason: 'STOP_LOSS'
          };
        }

        // 4. 检查固定止盈（仅在未启用动态止盈时）
        if (!use_dynamic_tp && position.take_profit_price && price_point.price >= position.take_profit_price) {
          return {
            exit_price: position.take_profit_price,
            exit_time: price_point.timestamp,
            reason: 'TAKE_PROFIT'
          };
        }
      }

      // 空头持仓
      if (position.side === PositionSide.SHORT) {
        // ⚠️ 优先检查爆仓（逐仓模式）
        if (liquidation_price && price_point.price >= liquidation_price) {
          if (use_dynamic_tp) {
            this.trailing_stop_manager.stop_tracking(position.id!);
          }
          logger.warn(`[BacktestEngine] LIQUIDATION! ${position.symbol} @ ${price_point.price.toFixed(6)} (entry: ${position.entry_price.toFixed(6)}, liq: ${liquidation_price.toFixed(6)})`);
          return {
            exit_price: liquidation_price,
            exit_time: price_point.timestamp,
            reason: 'LIQUIDATION'
          };
        }

        // 止损
        if (position.stop_loss_price && price_point.price >= position.stop_loss_price) {
          if (use_dynamic_tp) {
            this.trailing_stop_manager.stop_tracking(position.id!);
          }
          return {
            exit_price: position.stop_loss_price,
            exit_time: price_point.timestamp,
            reason: 'STOP_LOSS'
          };
        }

        // 固定止盈（仅在未启用动态止盈时）
        if (!use_dynamic_tp && position.take_profit_price && price_point.price <= position.take_profit_price) {
          return {
            exit_price: position.take_profit_price,
            exit_time: price_point.timestamp,
            reason: 'TAKE_PROFIT'
          };
        }
      }
    }

    // 超时平仓
    if (use_dynamic_tp) {
      this.trailing_stop_manager.stop_tracking(position.id!);
    }
    const last_price = prices[prices.length - 1];
    return {
      exit_price: last_price.price,
      exit_time: last_price.timestamp,
      reason: 'TIMEOUT'
    };
  }

  /**
   * 计算逐仓爆仓价格
   *
   * 逐仓模式下，当浮亏达到保证金时触发爆仓
   * 多头爆仓价 = 入场价 × (1 - 1/杠杆)
   * 空头爆仓价 = 入场价 × (1 + 1/杠杆)
   */
  private calculate_liquidation_price(position: PositionRecord): number {
    const leverage = position.leverage;

    if (position.side === PositionSide.LONG) {
      // 多头：价格下跌到爆仓价
      return position.entry_price * (1 - 1 / leverage);
    } else {
      // 空头：价格上涨到爆仓价
      return position.entry_price * (1 + 1 / leverage);
    }
  }

  /**
   * 获取历史价格数据（从OI快照表）
   */
  private async get_historical_prices(
    symbol: string,
    start_time: Date,
    end_time: Date
  ): Promise<HistoricalPriceSnapshot[]> {
    try {
      // 从OI快照表获取价格数据
      const snapshots = await this.oi_repository.get_snapshots_in_range(
        symbol,
        start_time,
        end_time
      );

      return snapshots
        .filter(s => s.mark_price && s.mark_price > 0)
        .map(s => ({
          timestamp: new Date(s.timestamp_ms),
          timestamp_ms: s.timestamp_ms,
          price: parseFloat(s.mark_price!.toString()),
          open_interest: parseFloat(s.open_interest.toString())
        }));
    } catch (error) {
      logger.error(`[BacktestEngine] Failed to get historical prices for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * 应用滑点
   */
  private apply_slippage(
    price: number,
    side: 'LONG' | 'SHORT' | PositionSide,
    config: BacktestConfig,
    is_exit: boolean = false
  ): number {
    if (!config.use_slippage) {
      return price;
    }

    const slippage = config.slippage_percent || 0.1;
    const slippage_multiplier = slippage / 100;

    // 开仓：做多价格上滑，做空价格下滑
    // 平仓：相反
    const side_str = typeof side === 'string' ? side : (side === PositionSide.LONG ? 'LONG' : 'SHORT');
    const is_long = side_str === 'LONG';
    const should_increase = (is_long && !is_exit) || (!is_long && is_exit);

    return should_increase
      ? price * (1 + slippage_multiplier)
      : price * (1 - slippage_multiplier);
  }

  /**
   * 计算手续费
   */
  private calculate_commission(
    position: PositionRecord,
    exit_price: number,
    config: BacktestConfig
  ): number {
    const commission_percent = config.commission_percent || 0.05;
    const trade_value = exit_price * position.quantity;
    return trade_value * (commission_percent / 100) * 2; // 开仓+平仓
  }

  /**
   * 计算盈亏
   *
   * ⚠️ 重要：合约交易盈亏计算
   * PnL = (出场价 - 入场价) × 数量
   * 杠杆不参与盈亏计算！杠杆只影响保证金
   */
  private calculate_pnl(position: PositionRecord, exit_price: number): number {
    const price_diff = exit_price - position.entry_price;

    let pnl: number;
    if (position.side === PositionSide.LONG) {
      pnl = price_diff * position.quantity;  // 多头：价格上涨盈利
    } else {
      pnl = -price_diff * position.quantity;  // 空头：价格下跌盈利
    }

    return pnl;
  }

  /**
   * 计算部分仓位盈亏（用于分批止盈）
   */
  private calculate_partial_pnl(position: PositionRecord, exit_price: number, quantity: number): number {
    const price_diff = exit_price - position.entry_price;

    let pnl: number;
    if (position.side === PositionSide.LONG) {
      pnl = price_diff * quantity;  // 多头：价格上涨盈利
    } else {
      pnl = -price_diff * quantity;  // 空头：价格下跌盈利
    }

    return pnl;
  }

  /**
   * 计算部分仓位手续费（用于分批止盈）
   */
  private calculate_partial_commission(
    position: PositionRecord,
    exit_price: number,
    quantity: number,
    config: BacktestConfig
  ): number {
    const commission_percent = config.commission_percent || 0.05;
    const trade_value = exit_price * quantity;
    // 注意：分批平仓只计算平仓手续费，开仓手续费已经在开仓时计算
    return trade_value * (commission_percent / 100);
  }

  /**
   * 计算未实现盈亏
   */
  private calculate_unrealized_pnl(positions: PositionRecord[]): number {
    return positions.reduce((sum, pos) => {
      const pnl = this.calculate_pnl(pos, pos.current_price);
      return sum + pnl;
    }, 0);
  }

  /**
   * 计算统计数据
   */
  private calculate_statistics(
    trades: PositionRecord[],
    config: BacktestConfig
  ): TradingStatistics {
    const total_trades = trades.length;
    const winning_trades = trades.filter(t => (t.realized_pnl || 0) > 0);
    const losing_trades = trades.filter(t => (t.realized_pnl || 0) < 0);

    const win_rate = total_trades > 0 ? (winning_trades.length / total_trades) * 100 : 0;

    const total_pnl = trades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0);
    const average_win = winning_trades.length > 0
      ? winning_trades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0) / winning_trades.length
      : 0;
    const average_loss = losing_trades.length > 0
      ? losing_trades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0) / losing_trades.length
      : 0;

    const profit_factor = average_loss !== 0 ? Math.abs(average_win / average_loss) : 0;

    // 计算最大回撤
    let max_drawdown = 0;
    let peak = config.initial_balance;
    let current_equity = config.initial_balance;

    for (const trade of trades) {
      current_equity += (trade.realized_pnl || 0);
      if (current_equity > peak) {
        peak = current_equity;
      }
      const drawdown = peak - current_equity;
      if (drawdown > max_drawdown) {
        max_drawdown = drawdown;
      }
    }

    const max_drawdown_percent = peak > 0 ? (max_drawdown / peak) * 100 : 0;

    // 平均持仓时间
    const average_hold_time = total_trades > 0
      ? trades.reduce((sum, t) => {
        if (t.closed_at && t.opened_at) {
          const hold_time = (t.closed_at.getTime() - t.opened_at.getTime()) / 1000 / 60;
          return sum + hold_time;
        }
        return sum;
      }, 0) / total_trades
      : 0;

    // 计算连胜连亏
    let current_streak = 0;
    let longest_winning_streak = 0;
    let longest_losing_streak = 0;
    let last_was_win = true;

    for (const trade of trades) {
      const is_win = (trade.realized_pnl || 0) > 0;

      if (is_win === last_was_win) {
        current_streak++;
      } else {
        if (last_was_win) {
          longest_winning_streak = Math.max(longest_winning_streak, current_streak);
        } else {
          longest_losing_streak = Math.max(longest_losing_streak, current_streak);
        }
        current_streak = 1;
        last_was_win = is_win;
      }
    }

    // 检查最后一个streak
    if (last_was_win) {
      longest_winning_streak = Math.max(longest_winning_streak, current_streak);
    } else {
      longest_losing_streak = Math.max(longest_losing_streak, current_streak);
    }

    return {
      total_trades,
      winning_trades: winning_trades.length,
      losing_trades: losing_trades.length,
      win_rate,
      total_pnl,
      average_win,
      average_loss,
      profit_factor,
      max_drawdown,
      max_drawdown_percent,
      average_hold_time,
      longest_winning_streak,
      longest_losing_streak,
      period_start: config.start_date,
      period_end: config.end_date
    };
  }

  /**
   * 创建空结果
   */
  private create_empty_result(config: BacktestConfig, start_time: number): BacktestResult {
    return {
      config,
      strategy_type: config.strategy_config.strategy_type,
      statistics: {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0,
        total_pnl: 0,
        average_win: 0,
        average_loss: 0,
        profit_factor: 0,
        max_drawdown: 0,
        max_drawdown_percent: 0,
        average_hold_time: 0,
        longest_winning_streak: 0,
        longest_losing_streak: 0,
        period_start: config.start_date,
        period_end: config.end_date
      },
      trades: [],
      signals: [],
      rejected_signals: [],
      equity_curve: [],
      execution_time_ms: Date.now() - start_time,
      created_at: new Date()
    };
  }

  /**
   * 批量补充缺失的价格极值数据
   */
  private async batch_fill_missing_price_extremes(anomalies: OIAnomalyRecord[]): Promise<void> {
    // 统计缺失数据的异动
    const missing_anomalies = anomalies.filter(a =>
      a.daily_price_low === null || a.daily_price_low === undefined
    );

    if (missing_anomalies.length === 0) {
      logger.info('[BacktestEngine] All anomalies have price extremes data');
      return;
    }

    logger.info(`[BacktestEngine] Found ${missing_anomalies.length}/${anomalies.length} anomalies missing price extremes, filling...`);

    // 按日期分组，减少数据库查询次数
    const by_date_symbol = new Map<string, OIAnomalyRecord[]>();
    for (const anomaly of missing_anomalies) {
      const beijing_time = new Date(anomaly.anomaly_time.getTime() + 8 * 60 * 60 * 1000);
      const date = beijing_time.toISOString().split('T')[0]; // YYYY-MM-DD
      const key = `${anomaly.symbol}_${date}`;

      if (!by_date_symbol.has(key)) {
        by_date_symbol.set(key, []);
      }
      by_date_symbol.get(key)!.push(anomaly);
    }

    logger.info(`[BacktestEngine] Grouped into ${by_date_symbol.size} unique symbol-date combinations`);

    // 批量查询每个symbol-date组合
    let filled_count = 0;
    for (const [key, group_anomalies] of by_date_symbol.entries()) {
      const [symbol, date] = key.split('_');

      try {
        // 一次查询获取当天所有快照
        const snapshots = await this.oi_repository.get_symbol_oi_curve(symbol, date);

        if (snapshots.length === 0) {
          continue;
        }

        // 计算当天价格极值
        const prices = snapshots
          .map(s => s.mark_price)
          .filter((price): price is number => price !== undefined && price !== null && price > 0)
          .map(price => typeof price === 'string' ? parseFloat(price) : price);

        if (prices.length === 0) {
          continue;
        }

        const daily_price_low = Math.min(...prices);
        const daily_price_high = Math.max(...prices);

        // 填充该组所有异动的价格极值
        for (const anomaly of group_anomalies) {
          const current_price_raw = anomaly.price_after || anomaly.price_before || 0;
          const current_price = typeof current_price_raw === 'string' ? parseFloat(current_price_raw) : current_price_raw;

          anomaly.daily_price_low = daily_price_low;
          anomaly.daily_price_high = daily_price_high;

          if (current_price > 0 && !isNaN(current_price)) {
            anomaly.price_from_low_pct = ((current_price - daily_price_low) / daily_price_low) * 100;
            anomaly.price_from_high_pct = ((daily_price_high - current_price) / daily_price_high) * 100;
          }

          filled_count++;
        }
      } catch (error) {
        logger.warn(`[BacktestEngine] Failed to fetch extremes for ${key}:`, error);
      }
    }

    logger.info(`[BacktestEngine] Successfully filled ${filled_count}/${missing_anomalies.length} anomalies`);
  }

  /**
   * 为历史异动记录计算当日价格极值
   * 仅在回测时使用，实时数据已包含此信息
   */
  private async calculate_historical_price_extremes(
    anomaly: OIAnomalyRecord
  ): Promise<{
    daily_price_low?: number;
    daily_price_high?: number;
    price_from_low_pct?: number;
    price_from_high_pct?: number;
  }> {
    try {
      // 获取当天的日期（UTC+8 北京时间）
      const beijing_time = new Date(anomaly.anomaly_time.getTime() + 8 * 60 * 60 * 1000);
      const date = beijing_time.toISOString().split('T')[0]; // YYYY-MM-DD

      // 查询当天该币种的所有快照
      const snapshots = await this.oi_repository.get_symbol_oi_curve(anomaly.symbol, date);

      if (snapshots.length === 0) {
        logger.debug(`[BacktestEngine] No snapshots found for ${anomaly.symbol} on ${date}`);
        return {}; // 无历史数据，返回空
      }

      // 提取价格数据
      const prices = snapshots
        .map(s => s.mark_price)
        .filter((price): price is number => price !== undefined && price !== null && price > 0)
        .map(price => typeof price === 'string' ? parseFloat(price) : price);

      if (prices.length === 0) {
        logger.debug(`[BacktestEngine] No valid prices for ${anomaly.symbol} on ${date}`);
        return {}; // 无价格数据
      }

      // 计算极值
      const daily_price_low = Math.min(...prices);
      const daily_price_high = Math.max(...prices);

      // 获取当前价格（异动触发时的价格）
      const current_price_raw = anomaly.price_after || anomaly.price_before || 0;
      const current_price = typeof current_price_raw === 'string' ? parseFloat(current_price_raw) : current_price_raw;

      if (current_price === 0 || isNaN(current_price)) {
        return { daily_price_low, daily_price_high };
      }

      // 计算百分比
      const price_from_low_pct = ((current_price - daily_price_low) / daily_price_low) * 100;
      const price_from_high_pct = ((daily_price_high - current_price) / daily_price_high) * 100;

      logger.debug(
        `[BacktestEngine] ${anomaly.symbol} ${date} - Low: ${daily_price_low.toFixed(2)}, High: ${daily_price_high.toFixed(2)}, ` +
        `Current: ${current_price.toFixed(2)}, From Low: ${price_from_low_pct.toFixed(2)}%, From High: ${price_from_high_pct.toFixed(2)}%`
      );

      return {
        daily_price_low,
        daily_price_high,
        price_from_low_pct,
        price_from_high_pct
      };
    } catch (error) {
      logger.warn(`[BacktestEngine] Failed to calculate historical price extremes for ${anomaly.symbol}:`, error);
      return {}; // 查询失败不影响回测
    }
  }
}
