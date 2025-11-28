/**
 * 交易系统管理器
 * 整合信号生成、策略评估、风险管理、订单执行和持仓跟踪
 */

import { OIAnomalyRecord } from '../types/oi_types';
import {
  TradingSignal,
  TradingMode,
  TradingSystemConfig,
  StrategyType,
  StrategyConfig,
  RiskConfig,
  PositionRecord,
  PositionSide,
  TradingStatistics
} from '../types/trading_types';
import { logger } from '../utils/logger';

import { SignalGenerator } from './signal_generator';
import { StrategyEngine } from './strategy_engine';
import { RiskManager } from './risk_manager';
import { OrderExecutor } from './order_executor';
import { PositionTracker } from './position_tracker';

export class TradingSystem {
  private signal_generator: SignalGenerator;
  private strategy_engine: StrategyEngine;
  private risk_manager: RiskManager;
  private order_executor: OrderExecutor;
  private position_tracker: PositionTracker;

  private config: TradingSystemConfig;
  private is_enabled: boolean = false;

  // 模拟账户余额（纸面交易）
  private paper_account_balance: number = 10000; // 默认$10000

  constructor(config?: Partial<TradingSystemConfig>) {
    // 默认配置
    const default_strategy: StrategyConfig = {
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
    };

    const default_risk: RiskConfig = {
      max_position_size_percent: 3,
      max_total_positions: 5,
      max_positions_per_symbol: 1,
      default_stop_loss_percent: 2,
      default_take_profit_percent: 5,
      use_trailing_stop: true,
      trailing_stop_callback_rate: 1,
      daily_loss_limit_percent: 5,
      consecutive_loss_limit: 6,  // 修改为6次
      pause_after_loss_limit: true,
      max_leverage: 3,
      leverage_by_signal_strength: {
        weak: 1,
        medium: 2,
        strong: 3
      }
    };

    this.config = {
      mode: TradingMode.LIVE,  // 修改为实盘模式
      enabled: false,
      strategies: [default_strategy],
      active_strategy_type: StrategyType.TREND_FOLLOWING,
      risk_config: default_risk,
      enable_notifications: false,
      ...config
    };

    // 初始化各个组件
    this.signal_generator = new SignalGenerator();
    this.strategy_engine = new StrategyEngine(this.config.strategies[0]);
    this.risk_manager = new RiskManager(this.config.risk_config);
    this.order_executor = new OrderExecutor(this.config.mode);
    this.position_tracker = new PositionTracker(this.order_executor, this.risk_manager);

    // 设置初始资金（用于仓位计算）
    if (this.config.initial_balance) {
      this.paper_account_balance = this.config.initial_balance;
      this.risk_manager.set_initial_balance(this.config.initial_balance);
      logger.info(`[TradingSystem] Initial balance set to $${this.config.initial_balance}`);
    }

    this.is_enabled = this.config.enabled;

    logger.info(`[TradingSystem] Initialized in ${this.config.mode} mode, enabled=${this.is_enabled}`);
  }

  /**
   * 处理异动，生成信号并尝试交易
   */
  async process_anomaly(anomaly: OIAnomalyRecord): Promise<{
    signal?: TradingSignal;
    position?: PositionRecord;
    action: 'NO_SIGNAL' | 'SIGNAL_REJECTED' | 'RISK_REJECTED' | 'POSITION_OPENED' | 'DISABLED';
    reason?: string;
  }> {
    if (!this.is_enabled) {
      return { action: 'DISABLED', reason: 'Trading system is disabled' };
    }

    // 1. 生成交易信号
    const signal = this.signal_generator.generate_signal(anomaly);
    if (!signal) {
      logger.debug(`[TradingSystem] No signal generated for ${anomaly.symbol}`);
      return { action: 'NO_SIGNAL' };
    }

    logger.info(`[TradingSystem] Signal generated: ${signal.symbol} ${signal.direction} (score: ${signal.score.toFixed(2)})`);

    // 2. 方向过滤（只做多）
    const allowed_directions = this.config.allowed_directions || ['LONG']; // 默认只做多
    if (!allowed_directions.includes(signal.direction as any)) {
      logger.info(`[TradingSystem] Signal rejected: ${signal.direction} not in allowed directions [${allowed_directions.join(', ')}]`);
      return {
        signal,
        action: 'SIGNAL_REJECTED',
        reason: `Direction filter: ${signal.direction} not in allowed directions`
      };
    }

    // 3. 策略评估
    const strategy_result = this.strategy_engine.evaluate_signal(signal);
    if (!strategy_result.passed) {
      logger.info(`[TradingSystem] Signal rejected by strategy: ${strategy_result.reason}`);
      return {
        signal,
        action: 'SIGNAL_REJECTED',
        reason: strategy_result.reason
      };
    }

    // 4. 风险检查
    const open_positions = this.position_tracker.get_open_positions();
    const risk_check = this.risk_manager.can_open_position(
      signal,
      open_positions,
      this.paper_account_balance
    );

    if (!risk_check.allowed) {
      logger.info(`[TradingSystem] Position rejected by risk manager: ${risk_check.reason}`);
      return {
        signal,
        action: 'RISK_REJECTED',
        reason: risk_check.reason
      };
    }

    // 5. 执行开仓
    try {
      const position = await this.execute_trade(
        signal,
        risk_check.position_size!,
        risk_check.leverage!
      );

      if (position) {
        logger.info(`[TradingSystem] Position opened: ${position.symbol} ${position.side} @ ${position.entry_price}`);
        return {
          signal,
          position,
          action: 'POSITION_OPENED'
        };
      }
    } catch (error) {
      logger.error('[TradingSystem] Failed to execute trade:', error);
      return {
        signal,
        action: 'RISK_REJECTED',
        reason: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return { action: 'NO_SIGNAL' };
  }

  /**
   * 执行交易
   */
  private async execute_trade(
    signal: TradingSignal,
    position_size: number,
    leverage: number
  ): Promise<PositionRecord | null> {
    // 计算数量（基于仓位金额和入场价格）
    const entry_price = signal.entry_price || 0;
    if (entry_price === 0) {
      throw new Error('Invalid entry price');
    }

    const quantity = position_size / entry_price;

    // 计算止损止盈
    const { stop_loss, take_profit } = this.risk_manager.calculate_stop_loss_take_profit(signal);

    // 构建止盈配置（实盘/测试网会在币安下止盈挂单）
    const take_profit_pct = this.config.risk_config.default_take_profit_percent;
    const trailing_callback_pct = this.config.risk_config.trailing_stop_callback_rate || 15;
    const use_trailing = this.config.risk_config.use_trailing_stop;

    const tp_config = {
      targets: [
        {
          percentage: 100,  // 全部仓位
          target_profit_pct: take_profit_pct,
          is_trailing: use_trailing,
          trailing_callback_pct: trailing_callback_pct
        }
      ]
    };

    // 执行市价开仓（带止盈挂单）
    const { entry_order, tp_order_ids } = await this.order_executor.execute_market_order_with_tp(
      signal,
      quantity,
      leverage,
      tp_config
    );

    if (entry_order.status !== 'FILLED') {
      throw new Error(`Order failed: ${entry_order.error_message}`);
    }

    if (tp_order_ids.length > 0) {
      logger.info(`[TradingSystem] Take profit orders placed: ${tp_order_ids.join(', ')}`);
    }

    // 创建持仓记录
    const position = this.position_tracker.open_position(
      signal,
      entry_order,
      leverage,
      stop_loss,
      take_profit
    );

    // 更新账户余额（纸面交易）
    if (this.config.mode === TradingMode.PAPER) {
      this.paper_account_balance -= position_size / leverage; // 扣除保证金
    }

    return position;
  }

  /**
   * 更新所有持仓价格（定期调用）
   */
  async update_positions(price_map: Map<string, number>): Promise<void> {
    await this.position_tracker.update_all_positions_prices(price_map);

    // 检查超时平仓
    await this.check_and_close_timeout_positions(price_map);

    // 计算盈亏并更新账户余额
    if (this.config.mode === TradingMode.PAPER) {
      const pnl = this.position_tracker.calculate_total_pnl();
      // 账户余额 = 初始余额 + 已实现盈亏 + 未实现盈亏
      // 这里简化处理，实际应该更复杂
    }
  }

  /**
   * 检查并关闭超时持仓
   */
  private async check_and_close_timeout_positions(price_map: Map<string, number>): Promise<void> {
    if (!this.config.max_holding_time_minutes) {
      return; // 未配置最大持仓时间，跳过检查
    }

    const open_positions = this.position_tracker.get_open_positions();
    const now = Date.now();

    for (const position of open_positions) {
      // 检查持仓时间
      const holding_time_ms = now - position.opened_at.getTime();
      const holding_time_minutes = holding_time_ms / (1000 * 60);

      if (holding_time_minutes >= this.config.max_holding_time_minutes) {
        const current_price = price_map.get(position.symbol);
        if (current_price && position.id) {
          logger.info(`[TradingSystem] Position ${position.symbol} timeout (${holding_time_minutes.toFixed(1)}min >= ${this.config.max_holding_time_minutes}min), closing...`);

          // 执行超时平仓
          await this.position_tracker.close_position(position.id, current_price, 'TIMEOUT');

          // 更新账户余额（如果是纸面交易）
          if (this.config.mode === TradingMode.PAPER) {
            const capital = position.entry_price * position.quantity;
            this.paper_account_balance += capital / position.leverage + (position.realized_pnl || 0);
          }
        }
      }
    }
  }

  /**
   * 手动平仓
   */
  async close_position_manual(position_id: number, current_price: number): Promise<boolean> {
    const position = await this.position_tracker.close_position(
      position_id,
      current_price,
      'MANUAL'
    );

    if (position && this.config.mode === TradingMode.PAPER) {
      // 返还保证金 + 盈亏
      const capital = position.entry_price * position.quantity;
      this.paper_account_balance += capital / position.leverage + (position.realized_pnl || 0);
    }

    return position !== null;
  }

  /**
   * 获取交易统计
   */
  get_statistics(): TradingStatistics {
    const all_positions = this.position_tracker.get_all_positions();
    const closed_positions = this.position_tracker.get_closed_positions();

    const winning_trades = closed_positions.filter(p => (p.realized_pnl || 0) > 0);
    const losing_trades = closed_positions.filter(p => (p.realized_pnl || 0) < 0);

    const total_trades = closed_positions.length;
    const win_rate = total_trades > 0 ? (winning_trades.length / total_trades) * 100 : 0;

    const total_pnl = closed_positions.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);
    const average_win = winning_trades.length > 0
      ? winning_trades.reduce((sum, p) => sum + (p.realized_pnl || 0), 0) / winning_trades.length
      : 0;
    const average_loss = losing_trades.length > 0
      ? losing_trades.reduce((sum, p) => sum + (p.realized_pnl || 0), 0) / losing_trades.length
      : 0;

    const profit_factor = average_loss !== 0 ? Math.abs(average_win / average_loss) : 0;

    // 计算最大回撤（简化版）
    let max_drawdown = 0;
    let peak = this.paper_account_balance;
    for (const position of closed_positions) {
      const equity = peak + (position.realized_pnl || 0);
      const drawdown = peak - equity;
      if (drawdown > max_drawdown) {
        max_drawdown = drawdown;
      }
      if (equity > peak) {
        peak = equity;
      }
    }

    const max_drawdown_percent = peak > 0 ? (max_drawdown / peak) * 100 : 0;

    // 平均持仓时间
    const average_hold_time = closed_positions.length > 0
      ? closed_positions.reduce((sum, p) => {
        const hold_time = p.closed_at && p.opened_at
          ? (p.closed_at.getTime() - p.opened_at.getTime()) / 1000 / 60 // 分钟
          : 0;
        return sum + hold_time;
      }, 0) / closed_positions.length
      : 0;

    const period_start = all_positions.length > 0 ? all_positions[0].opened_at : new Date();
    const period_end = new Date();

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
      longest_winning_streak: 0, // TODO: 实现
      longest_losing_streak: 0,  // TODO: 实现
      period_start,
      period_end
    };
  }

  /**
   * 启用/禁用交易系统
   */
  set_enabled(enabled: boolean): void {
    this.is_enabled = enabled;
    this.config.enabled = enabled;
    logger.info(`[TradingSystem] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * 获取系统状态
   */
  get_status(): {
    enabled: boolean;
    mode: TradingMode;
    open_positions: number;
    total_trades: number;
    account_balance: number;
    total_pnl: number;
    risk_status: any;
  } {
    const open_positions = this.position_tracker.get_open_positions();
    const all_positions = this.position_tracker.get_all_positions();
    const pnl = this.position_tracker.calculate_total_pnl();

    return {
      enabled: this.is_enabled,
      mode: this.config.mode,
      open_positions: open_positions.length,
      total_trades: all_positions.length,
      account_balance: this.paper_account_balance,
      total_pnl: pnl.total_pnl,
      risk_status: this.risk_manager.get_risk_status()
    };
  }

  /**
   * 获取所有持仓
   */
  get_positions(): PositionRecord[] {
    return this.position_tracker.get_all_positions();
  }

  /**
   * 获取开仓持仓
   */
  get_open_positions(): PositionRecord[] {
    return this.position_tracker.get_open_positions();
  }

  /**
   * 更新配置
   */
  update_config(new_config: Partial<TradingSystemConfig>): void {
    this.config = { ...this.config, ...new_config };

    if (new_config.risk_config) {
      this.risk_manager.update_config(new_config.risk_config);
    }

    if (new_config.mode) {
      this.order_executor.set_mode(new_config.mode);
    }

    logger.info('[TradingSystem] Config updated');
  }

  /**
   * 获取当前配置
   */
  get_config(): TradingSystemConfig {
    return { ...this.config };
  }

  /**
   * 设置追高阈值
   * @param threshold 追高阈值百分比（例如：16 表示16%）
   */
  set_chase_high_threshold(threshold: number): void {
    this.signal_generator.set_chase_high_threshold(threshold);
    logger.info(`[TradingSystem] Chase high threshold set to ${threshold}%`);
  }

  /**
   * 同步币安实际持仓到本地
   * 实盘交易时定时调用，确保本地状态与币安一致
   */
  async sync_positions_from_binance(): Promise<{
    synced: number;
    added: number;
    removed: number;
    updated: number;
  }> {
    if (this.config.mode === TradingMode.PAPER) {
      return { synced: 0, added: 0, removed: 0, updated: 0 };
    }

    try {
      // 获取币安实际持仓
      const binance_positions = await this.order_executor.get_binance_positions();
      const local_positions = this.position_tracker.get_open_positions();

      let added = 0;
      let removed = 0;
      let updated = 0;

      // 检查币安有但本地没有的持仓（需要添加）
      for (const bp of binance_positions) {
        const local = local_positions.find(lp => lp.symbol === bp.symbol && lp.side === bp.side);

        if (!local) {
          // 本地没有这个持仓，需要添加
          const margin = bp.isolatedWallet || bp.entryPrice * bp.positionAmt / bp.leverage;
          const side = bp.side === 'LONG' ? PositionSide.LONG : PositionSide.SHORT;

          // 根据风险配置计算止盈价格（止损通常设为100%表示不使用固定止损）
          const stop_loss_pct = this.config.risk_config.default_stop_loss_percent / 100;
          const take_profit_pct = this.config.risk_config.default_take_profit_percent / 100;

          // 止损：如果设置为100%，表示不使用固定止损（逐仓爆仓即止损）
          let stop_loss_price: number | undefined;
          if (stop_loss_pct < 0.99) {  // 小于99%才设置止损
            stop_loss_price = side === PositionSide.LONG
              ? bp.entryPrice * (1 - stop_loss_pct)
              : bp.entryPrice * (1 + stop_loss_pct);
          }

          // 止盈：始终设置
          const take_profit_price = side === PositionSide.LONG
            ? bp.entryPrice * (1 + take_profit_pct)
            : bp.entryPrice * (1 - take_profit_pct);

          const new_position: PositionRecord = {
            symbol: bp.symbol,
            side: side,
            entry_price: bp.entryPrice,
            current_price: bp.entryPrice,
            quantity: bp.positionAmt,
            leverage: bp.leverage,
            margin: margin,
            is_open: true,
            opened_at: new Date(bp.updateTime),  // 使用币安返回的updateTime
            unrealized_pnl: bp.unrealizedProfit,
            unrealized_pnl_percent: margin > 0
              ? (bp.unrealizedProfit / margin) * 100
              : 0,
            stop_loss_price: stop_loss_price,
            take_profit_price: take_profit_price
          };

          this.position_tracker.add_synced_position(new_position);
          logger.info(`[TradingSystem] Synced new position from Binance: ${bp.symbol} ${bp.side} qty=${bp.positionAmt} @ ${bp.entryPrice}, SL=${stop_loss_price?.toFixed(6) || 'N/A'}, TP=${take_profit_price.toFixed(6)}`);
          added++;
        } else {
          // 更新未实现盈亏
          local.unrealized_pnl = bp.unrealizedProfit;
          const margin = local.margin || (local.entry_price * local.quantity / local.leverage);
          local.unrealized_pnl_percent = margin > 0
            ? (bp.unrealizedProfit / margin) * 100
            : 0;
          updated++;
        }
      }

      // 检查本地有但币安没有的持仓（可能已被平仓）
      for (const lp of local_positions) {
        const binance = binance_positions.find(bp => bp.symbol === lp.symbol && bp.side === lp.side);

        if (!binance && lp.id !== undefined) {
          // 币安没有这个持仓，说明已平仓
          logger.warn(`[TradingSystem] Position ${lp.symbol} ${lp.side} not found in Binance, marking as closed`);
          // 标记为已关闭（实际盈亏未知，需要查询历史）
          this.position_tracker.mark_position_closed(lp.id, lp.unrealized_pnl || 0);
          removed++;
        }
      }

      if (added > 0 || removed > 0 || updated > 0) {
        logger.info(`[TradingSystem] Position sync completed: added=${added}, removed=${removed}, updated=${updated}`);
      }

      return {
        synced: binance_positions.length,
        added,
        removed,
        updated
      };
    } catch (error) {
      logger.error('[TradingSystem] Failed to sync positions from Binance:', error);
      return { synced: 0, added: 0, removed: 0, updated: 0 };
    }
  }

  /**
   * 获取币安账户余额
   */
  async get_binance_balance(): Promise<{
    totalWalletBalance: number;
    availableBalance: number;
    totalUnrealizedProfit: number;
  } | null> {
    return this.order_executor.get_binance_balance();
  }

  /**
   * 获取币安实际持仓
   */
  async get_binance_positions(): Promise<any[]> {
    return this.order_executor.get_binance_positions();
  }
}
