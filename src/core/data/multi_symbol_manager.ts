import { EventEmitter } from 'events';
import { RedisClientType } from 'redis';
import { Connection } from 'mysql2/promise';
import { DatabaseConfig } from '@/core/config/database';
import { SubscriptionStatusRepository, KlineMultiTableRepository } from '@/database';
import { SubscriptionPool } from './subscription_pool';
import { SymbolConfigManager } from './symbol_config_manager';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';
import { SubscriptionStatus, StreamType, KlineData } from '@/types/common';
import { logger } from '@/utils/logger';

export class MultiSymbolManager extends EventEmitter {
  private static instance: MultiSymbolManager;
  private redis: RedisClientType | null = null;
  private mysql: Connection | null = null;
  private subscription_status_repository: SubscriptionStatusRepository;
  private kline_repository: KlineMultiTableRepository;
  private subscription_pool: SubscriptionPool;
  private symbol_config_manager: SymbolConfigManager;
  private top_symbols_manager: TopSymbolsManager;
  private readonly STATUS_UPDATE_INTERVAL = 30000; // 30秒
  private status_update_timer: NodeJS.Timeout | null = null;
  private is_initialized = false;

  private constructor() {
    super();
    this.subscription_pool = SubscriptionPool.getInstance();
    this.symbol_config_manager = SymbolConfigManager.getInstance();
    this.top_symbols_manager = TopSymbolsManager.get_instance();
    this.subscription_status_repository = new SubscriptionStatusRepository();
    this.kline_repository = new KlineMultiTableRepository();
  }

  /**
   * 获取多币种订阅管理器单例实例
   */
  static getInstance(): MultiSymbolManager {
    if (!MultiSymbolManager.instance) {
      MultiSymbolManager.instance = new MultiSymbolManager();
    }
    return MultiSymbolManager.instance;
  }

  /**
   * 初始化多币种订阅管理器，创建表结构并设置WebSocket监听
   */
  async initialize(): Promise<void> {
    if (this.is_initialized) {
      logger.warn('MultiSymbolManager already initialized, skipping');
      return;
    }

    try {
      this.redis = await DatabaseConfig.get_redis_client();
      this.mysql = await DatabaseConfig.get_mysql_connection();
      await this.subscription_status_repository.create_table();
      await this.kline_repository.create_tables();
      await this.setup_websocket_listeners();
      this.start_status_monitoring();

      // 启动WebSocket订阅
      await this.subscribe_enabled_symbols();

      this.is_initialized = true;
      logger.info('MultiSymbolManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize MultiSymbolManager', error);
      throw error;
    }
  }


  /**
   * 设置WebSocket事件监听器，处理连接状态和数据事件
   */
  private async setup_websocket_listeners(): void {
    // 监听连接状态
    this.subscription_pool.on('connected', async () => {
      logger.info('WebSocket connected, ready for subscriptions');
      // 注意：不在这里调用 subscribe_enabled_symbols()，避免循环调用
    });

    this.subscription_pool.on('disconnected', async () => {
      logger.warn('WebSocket disconnected, updating status');
      await this.update_all_status_to_inactive();
    });

    this.subscription_pool.on('error', async (error) => {
      logger.error('WebSocket error', error);
      await this.handle_websocket_error(error);
    });

    // 监听数据事件
    this.subscription_pool.on('market_data', async (data) => {
      await this.update_subscription_status(data.symbol, 'ticker', 'active');
    });

    this.subscription_pool.on('kline_data', async (data) => {
      await this.update_subscription_status(data.symbol, 'kline', 'active');

      // 存储完整的K线数据到MySQL
      await this.handle_kline_data(data);
    });

    this.subscription_pool.on('depth_data', async (data) => {
      await this.update_subscription_status(data.symbol, 'depth', 'active');
    });

    this.subscription_pool.on('trade_data', async (data) => {
      await this.update_subscription_status(data.symbol, 'trade', 'active');
    });
  }

  /**
   * 订阅所有已启用的币种数据流，优先使用TOP symbols配置
   */
  async subscribe_enabled_symbols(): Promise<void> {
    try {
      // 优先获取TOP symbols配置
      const top_symbols = await this.top_symbols_manager.get_enabled_symbols();
      let symbols_to_subscribe = [];

      if (top_symbols.length > 0) {
        symbols_to_subscribe = top_symbols;
        logger.info(`Using TOP symbols configuration: ${top_symbols.length} symbols`);
      } else {
        // 降级到原有的symbol config
        const enabled_symbols = await this.symbol_config_manager.get_enabled_symbols();
        symbols_to_subscribe = enabled_symbols;
        logger.info(`Using symbol config fallback: ${enabled_symbols.length} symbols`);
      }

      if (symbols_to_subscribe.length === 0) {
        logger.warn('No enabled symbols found for subscription');
        return;
      }

      // 构建订阅流
      const streams: string[] = [];

      for (const symbol_config of symbols_to_subscribe) {
        const symbol_lower = symbol_config.symbol.toLowerCase();

        // 添加ticker流
        streams.push(`${symbol_lower}@ticker`);

        // 根据配置添加K线数据流
        if ('subscription_intervals' in symbol_config) {
          // TOP symbols配置，支持多个时间周期
          for (const interval of symbol_config.subscription_intervals) {
            streams.push(`${symbol_lower}@kline_${interval}`);
          }
        } else {
          // 原有配置，默认1分钟K线
          streams.push(`${symbol_lower}@kline_1m`);
        }

        // 为主流币添加更多数据流
        if (symbol_config.category === 'major' || ('rank_order' in symbol_config && symbol_config.rank_order <= 3)) {
          streams.push(`${symbol_lower}@depth20@100ms`);
          streams.push(`${symbol_lower}@trade`);
        }
      }

      // 连接WebSocket并订阅
      await this.subscription_pool.connect();
      await this.subscription_pool.subscribe_streams(streams);

      // 初始化订阅状态
      await this.initialize_subscription_status(symbols_to_subscribe);

      logger.info(`Successfully subscribed to ${streams.length} streams for ${symbols_to_subscribe.length} symbols`);

    } catch (error) {
      logger.error('Failed to subscribe enabled symbols', error);
      throw error;
    }
  }

  private async initialize_subscription_status(enabled_symbols: any[]): Promise<void> {
    try {
      for (const symbol_config of enabled_symbols) {
        const symbol = symbol_config.symbol;

        // ticker流
        await this.upsert_subscription_status(symbol, 'ticker', 'active');

        // kline流
        await this.upsert_subscription_status(symbol, 'kline', 'active');

        // 主流币额外流
        if (symbol_config.category === 'major') {
          await this.upsert_subscription_status(symbol, 'depth', 'active');
          await this.upsert_subscription_status(symbol, 'trade', 'active');
        }
      }
    } catch (error) {
      logger.error('Failed to initialize subscription status', error);
      throw error;
    }
  }

  private async upsert_subscription_status(symbol: string, stream_type: StreamType, status: 'active' | 'inactive' | 'error'): Promise<void> {
    try {
      const sql = `
        INSERT INTO subscription_status (symbol, stream_type, status, last_update)
        VALUES (?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          last_update = NOW(),
          error_count = IF(VALUES(status) = 'active', 0, error_count)
      `;

      await this.mysql!.execute(sql, [symbol, stream_type, status]);
    } catch (error) {
      logger.error(`Failed to upsert subscription status for ${symbol}:${stream_type}`, error);
    }
  }

  async update_subscription_status(symbol: string, stream_type: StreamType, status: 'active' | 'inactive' | 'error', error_message?: string): Promise<void> {
    try {
      // 检查客户端是否已关闭
      if (!this.mysql || !this.redis || !this.redis.isOpen) {
        return;
      }

      const sql = `
        UPDATE subscription_status
        SET status = ?, last_update = NOW(), error_message = ?, updated_at = NOW()
        WHERE symbol = ? AND stream_type = ?
      `;

      await this.mysql.execute(sql, [status, error_message || null, symbol, stream_type]);

      // 更新Redis缓存
      const cache_key = `status:subscription:${symbol}:${stream_type}`;
      await this.redis.setEx(cache_key, 60, JSON.stringify({
        symbol,
        stream_type,
        status,
        last_update: new Date(),
        error_message
      }));

    } catch (error) {
      logger.error(`Failed to update subscription status for ${symbol}:${stream_type}`, error);
    }
  }

  private async update_all_status_to_inactive(): Promise<void> {
    try {
      await this.mysql!.execute(`
        UPDATE subscription_status
        SET status = 'inactive', updated_at = NOW()
        WHERE status = 'active'
      `);

      logger.info('Updated all active subscriptions to inactive');
    } catch (error) {
      logger.error('Failed to update all status to inactive', error);
    }
  }

  private async handle_websocket_error(error: Error): Promise<void> {
    try {
      // 增加所有活跃订阅的错误计数
      await this.mysql!.execute(`
        UPDATE subscription_status
        SET error_count = error_count + 1,
            status = 'error',
            error_message = ?,
            updated_at = NOW()
        WHERE status = 'active'
      `, [error.message]);

      logger.warn('Updated subscription status due to WebSocket error');
    } catch (db_error) {
      logger.error('Failed to handle WebSocket error', db_error);
    }
  }

  async add_symbol_subscription(symbol: string): Promise<void> {
    try {
      // 检查币种配置是否存在
      const symbol_config = await this.symbol_config_manager.get_symbol_by_name(symbol);
      if (!symbol_config) {
        throw new Error(`Symbol ${symbol} not found in configuration`);
      }

      // 构建新的订阅流
      const symbol_lower = symbol.toLowerCase();
      const new_streams = [
        `${symbol_lower}@ticker`,
        `${symbol_lower}@kline_1m`
      ];

      // 主流币添加更多流
      if (symbol_config.category === 'major') {
        new_streams.push(`${symbol_lower}@depth20@100ms`);
        new_streams.push(`${symbol_lower}@trade`);
      }

      // 订阅新流
      await this.subscription_pool.subscribe_streams(new_streams);

      // 更新状态
      await this.upsert_subscription_status(symbol, 'ticker', 'active');
      await this.upsert_subscription_status(symbol, 'kline', 'active');

      if (symbol_config.category === 'major') {
        await this.upsert_subscription_status(symbol, 'depth', 'active');
        await this.upsert_subscription_status(symbol, 'trade', 'active');
      }

      logger.info(`Added subscription for symbol ${symbol}`);
    } catch (error) {
      logger.error(`Failed to add subscription for symbol ${symbol}`, error);
      throw error;
    }
  }

  async remove_symbol_subscription(symbol: string): Promise<void> {
    try {
      // 构建要取消订阅的流
      const symbol_lower = symbol.toLowerCase();
      const streams_to_remove = [
        `${symbol_lower}@ticker`,
        `${symbol_lower}@kline_1m`,
        `${symbol_lower}@depth20@100ms`,
        `${symbol_lower}@trade`
      ];

      // 取消订阅
      await this.subscription_pool.unsubscribe_streams(streams_to_remove);

      // 删除状态记录
      if (this.mysql) {
        await this.mysql.execute(
          'DELETE FROM subscription_status WHERE symbol = ?',
          [symbol]
        );
      }

      // 清除Redis缓存
      if (this.redis && this.redis.isOpen) {
        const cache_keys = ['ticker', 'kline', 'depth', 'trade'].map(
          type => `status:subscription:${symbol}:${type}`
        );
        await this.redis.del(cache_keys);
      }

      logger.info(`Removed subscription for symbol ${symbol}`);
    } catch (error) {
      logger.error(`Failed to remove subscription for symbol ${symbol}`, error);
      throw error;
    }
  }

  async get_subscription_status(): Promise<SubscriptionStatus[]> {
    try {
      const [rows] = await this.mysql!.execute(`
        SELECT * FROM subscription_status
        ORDER BY symbol ASC, stream_type ASC
      `);

      return rows as SubscriptionStatus[];
    } catch (error) {
      logger.error('Failed to get subscription status', error);
      throw error;
    }
  }

  async get_symbol_subscription_status(symbol: string): Promise<SubscriptionStatus[]> {
    try {
      const [rows] = await this.mysql!.execute(`
        SELECT * FROM subscription_status
        WHERE symbol = ?
        ORDER BY stream_type ASC
      `, [symbol]);

      return rows as SubscriptionStatus[];
    } catch (error) {
      logger.error(`Failed to get subscription status for symbol ${symbol}`, error);
      throw error;
    }
  }

  private start_status_monitoring(): void {
    this.status_update_timer = setInterval(async () => {
      try {
        // 检查客户端是否已关闭
        if (!this.redis || !this.redis.isOpen) {
          return;
        }

        const connection_status = this.subscription_pool.get_connection_status();

        // 记录连接状态到Redis
        await this.redis.setEx('status:websocket:connection', 60, JSON.stringify({
          connected: connection_status.connected,
          reconnect_attempts: connection_status.attempts,
          subscribed_streams: connection_status.streams,
          timestamp: new Date()
        }));

        // 如果连接超时，标记为错误
        await this.check_stale_subscriptions();

      } catch (error) {
        logger.error('Error in status monitoring', error);
      }
    }, this.STATUS_UPDATE_INTERVAL);
  }

  private async check_stale_subscriptions(): Promise<void> {
    try {
      // 查找超过2分钟没有更新的活跃订阅
      await this.mysql!.execute(`
        UPDATE subscription_status
        SET status = 'error', error_message = 'No data received for 2 minutes'
        WHERE status = 'active'
          AND last_update IS NOT NULL
          AND last_update < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
      `);
    } catch (error) {
      logger.error('Failed to check stale subscriptions', error);
    }
  }

  async refresh_subscriptions(): Promise<void> {
    try {
      logger.info('Refreshing all subscriptions...');

      // 断开当前连接
      await this.subscription_pool.disconnect();

      // 等待一秒后重新连接
      setTimeout(async () => {
        await this.subscribe_enabled_symbols();
      }, 1000);

    } catch (error) {
      logger.error('Failed to refresh subscriptions', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping MultiSymbolManager...');

    // 清理定时器
    if (this.status_update_timer) {
      clearInterval(this.status_update_timer);
      this.status_update_timer = null;
    }

    // 断开WebSocket连接
    await this.subscription_pool.disconnect();

    logger.info('MultiSymbolManager stopped');
  }

  /**
   * 处理实时K线数据，存储到MySQL
   * @param kline_data 从WebSocket接收的K线数据
   */
  private async handle_kline_data(kline_data: any): Promise<void> {
    try {
      // 提取实际的K线数据
      const actual_data = kline_data.data || kline_data;

      // 只存储已完成的K线数据
      if (!actual_data.is_final) {
        return;
      }

      // 转换为标准K线数据格式
      const formatted_kline: KlineData = {
        symbol: actual_data.symbol,
        interval: actual_data.interval,
        open_time: actual_data.open_time,
        close_time: actual_data.close_time,
        open: actual_data.open,
        high: actual_data.high,
        low: actual_data.low,
        close: actual_data.close,
        volume: actual_data.volume,
        trade_count: actual_data.trade_count,
        is_final: true
      };

      // 异步存储到MySQL，不阻塞主流程
      this.store_single_kline_to_mysql(formatted_kline).catch(error => {
        logger.error(`Failed to store real-time kline for ${kline_data.symbol}:${kline_data.interval}`, error);
      });

      // 发出K线完成事件，触发信号生成
      this.emit('kline_completed', {
        symbol: formatted_kline.symbol,
        interval: formatted_kline.interval,
        kline: formatted_kline
      });

    } catch (error) {
      logger.error('Failed to handle kline data', error);
    }
  }

  /**
   * 将单个K线数据存储到MySQL
   * @param kline_data K线数据
   */
  private async store_single_kline_to_mysql(kline_data: KlineData): Promise<void> {
    try {
      const inserted_count = await this.kline_repository.batch_insert([kline_data]);

      // 静默存储，避免频繁日志

    } catch (error) {
      logger.error('Failed to store single kline to MySQL', error);
      throw error;
    }
  }
}