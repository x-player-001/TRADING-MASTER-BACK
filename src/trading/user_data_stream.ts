/**
 * 币安用户数据流管理
 *
 * 功能：
 * 1. 获取和续期 listenKey
 * 2. 建立WebSocket连接接收用户数据
 * 3. 处理断线重连
 * 4. 分发账户更新事件
 *
 * 事件类型：
 * - ACCOUNT_UPDATE: 账户余额和仓位更新
 * - ORDER_TRADE_UPDATE: 订单/成交更新
 * - ACCOUNT_CONFIG_UPDATE: 账户配置更新
 */

import WebSocket from 'ws';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

/**
 * 仓位更新数据
 */
export interface PositionUpdate {
  symbol: string;           // 交易对
  positionAmt: number;      // 仓位数量
  entryPrice: number;       // 开仓均价
  unrealizedProfit: number; // 未实现盈亏
  marginType: string;       // 保证金模式
  isolatedWallet: number;   // 逐仓钱包余额
  positionSide: 'BOTH' | 'LONG' | 'SHORT';  // 持仓方向
}

/**
 * 余额更新数据
 */
export interface BalanceUpdate {
  asset: string;            // 资产
  walletBalance: number;    // 钱包余额
  crossWalletBalance: number; // 全仓余额
  balanceChange: number;    // 余额变化
}

/**
 * 订单更新数据
 */
export interface OrderUpdate {
  symbol: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  timeInForce: string;
  originalQuantity: number;
  originalPrice: number;
  averagePrice: number;
  stopPrice: number;
  executionType: string;    // NEW, TRADE, CANCELED, EXPIRED
  orderStatus: string;
  orderId: number;
  lastFilledQuantity: number;
  cumulativeFilledQuantity: number;
  lastFilledPrice: number;
  commissionAsset: string;
  commission: number;
  tradeTime: number;
  tradeId: number;
  realizedProfit: number;
  positionSide: string;
}

/**
 * 账户更新事件
 */
export interface AccountUpdateEvent {
  eventType: 'ACCOUNT_UPDATE';
  eventTime: number;
  transactionTime: number;
  balances: BalanceUpdate[];
  positions: PositionUpdate[];
  updateReason: string;     // DEPOSIT, WITHDRAW, ORDER, FUNDING_FEE, etc.
}

/**
 * 订单更新事件
 */
export interface OrderUpdateEvent {
  eventType: 'ORDER_TRADE_UPDATE';
  eventTime: number;
  transactionTime: number;
  order: OrderUpdate;
}

/**
 * WebSocket配置
 */
interface UserDataStreamConfig {
  base_url: string;           // REST API base URL
  ws_base_url: string;        // WebSocket base URL
  api_key: string;
  api_secret: string;
  listen_key_refresh_interval: number;  // listenKey续期间隔（毫秒）
  reconnect_interval: number;           // 重连间隔（毫秒）
  max_reconnect_attempts: number;       // 最大重连次数
  ping_interval: number;                // 心跳间隔（毫秒）
}

/**
 * 用户数据流管理器
 */
export class UserDataStream extends EventEmitter {
  private config: UserDataStreamConfig;
  private api_client: AxiosInstance;
  private ws: WebSocket | null = null;
  private listen_key: string | null = null;
  private listen_key_timer: NodeJS.Timeout | null = null;
  private reconnect_timer: NodeJS.Timeout | null = null;
  private ping_timer: NodeJS.Timeout | null = null;
  private reconnect_attempts: number = 0;
  private is_connected: boolean = false;
  private is_running: boolean = false;

  constructor(api_key: string, api_secret: string) {
    super();

    this.config = {
      base_url: process.env.BINANCE_FUTURES_API_URL || 'https://fapi.binance.com',
      ws_base_url: process.env.BINANCE_FUTURES_WS_URL || 'wss://fstream.binance.com/ws',
      api_key,
      api_secret,
      listen_key_refresh_interval: 30 * 60 * 1000,  // 30分钟续期一次
      reconnect_interval: 5000,                      // 5秒重连
      max_reconnect_attempts: 20,                    // 最大重连20次
      ping_interval: 30000                           // 30秒心跳
    };

    this.api_client = axios.create({
      baseURL: this.config.base_url,
      timeout: 10000,
      headers: {
        'X-MBX-APIKEY': this.config.api_key
      }
    });
  }

  /**
   * 签名请求参数
   */
  private sign_request(params: Record<string, any>): string {
    const query_string = Object.keys(params)
      .map(key => `${key}=${params[key]}`)
      .join('&');
    return crypto
      .createHmac('sha256', this.config.api_secret)
      .update(query_string)
      .digest('hex');
  }

  /**
   * 获取 listenKey
   */
  private async get_listen_key(): Promise<string> {
    try {
      const response = await this.api_client.post('/fapi/v1/listenKey');
      const listen_key = response.data.listenKey;
      logger.info(`[UserDataStream] ✅ Got listenKey: ${listen_key.substring(0, 20)}...`);
      return listen_key;
    } catch (error: any) {
      logger.error('[UserDataStream] Failed to get listenKey:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * 续期 listenKey
   */
  private async refresh_listen_key(): Promise<void> {
    if (!this.listen_key) {
      logger.warn('[UserDataStream] No listenKey to refresh');
      return;
    }

    try {
      await this.api_client.put('/fapi/v1/listenKey');
      logger.debug('[UserDataStream] listenKey refreshed successfully');
    } catch (error: any) {
      logger.error('[UserDataStream] Failed to refresh listenKey:', error.response?.data || error.message);
      // 刷新失败，需要重新获取listenKey并重连
      await this.reconnect_with_new_listen_key();
    }
  }

  /**
   * 启动 listenKey 定时续期
   */
  private start_listen_key_refresh(): void {
    if (this.listen_key_timer) {
      clearInterval(this.listen_key_timer);
    }

    this.listen_key_timer = setInterval(async () => {
      await this.refresh_listen_key();
    }, this.config.listen_key_refresh_interval);

    logger.info(`[UserDataStream] listenKey refresh timer started (interval: ${this.config.listen_key_refresh_interval / 60000} min)`);
  }

  /**
   * 停止 listenKey 定时续期
   */
  private stop_listen_key_refresh(): void {
    if (this.listen_key_timer) {
      clearInterval(this.listen_key_timer);
      this.listen_key_timer = null;
    }
  }

  /**
   * 建立 WebSocket 连接
   */
  private async establish_connection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.listen_key) {
        reject(new Error('No listenKey available'));
        return;
      }

      const ws_url = `${this.config.ws_base_url}/${this.listen_key}`;
      logger.info(`[UserDataStream] Connecting to: ${ws_url.substring(0, 60)}...`);

      this.ws = new WebSocket(ws_url);

      // 设置连接超时
      const connect_timeout = setTimeout(() => {
        if (!this.is_connected) {
          logger.error('[UserDataStream] Connection timeout');
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }
      }, 30000);

      this.ws.on('open', () => {
        clearTimeout(connect_timeout);
        logger.info('[UserDataStream] 🎉 WebSocket connected successfully');
        this.is_connected = true;
        this.reconnect_attempts = 0;
        this.start_ping();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handle_message(message);
        } catch (error) {
          logger.error('[UserDataStream] Failed to parse message:', error);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(connect_timeout);
        const reason_str = reason.toString() || 'Unknown';
        logger.warn(`[UserDataStream] WebSocket closed: ${code} - ${reason_str}`);
        this.is_connected = false;
        this.stop_ping();
        this.emit('disconnected', { code, reason: reason_str });

        // 如果还在运行状态，尝试重连
        if (this.is_running) {
          this.schedule_reconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(connect_timeout);
        logger.error('[UserDataStream] WebSocket error:', error);
        this.emit('error', error);
        if (!this.is_connected) {
          reject(error);
        }
      });

      this.ws.on('pong', () => {
        // 静默接收pong
      });
    });
  }

  /**
   * 处理接收到的消息
   */
  private handle_message(message: any): void {
    const event_type = message.e;

    if (event_type === 'ACCOUNT_UPDATE') {
      this.handle_account_update(message);
    } else if (event_type === 'ORDER_TRADE_UPDATE') {
      this.handle_order_update(message);
    } else if (event_type === 'ACCOUNT_CONFIG_UPDATE') {
      logger.debug('[UserDataStream] Account config updated');
      this.emit('account_config_update', message);
    } else if (event_type === 'listenKeyExpired') {
      logger.warn('[UserDataStream] ⚠️ listenKey expired, reconnecting...');
      this.reconnect_with_new_listen_key();
    } else {
      logger.debug(`[UserDataStream] Unknown event type: ${event_type}`);
    }
  }

  /**
   * 处理账户更新事件（包含仓位变化）
   */
  private handle_account_update(message: any): void {
    const account_data = message.a;

    // 解析余额更新
    const balances: BalanceUpdate[] = (account_data.B || []).map((b: any) => ({
      asset: b.a,
      walletBalance: parseFloat(b.wb),
      crossWalletBalance: parseFloat(b.cw),
      balanceChange: parseFloat(b.bc)
    }));

    // 解析仓位更新
    const positions: PositionUpdate[] = (account_data.P || []).map((p: any) => ({
      symbol: p.s,
      positionAmt: parseFloat(p.pa),
      entryPrice: parseFloat(p.ep),
      unrealizedProfit: parseFloat(p.up),
      marginType: p.mt,
      isolatedWallet: parseFloat(p.iw || '0'),
      positionSide: p.ps
    }));

    const event: AccountUpdateEvent = {
      eventType: 'ACCOUNT_UPDATE',
      eventTime: message.E,
      transactionTime: message.T,
      balances,
      positions,
      updateReason: account_data.m
    };

    logger.info(`[UserDataStream] 📊 Account update: reason=${event.updateReason}, positions=${positions.length}, balances=${balances.length}`);

    // 发送事件
    this.emit('account_update', event);

    // 单独发送仓位更新事件（方便监听）
    if (positions.length > 0) {
      this.emit('position_update', positions);
    }
  }

  /**
   * 处理订单更新事件
   */
  private handle_order_update(message: any): void {
    const order_data = message.o;

    const order: OrderUpdate = {
      symbol: order_data.s,
      clientOrderId: order_data.c,
      side: order_data.S,
      orderType: order_data.o,
      timeInForce: order_data.f,
      originalQuantity: parseFloat(order_data.q),
      originalPrice: parseFloat(order_data.p),
      averagePrice: parseFloat(order_data.ap),
      stopPrice: parseFloat(order_data.sp),
      executionType: order_data.x,
      orderStatus: order_data.X,
      orderId: order_data.i,
      lastFilledQuantity: parseFloat(order_data.l),
      cumulativeFilledQuantity: parseFloat(order_data.z),
      lastFilledPrice: parseFloat(order_data.L),
      commissionAsset: order_data.N || '',
      commission: parseFloat(order_data.n || '0'),
      tradeTime: order_data.T,
      tradeId: order_data.t,
      realizedProfit: parseFloat(order_data.rp || '0'),
      positionSide: order_data.ps
    };

    const event: OrderUpdateEvent = {
      eventType: 'ORDER_TRADE_UPDATE',
      eventTime: message.E,
      transactionTime: message.T,
      order
    };

    logger.info(`[UserDataStream] 📋 Order update: ${order.symbol} ${order.side} ${order.orderType} - ${order.executionType} (${order.orderStatus})`);

    this.emit('order_update', event);
  }

  /**
   * 启动心跳检测
   */
  private start_ping(): void {
    if (this.ping_timer) {
      clearInterval(this.ping_timer);
    }

    this.ping_timer = setInterval(() => {
      if (this.ws && this.is_connected) {
        this.ws.ping();
      }
    }, this.config.ping_interval);
  }

  /**
   * 停止心跳检测
   */
  private stop_ping(): void {
    if (this.ping_timer) {
      clearInterval(this.ping_timer);
      this.ping_timer = null;
    }
  }

  /**
   * 计划重连
   */
  private schedule_reconnect(): void {
    if (this.reconnect_attempts >= this.config.max_reconnect_attempts) {
      logger.error('[UserDataStream] ❌ Max reconnect attempts reached');
      this.emit('max_reconnect_reached');
      return;
    }

    if (this.reconnect_timer) {
      clearTimeout(this.reconnect_timer);
    }

    const delay = this.config.reconnect_interval * Math.min(this.reconnect_attempts + 1, 5);
    logger.info(`[UserDataStream] Reconnecting in ${delay / 1000}s... (attempt ${this.reconnect_attempts + 1}/${this.config.max_reconnect_attempts})`);

    this.reconnect_timer = setTimeout(async () => {
      this.reconnect_attempts++;
      try {
        await this.establish_connection();
      } catch (error) {
        logger.error('[UserDataStream] Reconnect failed:', error);
        this.schedule_reconnect();
      }
    }, delay);
  }

  /**
   * 使用新的 listenKey 重连
   */
  private async reconnect_with_new_listen_key(): Promise<void> {
    logger.info('[UserDataStream] Getting new listenKey and reconnecting...');

    // 关闭现有连接
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.is_connected = false;

    try {
      // 获取新的 listenKey
      this.listen_key = await this.get_listen_key();
      // 建立新连接
      await this.establish_connection();
    } catch (error) {
      logger.error('[UserDataStream] Failed to reconnect with new listenKey:', error);
      this.schedule_reconnect();
    }
  }

  /**
   * 启动用户数据流
   */
  async start(): Promise<void> {
    if (this.is_running) {
      logger.warn('[UserDataStream] Already running');
      return;
    }

    logger.info('[UserDataStream] Starting user data stream...');

    try {
      // 1. 获取 listenKey
      this.listen_key = await this.get_listen_key();

      // 2. 建立 WebSocket 连接
      await this.establish_connection();

      // 3. 启动 listenKey 定时续期
      this.start_listen_key_refresh();

      this.is_running = true;
      logger.info('[UserDataStream] ✅ User data stream started successfully');
    } catch (error) {
      logger.error('[UserDataStream] Failed to start:', error);
      throw error;
    }
  }

  /**
   * 停止用户数据流
   */
  async stop(): Promise<void> {
    logger.info('[UserDataStream] Stopping user data stream...');
    this.is_running = false;

    // 停止所有定时器
    this.stop_listen_key_refresh();
    this.stop_ping();

    if (this.reconnect_timer) {
      clearTimeout(this.reconnect_timer);
      this.reconnect_timer = null;
    }

    // 关闭 WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.is_connected = false;
    this.listen_key = null;

    logger.info('[UserDataStream] ✅ User data stream stopped');
  }

  /**
   * 获取连接状态
   */
  is_stream_connected(): boolean {
    return this.is_connected;
  }

  /**
   * 获取运行状态
   */
  is_stream_running(): boolean {
    return this.is_running;
  }
}
