/**
 * 订单执行器
 * 支持纸面交易（Paper Trading）、测试网和实盘模式
 */

import {
  TradingSignal,
  TradingMode,
  OrderType,
  OrderStatus,
  PositionSide,
  OrderRecord
} from '../types/trading_types';
import { logger } from '../utils/logger';
import { BinanceFuturesAPI } from '../api/binance_futures_api';

export class OrderExecutor {
  private mode: TradingMode;
  private binance_api?: BinanceFuturesAPI;

  // 纸面交易的模拟订单ID计数器
  private paper_order_id_counter = 1;

  constructor(mode: TradingMode = TradingMode.PAPER) {
    this.mode = mode;

    // 如果是测试网或实盘模式，初始化币安API
    if (mode === TradingMode.TESTNET || mode === TradingMode.LIVE) {
      this.binance_api = new BinanceFuturesAPI();
    }

    logger.info(`[OrderExecutor] Initialized in ${mode} mode`);
  }

  /**
   * 执行开仓订单
   * @param signal 交易信号
   * @param quantity 数量（币的数量，如0.01 BTC）
   * @param leverage 杠杆倍数
   * @returns 订单记录
   */
  async execute_market_order(
    signal: TradingSignal,
    quantity: number,
    leverage: number = 1
  ): Promise<OrderRecord> {
    logger.info(`[OrderExecutor] Executing ${signal.direction} order for ${signal.symbol}: qty=${quantity}, leverage=${leverage}x`);

    const order: OrderRecord = {
      symbol: signal.symbol,
      order_type: OrderType.MARKET,
      side: signal.direction === 'LONG' ? PositionSide.LONG : PositionSide.SHORT,
      quantity,
      status: OrderStatus.PENDING,
      signal_id: signal.source_anomaly_id,
      created_at: new Date()
    };

    try {
      switch (this.mode) {
        case TradingMode.PAPER:
          return await this.execute_paper_order(order, signal);

        case TradingMode.TESTNET:
          return await this.execute_testnet_order(order, leverage);

        case TradingMode.LIVE:
          return await this.execute_live_order(order, leverage);

        default:
          throw new Error(`Unknown trading mode: ${this.mode}`);
      }
    } catch (error) {
      logger.error('[OrderExecutor] Order execution failed:', error);

      order.status = OrderStatus.REJECTED;
      order.error_message = error instanceof Error ? error.message : 'Unknown error';
      order.updated_at = new Date();

      return order;
    }
  }

  /**
   * 纸面交易：模拟订单执行
   */
  private async execute_paper_order(
    order: OrderRecord,
    signal: TradingSignal
  ): Promise<OrderRecord> {
    // 模拟订单ID
    order.order_id = `PAPER_${this.paper_order_id_counter++}`;

    // 使用信号中的入场价格
    const fill_price = signal.entry_price || 0;

    // 模拟立即成交
    order.status = OrderStatus.FILLED;
    order.filled_quantity = order.quantity;
    order.average_price = fill_price;
    order.price = fill_price;
    order.filled_at = new Date();
    order.updated_at = new Date();

    logger.info(`[OrderExecutor] Paper order filled: ${order.order_id} at ${fill_price}`);

    return order;
  }

  /**
   * 测试网订单执行
   */
  private async execute_testnet_order(
    order: OrderRecord,
    leverage: number
  ): Promise<OrderRecord> {
    if (!this.binance_api) {
      throw new Error('Binance API not initialized for testnet');
    }

    // TODO: 调用币安测试网API
    // 1. 设置杠杆：POST /fapi/v1/leverage
    // 2. 下单：POST /fapi/v1/order

    logger.warn('[OrderExecutor] Testnet mode not fully implemented yet');

    // 暂时使用纸面交易模拟
    return this.execute_paper_order(order, { entry_price: 0 } as TradingSignal);
  }

  /**
   * 实盘订单执行
   */
  private async execute_live_order(
    order: OrderRecord,
    leverage: number
  ): Promise<OrderRecord> {
    if (!this.binance_api) {
      throw new Error('Binance API not initialized for live trading');
    }

    // 实盘模式需要额外的安全确认
    logger.error('[OrderExecutor] LIVE mode is not enabled. Please implement safety checks first.');

    throw new Error('Live trading is disabled for safety');
  }

  /**
   * 执行止损/止盈订单
   */
  async place_stop_order(
    symbol: string,
    side: PositionSide,
    quantity: number,
    stop_price: number,
    is_take_profit: boolean = false
  ): Promise<OrderRecord> {
    const order: OrderRecord = {
      symbol,
      order_type: is_take_profit ? OrderType.TAKE_PROFIT_MARKET : OrderType.STOP_MARKET,
      side: side === PositionSide.LONG ? PositionSide.SHORT : PositionSide.LONG, // 平仓方向相反
      quantity,
      price: stop_price,
      status: OrderStatus.PENDING,
      created_at: new Date()
    };

    if (this.mode === TradingMode.PAPER) {
      // 纸面交易：只记录止损单，实际触发在PositionTracker中处理
      order.order_id = `PAPER_STOP_${this.paper_order_id_counter++}`;
      order.status = OrderStatus.SUBMITTED;
      order.updated_at = new Date();

      logger.info(`[OrderExecutor] Paper stop order placed: ${order.order_id} at ${stop_price}`);
    }

    return order;
  }

  /**
   * 平仓（市价）
   */
  async close_position_market(
    symbol: string,
    side: PositionSide,
    quantity: number,
    current_price?: number
  ): Promise<OrderRecord> {
    logger.info(`[OrderExecutor] Closing position: ${symbol} ${side} qty=${quantity}`);

    const order: OrderRecord = {
      symbol,
      order_type: OrderType.MARKET,
      side: side === PositionSide.LONG ? PositionSide.SHORT : PositionSide.LONG, // 平仓方向相反
      quantity,
      status: OrderStatus.PENDING,
      created_at: new Date()
    };

    if (this.mode === TradingMode.PAPER) {
      order.order_id = `PAPER_CLOSE_${this.paper_order_id_counter++}`;
      order.status = OrderStatus.FILLED;
      order.filled_quantity = quantity;
      order.average_price = current_price || 0;
      order.price = current_price || 0;
      order.filled_at = new Date();
      order.updated_at = new Date();

      logger.info(`[OrderExecutor] Paper close order filled: ${order.order_id} at ${current_price}`);
    }

    return order;
  }

  /**
   * 取消订单
   */
  async cancel_order(order_id: string, symbol: string): Promise<boolean> {
    logger.info(`[OrderExecutor] Cancelling order: ${order_id}`);

    if (this.mode === TradingMode.PAPER) {
      // 纸面交易：直接返回成功
      return true;
    }

    // TODO: 实现实际的取消订单逻辑
    return false;
  }

  /**
   * 切换交易模式
   */
  set_mode(mode: TradingMode): void {
    logger.info(`[OrderExecutor] Switching mode from ${this.mode} to ${mode}`);
    this.mode = mode;

    if ((mode === TradingMode.TESTNET || mode === TradingMode.LIVE) && !this.binance_api) {
      this.binance_api = new BinanceFuturesAPI();
    }
  }

  /**
   * 获取当前模式
   */
  get_mode(): TradingMode {
    return this.mode;
  }
}
