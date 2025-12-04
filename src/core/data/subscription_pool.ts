import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { BinanceWebSocketMessage, WebSocketConfig, DataEventType } from '@/types/common';
import { logger } from '@/utils/logger';

export class SubscriptionPool extends EventEmitter {
  private static instance: SubscriptionPool;
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private reconnect_timer: NodeJS.Timeout | null = null;
  private ping_timer: NodeJS.Timeout | null = null;
  private reconnect_attempts: number = 0;
  private is_connected: boolean = false;
  private subscribed_streams: Set<string> = new Set();
  private mark_price_received: boolean = false;
  private first_message_logged: boolean = false;

  private constructor() {
    super();
    this.config = {
      base_url: process.env.BINANCE_WS_BASE_URL || 'wss://fstream.binance.com/ws',
      reconnect_interval: 5000,
      max_reconnect_attempts: 10,
      ping_interval: 30000
    };
  }

  /**
   * 获取WebSocket订阅池单例实例
   */
  static getInstance(): SubscriptionPool {
    if (!SubscriptionPool.instance) {
      SubscriptionPool.instance = new SubscriptionPool();
    }
    return SubscriptionPool.instance;
  }

  /**
   * 建立币安WebSocket连接
   */
  async connect(): Promise<void> {
    // 强制清理可能的残留状态
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.is_connected = false;

    try {
      logger.info(`🔗 Attempting WebSocket connection to: ${this.config.base_url}`);
      await this.establish_connection();
    } catch (error) {
      logger.error('Failed to connect to WebSocket', error);
      throw error;
    }
  }

  /**
   * 建立底层WebSocket连接并设置事件监听器
   */
  private async establish_connection(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.base_url);

        this.ws.on('open', () => {
          logger.info('🎉 WebSocket connected to Binance successfully');
          this.is_connected = true;
          this.reconnect_attempts = 0;
          this.start_ping();
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString()) as BinanceWebSocketMessage;
            this.handle_message(message);
          } catch (error) {
            logger.error('Failed to parse WebSocket message', error);
            logger.error('Raw message data:', data.toString());
          }
        });

        this.ws.on('close', (code: number, reason: string) => {
          if (code === 1006) {
            logger.warn(`⚠️ WebSocket connection lost unexpectedly (possibly ping timeout)`);
          } else {
            logger.warn(`WebSocket closed: ${code} - ${reason || 'Unknown reason'}`);
          }
          this.is_connected = false;
          this.stop_ping();
          this.emit('disconnected', { code, reason });
          this.schedule_reconnect();
        });

        this.ws.on('error', (error: Error) => {
          logger.error('WebSocket error', error);
          this.emit('error', error);
          if (!this.is_connected) {
            reject(error);
          }
        });

        this.ws.on('pong', () => {
          // 静默接收pong，连接正常
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 处理从币安WebSocket接收到的消息
   * @param message - 币安WebSocket消息
   */
  private message_count: number = 0;

  private handle_message(message: BinanceWebSocketMessage | any[]): void {
    this.message_count++;
    // 调试：记录前5条消息
    if (this.message_count <= 5) {
      logger.info(`[SubscriptionPool] 第${this.message_count}条WebSocket消息: ${JSON.stringify(message).slice(0, 300)}`);
    }

    // 处理顶层数组格式 [{"e":"markPriceUpdate",...}, {...}, ...]
    // 这是 !markPrice@arr@1s 聚合流的返回格式
    if (Array.isArray(message)) {
      if (message.length > 0 && message[0].e === 'markPriceUpdate') {
        // 首次收到时记录日志
        if (!this.mark_price_received) {
          this.mark_price_received = true;
          logger.info(`[SubscriptionPool] ✅ markPrice聚合流首次收到数据，共 ${message.length} 个币种`);
        }
        for (const item of message) {
          this.emit('mark_price_data', {
            symbol: item.s,
            data: this.parse_mark_price_data(item)
          });
        }
      }
      return;
    }

    // 处理直接事件格式 {"e":"kline","s":"SOLUSDT",...}
    if (message.e) {
      const event_type = message.e;
      const symbol = message.s;

      // 移除高频日志

      if (event_type === '24hrTicker') {
        this.emit('market_data', {
          symbol,
          data: this.parse_ticker_data(message)
        });
      } else if (event_type === 'kline') {
        this.emit('kline_data', {
          symbol,
          data: this.parse_kline_data(message)
        });
      } else if (event_type === 'depthUpdate') {
        this.emit('depth_data', {
          symbol,
          data: message
        });
      } else if (event_type === 'trade') {
        this.emit('trade_data', {
          symbol,
          data: message
        });
      } else if (event_type === 'markPriceUpdate') {
        // 标记价格更新事件
        this.emit('mark_price_data', {
          symbol,
          data: this.parse_mark_price_data(message)
        });
      }
    }
    // 处理流格式 {"stream":"solusdt@kline_15m","data":{...}}
    else if (message.stream && message.data) {
      // 处理 markPrice 聚合流 {"stream":"!markPrice@arr@1s","data":[{...},{...},...]}
      // 币安返回的stream名称包含频率后缀，使用startsWith匹配
      if (message.stream.startsWith('!markPrice@arr')) {
        // data 是数组，包含所有合约的 markPrice
        if (Array.isArray(message.data)) {
          // 首次收到时记录日志
          if (!this.mark_price_received) {
            this.mark_price_received = true;
            logger.info(`[SubscriptionPool] ✅ markPrice聚合流首次收到数据，共 ${message.data.length} 个币种`);
          }
          for (const item of message.data) {
            this.emit('mark_price_data', {
              symbol: item.s,
              data: this.parse_mark_price_data(item)
            });
          }
        }
        return;
      }

      const stream_parts = message.stream.split('@');
      const symbol = stream_parts[0].toUpperCase();
      const stream_type = stream_parts[1];

      if (stream_type.includes('ticker')) {
        this.emit('market_data', {
          symbol,
          data: this.parse_ticker_data(message.data)
        });
      } else if (stream_type.includes('kline')) {
        this.emit('kline_data', {
          symbol,
          data: this.parse_kline_data(message.data)
        });
      } else if (stream_type.includes('depth')) {
        this.emit('depth_data', {
          symbol,
          data: message.data
        });
      } else if (stream_type.includes('trade')) {
        this.emit('trade_data', {
          symbol,
          data: message.data
        });
      } else if (stream_type.includes('markPrice')) {
        // 单个币种的标记价格流
        this.emit('mark_price_data', {
          symbol,
          data: this.parse_mark_price_data(message.data)
        });
      }
    }
  }

  /**
   * 解析币安ticker数据为标准格式
   * @param data - 原始ticker数据
   */
  private parse_ticker_data(data: any): any {
    return {
      symbol: data.s,
      price: parseFloat(data.c),
      volume: parseFloat(data.v),
      change_24h: parseFloat(data.P),
      high_24h: parseFloat(data.h),
      low_24h: parseFloat(data.l),
      timestamp: Date.now()
    };
  }

  /**
   * 解析币安K线数据为标准格式
   * @param data - 原始K线数据
   */
  private parse_kline_data(data: any): any {
    // 处理直接事件格式 {"e":"kline","k":{...}}
    const kline = data.k || data;

    return {
      symbol: kline.s,
      interval: kline.i,
      open_time: kline.t,
      close_time: kline.T,
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
      volume: parseFloat(kline.v),
      trade_count: kline.n,
      is_final: kline.x
    };
  }

  /**
   * 解析币安标记价格数据为标准格式
   * @param data - 原始markPrice数据
   */
  private parse_mark_price_data(data: any): any {
    return {
      symbol: data.s,
      mark_price: parseFloat(data.p),           // 标记价格
      index_price: parseFloat(data.i),          // 指数价格
      funding_rate: parseFloat(data.r),         // 资金费率
      next_funding_time: data.T,                // 下次资金费率时间
      timestamp: data.E || Date.now()
    };
  }

  /**
   * 启动心跳检测，定期发送ping消息保持连接活跃
   */
  private start_ping(): void {
    this.ping_timer = setInterval(() => {
      if (this.ws && this.is_connected) {
        this.ws.ping();
        // 静默发送ping，只在失败时记录日志
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
   * 计划重连，在连接断开后延迟一段时间后尝试重新连接
   */
  private schedule_reconnect(): void {
    if (this.reconnect_attempts >= this.config.max_reconnect_attempts) {
      logger.error('Max reconnect attempts reached, giving up');
      this.emit('max_reconnect_reached');
      return;
    }

    if (this.reconnect_timer) {
      clearTimeout(this.reconnect_timer);
    }

    this.reconnect_timer = setTimeout(async () => {
      logger.info(`Attempting to reconnect... (${this.reconnect_attempts + 1}/${this.config.max_reconnect_attempts})`);
      this.reconnect_attempts++;

      try {
        await this.establish_connection();
        // 重新订阅之前的流
        if (this.subscribed_streams.size > 0) {
          await this.resubscribe_streams();
        }
      } catch (error) {
        logger.error('Reconnect failed', error);
        this.schedule_reconnect();
      }
    }, this.config.reconnect_interval);
  }

  /**
   * 订阅多个数据流
   * @param streams - 要订阅的数据流列表
   */
  async subscribe_streams(streams: string[]): Promise<void> {
    if (!this.is_connected) {
      throw new Error('WebSocket not connected');
    }

    const subscribe_message = {
      method: 'SUBSCRIBE',
      params: streams,
      id: Date.now()
    };

    try {
      const msg_str = JSON.stringify(subscribe_message);
      logger.info(`📡 发送订阅请求: ${msg_str}`);
      this.ws!.send(msg_str);

      // 记录已订阅的流
      streams.forEach(stream => {
        this.subscribed_streams.add(stream);
      });

      logger.info(`📡 Subscription request sent for ${streams.length} streams: ${streams.join(', ')}`);
    } catch (error) {
      logger.error('Failed to subscribe streams', error);
      throw error;
    }
  }

  /**
   * 取消订阅多个数据流
   * @param streams - 要取消订阅的数据流列表
   */
  async unsubscribe_streams(streams: string[]): Promise<void> {
    if (!this.is_connected) {
      throw new Error('WebSocket not connected');
    }

    const unsubscribe_message = {
      method: 'UNSUBSCRIBE',
      params: streams,
      id: Date.now()
    };

    try {
      this.ws!.send(JSON.stringify(unsubscribe_message));

      // 从记录中移除
      streams.forEach(stream => {
        this.subscribed_streams.delete(stream);
      });

      logger.info(`Unsubscribed from ${streams.length} streams:`, streams);
    } catch (error) {
      logger.error('Failed to unsubscribe streams', error);
      throw error;
    }
  }

  /**
   * 重连后重新订阅所有之前订阅的数据流
   */
  private async resubscribe_streams(): Promise<void> {
    if (this.subscribed_streams.size > 0) {
      const streams = Array.from(this.subscribed_streams);
      await this.subscribe_streams(streams);
      logger.info(`Resubscribed to ${streams.length} streams after reconnection`);
    }
  }

  /**
   * 获取当前已订阅的数据流列表
   */
  get_subscribed_streams(): string[] {
    return Array.from(this.subscribed_streams);
  }

  /**
   * 获取WebSocket连接状态信息
   */
  get_connection_status(): { connected: boolean; attempts: number; streams: number } {
    return {
      connected: this.is_connected,
      attempts: this.reconnect_attempts,
      streams: this.subscribed_streams.size
    };
  }

  /**
   * 断开WebSocket连接并清理相关资源
   */
  async disconnect(): Promise<void> {
    logger.info('Disconnecting WebSocket');

    // 清理定时器
    if (this.reconnect_timer) {
      clearTimeout(this.reconnect_timer);
      this.reconnect_timer = null;
    }

    this.stop_ping();

    // 关闭连接
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.is_connected = false;
    this.reconnect_attempts = 0;
    this.subscribed_streams.clear();

    logger.info('WebSocket disconnected');
  }
}