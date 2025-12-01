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
import { OrderRecordRepository } from '../database/order_record_repository';
import { signal_processing_repository } from '../database/signal_processing_repository';
import {
  SignalProcessingResult,
  RejectionCategory,
  SignalDirection,
  CreateSignalProcessingRecordInput
} from '../types/signal_processing';

export class TradingSystem {
  private signal_generator: SignalGenerator;
  private strategy_engine: StrategyEngine;
  private risk_manager: RiskManager;
  private order_executor: OrderExecutor;
  private position_tracker: PositionTracker;
  private order_record_repository: OrderRecordRepository;

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
    this.order_record_repository = OrderRecordRepository.get_instance();

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
    const signal_received_at = new Date();

    if (!this.is_enabled) {
      return { action: 'DISABLED', reason: 'Trading system is disabled' };
    }

    // 1. 生成交易信号（使用带原因的版本）
    const signal_result = this.signal_generator.generate_signal_with_reason(anomaly);
    if (!signal_result.signal) {
      // ⭐ 记录拒绝：无有效信号
      await this.record_signal_rejection({
        anomaly_id: anomaly.id,
        symbol: anomaly.symbol,
        signal_direction: anomaly.signal_direction === 'LONG' ? SignalDirection.LONG : SignalDirection.SHORT,
        signal_score: anomaly.signal_score,
        rejection_reason: signal_result.reason || '无有效信号',
        rejection_category: RejectionCategory.SIGNAL_SCORE_TOO_LOW,
        signal_received_at
      });

      return {
        action: 'SIGNAL_REJECTED',
        reason: signal_result.reason || '无有效信号'
      };
    }
    const signal = signal_result.signal;

    logger.info(`[TradingSystem] Signal generated: ${signal.symbol} ${signal.direction} (score: ${signal.score.toFixed(2)})`);

    // 2. 方向过滤（只做多）
    const allowed_directions = this.config.allowed_directions || ['LONG']; // 默认只做多
    if (!allowed_directions.includes(signal.direction as any)) {
      logger.info(`[TradingSystem] Signal rejected: ${signal.direction} not in allowed directions [${allowed_directions.join(', ')}]`);

      // ⭐ 记录拒绝：方向过滤
      await this.record_signal_rejection({
        anomaly_id: anomaly.id,
        symbol: signal.symbol,
        signal_direction: signal.direction === 'LONG' ? SignalDirection.LONG : SignalDirection.SHORT,
        signal_score: signal.score,
        rejection_reason: `Direction filter: ${signal.direction} not in allowed directions [${allowed_directions.join(', ')}]`,
        rejection_category: RejectionCategory.MARKET_CONDITIONS,
        signal_received_at
      });

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

      // ⭐ 记录拒绝：策略评估未通过
      const rejection_category = this.categorize_strategy_rejection(strategy_result.reason || '');
      await this.record_signal_rejection({
        anomaly_id: anomaly.id,
        symbol: signal.symbol,
        signal_direction: signal.direction === 'LONG' ? SignalDirection.LONG : SignalDirection.SHORT,
        signal_score: signal.score,
        rejection_reason: strategy_result.reason || 'Strategy evaluation failed',
        rejection_category,
        signal_received_at
      });

      return {
        signal,
        action: 'SIGNAL_REJECTED',
        reason: strategy_result.reason
      };
    }

    // 3.5. 价格趋势检查（2小时涨幅 + 30分钟趋势）
    if (signal.entry_price) {
      const trend_check = await this.check_price_trend(signal.symbol, signal.entry_price);
      if (!trend_check.passed) {
      logger.info(`[TradingSystem] Signal rejected by price trend check: ${trend_check.reason}`);

      // ⭐ 记录拒绝：价格趋势不符合
      await this.record_signal_rejection({
        anomaly_id: anomaly.id,
        symbol: signal.symbol,
        signal_direction: signal.direction === 'LONG' ? SignalDirection.LONG : SignalDirection.SHORT,
        signal_score: signal.score,
        rejection_reason: trend_check.reason || 'Price trend check failed',
        rejection_category: RejectionCategory.MARKET_CONDITIONS,
        signal_received_at
      });

        return {
          signal,
          action: 'SIGNAL_REJECTED',
          reason: trend_check.reason
        };
      }
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

      // ⭐ 记录拒绝：风控拒绝
      const rejection_category = this.categorize_risk_rejection(risk_check.reason || '');
      const daily_stats = await this.get_statistics_from_db();

      await this.record_signal_rejection({
        anomaly_id: anomaly.id,
        symbol: signal.symbol,
        signal_direction: signal.direction === 'LONG' ? SignalDirection.LONG : SignalDirection.SHORT,
        signal_score: signal.score,
        rejection_reason: risk_check.reason || 'Risk check failed',
        rejection_category,
        current_daily_loss: daily_stats.total_pnl < 0 ? Math.abs(daily_stats.total_pnl) : 0,
        current_open_positions: open_positions.length,
        available_balance: this.paper_account_balance,
        signal_received_at
      });

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

        // ⭐ 记录接受：成功开仓
        await this.record_signal_acceptance({
          anomaly_id: anomaly.id,
          symbol: position.symbol,
          signal_direction: position.side === PositionSide.LONG ? SignalDirection.LONG : SignalDirection.SHORT,
          signal_score: signal.score,
          position_id: position.id ? String(position.id) : undefined,
          entry_price: position.entry_price,
          quantity: position.quantity,
          position_value_usd: position.quantity * position.entry_price,
          current_open_positions: open_positions.length + 1,
          available_balance: this.paper_account_balance,
          signal_received_at
        });

        return {
          signal,
          position,
          action: 'POSITION_OPENED'
        };
      }
    } catch (error) {
      logger.error('[TradingSystem] Failed to execute trade:', error);

      // ⭐ 记录拒绝：执行错误
      await this.record_signal_rejection({
        anomaly_id: anomaly.id,
        symbol: signal.symbol,
        signal_direction: signal.direction === 'LONG' ? SignalDirection.LONG : SignalDirection.SHORT,
        signal_score: signal.score,
        rejection_reason: error instanceof Error ? error.message : 'Unknown error',
        rejection_category: RejectionCategory.SYSTEM_ERROR,
        error_message: error instanceof Error ? error.stack : String(error),
        signal_received_at
      });

      return {
        signal,
        action: 'RISK_REJECTED',
        reason: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return { action: 'NO_SIGNAL' };
  }

  /**
   * 记录信号拒绝
   */
  private async record_signal_rejection(data: Omit<CreateSignalProcessingRecordInput, 'processing_result'>): Promise<void> {
    try {
      await signal_processing_repository.create_record({
        ...data,
        processing_result: SignalProcessingResult.REJECTED,
        signal_source: 'OI_ANOMALY'
      });
    } catch (error) {
      logger.error('[TradingSystem] Failed to record signal rejection:', error);
      // 不抛出错误，避免影响主流程
    }
  }

  /**
   * 记录信号接受
   */
  private async record_signal_acceptance(data: Omit<CreateSignalProcessingRecordInput, 'processing_result'>): Promise<void> {
    try {
      await signal_processing_repository.create_record({
        ...data,
        processing_result: SignalProcessingResult.ACCEPTED,
        signal_source: 'OI_ANOMALY'
      });
    } catch (error) {
      logger.error('[TradingSystem] Failed to record signal acceptance:', error);
      // 不抛出错误，避免影响主流程
    }
  }

  /**
   * 根据策略拒绝原因分类
   */
  private categorize_strategy_rejection(reason: string): RejectionCategory {
    if (reason.includes('追高') || reason.includes('chase high')) {
      return RejectionCategory.MARKET_CONDITIONS;
    }
    if (reason.includes('评分') || reason.includes('score')) {
      return RejectionCategory.SIGNAL_SCORE_TOO_LOW;
    }
    return RejectionCategory.OTHER;
  }

  /**
   * 根据风控拒绝原因分类
   */
  private categorize_risk_rejection(reason: string): RejectionCategory {
    if (reason.includes('亏损') || reason.includes('loss limit')) {
      return RejectionCategory.DAILY_LOSS_LIMIT;
    }
    if (reason.includes('持仓') || reason.includes('position') && reason.includes('limit')) {
      return RejectionCategory.MAX_POSITIONS_LIMIT;
    }
    if (reason.includes('已存在') || reason.includes('exists')) {
      return RejectionCategory.POSITION_EXISTS;
    }
    if (reason.includes('余额') || reason.includes('balance')) {
      return RejectionCategory.INSUFFICIENT_BALANCE;
    }
    return RejectionCategory.RISK_MANAGEMENT;
  }

  /**
   * 检查价格趋势（2小时涨幅和30分钟趋势）
   * @param symbol 交易对
   * @param current_price 当前价格（来自信号的开仓价）
   * @returns 检查结果
   */
  private async check_price_trend(
    symbol: string,
    current_price: number
  ): Promise<{
    passed: boolean;
    reason?: string;
    data?: {
      price_2h_ago: number;
      price_30m_ago: number;
      rise_2h_pct: number;
      rise_30m_pct: number;
    };
  }> {
    try {
      // 获取25根5分钟K线（覆盖2小时）
      const klines = await this.order_executor.get_klines(symbol, '5m', 25);

      if (!klines || klines.length < 25) {
        logger.warn(`[TradingSystem] Failed to get klines for ${symbol}, skip price trend check`);
        return { passed: true }; // API失败时不阻止交易
      }

      const price_2h_ago = klines[0].close;      // 索引0 = 2小时前
      const price_30m_ago = klines[18].close;    // 索引18 = 30分钟前 (25-6-1)

      // 计算涨幅
      const rise_2h_pct = ((current_price - price_2h_ago) / price_2h_ago) * 100;
      const rise_30m_pct = ((current_price - price_30m_ago) / price_30m_ago) * 100;

      const data = {
        price_2h_ago,
        price_30m_ago,
        rise_2h_pct,
        rise_30m_pct
      };

      // 检查1: 2小时涨幅不超过8%（避免追高）
      if (rise_2h_pct > 8) {
        return {
          passed: false,
          reason: `追高风险：2小时涨幅${rise_2h_pct.toFixed(2)}%超过8%阈值`,
          data
        };
      }

      // 检查2: 30分钟趋势向上（当前价格必须高于30分钟前）
      if (current_price <= price_30m_ago) {
        return {
          passed: false,
          reason: `趋势不符：当前价格${current_price}未高于30分钟前${price_30m_ago}`,
          data
        };
      }

      logger.info(
        `[TradingSystem] ${symbol} 价格趋势检查通过: ` +
        `2h涨幅=${rise_2h_pct.toFixed(2)}%, 30m涨幅=${rise_30m_pct.toFixed(2)}%`
      );

      return { passed: true, data };
    } catch (error) {
      logger.error(`[TradingSystem] Error checking price trend for ${symbol}:`, error);
      return { passed: true }; // 发生错误时不阻止交易
    }
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
    let tp_config: {
      targets: Array<{
        percentage: number;
        target_profit_pct: number;
        is_trailing?: boolean;
        trailing_callback_pct?: number;
      }>;
    };

    // 优先使用分批止盈配置
    if (this.config.risk_config.take_profit_targets && this.config.risk_config.take_profit_targets.length > 0) {
      // 使用配置的分批止盈
      tp_config = {
        targets: this.config.risk_config.take_profit_targets.map(target => ({
          percentage: target.percentage,
          target_profit_pct: target.target_profit_pct,
          is_trailing: target.is_trailing,
          trailing_callback_pct: target.trailing_callback_pct
        }))
      };
      logger.info(`[TradingSystem] Using multi-batch take profit: ${tp_config.targets.length} targets`);
    } else {
      // 回退到单批止盈（默认行为）
      const take_profit_pct = this.config.risk_config.default_take_profit_percent;
      const trailing_callback_pct = this.config.risk_config.trailing_stop_callback_rate || 15;
      const use_trailing = this.config.risk_config.use_trailing_stop;

      tp_config = {
        targets: [
          {
            percentage: 100,  // 全部仓位
            target_profit_pct: take_profit_pct,
            is_trailing: use_trailing,
            trailing_callback_pct: trailing_callback_pct
          }
        ]
      };
    }

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

    // 生成 position_id（用于关联同一持仓周期的开平仓订单）
    // 格式：${symbol}_${direction}_${timestamp}，包含方向以区分多空
    const position_id = `${signal.symbol}_${signal.direction}_${Date.now()}`;
    position.position_id = position_id;

    // 写入数据库（统一从 userTrades 获取数据）
    if (this.config.mode === TradingMode.PAPER) {
      // 纸面交易：直接用下单返回值写库
      try {
        const order_db_id = await this.order_record_repository.create_order({
          order_id: `PAPER_${Date.now()}`,
          symbol: signal.symbol,
          side: signal.direction === 'LONG' ? 'BUY' : 'SELL',
          position_side: signal.direction === 'LONG' ? 'LONG' : 'SHORT',
          order_type: 'OPEN',
          trading_mode: 'PAPER',
          price: entry_order.average_price || entry_price,
          quantity: entry_order.filled_quantity || quantity,
          leverage: leverage,
          position_id: position_id,
          signal_id: signal.source_anomaly_id,
          anomaly_id: signal.source_anomaly_id,
          order_time: position.opened_at
        });
        // ⚠️ 不要修改 position.id，它是 position_tracker Map 的 key
        // position.position_id 用于数据库关联
        logger.info(`[TradingSystem] Paper order record saved, db_id=${order_db_id}`);
      } catch (error) {
        logger.error('[TradingSystem] Failed to save paper order record:', error);
      }
    } else if (entry_order.order_id) {
      // 实盘/测试网：异步从 userTrades 获取数据后写库
      this.save_order_from_user_trades(
        entry_order.order_id,
        signal.symbol,
        'OPEN',
        position_id,
        leverage,
        signal.source_anomaly_id
      ).then(db_id => {
        // ⚠️ 不要修改 position.id，它是 position_tracker Map 的 key
        // db_id 只用于日志，数据库关联用 position.position_id
        if (db_id) {
          logger.debug(`[TradingSystem] Order saved to db, db_id=${db_id}`);
        }
      });
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
      logger.debug('[TradingSystem] Timeout check skipped: max_holding_time_minutes not configured');
      return; // 未配置最大持仓时间，跳过检查
    }

    const open_positions = this.position_tracker.get_open_positions();
    const now = Date.now();

    // 调试：打印所有持仓的超时状态
    if (open_positions.length > 0) {
      logger.info(`[TradingSystem] Timeout check: ${open_positions.length} positions, max_hold=${this.config.max_holding_time_minutes}min, price_map has ${price_map.size} prices`);
    }

    for (const position of open_positions) {
      // 检查持仓时间
      const holding_time_ms = now - position.opened_at.getTime();
      const holding_time_minutes = holding_time_ms / (1000 * 60);

      if (holding_time_minutes >= this.config.max_holding_time_minutes) {
        const current_price = price_map.get(position.symbol);

        // 调试日志：为什么没有平仓
        if (!current_price) {
          logger.warn(`[TradingSystem] Position ${position.symbol} timeout (${holding_time_minutes.toFixed(1)}min) but NO PRICE in price_map. Available: [${Array.from(price_map.keys()).join(', ')}]`);
          continue;
        }
        if (!position.id) {
          logger.warn(`[TradingSystem] Position ${position.symbol} timeout but NO ID`);
          continue;
        }

        logger.info(`[TradingSystem] Position ${position.symbol} timeout (${holding_time_minutes.toFixed(1)}min >= ${this.config.max_holding_time_minutes}min), closing @ ${current_price}...`);

        // ⭐ 先撤销所有挂单，再平仓（防止竞态：平仓后止盈单触发导致开反向仓）
        try {
          const cancelled = await this.order_executor.cancel_all_open_orders(position.symbol);
          if (cancelled) {
            logger.info(`[TradingSystem] Cancelled all open orders for ${position.symbol} before timeout close`);
          } else {
            logger.warn(`[TradingSystem] Failed to cancel orders for ${position.symbol}, proceeding with close anyway`);
          }
        } catch (cancel_err) {
          logger.warn(`[TradingSystem] Error cancelling orders for ${position.symbol}:`, cancel_err);
        }

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
        } else {
          logger.error(`[TradingSystem] Failed to close timeout position ${position.symbol}`);
        }
      }
    }
  }

  /**
   * 手动平仓
   */
  async close_position_manual(position_id: number, current_price: number): Promise<boolean> {
    // 先获取仓位信息，用于撤单
    const position_info = this.position_tracker.get_position(position_id);
    if (!position_info) {
      logger.warn(`[TradingSystem] Position ${position_id} not found for manual close`);
      return false;
    }

    // ⭐ 先撤销所有挂单，再平仓（防止竞态：平仓后止盈单触发导致开反向仓）
    try {
      const cancelled = await this.order_executor.cancel_all_open_orders(position_info.symbol);
      if (cancelled) {
        logger.info(`[TradingSystem] Cancelled all open orders for ${position_info.symbol} before manual close`);
      } else {
        logger.warn(`[TradingSystem] Failed to cancel orders for ${position_info.symbol}, proceeding with close anyway`);
      }
    } catch (cancel_err) {
      logger.warn(`[TradingSystem] Error cancelling orders for ${position_info.symbol}:`, cancel_err);
    }

    // 执行手动平仓
    const position = await this.position_tracker.close_position(
      position_id,
      current_price,
      'MANUAL'
    );

    if (position) {
      if (this.config.mode === TradingMode.PAPER) {
        // 返还保证金 + 盈亏
        const capital = position.entry_price * position.quantity;
        this.paper_account_balance += capital / position.leverage + (position.realized_pnl || 0);
      }

      // 更新数据库记录
      await this.update_trade_record_on_close(position);
    }

    return position !== null;
  }

  /**
   * 平仓后更新数据库记录
   */
  private async update_trade_record_on_close(position: PositionRecord): Promise<void> {
    // 纸面交易：直接用本地数据写库
    if (this.config.mode === TradingMode.PAPER) {
      try {
        await this.order_record_repository.create_order({
          order_id: `PAPER_CLOSE_${Date.now()}`,
          symbol: position.symbol,
          side: position.side === PositionSide.LONG ? 'SELL' : 'BUY',
          position_side: position.side === PositionSide.LONG ? 'LONG' : 'SHORT',
          order_type: 'CLOSE',
          trading_mode: 'PAPER',
          price: position.current_price,
          quantity: position.quantity,
          realized_pnl: position.realized_pnl || 0,
          position_id: position.position_id,
          related_order_id: position.entry_order_id?.toString(),
          close_reason: position.close_reason || 'MANUAL',
          order_time: position.closed_at || new Date()
        });
        logger.info(`[TradingSystem] Paper close order saved, pnl=${(position.realized_pnl || 0).toFixed(4)}`);
      } catch (error) {
        logger.error('[TradingSystem] Failed to save paper close order:', error);
      }
      return;
    }

    // 实盘/测试网：从 userTrades 获取数据后写库
    if (position.exit_order_id) {
      this.save_order_from_user_trades(
        position.exit_order_id.toString(),
        position.symbol,
        'CLOSE',
        position.position_id,
        position.leverage,
        undefined,
        position.entry_order_id?.toString(),
        position.close_reason
      );
    }
  }

  /**
   * 从 userTrades 获取订单数据并写入数据库
   * 统一的数据存储入口，确保所有订单数据来源一致
   */
  private async save_order_from_user_trades(
    order_id: string,
    symbol: string,
    order_type: 'OPEN' | 'CLOSE',
    position_id?: string,
    leverage?: number,
    signal_id?: number,
    related_order_id?: string,
    close_reason?: string
  ): Promise<number | null> {
    try {
      // 延迟1秒确保成交记录已同步到币安
      await new Promise(resolve => setTimeout(resolve, 1000));

      const tradeInfo = await this.order_executor.get_order_trades(symbol, parseInt(order_id));
      if (!tradeInfo) {
        logger.warn(`[TradingSystem] No trade info found for order ${order_id}`);
        return null;
      }

      const trading_mode = this.config.mode === TradingMode.TESTNET ? 'TESTNET' : 'LIVE';

      // 处理 positionSide：BOTH（单向持仓）时根据 side 推断
      // 开仓：BUY->LONG, SELL->SHORT
      // 平仓：SELL->LONG（平多）, BUY->SHORT（平空）
      let position_side: 'LONG' | 'SHORT';
      if (tradeInfo.positionSide === 'BOTH') {
        if (order_type === 'OPEN') {
          position_side = tradeInfo.side === 'BUY' ? 'LONG' : 'SHORT';
        } else {
          position_side = tradeInfo.side === 'SELL' ? 'LONG' : 'SHORT';
        }
      } else {
        position_side = tradeInfo.positionSide as 'LONG' | 'SHORT';
      }

      // 从 userTrades 获取的数据写入数据库
      const db_id = await this.order_record_repository.create_order({
        order_id: order_id,
        symbol: symbol,
        side: tradeInfo.side as 'BUY' | 'SELL',
        position_side: position_side,
        order_type: order_type,
        trading_mode: trading_mode,
        price: tradeInfo.avgPrice,
        quantity: tradeInfo.totalQuantity,
        quote_quantity: tradeInfo.avgPrice * tradeInfo.totalQuantity,
        leverage: leverage || 1,
        realized_pnl: order_type === 'CLOSE' ? tradeInfo.realizedPnl : undefined,
        commission: tradeInfo.totalCommission,
        commission_asset: tradeInfo.commissionAsset,
        position_id: position_id,
        related_order_id: related_order_id,
        close_reason: order_type === 'CLOSE' ? close_reason : undefined,
        signal_id: signal_id,
        anomaly_id: signal_id,
        order_time: new Date(tradeInfo.time)
      });

      logger.info(`[TradingSystem] Order saved from userTrades: ${order_type} ${symbol} order_id=${order_id}, price=${tradeInfo.avgPrice}, qty=${tradeInfo.totalQuantity}, commission=${tradeInfo.totalCommission}${order_type === 'CLOSE' ? `, pnl=${tradeInfo.realizedPnl}` : ''}`);
      return db_id;
    } catch (error) {
      logger.error(`[TradingSystem] Failed to save order from userTrades:`, error);
      return null;
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
   * 按 position_id 计算完整交易笔数（分批止盈算一笔）
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

    // 使用新表 order_records 统计
    const db_stats = await this.order_record_repository.get_statistics(trading_mode, this.started_at);

    return {
      total_trades: db_stats.total_trades,  // 按position_id计算的完整交易笔数
      winning_trades: db_stats.winning_trades,
      losing_trades: db_stats.losing_trades,
      win_rate: db_stats.win_rate * 100,
      total_pnl: db_stats.total_pnl,
      total_commission: db_stats.total_commission,
      net_pnl: db_stats.net_pnl
    };
  }

  /**
   * 获取今日交易统计（从数据库）
   * 按 position_id 计算完整交易笔数（分批止盈算一笔）
   */
  async get_today_statistics_from_db(): Promise<{
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

    // 获取今日0点时间
    const today_start = new Date();
    today_start.setHours(0, 0, 0, 0);

    const db_stats = await this.order_record_repository.get_statistics(trading_mode, today_start);

    return {
      total_trades: db_stats.total_trades,  // 按position_id计算的完整交易笔数
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

      // 完全以币安数据为准，不做安全检查
      // 即使API偶尔返回空，下次同步也会恢复

      // 检查币安有但本地没有的持仓（需要添加）
      for (const bp of binance_positions) {
        const local = local_positions.find(lp => lp.symbol === bp.symbol && lp.side === bp.side);

        if (!local) {
          // 本地没有这个持仓，需要添加
          // ⚠️ 保证金用固定公式计算，不用 isolatedWallet（会随浮动盈亏变化）
          const margin = bp.entryPrice * bp.positionAmt / bp.leverage;
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

          // 查询真正的开仓时间（通过历史成交记录反向累加匹配）
          let actual_opened_at = new Date(bp.updateTime);  // 默认使用 updateTime
          try {
            const entry_time = await this.fetch_actual_entry_time(
              bp.symbol,
              side,
              bp.positionAmt,  // 当前持仓数量
              bp.entryPrice    // 开仓均价
            );
            if (entry_time) {
              actual_opened_at = entry_time;
              logger.info(`[TradingSystem] Found actual entry time for ${bp.symbol}: ${actual_opened_at.toISOString()}`);
            } else {
              logger.warn(`[TradingSystem] Could not find matching entry time for ${bp.symbol}, using updateTime as fallback`);
            }
          } catch (err) {
            logger.warn(`[TradingSystem] Failed to fetch actual entry time for ${bp.symbol}, using updateTime:`, err);
          }

          const new_position: PositionRecord = {
            symbol: bp.symbol,
            side: side,
            entry_price: bp.entryPrice,
            current_price: bp.entryPrice,
            quantity: bp.positionAmt,
            leverage: bp.leverage,
            margin: margin,
            is_open: true,
            opened_at: actual_opened_at,
            // PnL 直接用币安返回值，盈亏率 = PnL / 保证金
            unrealized_pnl: bp.unrealizedProfit,
            unrealized_pnl_percent: margin > 0
              ? (bp.unrealizedProfit / margin) * 100
              : 0,
            stop_loss_price: stop_loss_price,
            take_profit_price: take_profit_price
          };

          this.position_tracker.add_synced_position(new_position);
          logger.info(`[TradingSystem] Synced new position from Binance: ${bp.symbol} ${bp.side} qty=${bp.positionAmt} @ ${bp.entryPrice}, opened_at=${new_position.opened_at.toISOString()}, SL=${stop_loss_price?.toFixed(6) || 'N/A'}, TP=${take_profit_price.toFixed(6)}`);
          added++;

          // 检查数据库是否有对应记录，如果没有则创建
          await this.ensure_trade_record_for_synced_position(new_position, bp);
        } else {
          // ⭐ 检测部分止盈：如果币安数量小于本地数量，说明部分平仓了
          const quantity_diff = local.quantity - bp.positionAmt;
          if (quantity_diff > 0.0001) {  // 有显著的数量差异
            logger.info(`[TradingSystem] Detected partial close for ${local.symbol}: qty ${local.quantity} -> ${bp.positionAmt} (diff: ${quantity_diff.toFixed(6)})`);

            // 记录部分止盈的已实现盈亏
            await this.record_partial_close(local, quantity_diff, bp);

            // 更新本地持仓数量
            local.quantity = bp.positionAmt;
            // 更新保证金（用固定公式计算，不用 isolatedWallet）
            local.margin = local.entry_price * bp.positionAmt / local.leverage;

            // ⭐ 检查挂单数量是否超过剩余仓位，超过则撤销所有挂单防止开反向仓
            const position_side = local.side === PositionSide.LONG ? 'LONG' : 'SHORT';
            await this.order_executor.check_and_cancel_excess_orders(
              local.symbol,
              bp.positionAmt,  // 剩余仓位数量
              position_side
            );
          }

          // 更新未实现盈亏
          // 币安返回的 unrealizedProfit 就是真实的仓位盈亏（美元）
          // 盈亏率 = unrealizedProfit / 保证金（相对保证金的收益率）
          // ⚠️ 保证金必须用固定公式计算：entry_price * quantity / leverage
          // 不能用 isolatedWallet，因为 isolatedWallet 会随浮动盈亏变化导致 PnL% 波动
          const current_margin = local.entry_price * local.quantity / local.leverage;
          local.margin = current_margin;  // 同时更新 local.margin 保持一致
          local.unrealized_pnl = bp.unrealizedProfit;
          local.unrealized_pnl_percent = current_margin > 0
            ? (bp.unrealizedProfit / current_margin) * 100
            : 0;

          // 检查是否达到保本止损条件（盈利 >= 5% 且未下过保本止损单）
          if (local.unrealized_pnl_percent >= 5 && !local.breakeven_sl_placed) {
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

          // ⭐ 撤销该币种所有未成交的止盈/止损挂单
          // 场景：成本止损或手动平仓后，之前挂的分批止盈单需要撤销，否则会开反向仓
          try {
            await this.order_executor.cancel_all_open_orders(lp.symbol);
            logger.info(`[TradingSystem] Cancelled all open orders for ${lp.symbol} after position closed`);
          } catch (cancel_err) {
            logger.warn(`[TradingSystem] Failed to cancel open orders for ${lp.symbol}:`, cancel_err);
          }

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

          // 写入新表 order_records（同步发现的平仓）
          const trading_mode_str = this.config.mode === TradingMode.TESTNET ? 'TESTNET' : 'LIVE';

          if (exit_order_id) {
            try {
              const close_side = lp.side === PositionSide.LONG ? 'SELL' : 'BUY';
              await this.order_record_repository.create_order({
                order_id: exit_order_id.toString(),
                symbol: lp.symbol,
                side: close_side as 'BUY' | 'SELL',
                position_side: lp.side === PositionSide.LONG ? 'LONG' : 'SHORT',
                order_type: 'CLOSE',
                trading_mode: trading_mode_str as 'PAPER' | 'TESTNET' | 'LIVE',
                price: exit_price,
                quantity: lp.quantity,
                realized_pnl: realized_pnl,
                commission: exit_commission,
                commission_asset: 'USDT',
                position_id: lp.position_id,
                related_order_id: lp.entry_order_id?.toString(),
                close_reason: 'SYNC_CLOSED',
                order_time: closed_at || new Date()
              });
              logger.info(`[TradingSystem] Sync-closed order saved to order_records: order_id=${exit_order_id}, pnl=${realized_pnl.toFixed(4)}`);
            } catch (err) {
              logger.error('[TradingSystem] Failed to save sync-closed order to order_records:', err);
            }
          }
        }
      }

      if (added > 0 || removed > 0 || updated > 0) {
        logger.info(`[TradingSystem] Position sync completed: added=${added}, removed=${removed}, updated=${updated}`);
      }

      // ⭐ 同步完成后检查超时平仓
      // 构建价格Map（使用本地持仓的当前价格，已在上面同步时更新）
      const open_positions = this.position_tracker.get_open_positions();
      if (open_positions.length > 0) {
        const price_map = new Map<string, number>();
        for (const position of open_positions) {
          price_map.set(position.symbol, position.current_price);
        }

        // 执行超时检查和平仓
        await this.check_and_close_timeout_positions(price_map);
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
   * 尝试关联同步持仓与数据库记录
   * 不再创建 SYNC_ 伪记录，因为回填历史交易已经覆盖了所有订单
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
    // 生成 position_id（用于内存关联）
    position.position_id = `${binance_position.symbol}_${binance_position.updateTime}`;

    // 注意：不再插入 SYNC_ 伪记录
    // 开仓订单应该已经通过以下方式存入数据库：
    // 1. 实时开仓 -> save_order_from_user_trades()
    // 2. 历史开仓 -> backfill_historical_trades()
    // 同步持仓只负责将币安持仓同步到内存，不创建数据库记录
  }

  /**
   * 尝试下保本止损单
   * 当盈利达到5%时，设置止损单确保覆盖手续费后保本
   * 止损价 = 成本价 × (1 + 手续费率×2 + 滑点余量)
   * 会先通过币安API检查是否已有止损挂单，避免重复下单
   */
  private async try_place_breakeven_stop_loss(position: PositionRecord): Promise<void> {
    try {
      // 计算覆盖手续费的止损价
      // Taker费率0.05%，开仓+平仓共0.1%，再加0.05%滑点余量 = 0.15%
      const fee_compensation_rate = 0.0015; // 0.15%
      let breakeven_price: number;

      if (position.side === PositionSide.LONG) {
        // 多头：止损价要高于成本价才能覆盖手续费
        breakeven_price = position.entry_price * (1 + fee_compensation_rate);
      } else {
        // 空头：止损价要低于成本价才能覆盖手续费
        breakeven_price = position.entry_price * (1 - fee_compensation_rate);
      }

      logger.info(`[TradingSystem] Position ${position.symbol} reached +${position.unrealized_pnl_percent.toFixed(2)}%, checking/placing breakeven stop loss at ${breakeven_price.toFixed(6)} (entry: ${position.entry_price}, +0.15% fee compensation)`);

      const result = await this.order_executor.place_breakeven_stop_loss(
        position.symbol,
        position.side,
        position.quantity,
        breakeven_price
      );

      if (result.success) {
        // 标记已下保本止损单（无论是新下单还是已存在）
        position.breakeven_sl_placed = true;

        if (result.alreadyExists) {
          // 止损单已存在，静默标记
          logger.info(`[TradingSystem] ✅ Stop loss already exists for ${position.symbol}, marked as breakeven_sl_placed`);
        } else {
          // 新下单成功
          logger.info(`[TradingSystem] ✅ Breakeven stop loss placed for ${position.symbol}: orderId=${result.orderId}, stopPrice=${breakeven_price.toFixed(6)}`);
          console.log(`\n🛡️ 保本止损已设置: ${position.symbol} @ ${breakeven_price.toFixed(6)} (成本${position.entry_price}+0.15%手续费, 当前盈利: +${position.unrealized_pnl_percent.toFixed(2)}%)\n`);
        }
      } else {
        logger.error(`[TradingSystem] ❌ Failed to place breakeven stop loss for ${position.symbol}: ${result.error}`);
      }
    } catch (error) {
      logger.error(`[TradingSystem] Error placing breakeven stop loss for ${position.symbol}:`, error);
    }
  }

  /**
   * 记录部分平仓的已实现盈亏
   * 当检测到持仓数量减少时调用，从币安获取精确的部分平仓数据
   */
  private async record_partial_close(
    local_position: PositionRecord,
    closed_quantity: number,
    binance_position: any
  ): Promise<void> {
    try {
      // 从币安查询最近的成交记录，找出部分平仓的数据
      const trades = await this.order_executor.get_historical_trades(local_position.symbol, {
        startTime: local_position.opened_at.getTime(),
        endTime: Date.now(),
        limit: 100
      });

      if (!trades || trades.length === 0) {
        logger.warn(`[TradingSystem] No trades found for partial close of ${local_position.symbol}`);
        return;
      }

      // 找出平仓方向的成交（平多用SELL，平空用BUY）
      const close_side = local_position.side === PositionSide.LONG ? 'SELL' : 'BUY';

      // 按订单ID分组，找出有realized_pnl的订单（即平仓订单）
      const trades_by_order = new Map<number, typeof trades>();
      for (const trade of trades) {
        if (trade.side === close_side) {
          if (!trades_by_order.has(trade.orderId)) {
            trades_by_order.set(trade.orderId, []);
          }
          trades_by_order.get(trade.orderId)!.push(trade);
        }
      }

      // 找出最近的有盈亏的平仓订单
      let recent_close_trades: typeof trades | null = null;
      let recent_close_time = 0;
      let recent_order_id = 0;

      for (const [orderId, orderTrades] of trades_by_order) {
        const totalPnl = orderTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const trade_time = Math.max(...orderTrades.map(t => t.time));

        if (Math.abs(totalPnl) > 0.0001 && trade_time > recent_close_time) {
          recent_close_trades = orderTrades;
          recent_close_time = trade_time;
          recent_order_id = orderId;
        }
      }

      if (!recent_close_trades) {
        logger.warn(`[TradingSystem] No closing trade found for partial close of ${local_position.symbol}`);
        return;
      }

      // ⭐ 检查该订单是否已记录过，避免重复记录
      const trading_mode_str = this.config.mode === TradingMode.PAPER ? 'PAPER'
        : this.config.mode === TradingMode.TESTNET ? 'TESTNET' : 'LIVE';
      const existing_record = await this.order_record_repository.find_by_order_id(
        recent_order_id.toString(),
        trading_mode_str
      );
      if (existing_record) {
        logger.debug(`[TradingSystem] Order ${recent_order_id} already recorded, skipping duplicate`);
        return;
      }

      // 计算部分平仓的数据
      const closed_qty = recent_close_trades.reduce((sum, t) => sum + parseFloat(t.qty), 0);
      const closed_quote_qty = recent_close_trades.reduce((sum, t) => sum + parseFloat(t.quoteQty), 0);
      const exit_price = closed_qty > 0 ? closed_quote_qty / closed_qty : 0;
      const exit_commission = recent_close_trades.reduce((sum, t) => sum + parseFloat(t.commission), 0);
      const realized_pnl = recent_close_trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);

      // 记录到分批止盈执行记录
      const execution = {
        batch_number: (local_position.take_profit_executions?.length || 0) + 1,
        type: 'BATCH_TAKE_PROFIT' as const,
        quantity: closed_qty,
        exit_price: exit_price,
        pnl: realized_pnl,
        profit_percent: local_position.entry_price > 0
          ? ((exit_price - local_position.entry_price) / local_position.entry_price) * 100
          : 0,
        executed_at: new Date(recent_close_time),
        reason: 'Manual partial close detected via sync'
      };

      if (!local_position.take_profit_executions) {
        local_position.take_profit_executions = [];
      }
      local_position.take_profit_executions.push(execution);

      // 写入新表 order_records（分批平仓订单）
      try {
        await this.order_record_repository.create_order({
          order_id: recent_order_id.toString(),
          symbol: local_position.symbol,
          side: close_side as 'BUY' | 'SELL',
          position_side: local_position.side === PositionSide.LONG ? 'LONG' : 'SHORT',
          order_type: 'CLOSE',
          trading_mode: trading_mode_str as 'PAPER' | 'TESTNET' | 'LIVE',
          price: exit_price,
          quantity: closed_qty,
          realized_pnl: realized_pnl,
          commission: exit_commission,
          commission_asset: 'USDT',
          position_id: local_position.position_id,
          related_order_id: local_position.entry_order_id?.toString(),
          close_reason: 'PARTIAL_TAKE_PROFIT',
          order_time: new Date(recent_close_time)
        });

        logger.info(`[TradingSystem] Partial close order saved to order_records: order_id=${recent_order_id}, pnl=${realized_pnl.toFixed(4)}`);
        console.log(`\n💰 部分止盈已记录: ${local_position.symbol} 平仓 ${closed_qty.toFixed(4)} @ ${exit_price.toFixed(6)}, 盈亏: ${realized_pnl >= 0 ? '+' : ''}$${realized_pnl.toFixed(4)}\n`);
      } catch (err) {
        logger.error(`[TradingSystem] Failed to save partial close to order_records:`, err);
      }

    } catch (error) {
      logger.error(`[TradingSystem] Error recording partial close for ${local_position.symbol}:`, error);
    }
  }

  /**
   * 查询真正的开仓时间
   * 通过反向累加持仓量，找到当前持仓的真实开仓时间点
   *
   * ⭐ 核心逻辑：从最新交易往前推，累加开平仓数量，找到持仓从0开始的转折点
   * 支持多次开平仓、部分止盈等复杂场景
   *
   * @param symbol 交易对
   * @param side 持仓方向
   * @param current_position_amt 当前持仓数量
   * @param entry_price 开仓均价（用于价格验证）
   */
  private async fetch_actual_entry_time(
    symbol: string,
    side: PositionSide,
    current_position_amt: number,
    entry_price: number
  ): Promise<Date | null> {
    try {
      // 查询最近7天的成交记录
      const endTime = Date.now();
      const startTime = endTime - 7 * 24 * 60 * 60 * 1000;

      const trades = await this.order_executor.get_historical_trades(symbol, {
        startTime,
        endTime,
        limit: 500
      });

      if (!trades || trades.length === 0) {
        return null;
      }

      // 开仓方向：LONG->BUY, SHORT->SELL
      const entry_side = side === PositionSide.LONG ? 'BUY' : 'SELL';
      const exit_side = side === PositionSide.LONG ? 'SELL' : 'BUY';

      // ⭐ 反向累加持仓量，从最新交易往前推
      let position_amt = current_position_amt;

      logger.debug(`[TradingSystem] Backtracking entry time for ${symbol} ${side}, current_amt=${current_position_amt}, entry_price=${entry_price}`);

      for (let i = trades.length - 1; i >= 0; i--) {
        const trade = trades[i];
        const trade_qty = parseFloat(trade.qty);
        const trade_price = parseFloat(trade.price);

        if (trade.side === exit_side) {
          // 平仓交易 → 之前持仓应该更多
          position_amt += trade_qty;
          logger.debug(`[TradingSystem]   ${new Date(trade.time).toISOString()} ${trade.side} ${trade_qty} (CLOSE) → position_amt=${position_amt.toFixed(4)}`);

        } else if (trade.side === entry_side) {
          // 开仓/加仓交易
          const prev_position = position_amt - trade_qty;

          logger.debug(`[TradingSystem]   ${new Date(trade.time).toISOString()} ${trade.side} ${trade_qty} @ ${trade_price} (OPEN) → prev=${prev_position.toFixed(4)}`);

          // 🎯 找到持仓从0开始的点
          if (prev_position <= 0.0001) {
            // 价格验证：确保是同一批持仓（允许5%误差）
            const price_diff_pct = Math.abs(trade_price - entry_price) / entry_price;

            if (price_diff_pct < 0.05) {
              logger.info(`[TradingSystem] ✅ Found entry time for ${symbol}: ${new Date(trade.time).toISOString()}, price=${trade_price} (diff=${(price_diff_pct*100).toFixed(2)}%)`);
              return new Date(trade.time);
            } else {
              logger.warn(`[TradingSystem] ⚠️ Found position start but price mismatch: trade=${trade_price} vs entry=${entry_price} (diff=${(price_diff_pct*100).toFixed(2)}%), continuing search...`);
            }
          }

          position_amt = prev_position;
        }
      }

      logger.warn(`[TradingSystem] ❌ No matching entry trade found for ${symbol} ${side} (backtracked to position_amt=${position_amt.toFixed(4)})`);
      return null;
    } catch (error) {
      logger.error(`[TradingSystem] Failed to fetch entry time for ${symbol}:`, error);
      return null;
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

      // 找出所有平仓订单（有realized_pnl的是平仓）
      // 平多用SELL，平空用BUY
      const close_side = side === PositionSide.LONG ? 'SELL' : 'BUY';

      // ⭐ 累加所有平仓订单的数据（支持部分平仓场景）
      const all_close_orders: Array<{
        orderId: number;
        trades: typeof trades;
        qty: number;
        quoteQty: number;
        commission: number;
        pnl: number;
        time: number;
      }> = [];

      for (const [orderId, orderTrades] of trades_by_order) {
        const totalPnl = orderTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const trade_side = orderTrades[0].side;

        // 是平仓方向且有盈亏
        if (trade_side === close_side && Math.abs(totalPnl) > 0.0001) {
          const qty = orderTrades.reduce((sum, t) => sum + parseFloat(t.qty), 0);
          const quoteQty = orderTrades.reduce((sum, t) => sum + parseFloat(t.quoteQty), 0);
          const commission = orderTrades.reduce((sum, t) => sum + parseFloat(t.commission), 0);
          const time = Math.max(...orderTrades.map(t => t.time));

          all_close_orders.push({
            orderId,
            trades: orderTrades,
            qty,
            quoteQty,
            commission,
            pnl: totalPnl,
            time
          });
        }
      }

      if (all_close_orders.length === 0) {
        logger.warn(`[TradingSystem] No closing trade found for ${symbol} ${side}`);
        return null;
      }

      // ⭐ 按时间排序，取最晚的订单ID作为exit_order_id
      all_close_orders.sort((a, b) => a.time - b.time);
      const latest_order = all_close_orders[all_close_orders.length - 1];

      // ⭐ 累加所有平仓订单的数据
      const total_exit_qty = all_close_orders.reduce((sum, o) => sum + o.qty, 0);
      const total_exit_quote_qty = all_close_orders.reduce((sum, o) => sum + o.quoteQty, 0);
      const exit_price = total_exit_qty > 0 ? total_exit_quote_qty / total_exit_qty : 0;
      const exit_commission = all_close_orders.reduce((sum, o) => sum + o.commission, 0);
      const realized_pnl = all_close_orders.reduce((sum, o) => sum + o.pnl, 0);

      logger.info(`[TradingSystem] Found actual close data for ${symbol}: ${all_close_orders.length} close orders, price=${exit_price.toFixed(6)}, pnl=${realized_pnl.toFixed(4)}, commission=${exit_commission.toFixed(4)}`);

      return {
        exit_price,
        realized_pnl,
        exit_commission,
        exit_order_id: latest_order.orderId,
        closed_at: new Date(latest_order.time)
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
   * ⭐ 核心逻辑：按开仓订单分组，累加所有关联的平仓订单数据
   * 支持分批止盈场景：一个开仓订单可能对应多个平仓订单
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

      // 按symbol分组（有平仓记录的币种）
      const symbols_to_backfill = new Set(pnl_records?.map(r => r.symbol) || []);

      // 2. 补充当前持仓的币种（可能有未平仓的开仓订单）
      const binance_positions = await this.order_executor.get_binance_positions();
      if (binance_positions) {
        for (const pos of binance_positions) {
          const amt = typeof pos.positionAmt === 'string' ? parseFloat(pos.positionAmt) : pos.positionAmt;
          if (Math.abs(amt) > 0) {
            symbols_to_backfill.add(pos.symbol);
          }
        }
      }

      if (symbols_to_backfill.size === 0) {
        logger.info('[TradingSystem] No symbols to backfill');
        return result;
      }

      logger.info(`[TradingSystem] Found ${symbols_to_backfill.size} symbols to backfill (${pnl_records?.length || 0} PnL records + current positions)`);

      // 3. 对每个币种，获取详细成交记录
      for (const symbol of symbols_to_backfill) {
        try {
          // 获取该币种的成交记录
          const trades = await this.order_executor.get_historical_trades(symbol, {
            startTime,
            endTime,
            limit: 1000
          });

          if (!trades || trades.length === 0) continue;

          // ⭐ 新逻辑：按订单存储，每个订单一条记录
          // 按订单ID分组成交记录
          const trades_by_order = new Map<number, typeof trades>();
          for (const trade of trades) {
            const orderId = trade.orderId;
            if (!trades_by_order.has(orderId)) {
              trades_by_order.set(orderId, []);
            }
            trades_by_order.get(orderId)!.push(trade);
          }

          // 收集所有订单ID，批量检查是否存在
          const all_order_ids = Array.from(trades_by_order.keys()).map(id => id.toString());
          const existing_order_ids = await this.order_record_repository.find_existing_order_ids(
            all_order_ids,
            trading_mode
          );

          // ⭐ 预处理：按时间排序订单，用于生成position_id
          // 将订单按时间排序，先处理开仓订单，为后续平仓订单分配相同的position_id
          interface OrderInfo {
            orderId: number;
            orderTrades: typeof trades;
            orderTime: number;
            order_type: 'OPEN' | 'CLOSE';
            position_side: 'LONG' | 'SHORT';
            side: 'BUY' | 'SELL';
            totalPnl: number;
            qty: number;
            quoteQty: number;
            commission: number;
            commissionAsset: string;
            avgPrice: number;
          }

          const order_infos: OrderInfo[] = [];
          for (const [orderId, orderTrades] of trades_by_order) {
            const totalPnl = orderTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            const qty = orderTrades.reduce((sum, t) => sum + parseFloat(t.qty), 0);
            const quoteQty = orderTrades.reduce((sum, t) => sum + parseFloat(t.quoteQty), 0);
            const commission = orderTrades.reduce((sum, t) => sum + parseFloat(t.commission), 0);
            const commissionAsset = orderTrades[0].commissionAsset || 'USDT';
            const orderTime = Math.min(...orderTrades.map(t => t.time));
            const side = orderTrades[0].side as 'BUY' | 'SELL';
            const avgPrice = qty > 0 ? quoteQty / qty : 0;
            const order_type: 'OPEN' | 'CLOSE' = Math.abs(totalPnl) > 0.0001 ? 'CLOSE' : 'OPEN';

            let position_side: 'LONG' | 'SHORT';
            if (order_type === 'OPEN') {
              position_side = side === 'BUY' ? 'LONG' : 'SHORT';
            } else {
              position_side = side === 'SELL' ? 'LONG' : 'SHORT';
            }

            order_infos.push({
              orderId,
              orderTrades,
              orderTime,
              order_type,
              position_side,
              side,
              totalPnl,
              qty,
              quoteQty,
              commission,
              commissionAsset,
              avgPrice
            });
          }

          // 按时间排序
          order_infos.sort((a, b) => a.orderTime - b.orderTime);

          // ⭐ 生成position_id的逻辑
          // 由于不存在加仓情况，一个开仓对应后续的所有平仓（直到下一个开仓）
          // 用开仓时间+方向作为position_id: ${symbol}_${positionSide}_${openTime}
          // 区分多空方向，避免多单平仓后紧接着开空单被误认为是同一笔交易
          const current_position_ids: { LONG: string | null; SHORT: string | null } = {
            LONG: null,
            SHORT: null
          };

          // 处理每个订单
          for (const info of order_infos) {
            result.total_found++;

            // 生成position_id（无论是否已存在都需要计算，用于更新旧记录）
            let position_id: string;
            if (info.order_type === 'OPEN') {
              // 开仓订单：生成新的position_id（包含方向）
              position_id = `${symbol}_${info.position_side}_${info.orderTime}`;
              current_position_ids[info.position_side] = position_id;
            } else {
              // 平仓订单：使用当前该方向的position_id
              if (current_position_ids[info.position_side]) {
                position_id = current_position_ids[info.position_side]!;
              } else {
                // 没有对应的开仓订单（可能开仓在查询时间范围之前）
                // 使用一个特殊的position_id标记
                position_id = `${symbol}_${info.position_side}_unknown_open`;
              }
            }

            // 检查是否已存在
            if (existing_order_ids.has(info.orderId.toString())) {
              result.already_exists++;
              // 更新已有记录的position_id（如果之前是null）
              try {
                await this.order_record_repository.update_position_id(
                  info.orderId.toString(),
                  trading_mode,
                  position_id
                );
              } catch {
                // 忽略更新错误
              }
              continue;
            }

            // 创建订单记录
            try {
              await this.order_record_repository.create_order({
                order_id: info.orderId.toString(),
                symbol,
                side: info.side,
                position_side: info.position_side,
                order_type: info.order_type,
                trading_mode: trading_mode as 'LIVE' | 'TESTNET' | 'PAPER',
                price: info.avgPrice,
                quantity: info.qty,
                quote_quantity: info.quoteQty,
                leverage: this.config.risk_config.max_leverage || 6,
                realized_pnl: info.order_type === 'CLOSE' ? info.totalPnl : undefined,
                commission: info.commission,
                commission_asset: info.commissionAsset,
                close_reason: info.order_type === 'CLOSE' ? 'BACKFILLED' : undefined,
                order_time: new Date(info.orderTime),
                position_id
              });

              result.newly_created++;
              const type_str = info.order_type === 'OPEN' ? '开仓' : '平仓';
              const pnl_str = info.order_type === 'CLOSE' ? ` pnl=${info.totalPnl >= 0 ? '+' : ''}${info.totalPnl.toFixed(4)}` : '';
              result.details.push(`${symbol} ${info.position_side} ${type_str}: ${info.side} ${info.qty.toFixed(6)} @ ${info.avgPrice.toFixed(6)}${pnl_str}`);
              logger.info(`[TradingSystem] Backfilled order: ${symbol} ${info.order_type} ${info.side} qty=${info.qty.toFixed(6)} price=${info.avgPrice.toFixed(6)}${pnl_str} position_id=${position_id}`);

            } catch (error) {
              result.failed++;
              logger.error(`[TradingSystem] Failed to create backfill record for ${symbol} order ${info.orderId}:`, error);
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
