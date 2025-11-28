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
import {
  BinanceFuturesTradingAPI,
  OrderSide,
  PositionSide as BinancePositionSide
} from '../api/binance_futures_trading_api';
import { OIRepository } from '../database/oi_repository';

export class OrderExecutor {
  private mode: TradingMode;
  private binance_api?: BinanceFuturesAPI;
  private trading_api?: BinanceFuturesTradingAPI;
  private oi_repository?: OIRepository;

  // 币种精度缓存
  private precision_cache: Map<string, {
    quantity_precision: number;
    price_precision: number;
    step_size: number;
    min_notional: number;
  }> = new Map();

  // 纸面交易的模拟订单ID计数器
  private paper_order_id_counter = 1;

  constructor(mode: TradingMode = TradingMode.PAPER) {
    this.mode = mode;

    // 如果是测试网或实盘模式，初始化币安API
    if (mode === TradingMode.TESTNET || mode === TradingMode.LIVE) {
      this.binance_api = new BinanceFuturesAPI();
      this.oi_repository = new OIRepository();

      // 根据模式选择正确的API密钥
      let api_key: string | undefined;
      let secret_key: string | undefined;

      if (mode === TradingMode.TESTNET) {
        // 测试网模式：使用测试网专用密钥
        api_key = process.env.BINANCE_TESTNET_API_KEY;
        secret_key = process.env.BINANCE_TESTNET_SECRET_KEY;
      } else {
        // 实盘模式：优先使用交易专用密钥，回退到通用密钥
        api_key = process.env.BINANCE_TRADE_API_KEY || process.env.BINANCE_API_KEY;
        secret_key = process.env.BINANCE_TRADE_SECRET || process.env.BINANCE_API_SECRET;
      }

      this.trading_api = new BinanceFuturesTradingAPI(
        api_key,
        secret_key,
        mode === TradingMode.TESTNET  // testnet标志
      );
    }

    logger.info(`[OrderExecutor] Initialized in ${mode} mode`);
  }

  /**
   * 获取币种精度信息（带缓存）
   */
  private async get_symbol_precision(symbol: string): Promise<{
    quantity_precision: number;
    price_precision: number;
    step_size: number;
    min_notional: number;
  } | null> {
    // 检查缓存
    if (this.precision_cache.has(symbol)) {
      return this.precision_cache.get(symbol)!;
    }

    // 从数据库获取
    if (!this.oi_repository) {
      return null;
    }

    const precision = await this.oi_repository.get_symbol_precision(symbol);
    if (precision) {
      this.precision_cache.set(symbol, precision);
      logger.debug(`[OrderExecutor] Loaded precision for ${symbol}: qty=${precision.quantity_precision}, step=${precision.step_size}`);
    }

    return precision;
  }

  /**
   * 根据精度格式化数量
   * @param quantity 原始数量
   * @param precision 小数位数精度
   * @param step_size 最小步长（如 0.001）
   */
  private format_quantity(quantity: number, precision: number, step_size: number): number {
    // 使用 step_size 进行对齐（向下取整到最近的 step_size 倍数）
    if (step_size > 0) {
      const steps = Math.floor(quantity / step_size);
      quantity = steps * step_size;
    }

    // 再按精度截断
    const multiplier = Math.pow(10, precision);
    quantity = Math.floor(quantity * multiplier) / multiplier;

    return quantity;
  }

  /**
   * 执行开仓订单（带止盈配置）
   * @param signal 交易信号
   * @param quantity 数量（币的数量，如0.01 BTC）
   * @param leverage 杠杆倍数
   * @param take_profit_config 止盈配置（可选）
   * @returns 订单记录和止盈订单ID列表
   */
  async execute_market_order_with_tp(
    signal: TradingSignal,
    quantity: number,
    leverage: number = 1,
    take_profit_config?: {
      targets: Array<{
        percentage: number;
        target_profit_pct: number;
        is_trailing?: boolean;
        trailing_callback_pct?: number;
      }>;
    }
  ): Promise<{
    entry_order: OrderRecord;
    tp_order_ids: number[];
  }> {
    // 先执行开仓
    const entry_order = await this.execute_market_order(signal, quantity, leverage);

    const tp_order_ids: number[] = [];

    // 如果配置了止盈且是TESTNET或LIVE模式，下止盈订单
    if (take_profit_config && this.trading_api && (this.mode === TradingMode.TESTNET || this.mode === TradingMode.LIVE)) {
      const entry_price = entry_order.average_price || signal.entry_price || 0;
      const binance_position_side = signal.direction === 'LONG'
        ? BinancePositionSide.LONG
        : BinancePositionSide.SHORT;

      // 平仓方向相反
      const close_side = signal.direction === 'LONG' ? OrderSide.SELL : OrderSide.BUY;

      for (const target of take_profit_config.targets) {
        const target_quantity = quantity * (target.percentage / 100);

        if (target.is_trailing) {
          // 使用TRAILING_STOP_MARKET订单
          try {
            const tp_order = await this.trading_api.place_trailing_stop_order(
              signal.symbol,
              close_side,
              target_quantity,
              target.trailing_callback_pct || 10,  // 默认10%回调
              binance_position_side
            );
            tp_order_ids.push(tp_order.orderId);
            logger.info(`[OrderExecutor] Trailing TP order placed: ${tp_order.orderId} (${target.percentage}% @ ${target.trailing_callback_pct}% callback)`);
          } catch (error) {
            logger.error(`[OrderExecutor] Failed to place trailing TP order:`, error);
          }
        } else {
          // 使用TAKE_PROFIT_MARKET订单
          const tp_price = signal.direction === 'LONG'
            ? entry_price * (1 + target.target_profit_pct / 100)
            : entry_price * (1 - target.target_profit_pct / 100);

          try {
            const tp_order = await this.trading_api.place_take_profit_market_order(
              signal.symbol,
              close_side,
              target_quantity,
              tp_price,
              binance_position_side,
              true  // reduceOnly
            );
            tp_order_ids.push(tp_order.orderId);
            logger.info(`[OrderExecutor] TP order placed: ${tp_order.orderId} (${target.percentage}% @ +${target.target_profit_pct}%)`);
          } catch (error) {
            logger.error(`[OrderExecutor] Failed to place TP order:`, error);
          }
        }
      }
    }

    return { entry_order, tp_order_ids };
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
    // 获取精度并格式化数量（仅实盘/测试网）
    let formatted_quantity = quantity;
    if (this.mode === TradingMode.TESTNET || this.mode === TradingMode.LIVE) {
      const precision = await this.get_symbol_precision(signal.symbol);
      if (precision) {
        formatted_quantity = this.format_quantity(
          quantity,
          precision.quantity_precision,
          precision.step_size
        );
        logger.info(`[OrderExecutor] Quantity formatted: ${quantity} -> ${formatted_quantity} (precision=${precision.quantity_precision}, step=${precision.step_size})`);

        // 检查最小名义价值
        const entry_price = signal.entry_price || 0;
        const notional = formatted_quantity * entry_price;
        if (notional < precision.min_notional) {
          throw new Error(`Order notional value (${notional.toFixed(2)} USDT) is below minimum (${precision.min_notional} USDT)`);
        }
      } else {
        logger.warn(`[OrderExecutor] No precision info for ${signal.symbol}, using raw quantity`);
      }
    }

    logger.info(`[OrderExecutor] Executing ${signal.direction} order for ${signal.symbol}: qty=${formatted_quantity}, leverage=${leverage}x`);

    const order: OrderRecord = {
      symbol: signal.symbol,
      order_type: OrderType.MARKET,
      side: signal.direction === 'LONG' ? PositionSide.LONG : PositionSide.SHORT,
      quantity: formatted_quantity,
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
    if (!this.trading_api) {
      throw new Error('Binance Trading API not initialized for testnet');
    }

    try {
      // 1. 设置保证金模式为逐仓
      try {
        await this.trading_api.set_margin_type(order.symbol, 'ISOLATED');
        logger.info(`[OrderExecutor] Set ${order.symbol} to ISOLATED margin mode`);
      } catch (error: any) {
        // 如果已经是逐仓模式，忽略错误
        if (error.message?.includes('-4046') || error.message?.includes('No need to change margin type')) {
          logger.debug(`[OrderExecutor] ${order.symbol} already in ISOLATED mode`);
        } else {
          throw error;
        }
      }

      // 2. 设置杠杆倍数
      await this.trading_api.set_leverage(order.symbol, leverage);
      logger.info(`[OrderExecutor] Set ${order.symbol} leverage to ${leverage}x`);

      // 3. 下市价单（使用单向持仓模式 BOTH）
      const binance_side = order.side === PositionSide.LONG ? OrderSide.BUY : OrderSide.SELL;

      const result = await this.trading_api.place_market_order(
        order.symbol,
        binance_side,
        order.quantity,
        BinancePositionSide.BOTH,  // 单向持仓模式
        false  // not reduceOnly
      );

      // 4. 更新订单记录
      order.order_id = result.orderId.toString();
      order.status = result.status === 'FILLED' ? OrderStatus.FILLED : OrderStatus.SUBMITTED;
      order.filled_quantity = parseFloat(result.executedQty);
      order.average_price = parseFloat(result.avgPrice) || parseFloat(result.price);
      order.price = order.average_price;
      order.filled_at = new Date(result.updateTime);
      order.updated_at = new Date(result.updateTime);

      logger.info(
        `[OrderExecutor] TESTNET order executed: ${order.order_id} ` +
        `${order.symbol} ${order.side} ${order.filled_quantity} @ ${order.average_price}`
      );

      return order;

    } catch (error) {
      logger.error('[OrderExecutor] Testnet order execution failed:', error);
      throw error;
    }
  }

  /**
   * 实盘订单执行 (与TESTNET相同的逻辑，但使用实盘API)
   */
  private async execute_live_order(
    order: OrderRecord,
    leverage: number
  ): Promise<OrderRecord> {
    if (!this.trading_api) {
      throw new Error('Binance Trading API not initialized for live trading');
    }

    // ⚠️ 实盘交易警告
    logger.warn('🔴 [OrderExecutor] LIVE MODE - REAL MONEY TRADING! 🔴');

    try {
      // 1. 设置保证金模式为逐仓
      try {
        await this.trading_api.set_margin_type(order.symbol, 'ISOLATED');
        logger.info(`[OrderExecutor] Set ${order.symbol} to ISOLATED margin mode`);
      } catch (error: any) {
        // 如果已经是逐仓模式，忽略错误
        if (error.message?.includes('-4046') || error.message?.includes('No need to change margin type')) {
          logger.debug(`[OrderExecutor] ${order.symbol} already in ISOLATED mode`);
        } else {
          throw error;
        }
      }

      // 2. 设置杠杆倍数
      await this.trading_api.set_leverage(order.symbol, leverage);
      logger.info(`[OrderExecutor] Set ${order.symbol} leverage to ${leverage}x`);

      // 3. 下市价单（使用单向持仓模式 BOTH）
      const binance_side = order.side === PositionSide.LONG ? OrderSide.BUY : OrderSide.SELL;

      const result = await this.trading_api.place_market_order(
        order.symbol,
        binance_side,
        order.quantity,
        BinancePositionSide.BOTH,  // 单向持仓模式
        false  // not reduceOnly
      );

      // 4. 更新订单记录
      order.order_id = result.orderId.toString();
      order.status = result.status === 'FILLED' ? OrderStatus.FILLED : OrderStatus.SUBMITTED;
      order.filled_quantity = parseFloat(result.executedQty);
      order.average_price = parseFloat(result.avgPrice) || parseFloat(result.price);
      order.price = order.average_price;
      order.filled_at = new Date(result.updateTime);
      order.updated_at = new Date(result.updateTime);

      logger.info(
        `[OrderExecutor] 💰 LIVE order executed: ${order.order_id} ` +
        `${order.symbol} ${order.side} ${order.filled_quantity} @ ${order.average_price}`
      );

      return order;

    } catch (error) {
      logger.error('[OrderExecutor] Live order execution failed:', error);
      throw error;
    }
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
    // 获取精度并格式化数量（仅实盘/测试网）
    let formatted_quantity = quantity;
    if (this.mode === TradingMode.TESTNET || this.mode === TradingMode.LIVE) {
      const precision = await this.get_symbol_precision(symbol);
      if (precision) {
        formatted_quantity = this.format_quantity(
          quantity,
          precision.quantity_precision,
          precision.step_size
        );
        logger.debug(`[OrderExecutor] Close quantity formatted: ${quantity} -> ${formatted_quantity}`);
      }
    }

    logger.info(`[OrderExecutor] Closing position: ${symbol} ${side} qty=${formatted_quantity}`);

    const order: OrderRecord = {
      symbol,
      order_type: OrderType.MARKET,
      side: side === PositionSide.LONG ? PositionSide.SHORT : PositionSide.LONG, // 平仓方向相反
      quantity: formatted_quantity,
      status: OrderStatus.PENDING,
      created_at: new Date()
    };

    try {
      if (this.mode === TradingMode.PAPER) {
        // 纸面交易模拟
        order.order_id = `PAPER_CLOSE_${this.paper_order_id_counter++}`;
        order.status = OrderStatus.FILLED;
        order.filled_quantity = formatted_quantity;
        order.average_price = current_price || 0;
        order.price = current_price || 0;
        order.filled_at = new Date();
        order.updated_at = new Date();

        logger.info(`[OrderExecutor] Paper close order filled: ${order.order_id} at ${current_price}`);
      } else if (this.mode === TradingMode.TESTNET || this.mode === TradingMode.LIVE) {
        // 实际平仓订单
        if (!this.trading_api) {
          throw new Error('Trading API not initialized');
        }

        // 单向持仓模式：平仓用相反方向，不指定 positionSide
        const binance_side = side === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY;

        const result = await this.trading_api.place_market_order(
          symbol,
          binance_side,
          formatted_quantity,
          BinancePositionSide.BOTH,  // 单向持仓模式
          true  // reduceOnly = true (平仓单)
        );

        order.order_id = result.orderId.toString();
        order.status = result.status === 'FILLED' ? OrderStatus.FILLED : OrderStatus.SUBMITTED;
        order.filled_quantity = parseFloat(result.executedQty);
        order.average_price = parseFloat(result.avgPrice) || parseFloat(result.price);
        order.price = order.average_price;
        order.filled_at = new Date(result.updateTime);
        order.updated_at = new Date(result.updateTime);

        logger.info(
          `[OrderExecutor] ${this.mode} close order executed: ${order.order_id} ` +
          `${symbol} ${side} ${order.filled_quantity} @ ${order.average_price}`
        );
      }

      return order;

    } catch (error) {
      logger.error('[OrderExecutor] Close position failed:', error);
      order.status = OrderStatus.REJECTED;
      order.error_message = error instanceof Error ? error.message : 'Unknown error';
      order.updated_at = new Date();
      throw error;
    }
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

      // 根据模式选择正确的API密钥
      let api_key: string | undefined;
      let secret_key: string | undefined;

      if (mode === TradingMode.TESTNET) {
        // 测试网模式：使用测试网专用密钥
        api_key = process.env.BINANCE_TESTNET_API_KEY;
        secret_key = process.env.BINANCE_TESTNET_SECRET_KEY;
      } else {
        // 实盘模式：优先使用交易专用密钥，回退到通用密钥
        api_key = process.env.BINANCE_TRADE_API_KEY || process.env.BINANCE_API_KEY;
        secret_key = process.env.BINANCE_TRADE_SECRET || process.env.BINANCE_API_SECRET;
      }

      this.trading_api = new BinanceFuturesTradingAPI(
        api_key,
        secret_key,
        mode === TradingMode.TESTNET
      );
    }
  }

  /**
   * 获取当前模式
   */
  get_mode(): TradingMode {
    return this.mode;
  }

  /**
   * 获取币安实际持仓（实盘/测试网模式）
   * @returns 币安账户中的所有持仓
   */
  async get_binance_positions(): Promise<{
    symbol: string;
    positionAmt: number;
    entryPrice: number;
    unrealizedProfit: number;
    leverage: number;
    marginType: string;
    isolatedWallet: number;
    side: 'LONG' | 'SHORT';
  }[]> {
    if (this.mode === TradingMode.PAPER) {
      return [];
    }

    if (!this.trading_api) {
      logger.warn('[OrderExecutor] Trading API not initialized');
      return [];
    }

    try {
      const account = await this.trading_api.get_account_info();
      const positions = account.positions?.filter((p: any) => parseFloat(p.positionAmt) !== 0) || [];

      return positions.map((p: any) => ({
        symbol: p.symbol,
        positionAmt: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        unrealizedProfit: parseFloat(p.unrealizedProfit),
        leverage: parseInt(p.leverage),
        marginType: p.marginType,
        isolatedWallet: parseFloat(p.isolatedWallet || '0'),
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const
      }));
    } catch (error) {
      logger.error('[OrderExecutor] Failed to get Binance positions:', error);
      return [];
    }
  }

  /**
   * 获取币安账户余额信息
   */
  async get_binance_balance(): Promise<{
    totalWalletBalance: number;
    availableBalance: number;
    totalUnrealizedProfit: number;
  } | null> {
    if (this.mode === TradingMode.PAPER) {
      return null;
    }

    if (!this.trading_api) {
      logger.warn('[OrderExecutor] Trading API not initialized');
      return null;
    }

    try {
      const account = await this.trading_api.get_account_info();
      return {
        totalWalletBalance: parseFloat(account.totalWalletBalance),
        availableBalance: parseFloat(account.availableBalance),
        totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit)
      };
    } catch (error) {
      logger.error('[OrderExecutor] Failed to get Binance balance:', error);
      return null;
    }
  }
}
