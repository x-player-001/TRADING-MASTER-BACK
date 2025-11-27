/**
 * 实盘交易引擎
 * 集成信号生成、策略过滤、风险管理、订单执行
 * 支持币安测试网
 */

import { SignalGenerator } from './signal_generator';
import { StrategyEngine } from './strategy_engine';
import { RiskManager } from './risk_manager';
import { OrderExecutor } from './order_executor';
import { TrailingStopManager } from './trailing_stop_manager';
import { OIAnomalyRecord } from '../types/oi_types';
import {
  TradingSignal,
  TradingMode,
  StrategyConfig,
  RiskConfig,
  PositionRecord,
  PositionSide
} from '../types/trading_types';
import { logger } from '../utils/logger';

export interface LiveTradingConfig {
  mode: TradingMode;                    // PAPER / TESTNET / LIVE
  strategy_config: StrategyConfig;      // 策略配置
  risk_config: RiskConfig;              // 风险配置
  initial_balance: number;              // 初始资金
  max_holding_time_minutes?: number;    // 最大持仓时间
  allowed_directions?: ('LONG' | 'SHORT')[];  // 允许的交易方向
  dynamic_take_profit?: any;            // 动态止盈配置
}

export class LiveTradingEngine {
  private signal_generator: SignalGenerator;
  private strategy_engine: StrategyEngine;
  private risk_manager: RiskManager;
  private order_executor: OrderExecutor;
  private trailing_stop_manager: TrailingStopManager;

  private config: LiveTradingConfig;
  private current_positions: Map<string, PositionRecord> = new Map();
  private is_running: boolean = false;

  // 统计数据
  private total_trades: number = 0;
  private winning_trades: number = 0;
  private losing_trades: number = 0;
  private total_pnl: number = 0;

  constructor(config: LiveTradingConfig) {
    this.config = config;

    this.signal_generator = new SignalGenerator();
    this.strategy_engine = new StrategyEngine(config.strategy_config);
    this.risk_manager = new RiskManager(config.risk_config);
    this.order_executor = new OrderExecutor(config.mode);
    this.trailing_stop_manager = new TrailingStopManager();

    // 设置初始资金
    this.risk_manager.set_initial_balance(config.initial_balance);

    logger.info('[LiveTradingEngine] Initialized in', config.mode, 'mode');
    logger.info('[LiveTradingEngine] Strategy:', config.strategy_config.strategy_type);
  }

  /**
   * 启动交易引擎
   */
  start(): void {
    if (this.is_running) {
      logger.warn('[LiveTradingEngine] Already running');
      return;
    }

    this.is_running = true;
    logger.info('[LiveTradingEngine] ✅ Trading engine started');

    // 启动持仓监控（每10秒检查一次）
    this.start_position_monitor();
  }

  /**
   * 停止交易引擎
   */
  stop(): void {
    this.is_running = false;
    logger.info('[LiveTradingEngine] ❌ Trading engine stopped');
  }

  /**
   * 处理OI异动事件（主入口）
   * 当OI监控检测到异动时调用此方法
   */
  async process_anomaly(anomaly: OIAnomalyRecord): Promise<void> {
    if (!this.is_running) {
      return;
    }

    try {
      logger.info(`[LiveTradingEngine] Processing anomaly: ${anomaly.symbol} OI change: ${anomaly.percent_change}%`);

      // 1. 生成信号
      const signal = this.signal_generator.generate_signal(anomaly);
      if (!signal) {
        logger.debug(`[LiveTradingEngine] No signal generated for ${anomaly.symbol}`);
        return;
      }

      // 2. 策略过滤
      const strategy_check = this.strategy_engine.evaluate_signal(signal);
      if (!strategy_check.passed) {
        logger.debug(`[LiveTradingEngine] Signal rejected by strategy: ${strategy_check.reason}`);
        return;
      }

      // 3. 方向过滤（只做多或只做空）
      if (this.config.allowed_directions && this.config.allowed_directions.length > 0) {
        if (!this.config.allowed_directions.includes(signal.direction as any)) {
          logger.info(`[LiveTradingEngine] Signal rejected by direction filter: ${signal.direction} not in [${this.config.allowed_directions.join(', ')}]`);
          return;
        }
      }

      // 4. 风险检查
      const risk_check = await this.risk_manager.check_trading_allowed(
        signal,
        this.current_positions,
        this.config.initial_balance + this.total_pnl
      );

      if (!risk_check.allowed) {
        logger.info(`[LiveTradingEngine] Signal rejected by risk manager: ${risk_check.reason}`);
        return;
      }

      // 4. 执行开仓
      await this.execute_entry(signal, risk_check.position_size!, risk_check.leverage!);

    } catch (error) {
      logger.error('[LiveTradingEngine] Error processing anomaly:', error);
    }
  }

  /**
   * 执行开仓
   */
  private async execute_entry(
    signal: TradingSignal,
    position_size: number,
    leverage: number
  ): Promise<void> {
    try {
      const quantity = position_size / (signal.entry_price || 0);

      logger.info(`[LiveTradingEngine] 🚀 Opening position: ${signal.symbol} ${signal.direction}`);
      logger.info(`[LiveTradingEngine] Size: $${position_size.toFixed(2)}, Leverage: ${leverage}x, Qty: ${quantity.toFixed(4)}`);

      // 执行订单
      const order = await this.order_executor.execute_market_order(signal, quantity, leverage);

      if (order.status !== 'FILLED') {
        logger.error(`[LiveTradingEngine] Order failed: ${order.error_message}`);
        return;
      }

      const entry_price = order.average_price || signal.entry_price || 0;

      // 计算止损止盈
      const { stop_loss, take_profit } = this.risk_manager.calculate_stop_loss_take_profit(signal);

      // 创建持仓记录
      const position: PositionRecord = {
        id: `${signal.symbol}_${Date.now()}`,
        symbol: signal.symbol,
        side: signal.direction === 'LONG' ? PositionSide.LONG : PositionSide.SHORT,
        entry_price,
        quantity: order.filled_quantity || quantity,
        stop_loss_price: stop_loss,
        take_profit_price: take_profit,
        leverage,
        signal_score: signal.score,
        entry_time: new Date(),
        opened_at: new Date(),
        is_open: true,
        status: 'OPEN',
        current_price: entry_price
      };

      // 如果配置了动态止盈，启动跟踪
      if (this.config.dynamic_take_profit) {
        const tp_config = {
          ...this.config.dynamic_take_profit,
          targets: this.config.dynamic_take_profit.targets.map((target: any) => {
            if (target.is_trailing) {
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

        logger.info(`[LiveTradingEngine] ✅ Dynamic take profit enabled with ${tp_config.targets.length} targets`);
      }

      this.current_positions.set(signal.symbol, position);

      logger.info(`[LiveTradingEngine] ✅ Position opened: ${signal.symbol} @ $${entry_price.toFixed(4)}`);
      logger.info(`[LiveTradingEngine] Stop Loss: $${stop_loss.toFixed(4)}, Take Profit: $${take_profit.toFixed(4)}`);

    } catch (error) {
      logger.error('[LiveTradingEngine] Failed to execute entry:', error);
    }
  }

  /**
   * 执行平仓
   */
  private async execute_exit(
    position: PositionRecord,
    current_price: number,
    reason: string
  ): Promise<void> {
    try {
      logger.info(`[LiveTradingEngine] 🔚 Closing position: ${position.symbol} Reason: ${reason}`);

      // 执行平仓订单
      const close_order = await this.order_executor.close_position_market(
        position.symbol,
        position.side,
        position.quantity,
        current_price
      );

      // 计算盈亏
      const is_long = position.side === PositionSide.LONG;
      const price_diff = is_long
        ? current_price - position.entry_price
        : position.entry_price - current_price;

      const pnl = price_diff * position.quantity * position.leverage;
      position.realized_pnl = pnl;
      position.exit_price = current_price;
      position.exit_time = new Date();
      position.close_reason = reason;
      position.status = 'CLOSED';

      // 更新统计
      this.total_trades++;
      this.total_pnl += pnl;

      if (pnl > 0) {
        this.winning_trades++;
        logger.info(`[LiveTradingEngine] ✅ WIN: ${position.symbol} PnL: +$${pnl.toFixed(2)}`);
      } else {
        this.losing_trades++;
        logger.info(`[LiveTradingEngine] ❌ LOSS: ${position.symbol} PnL: -$${Math.abs(pnl).toFixed(2)}`);
      }

      // 记录到风险管理器
      await this.risk_manager.record_trade_result(pnl, position);

      // 移除持仓
      this.current_positions.delete(position.symbol);

      logger.info(`[LiveTradingEngine] Current Balance: $${(this.config.initial_balance + this.total_pnl).toFixed(2)}`);
      logger.info(`[LiveTradingEngine] Win Rate: ${(this.winning_trades / this.total_trades * 100).toFixed(1)}% (${this.winning_trades}/${this.total_trades})`);

    } catch (error) {
      logger.error('[LiveTradingEngine] Failed to execute exit:', error);
    }
  }

  /**
   * 启动持仓监控
   * 定期检查止损、止盈、超时
   */
  private start_position_monitor(): void {
    setInterval(() => {
      if (!this.is_running) {
        return;
      }

      this.check_positions();
    }, 10000); // 每10秒检查一次
  }

  /**
   * 检查所有持仓
   */
  private async check_positions(): Promise<void> {
    for (const [symbol, position] of this.current_positions.entries()) {
      try {
        await this.check_single_position(position);
      } catch (error) {
        logger.error(`[LiveTradingEngine] Error checking position ${symbol}:`, error);
      }
    }
  }

  /**
   * 检查单个持仓
   * TODO: 实际应用中需要实时获取最新价格
   */
  private async check_single_position(position: PositionRecord): Promise<void> {
    // TODO: 获取最新价格
    // const current_price = await this.get_current_price(position.symbol);

    // 暂时跳过，实际应用中需要实现价格获取
    const current_price = position.entry_price; // 占位

    // 检查止损
    if (this.check_stop_loss(position, current_price)) {
      await this.execute_exit(position, current_price, 'STOP_LOSS');
      return;
    }

    // 检查止盈
    if (this.check_take_profit(position, current_price)) {
      await this.execute_exit(position, current_price, 'TAKE_PROFIT');
      return;
    }

    // 检查超时
    if (this.check_timeout(position)) {
      await this.execute_exit(position, current_price, 'TIMEOUT');
      return;
    }

    // 更新移动止损
    if (this.config.risk_config.use_trailing_stop) {
      const new_stop = this.risk_manager.update_trailing_stop(position, current_price);
      if (new_stop && new_stop !== position.stop_loss_price) {
        position.stop_loss_price = new_stop;
        logger.info(`[LiveTradingEngine] Trailing stop updated: ${position.symbol} -> $${new_stop.toFixed(4)}`);
      }
    }
  }

  /**
   * 检查是否触发止损
   */
  private check_stop_loss(position: PositionRecord, current_price: number): boolean {
    if (!position.stop_loss_price) return false;

    if (position.side === PositionSide.LONG) {
      return current_price <= position.stop_loss_price;
    } else {
      return current_price >= position.stop_loss_price;
    }
  }

  /**
   * 检查是否触发止盈
   */
  private check_take_profit(position: PositionRecord, current_price: number): boolean {
    if (!position.take_profit_price) return false;

    if (position.side === PositionSide.LONG) {
      return current_price >= position.take_profit_price;
    } else {
      return current_price <= position.take_profit_price;
    }
  }

  /**
   * 检查是否超时
   */
  private check_timeout(position: PositionRecord): boolean {
    if (!this.config.max_holding_time_minutes) return false;

    const holding_time_ms = Date.now() - position.entry_time.getTime();
    const holding_time_minutes = holding_time_ms / (1000 * 60);

    return holding_time_minutes >= this.config.max_holding_time_minutes;
  }

  /**
   * 获取当前状态
   */
  get_status() {
    return {
      is_running: this.is_running,
      mode: this.config.mode,
      current_positions: Array.from(this.current_positions.values()),
      statistics: {
        total_trades: this.total_trades,
        winning_trades: this.winning_trades,
        losing_trades: this.losing_trades,
        win_rate: this.total_trades > 0 ? this.winning_trades / this.total_trades : 0,
        total_pnl: this.total_pnl,
        current_balance: this.config.initial_balance + this.total_pnl
      }
    };
  }

  /**
   * 强制平掉所有仓位
   */
  async close_all_positions(reason: string = 'MANUAL'): Promise<void> {
    logger.info(`[LiveTradingEngine] Closing all positions: ${reason}`);

    for (const [symbol, position] of this.current_positions.entries()) {
      await this.execute_exit(position, position.entry_price, reason);
    }
  }
}
