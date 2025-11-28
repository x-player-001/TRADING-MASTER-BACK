/**
 * 币安期货交易API扩展
 * 包含下单、撤单、修改杠杆等交易功能
 */

import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * 订单侧方向
 */
export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL'
}

/**
 * 持仓方向
 */
export enum PositionSide {
  BOTH = 'BOTH',      // 单向持仓
  LONG = 'LONG',      // 多头（双向持仓）
  SHORT = 'SHORT'     // 空头（双向持仓）
}

/**
 * 订单类型
 */
export enum OrderType {
  LIMIT = 'LIMIT',              // 限价单
  MARKET = 'MARKET',            // 市价单
  STOP = 'STOP',                // 止损单
  STOP_MARKET = 'STOP_MARKET',  // 止损市价单
  TAKE_PROFIT = 'TAKE_PROFIT',  // 止盈单
  TAKE_PROFIT_MARKET = 'TAKE_PROFIT_MARKET',  // 止盈市价单
  TRAILING_STOP_MARKET = 'TRAILING_STOP_MARKET'  // 追踪止盈市价单
}

/**
 * 有效方式
 */
export enum TimeInForce {
  GTC = 'GTC',  // 成交为止
  IOC = 'IOC',  // 立即成交并取消剩余
  FOK = 'FOK',  // 全部成交或立即取消
  GTX = 'GTX'   // 无法立即成交就取消
}

/**
 * 订单响应
 */
export interface OrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  timeInForce: string;
  type: string;
  reduceOnly: boolean;
  closePosition: boolean;
  side: string;
  positionSide: string;
  stopPrice: string;
  workingType: string;
  priceProtect: boolean;
  origType: string;
  updateTime: number;
}

/**
 * 持仓信息
 */
export interface PositionInfo {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  maxNotionalValue: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
}

/**
 * 币安期货交易API客户端
 */
export class BinanceFuturesTradingAPI {
  private readonly base_url: string;
  private readonly api_client: AxiosInstance;
  private readonly api_key: string;
  private readonly api_secret: string;
  private readonly testnet: boolean;

  constructor(api_key?: string, api_secret?: string, testnet: boolean = false) {
    this.api_key = api_key || process.env.BINANCE_API_KEY || '';
    this.api_secret = api_secret || process.env.BINANCE_API_SECRET || '';
    this.testnet = testnet;

    // 测试网和实盘使用不同的URL
    this.base_url = testnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    this.api_client = axios.create({
      baseURL: this.base_url,
      timeout: 30000,
      headers: {
        'X-MBX-APIKEY': this.api_key
      },
      proxy: false
    });

    logger.info(`[BinanceTradingAPI] Initialized in ${testnet ? 'TESTNET' : 'LIVE'} mode`);
  }

  /**
   * 生成签名
   */
  private sign_request(params: Record<string, any>): string {
    const query_string = Object.keys(params)
      .map(key => `${key}=${params[key]}`)
      .join('&');

    return crypto
      .createHmac('sha256', this.api_secret)
      .update(query_string)
      .digest('hex');
  }

  /**
   * 设置杠杆倍数
   * @param symbol 交易对
   * @param leverage 杠杆倍数 (1-125)
   */
  async set_leverage(symbol: string, leverage: number): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = {
        symbol,
        leverage,
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.post('/fapi/v1/leverage', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Set leverage for ${symbol}: ${leverage}x`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to set leverage for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to set leverage: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 设置保证金模式
   * @param symbol 交易对
   * @param marginType ISOLATED(逐仓) 或 CROSSED(全仓)
   */
  async set_margin_type(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = {
        symbol,
        marginType,
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.post('/fapi/v1/marginType', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Set margin type for ${symbol}: ${marginType}`);
      return response.data;
    } catch (error: any) {
      // 如果已经是该保证金模式，忽略错误
      if (error.response?.data?.code === -4046) {
        logger.debug(`[BinanceTradingAPI] ${symbol} already in ${marginType} mode`);
        return { msg: 'Already in this margin type' };
      }

      logger.error(`[BinanceTradingAPI] Failed to set margin type for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to set margin type: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 下市价单
   * @param symbol 交易对
   * @param side BUY 或 SELL
   * @param quantity 数量
   * @param positionSide LONG/SHORT (双向持仓) 或 BOTH (单向持仓)
   * @param reduceOnly 是否只减仓 (平仓时使用)
   */
  async place_market_order(
    symbol: string,
    side: OrderSide,
    quantity: number,
    positionSide: PositionSide = PositionSide.BOTH,
    reduceOnly: boolean = false
  ): Promise<OrderResponse> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        symbol,
        side,
        type: OrderType.MARKET,
        quantity: quantity.toString(),
        newOrderRespType: 'RESULT',  // 返回成交结果（包含avgPrice和executedQty）
        timestamp
      };

      // 如果是双向持仓模式，需要指定positionSide
      if (positionSide !== PositionSide.BOTH) {
        params.positionSide = positionSide;
      }

      // 如果是平仓单
      if (reduceOnly) {
        params.reduceOnly = 'true';
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.post<OrderResponse>('/fapi/v1/order', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Market order placed: ${symbol} ${side} ${quantity} @ MARKET`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to place market order for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to place market order: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 下限价单
   * @param symbol 交易对
   * @param side BUY 或 SELL
   * @param quantity 数量
   * @param price 价格
   * @param positionSide LONG/SHORT (双向持仓) 或 BOTH (单向持仓)
   * @param timeInForce 有效方式 (默认GTC)
   */
  async place_limit_order(
    symbol: string,
    side: OrderSide,
    quantity: number,
    price: number,
    positionSide: PositionSide = PositionSide.BOTH,
    timeInForce: TimeInForce = TimeInForce.GTC
  ): Promise<OrderResponse> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        symbol,
        side,
        type: OrderType.LIMIT,
        quantity: quantity.toString(),
        price: price.toString(),
        timeInForce,
        timestamp
      };

      if (positionSide !== PositionSide.BOTH) {
        params.positionSide = positionSide;
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.post<OrderResponse>('/fapi/v1/order', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Limit order placed: ${symbol} ${side} ${quantity} @ ${price}`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to place limit order for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to place limit order: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 下止盈市价单
   * @param symbol 交易对
   * @param side BUY 或 SELL (平仓方向)
   * @param quantity 数量
   * @param stopPrice 触发价格
   * @param positionSide LONG/SHORT
   * @param reduceOnly 是否只减仓 (默认true)
   */
  async place_take_profit_market_order(
    symbol: string,
    side: OrderSide,
    quantity: number,
    stopPrice: number,
    positionSide: PositionSide = PositionSide.BOTH,
    reduceOnly: boolean = true
  ): Promise<OrderResponse> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        symbol,
        side,
        type: OrderType.TAKE_PROFIT_MARKET,
        quantity: quantity.toString(),
        stopPrice: stopPrice.toString(),
        timestamp
      };

      if (positionSide !== PositionSide.BOTH) {
        params.positionSide = positionSide;
      }

      if (reduceOnly) {
        params.reduceOnly = 'true';
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.post<OrderResponse>('/fapi/v1/order', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Take profit order placed: ${symbol} ${side} ${quantity} @ stopPrice ${stopPrice}`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to place take profit order for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to place take profit order: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 下追踪止盈单
   * @param symbol 交易对
   * @param side BUY 或 SELL (平仓方向)
   * @param quantity 数量
   * @param callbackRate 回调比例 (0.1-10, 1代表1%)
   * @param positionSide LONG/SHORT
   * @param activationPrice 激活价格 (可选)
   */
  async place_trailing_stop_order(
    symbol: string,
    side: OrderSide,
    quantity: number,
    callbackRate: number,
    positionSide: PositionSide = PositionSide.BOTH,
    activationPrice?: number
  ): Promise<OrderResponse> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        symbol,
        side,
        type: OrderType.TRAILING_STOP_MARKET,
        quantity: quantity.toString(),
        callbackRate: callbackRate.toString(),
        timestamp
      };

      if (positionSide !== PositionSide.BOTH) {
        params.positionSide = positionSide;
      }

      if (activationPrice) {
        params.activationPrice = activationPrice.toString();
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.post<OrderResponse>('/fapi/v1/order', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Trailing stop order placed: ${symbol} ${side} ${quantity} callbackRate=${callbackRate}%`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to place trailing stop order for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to place trailing stop order: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 撤销订单
   * @param symbol 交易对
   * @param orderId 订单ID
   */
  async cancel_order(symbol: string, orderId: number): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = {
        symbol,
        orderId,
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.delete('/fapi/v1/order', {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Order cancelled: ${symbol} orderId=${orderId}`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to cancel order ${orderId} for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to cancel order: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 撤销所有订单
   * @param symbol 交易对
   */
  async cancel_all_orders(symbol: string): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = {
        symbol,
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.delete('/fapi/v1/allOpenOrders', {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] All orders cancelled for ${symbol}`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to cancel all orders for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to cancel all orders: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 查询订单
   * @param symbol 交易对
   * @param orderId 订单ID
   */
  async get_order(symbol: string, orderId: number): Promise<OrderResponse> {
    try {
      const timestamp = Date.now();
      const params = {
        symbol,
        orderId,
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.get<OrderResponse>('/fapi/v1/order', {
        params: { ...params, signature }
      });

      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to get order ${orderId} for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to get order: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 查询所有当前挂单
   * @param symbol 交易对 (可选，不传则查询所有)
   */
  async get_open_orders(symbol?: string): Promise<OrderResponse[]> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        timestamp
      };

      if (symbol) {
        params.symbol = symbol;
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.get<OrderResponse[]>('/fapi/v1/openOrders', {
        params: { ...params, signature }
      });

      return response.data;
    } catch (error: any) {
      logger.error('[BinanceTradingAPI] Failed to get open orders:', error.response?.data || error.message);
      throw new Error(`Failed to get open orders: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 查询持仓信息
   * @param symbol 交易对 (可选，不传则查询所有)
   */
  async get_position_info(symbol?: string): Promise<PositionInfo[]> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        timestamp
      };

      if (symbol) {
        params.symbol = symbol;
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.get<PositionInfo[]>('/fapi/v2/positionRisk', {
        params: { ...params, signature }
      });

      return response.data;
    } catch (error: any) {
      logger.error('[BinanceTradingAPI] Failed to get position info:', error.response?.data || error.message);
      throw new Error(`Failed to get position info: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 获取账户余额
   */
  async get_account_balance(): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = {
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.get('/fapi/v2/balance', {
        params: { ...params, signature }
      });

      return response.data;
    } catch (error: any) {
      logger.error('[BinanceTradingAPI] Failed to get account balance:', error.response?.data || error.message);
      throw new Error(`Failed to get account balance: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 获取账户信息
   */
  async get_account_info(): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = {
        timestamp
      };

      const signature = this.sign_request(params);

      const response = await this.api_client.get('/fapi/v2/account', {
        params: { ...params, signature }
      });

      return response.data;
    } catch (error: any) {
      logger.error('[BinanceTradingAPI] Failed to get account info:', error.response?.data || error.message);
      throw new Error(`Failed to get account info: ${error.response?.data?.msg || error.message}`);
    }
  }

  /**
   * 一键平仓
   * @param symbol 交易对
   * @param positionSide 持仓方向 (LONG/SHORT for dual position mode, BOTH for one-way mode)
   */
  async close_all_positions(symbol: string, positionSide: PositionSide = PositionSide.BOTH): Promise<OrderResponse> {
    try {
      const timestamp = Date.now();
      const params: Record<string, any> = {
        symbol,
        side: positionSide === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY,
        type: OrderType.MARKET,
        closePosition: 'true',
        timestamp
      };

      if (positionSide !== PositionSide.BOTH) {
        params.positionSide = positionSide;
      }

      const signature = this.sign_request(params);

      const response = await this.api_client.post<OrderResponse>('/fapi/v1/order', null, {
        params: { ...params, signature }
      });

      logger.info(`[BinanceTradingAPI] Closed all positions for ${symbol} ${positionSide}`);
      return response.data;
    } catch (error: any) {
      logger.error(`[BinanceTradingAPI] Failed to close all positions for ${symbol}:`, error.response?.data || error.message);
      throw new Error(`Failed to close all positions: ${error.response?.data?.msg || error.message}`);
    }
  }
}
