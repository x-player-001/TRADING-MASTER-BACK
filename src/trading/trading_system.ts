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
import { TradeRecordRepository } from '../database/trade_record_repository';

export class TradingSystem {
  private signal_generator: SignalGenerator;
  private strategy_engine: StrategyEngine;
  private risk_manager: RiskManager;
  private order_executor: OrderExecutor;
  private position_tracker: PositionTracker;
  private trade_record_repository: TradeRecordRepository;

  private config: TradingSystemConfig;
  private is_enabled: boolean = false;

  // 模拟账户余额（纸面交易）
  private paper_account_balance: number = 10000; // 默认$10000

  // 系统启动时间（用于统计只计算启动后的交易）
  private readonly started_at: Date = new Date();

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
    this.trade_record_repository = TradeRecordRepository.get_instance();

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

    // 写入数据库
    try {
      const margin = position_size / leverage;
      const trading_mode_str = this.config.mode === TradingMode.PAPER ? 'PAPER'
        : this.config.mode === TradingMode.TESTNET ? 'TESTNET' : 'LIVE';

      const db_id = await this.trade_record_repository.create_trade({
        symbol: signal.symbol,
        side: signal.direction === 'LONG' ? 'LONG' : 'SHORT',
        trading_mode: trading_mode_str as 'PAPER' | 'TESTNET' | 'LIVE',
        entry_price: entry_order.average_price || entry_price,
        quantity: entry_order.filled_quantity || quantity,
        leverage: leverage,
        margin: margin,
        position_value: position_size,
        stop_loss_price: stop_loss,
        take_profit_price: take_profit,
        entry_order_id: entry_order.order_id?.toString(),
        tp_order_ids: tp_order_ids.length > 0 ? JSON.stringify(tp_order_ids) : undefined,
        signal_id: signal.source_anomaly_id,  // 关联异动记录ID
        signal_score: signal.score,
        anomaly_id: signal.source_anomaly_id,
        status: 'OPEN',
        opened_at: position.opened_at
      });

      // 将数据库ID关联到仓位记录
      position.id = db_id;
      logger.info(`[TradingSystem] Trade record saved to database, id=${db_id}`);

      // 异步查询币安成交记录更新手续费（不阻塞主流程）
      if (entry_order.order_id && this.config.mode !== TradingMode.PAPER) {
        this.fetch_and_update_entry_commission(db_id, signal.symbol, parseInt(entry_order.order_id));
      }
    } catch (error) {
      logger.error('[TradingSystem] Failed to save trade record to database:', error);
      // 不影响交易，只记录日志
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
          const closed_position = await this.position_tracker.close_position(position.id, current_price, 'TIMEOUT');

          // 更新账户余额（如果是纸面交易）
          if (this.config.mode === TradingMode.PAPER) {
            const capital = position.entry_price * position.quantity;
            this.paper_account_balance += capital / position.leverage + (position.realized_pnl || 0);
          }

          // 更新数据库记录
          if (closed_position) {
            await this.update_trade_record_on_close(closed_position);
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

    // 更新数据库记录
    if (position) {
      await this.update_trade_record_on_close(position);
    }

    return position !== null;
  }

  /**
   * 平仓后更新数据库记录
   */
  private async update_trade_record_on_close(position: PositionRecord): Promise<void> {
    if (!position.id) {
      logger.warn(`[TradingSystem] Cannot update trade record: position has no id`);
      return;
    }

    try {
      // 计算基于保证金的收益率
      const margin = position.margin || (position.entry_price * position.quantity / position.leverage);
      const realized_pnl_percent = margin > 0 ? ((position.realized_pnl || 0) / margin) * 100 : 0;

      await this.trade_record_repository.close_trade(
        position.id,
        position.current_price,
        position.realized_pnl || 0,
        realized_pnl_percent,
        position.close_reason || 'MANUAL',
        position.exit_order_id?.toString(),
        position.take_profit_executions ? JSON.stringify(position.take_profit_executions) : undefined
      );

      logger.info(`[TradingSystem] Trade record updated in database, id=${position.id}, pnl=${(position.realized_pnl || 0).toFixed(4)}`);

      // 异步查询平仓手续费（不阻塞主流程）
      if (position.exit_order_id && this.config.mode !== TradingMode.PAPER) {
        this.fetch_and_update_exit_commission(position.id, position.symbol, position.exit_order_id);
      }
    } catch (error) {
      logger.error('[TradingSystem] Failed to update trade record in database:', error);
      // 不影响交易，只记录日志
    }
  }

  /**
   * 异步获取平仓订单的成交详情并更新手续费
   */
  private async fetch_and_update_exit_commission(
    db_id: number,
    symbol: string,
    orderId: number
  ): Promise<void> {
    try {
      // 延迟1秒确保成交记录已同步
      await new Promise(resolve => setTimeout(resolve, 1000));

      const tradeInfo = await this.order_executor.get_order_trades(symbol, orderId);
      if (tradeInfo) {
        await this.trade_record_repository.update_exit_commission(
          db_id,
          tradeInfo.totalCommission,
          tradeInfo.realizedPnl  // 平仓时从币安获取的实际盈亏
        );
        logger.info(`[TradingSystem] Exit commission updated for trade ${db_id}: commission=${tradeInfo.totalCommission.toFixed(4)} USDT, binance_pnl=${tradeInfo.realizedPnl.toFixed(4)}`);
      }
    } catch (error) {
      logger.error(`[TradingSystem] Failed to fetch exit commission for trade ${db_id}:`, error);
      // 不影响主流程
    }
  }

  /**
   * 异步获取开仓订单的成交详情并更新手续费
   */
  private async fetch_and_update_entry_commission(
    db_id: number,
    symbol: string,
    orderId: number
  ): Promise<void> {
    try {
      // 延迟1秒确保成交记录已同步
      await new Promise(resolve => setTimeout(resolve, 1000));

      const tradeInfo = await this.order_executor.get_order_trades(symbol, orderId);
      if (tradeInfo) {
        await this.trade_record_repository.update_entry_commission(
          db_id,
          tradeInfo.totalCommission,
          tradeInfo.commissionAsset,
          tradeInfo.avgPrice,
          tradeInfo.totalQuantity
        );
        logger.info(`[TradingSystem] Updated entry commission for trade ${db_id}: ${tradeInfo.totalCommission} ${tradeInfo.commissionAsset}`);
      }
    } catch (error) {
      logger.error(`[TradingSystem] Failed to fetch entry commission for trade ${db_id}:`, error);
    }
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
      total_commission: 0,  // 内存统计暂不支持，需从数据库获取
      net_pnl: total_pnl,   // 内存统计暂不支持，与total_pnl相同
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
   * 从数据库获取统计信息（包含手续费）
   * 只统计系统启动后的交易，不包含回填的历史记录
   */
  async get_statistics_from_db(): Promise<{
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    win_rate: number;
    total_pnl: number;
    total_commission: number;
    net_pnl: number;
  }> {
    const trading_mode = this.config.mode === TradingMode.LIVE ? 'LIVE' :
                        this.config.mode === TradingMode.TESTNET ? 'TESTNET' : 'PAPER';

    // 只统计系统启动后的交易（opened_at >= started_at）
    const db_stats = await this.trade_record_repository.get_statistics(trading_mode, this.started_at);

    return {
      total_trades: db_stats.total_trades,
      winning_trades: db_stats.winning_trades,
      losing_trades: db_stats.losing_trades,
      win_rate: db_stats.win_rate * 100,
      total_pnl: db_stats.total_pnl,
      total_commission: db_stats.total_commission,
      net_pnl: db_stats.net_pnl
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

          // 检查数据库是否有对应记录，如果没有则创建
          await this.ensure_trade_record_for_synced_position(new_position, bp);
        } else {
          // 更新未实现盈亏
          local.unrealized_pnl = bp.unrealizedProfit;
          const margin = local.margin || (local.entry_price * local.quantity / local.leverage);
          local.unrealized_pnl_percent = margin > 0
            ? (bp.unrealizedProfit / margin) * 100
            : 0;

          // 检查是否达到保本止损条件（盈利 >= 6% 且未下过保本止损单）
          if (local.unrealized_pnl_percent >= 6 && !local.breakeven_sl_placed) {
            await this.try_place_breakeven_stop_loss(local);
          }

          updated++;
        }
      }

      // 检查本地有但币安没有的持仓（可能已被平仓）
      for (const lp of local_positions) {
        const binance = binance_positions.find(bp => bp.symbol === lp.symbol && bp.side === lp.side);

        if (!binance && lp.id !== undefined) {
          // 币安没有这个持仓，说明已平仓（手动平仓或止盈止损触发）
          logger.warn(`[TradingSystem] Position ${lp.symbol} ${lp.side} not found in Binance, fetching actual close data...`);

          // ⭐ 从币安查询精确的平仓数据
          const close_data = await this.fetch_actual_close_data(lp.symbol, lp.side, lp.opened_at);

          // 使用精确数据或回退到近似值
          const exit_price = close_data?.exit_price || lp.current_price;
          const realized_pnl = close_data?.realized_pnl ?? lp.unrealized_pnl ?? 0;
          const exit_commission = close_data?.exit_commission || 0;
          const exit_order_id = close_data?.exit_order_id;
          const closed_at = close_data?.closed_at;

          // 标记为已关闭
          this.position_tracker.mark_position_closed(lp.id, realized_pnl);
          removed++;

          // 更新数据库记录（同步发现的平仓）
          try {
            const margin = lp.margin || (lp.entry_price * lp.quantity / lp.leverage);
            const realized_pnl_percent = margin > 0 ? (realized_pnl / margin) * 100 : 0;

            await this.trade_record_repository.close_trade(
              lp.id,
              exit_price,
              realized_pnl,
              realized_pnl_percent,
              'SYNC_CLOSED',
              exit_order_id?.toString()
            );

            // 如果有手续费数据，更新手续费
            if (exit_commission > 0) {
              await this.trade_record_repository.update_exit_commission(
                lp.id,
                exit_commission,
                realized_pnl  // 使用币安返回的精确盈亏
              );
            }

            logger.info(`[TradingSystem] Trade record updated with actual data: id=${lp.id}, exit_price=${exit_price.toFixed(6)}, pnl=${realized_pnl.toFixed(4)}`);
          } catch (err) {
            logger.error('[TradingSystem] Failed to update sync-closed trade in database:', err);
          }
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
   * 确保同步的持仓在数据库中有对应记录
   * 如果数据库没有该持仓的记录，则自动创建
   */
  private async ensure_trade_record_for_synced_position(
    position: PositionRecord,
    binance_position: {
      symbol: string;
      positionAmt: number;
      entryPrice: number;
      leverage: number;
      isolatedWallet: number;
      side: 'LONG' | 'SHORT';
      updateTime: number;
    }
  ): Promise<void> {
    try {
      const trading_mode = this.config.mode === TradingMode.LIVE ? 'LIVE' :
                          this.config.mode === TradingMode.TESTNET ? 'TESTNET' : 'PAPER';

      // 检查数据库是否已有该持仓的记录
      const existing = await this.trade_record_repository.find_open_trade_by_symbol(
        binance_position.symbol,
        binance_position.side,
        trading_mode
      );

      if (existing) {
        // 已有记录，将数据库ID同步到内存持仓
        position.id = existing.id;
        logger.debug(`[TradingSystem] Found existing trade record for ${binance_position.symbol}: id=${existing.id}`);
        return;
      }

      // 数据库没有记录，创建新记录
      const margin = binance_position.isolatedWallet ||
                    (binance_position.entryPrice * binance_position.positionAmt / binance_position.leverage);
      const position_value = binance_position.entryPrice * binance_position.positionAmt;

      const db_id = await this.trade_record_repository.create_trade({
        symbol: binance_position.symbol,
        side: binance_position.side,
        trading_mode: trading_mode,
        entry_price: binance_position.entryPrice,
        quantity: binance_position.positionAmt,
        leverage: binance_position.leverage,
        margin: margin,
        position_value: position_value,
        stop_loss_price: position.stop_loss_price,
        take_profit_price: position.take_profit_price,
        status: 'OPEN',
        opened_at: new Date(binance_position.updateTime)
      });

      // 将数据库ID同步回内存中的持仓
      position.id = db_id;
      logger.info(`[TradingSystem] Created trade record for synced position: ${binance_position.symbol} ${binance_position.side}, db_id=${db_id}`);

    } catch (error) {
      logger.error(`[TradingSystem] Failed to ensure trade record for ${binance_position.symbol}:`, error);
      // 不影响同步流程
    }
  }

  /**
   * 尝试下保本止损单
   * 当盈利达到6%时，在成本价处设置止损单，确保保本
   * 会先通过币安API检查是否已有止损挂单，避免重复下单
   */
  private async try_place_breakeven_stop_loss(position: PositionRecord): Promise<void> {
    try {
      logger.info(`[TradingSystem] Position ${position.symbol} reached +${position.unrealized_pnl_percent.toFixed(2)}%, checking/placing breakeven stop loss at entry price ${position.entry_price}`);

      const result = await this.order_executor.place_breakeven_stop_loss(
        position.symbol,
        position.side,
        position.quantity,
        position.entry_price
      );

      if (result.success) {
        // 标记已下保本止损单（无论是新下单还是已存在）
        position.breakeven_sl_placed = true;

        if (result.alreadyExists) {
          // 止损单已存在，静默标记
          logger.info(`[TradingSystem] ✅ Stop loss already exists for ${position.symbol}, marked as breakeven_sl_placed`);
        } else {
          // 新下单成功
          logger.info(`[TradingSystem] ✅ Breakeven stop loss placed for ${position.symbol}: orderId=${result.orderId}, stopPrice=${position.entry_price}`);
          console.log(`\n🛡️ 保本止损已设置: ${position.symbol} @ ${position.entry_price} (当前盈利: +${position.unrealized_pnl_percent.toFixed(2)}%)\n`);
        }
      } else {
        logger.error(`[TradingSystem] ❌ Failed to place breakeven stop loss for ${position.symbol}: ${result.error}`);
      }
    } catch (error) {
      logger.error(`[TradingSystem] Error placing breakeven stop loss for ${position.symbol}:`, error);
    }
  }

  /**
   * 从币安查询精确的平仓数据
   * 用于手动平仓或止盈止损触发时获取实际成交信息
   */
  private async fetch_actual_close_data(
    symbol: string,
    side: PositionSide,
    opened_at: Date
  ): Promise<{
    exit_price: number;
    realized_pnl: number;
    exit_commission: number;
    exit_order_id: number;
    closed_at: Date;
  } | null> {
    try {
      // 查询从开仓时间到现在的成交记录
      const startTime = opened_at.getTime();
      const endTime = Date.now();

      const trades = await this.order_executor.get_historical_trades(symbol, {
        startTime,
        endTime,
        limit: 100
      });

      if (!trades || trades.length === 0) {
        logger.warn(`[TradingSystem] No trades found for ${symbol} since ${opened_at.toISOString()}`);
        return null;
      }

      // 按订单ID分组
      const trades_by_order = new Map<number, typeof trades>();
      for (const trade of trades) {
        if (!trades_by_order.has(trade.orderId)) {
          trades_by_order.set(trade.orderId, []);
        }
        trades_by_order.get(trade.orderId)!.push(trade);
      }

      // 找出平仓订单（有realized_pnl的是平仓）
      // 平多用SELL，平空用BUY
      const close_side = side === PositionSide.LONG ? 'SELL' : 'BUY';

      let latest_close_order: typeof trades | null = null;
      let latest_close_time = 0;
      let latest_order_id = 0;

      for (const [orderId, orderTrades] of trades_by_order) {
        const totalPnl = orderTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const trade_side = orderTrades[0].side;
        const trade_time = Math.max(...orderTrades.map(t => t.time));

        // 是平仓方向且有盈亏且是最近的
        if (trade_side === close_side && Math.abs(totalPnl) > 0.0001 && trade_time > latest_close_time) {
          latest_close_order = orderTrades;
          latest_close_time = trade_time;
          latest_order_id = orderId;
        }
      }

      if (!latest_close_order) {
        logger.warn(`[TradingSystem] No closing trade found for ${symbol} ${side}`);
        return null;
      }

      // 计算平仓数据
      const exit_qty = latest_close_order.reduce((sum, t) => sum + parseFloat(t.qty), 0);
      const exit_quote_qty = latest_close_order.reduce((sum, t) => sum + parseFloat(t.quoteQty), 0);
      const exit_price = exit_qty > 0 ? exit_quote_qty / exit_qty : 0;
      const exit_commission = latest_close_order.reduce((sum, t) => sum + parseFloat(t.commission), 0);
      const realized_pnl = latest_close_order.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);

      logger.info(`[TradingSystem] Found actual close data for ${symbol}: price=${exit_price.toFixed(6)}, pnl=${realized_pnl.toFixed(4)}, commission=${exit_commission.toFixed(4)}`);

      return {
        exit_price,
        realized_pnl,
        exit_commission,
        exit_order_id: latest_order_id,
        closed_at: new Date(latest_close_time)
      };

    } catch (error) {
      logger.error(`[TradingSystem] Failed to fetch actual close data for ${symbol}:`, error);
      return null;
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

  /**
   * 回填历史交易记录
   * 从币安查询最近7天的已实现盈亏记录，检查数据库是否存在，不存在则创建
   *
   * @param days 回填天数（默认7天，最大7天）
   * @returns 回填结果
   */
  async backfill_historical_trades(days: number = 7): Promise<{
    total_found: number;
    already_exists: number;
    newly_created: number;
    failed: number;
    details: string[];
  }> {
    if (this.config.mode === TradingMode.PAPER) {
      return {
        total_found: 0,
        already_exists: 0,
        newly_created: 0,
        failed: 0,
        details: ['Paper mode does not support backfill']
      };
    }

    const trading_mode = this.config.mode === TradingMode.LIVE ? 'LIVE' : 'TESTNET';
    const result = {
      total_found: 0,
      already_exists: 0,
      newly_created: 0,
      failed: 0,
      details: [] as string[]
    };

    logger.info(`[TradingSystem] Starting historical trades backfill for last ${days} days...`);

    try {
      // 1. 获取最近N天的已实现盈亏记录
      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;

      const pnl_records = await this.order_executor.get_income_history({
        incomeType: 'REALIZED_PNL',
        startTime,
        endTime,
        limit: 1000
      });

      if (!pnl_records || pnl_records.length === 0) {
        logger.info('[TradingSystem] No historical PnL records found');
        return result;
      }

      // 按symbol分组
      const symbols_with_pnl = new Set(pnl_records.map(r => r.symbol));
      logger.info(`[TradingSystem] Found ${pnl_records.length} PnL records across ${symbols_with_pnl.size} symbols`);

      // 2. 对每个有盈亏的币种，获取详细成交记录
      for (const symbol of symbols_with_pnl) {
        try {
          // 获取该币种的成交记录
          const trades = await this.order_executor.get_historical_trades(symbol, {
            startTime,
            endTime,
            limit: 1000
          });

          if (!trades || trades.length === 0) continue;

          // 按订单ID分组成交记录
          const trades_by_order = new Map<number, typeof trades>();
          for (const trade of trades) {
            const orderId = trade.orderId;
            if (!trades_by_order.has(orderId)) {
              trades_by_order.set(orderId, []);
            }
            trades_by_order.get(orderId)!.push(trade);
          }

          // 找出开仓和平仓订单（通过realizedPnl判断：平仓有盈亏，开仓为0）
          const entry_orders: number[] = [];
          const exit_orders: number[] = [];

          for (const [orderId, orderTrades] of trades_by_order) {
            const totalPnl = orderTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            if (Math.abs(totalPnl) > 0.0001) {
              exit_orders.push(orderId);
            } else {
              entry_orders.push(orderId);
            }
          }

          // 3. 尝试匹配开仓和平仓，创建完整交易记录
          for (const exit_order_id of exit_orders) {
            const exit_trades = trades_by_order.get(exit_order_id)!;
            result.total_found++;

            // 计算平仓数据
            const exit_qty = exit_trades.reduce((sum, t) => sum + parseFloat(t.qty), 0);
            const exit_quote_qty = exit_trades.reduce((sum, t) => sum + parseFloat(t.quoteQty), 0);
            const exit_price = exit_qty > 0 ? exit_quote_qty / exit_qty : 0;
            const exit_commission = exit_trades.reduce((sum, t) => sum + parseFloat(t.commission), 0);
            const realized_pnl = exit_trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            const exit_time = Math.max(...exit_trades.map(t => t.time));
            const exit_side = exit_trades[0].side;  // SELL = 平多, BUY = 平空
            const position_side: 'LONG' | 'SHORT' = exit_side === 'SELL' ? 'LONG' : 'SHORT';

            // 寻找可能的开仓订单（时间早于平仓，方向相反）
            let matched_entry: typeof trades | undefined;
            let entry_order_id: number | undefined;

            for (const entry_id of entry_orders) {
              const entry_trades = trades_by_order.get(entry_id)!;
              const entry_time = Math.min(...entry_trades.map(t => t.time));
              const entry_side = entry_trades[0].side;

              // 开仓方向与平仓方向相反，且时间更早
              if (entry_time < exit_time &&
                  ((position_side === 'LONG' && entry_side === 'BUY') ||
                   (position_side === 'SHORT' && entry_side === 'SELL'))) {
                matched_entry = entry_trades;
                entry_order_id = entry_id;
                break;
              }
            }

            // 检查数据库是否已存在该记录（使用平仓订单ID查找）
            // 注：由于历史原因，可能用开仓或平仓订单ID存储
            const existing_by_exit = await this.trade_record_repository.find_by_entry_order_id(
              exit_order_id.toString(),
              trading_mode
            );
            const existing_by_entry = entry_order_id
              ? await this.trade_record_repository.find_by_entry_order_id(
                  entry_order_id.toString(),
                  trading_mode
                )
              : null;

            if (existing_by_exit || existing_by_entry) {
              result.already_exists++;
              continue;
            }

            // 计算开仓数据
            let entry_price = exit_price;  // 默认值
            let entry_commission = 0;
            let entry_time = exit_time - 60000;  // 默认早1分钟
            let quantity = exit_qty;

            if (matched_entry) {
              const entry_qty = matched_entry.reduce((sum, t) => sum + parseFloat(t.qty), 0);
              const entry_quote_qty = matched_entry.reduce((sum, t) => sum + parseFloat(t.quoteQty), 0);
              entry_price = entry_qty > 0 ? entry_quote_qty / entry_qty : exit_price;
              entry_commission = matched_entry.reduce((sum, t) => sum + parseFloat(t.commission), 0);
              entry_time = Math.min(...matched_entry.map(t => t.time));
              quantity = entry_qty;
            } else {
              // 无法找到开仓订单，通过盈亏反推开仓价格
              // 做多: pnl = (exit_price - entry_price) * qty
              // 做空: pnl = (entry_price - exit_price) * qty
              if (exit_qty > 0) {
                if (position_side === 'LONG') {
                  entry_price = exit_price - (realized_pnl / exit_qty);
                } else {
                  entry_price = exit_price + (realized_pnl / exit_qty);
                }
              }
            }

            // 假设6倍杠杆（与当前配置一致）
            const leverage = this.config.risk_config.max_leverage || 6;
            const position_value = entry_price * quantity;
            const margin = position_value / leverage;
            const total_commission = entry_commission + exit_commission;
            const net_pnl = realized_pnl - total_commission;
            const realized_pnl_percent = margin > 0 ? (realized_pnl / margin) * 100 : 0;

            // 创建交易记录
            try {
              await this.trade_record_repository.create_closed_trade({
                symbol,
                side: position_side,
                trading_mode: trading_mode as 'LIVE' | 'TESTNET' | 'PAPER',
                entry_price,
                quantity,
                leverage,
                margin,
                position_value,
                exit_price,
                realized_pnl,
                realized_pnl_percent,
                close_reason: 'BACKFILLED',
                entry_commission,
                exit_commission,
                total_commission,
                commission_asset: 'USDT',
                net_pnl,
                entry_order_id: entry_order_id?.toString(),
                exit_order_id: exit_order_id.toString(),
                status: 'CLOSED',
                opened_at: new Date(entry_time),
                closed_at: new Date(exit_time)
              });

              result.newly_created++;
              result.details.push(`${symbol} ${position_side}: entry=${entry_price.toFixed(6)} exit=${exit_price.toFixed(6)} pnl=${realized_pnl.toFixed(4)} USDT`);
              logger.info(`[TradingSystem] Backfilled trade: ${symbol} ${position_side} pnl=${realized_pnl.toFixed(4)}`);

            } catch (error) {
              result.failed++;
              logger.error(`[TradingSystem] Failed to create backfill record for ${symbol}:`, error);
            }
          }

          // 避免触发限速
          await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error) {
          logger.error(`[TradingSystem] Failed to process trades for ${symbol}:`, error);
        }
      }

      logger.info(`[TradingSystem] Backfill completed: found=${result.total_found}, exists=${result.already_exists}, created=${result.newly_created}, failed=${result.failed}`);
      return result;

    } catch (error) {
      logger.error('[TradingSystem] Failed to backfill historical trades:', error);
      return result;
    }
  }
}
