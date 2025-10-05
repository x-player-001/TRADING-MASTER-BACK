import { EventEmitter } from 'events';
import { RedisClientType } from 'redis';
import { DatabaseConfig } from '@/core/config/database';
import { SubscriptionPool } from './subscription_pool';
import { MarketData, KlineData } from '@/types/common';
import { logger } from '@/utils/logger';

export class StreamDispatcher extends EventEmitter {
  private static instance: StreamDispatcher;
  private redis: RedisClientType | null = null;
  private subscription_pool: SubscriptionPool;
  private readonly CACHE_TTL = {
    market_data: 300,    // 5分钟
    kline_data: 3600,    // 1小时
    depth_data: 60,      // 1分钟
    trade_data: 1800     // 30分钟
  };

  private constructor() {
    super();
    this.subscription_pool = SubscriptionPool.getInstance();
  }

  /**
   * 获取数据流分发器单例实例
   */
  static getInstance(): StreamDispatcher {
    if (!StreamDispatcher.instance) {
      StreamDispatcher.instance = new StreamDispatcher();
    }
    return StreamDispatcher.instance;
  }

  /**
   * 初始化数据流分发器，建立数据库连接并设置数据监听
   */
  async initialize(): Promise<void> {
    try {
      this.redis = await DatabaseConfig.get_redis_client();
      await this.setup_data_listeners();

      logger.info('StreamDispatcher initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize StreamDispatcher', error);
      throw error;
    }
  }

  /**
   * 设置数据事件监听器，处理来自订阅池的各种数据事件
   */
  private async setup_data_listeners(): void {
    // 监听市场数据
    this.subscription_pool.on('market_data', async (event) => {
      await this.handle_market_data(event.symbol, event.data);
    });

    // 监听K线数据
    this.subscription_pool.on('kline_data', async (event) => {
      await this.handle_kline_data(event.symbol, event.data);
    });

    // 监听深度数据
    this.subscription_pool.on('depth_data', async (event) => {
      await this.handle_depth_data(event.symbol, event.data);
    });

    // 监听交易数据
    this.subscription_pool.on('trade_data', async (event) => {
      await this.handle_trade_data(event.symbol, event.data);
    });

    logger.info('Data listeners setup completed');
  }

  /**
   * 处理市场数据，缓存并分发给订阅者
   * @param symbol - 交易对符号
   * @param raw_data - 原始市场数据
   */
  private async handle_market_data(symbol: string, raw_data: any): Promise<void> {
    try {
      const market_data: MarketData = {
        symbol,
        price: raw_data.price,
        volume: raw_data.volume,
        change_24h: raw_data.change_24h,
        high_24h: raw_data.high_24h,
        low_24h: raw_data.low_24h,
        timestamp: raw_data.timestamp
      };

      // 缓存到Redis
      const cache_key = `market:ticker:${symbol}`;
      await this.redis!.setEx(
        cache_key,
        this.CACHE_TTL.market_data,
        JSON.stringify(market_data)
      );

      // 发布到所有订阅者
      await this.redis!.publish(`market_data:${symbol}`, JSON.stringify(market_data));

      // 触发本地事件
      this.emit('market_data', market_data);

      logger.debug(`Processed market data for ${symbol}: $${market_data.price}`);
    } catch (error) {
      logger.error(`Failed to handle market data for ${symbol}`, error);
    }
  }

  /**
   * 处理K线数据，缓存并分发给订阅者
   * @param symbol - 交易对符号
   * @param raw_data - 原始K线数据
   */
  private async handle_kline_data(symbol: string, raw_data: any): Promise<void> {
    try {
      const kline_data: KlineData = {
        symbol,
        interval: raw_data.interval,
        open_time: raw_data.open_time,
        close_time: raw_data.close_time,
        open: raw_data.open,
        high: raw_data.high,
        low: raw_data.low,
        close: raw_data.close,
        volume: raw_data.volume,
        trade_count: raw_data.trade_count
      };

      // 只处理完成的K线
      if (raw_data.is_final) {
        // 缓存到Redis - 使用列表存储最近的K线
        const cache_key = `market:kline:${symbol}:${kline_data.interval}`;

        // 添加到列表头部
        await this.redis!.lPush(cache_key, JSON.stringify(kline_data));

        // 保持列表最多1000条记录
        await this.redis!.lTrim(cache_key, 0, 999);

        // 设置过期时间
        await this.redis!.expire(cache_key, this.CACHE_TTL.kline_data);

        // 发布K线更新事件
        await this.redis!.publish(`kline_data:${symbol}:${kline_data.interval}`, JSON.stringify(kline_data));

        logger.debug(`Processed kline data for ${symbol} ${kline_data.interval}: OHLC(${kline_data.open}/${kline_data.high}/${kline_data.low}/${kline_data.close})`);
      }

      // 实时K线数据（包括未完成的）
      const realtime_key = `market:kline:${symbol}:${kline_data.interval}:realtime`;
      await this.redis!.setEx(realtime_key, 60, JSON.stringify(kline_data));

      // 发布实时更新
      await this.redis!.publish(`realtime_kline:${symbol}:${kline_data.interval}`, JSON.stringify(kline_data));

      // 触发本地事件
      this.emit('kline_data', kline_data);

    } catch (error) {
      logger.error(`Failed to handle kline data for ${symbol}`, error);
    }
  }

  private async handle_depth_data(symbol: string, raw_data: any): Promise<void> {
    try {
      const depth_data = {
        symbol,
        bids: raw_data.bids,
        asks: raw_data.asks,
        timestamp: Date.now()
      };

      // 缓存订单簿数据
      const cache_key = `market:depth:${symbol}`;
      await this.redis!.setEx(
        cache_key,
        this.CACHE_TTL.depth_data,
        JSON.stringify(depth_data)
      );

      // 发布深度更新
      await this.redis!.publish(`depth_data:${symbol}`, JSON.stringify(depth_data));

      // 触发本地事件
      this.emit('depth_data', depth_data);

      logger.debug(`Processed depth data for ${symbol}: ${depth_data.bids.length} bids, ${depth_data.asks.length} asks`);
    } catch (error) {
      logger.error(`Failed to handle depth data for ${symbol}`, error);
    }
  }

  private async handle_trade_data(symbol: string, raw_data: any): Promise<void> {
    try {
      const trade_data = {
        symbol,
        trade_id: raw_data.t,
        price: parseFloat(raw_data.p),
        quantity: parseFloat(raw_data.q),
        timestamp: raw_data.T,
        is_buyer_maker: raw_data.m
      };

      // 缓存最近交易记录
      const cache_key = `market:trades:${symbol}`;

      // 添加到列表头部
      await this.redis!.lPush(cache_key, JSON.stringify(trade_data));

      // 保持最近100条交易
      await this.redis!.lTrim(cache_key, 0, 99);

      // 设置过期时间
      await this.redis!.expire(cache_key, this.CACHE_TTL.trade_data);

      // 发布交易事件
      await this.redis!.publish(`trade_data:${symbol}`, JSON.stringify(trade_data));

      // 触发本地事件
      this.emit('trade_data', trade_data);

      logger.debug(`Processed trade data for ${symbol}: ${trade_data.quantity} @ $${trade_data.price}`);
    } catch (error) {
      logger.error(`Failed to handle trade data for ${symbol}`, error);
    }
  }

  // 获取缓存的市场数据
  /**
   * 获取缓存的市场数据
   * @param symbol - 交易对符号
   */
  async get_cached_market_data(symbol: string): Promise<MarketData | null> {
    try {
      const cache_key = `market:ticker:${symbol}`;
      const cached = await this.redis!.get(cache_key);

      if (cached) {
        return JSON.parse(cached) as MarketData;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get cached market data for ${symbol}`, error);
      return null;
    }
  }

  // 获取缓存的K线数据
  /**
   * 获取缓存的K线数据
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param limit - 数据条数限制
   */
  async get_cached_kline_data(symbol: string, interval: string, limit: number = 100): Promise<KlineData[]> {
    try {
      const cache_key = `market:kline:${symbol}:${interval}`;
      const cached_list = await this.redis!.lRange(cache_key, 0, limit - 1);

      return cached_list.map(item => JSON.parse(item) as KlineData);
    } catch (error) {
      logger.error(`Failed to get cached kline data for ${symbol}:${interval}`, error);
      return [];
    }
  }

  // 获取实时K线数据
  /**
   * 获取实时K线数据（包括未完成的K线）
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   */
  async get_realtime_kline(symbol: string, interval: string): Promise<KlineData | null> {
    try {
      const cache_key = `market:kline:${symbol}:${interval}:realtime`;
      const cached = await this.redis!.get(cache_key);

      if (cached) {
        return JSON.parse(cached) as KlineData;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get realtime kline for ${symbol}:${interval}`, error);
      return null;
    }
  }

  // 获取缓存的深度数据
  async get_cached_depth_data(symbol: string): Promise<any | null> {
    try {
      const cache_key = `market:depth:${symbol}`;
      const cached = await this.redis!.get(cache_key);

      if (cached) {
        return JSON.parse(cached);
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get cached depth data for ${symbol}`, error);
      return null;
    }
  }

  // 获取最近交易记录
  async get_recent_trades(symbol: string, limit: number = 50): Promise<any[]> {
    try {
      const cache_key = `market:trades:${symbol}`;
      const cached_list = await this.redis!.lRange(cache_key, 0, limit - 1);

      return cached_list.map(item => JSON.parse(item));
    } catch (error) {
      logger.error(`Failed to get recent trades for ${symbol}`, error);
      return [];
    }
  }

  // 获取所有符号的最新价格
  /**
   * 获取所有币种的最新价格
   */
  async get_all_symbols_prices(): Promise<{ [symbol: string]: number }> {
    try {
      const pattern = 'market:ticker:*';
      const keys = await this.redis!.keys(pattern);
      const prices: { [symbol: string]: number } = {};

      for (const key of keys) {
        const symbol = key.replace('market:ticker:', '');
        const cached = await this.redis!.get(key);

        if (cached) {
          const market_data = JSON.parse(cached) as MarketData;
          prices[symbol] = market_data.price;
        }
      }

      return prices;
    } catch (error) {
      logger.error('Failed to get all symbols prices', error);
      return {};
    }
  }

  // 清理过期缓存
  /**
   * 清理过期的缓存数据
   */
  async cleanup_expired_cache(): Promise<void> {
    try {
      const patterns = [
        'market:ticker:*',
        'market:kline:*',
        'market:depth:*',
        'market:trades:*'
      ];

      for (const pattern of patterns) {
        const keys = await this.redis!.keys(pattern);

        for (const key of keys) {
          const ttl = await this.redis!.ttl(key);
          if (ttl === -1) {
            // 为没有过期时间的key设置默认过期时间
            await this.redis!.expire(key, this.CACHE_TTL.market_data);
          }
        }
      }

      logger.info('Cache cleanup completed');
    } catch (error) {
      logger.error('Failed to cleanup expired cache', error);
    }
  }

  // 获取缓存统计信息
  async get_cache_stats(): Promise<any> {
    try {
      const stats = {
        market_data_keys: 0,
        kline_data_keys: 0,
        depth_data_keys: 0,
        trade_data_keys: 0,
        total_memory: 0
      };

      const patterns = [
        { pattern: 'market:ticker:*', field: 'market_data_keys' },
        { pattern: 'market:kline:*', field: 'kline_data_keys' },
        { pattern: 'market:depth:*', field: 'depth_data_keys' },
        { pattern: 'market:trades:*', field: 'trade_data_keys' }
      ];

      for (const { pattern, field } of patterns) {
        const keys = await this.redis!.keys(pattern);
        stats[field as keyof typeof stats] = keys.length;
      }

      // 获取内存使用情况
      const info = await this.redis!.info('memory');
      const memory_match = info.match(/used_memory:(\d+)/);
      if (memory_match) {
        stats.total_memory = parseInt(memory_match[1]);
      }

      return stats;
    } catch (error) {
      logger.error('Failed to get cache stats', error);
      return null;
    }
  }
}