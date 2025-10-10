import { RedisClientType } from 'redis';
import { DatabaseConfig } from '@/core/config/database';
import { BinanceAPI } from '@/api';
import { HistoricalDataCacheRepository, KlineMultiTableRepository } from '@/database';
import { HistoricalDataCache, KlineData } from '@/types/common';
import { logger } from '@/utils/logger';

export class HistoricalDataManager {
  private static instance: HistoricalDataManager;
  private redis: RedisClientType | null = null;
  private binance_api: BinanceAPI;
  private cache_repository: HistoricalDataCacheRepository;
  private kline_repository: KlineMultiTableRepository;
  private readonly CACHE_EXPIRE_HOURS = parseInt(process.env.CACHE_EXPIRE_HOURS || '24');

  private constructor() {
    this.binance_api = BinanceAPI.getInstance();
    this.cache_repository = new HistoricalDataCacheRepository();
    this.kline_repository = new KlineMultiTableRepository();
  }

  /**
   * 获取历史数据管理器单例实例
   */
  static getInstance(): HistoricalDataManager {
    if (!HistoricalDataManager.instance) {
      HistoricalDataManager.instance = new HistoricalDataManager();
    }
    return HistoricalDataManager.instance;
  }

  /**
   * 初始化历史数据管理器，建立数据库连接并创建必要的表结构
   */
  async initialize(): Promise<void> {
    try {
      this.redis = await DatabaseConfig.get_redis_client();
      await this.cache_repository.create_table();
      await this.kline_repository.create_tables();

      logger.info('HistoricalDataManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize HistoricalDataManager', error);
      throw error;
    }
  }


  /**
   * 获取历史K线数据，优先从缓存获取，缓存未命中则从API获取
   * @param symbol - 交易对符号 (如: BTCUSDT)
   * @param interval - K线时间间隔 (如: 1m, 5m, 1h)
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   * @param limit - 数据条数限制
   */
  async get_historical_klines(
    symbol: string,
    interval: string,
    start_time?: number,
    end_time?: number,
    limit: number = 500
  ): Promise<KlineData[]> {
    const fetch_start = Date.now();

    try {
      // 检查缓存
      const cached_data = await this.check_cache(symbol, interval, start_time, end_time, limit);
      if (cached_data) {
        return cached_data;
      }

      // 从API获取数据
      const api_data = await this.binance_api.get_klines(symbol, interval, start_time, end_time, limit);

      // 缓存数据到Redis和MySQL
      await this.cache_historical_data(symbol, interval, api_data, start_time, end_time, Date.now() - fetch_start);

      return api_data;

    } catch (error) {
      logger.error(`Failed to get historical klines for ${symbol}:${interval}`, error);
      throw error;
    }
  }

  /**
   * 检查缓存中是否存在请求的历史数据
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   * @param limit - 数据条数限制
   */
  private async check_cache(
    symbol: string,
    interval: string,
    start_time?: number,
    end_time?: number,
    limit?: number
  ): Promise<KlineData[] | null> {
    try {
      // 1. 优先检查Redis缓存
      const cache_key = this.build_cache_key(symbol, interval, start_time, end_time, limit);
      const redis_cached = await this.redis!.get(cache_key);
      if (redis_cached) {
        return JSON.parse(redis_cached) as KlineData[];
      }

      // 2. 检查数据库缓存记录
      const cache_records = await this.cache_repository.find_valid_cache(symbol, interval, cache_key);
      if (cache_records.length > 0) {
        // 从Redis恢复数据
        const cached = await this.redis!.get(cache_records[0].cache_key);
        if (cached) {
          return JSON.parse(cached) as KlineData[];
        }
      }

      // 3. 从MySQL查询历史数据（降级策略）
      const mysql_data = await this.query_from_mysql(symbol, interval, start_time, end_time, limit);
      if (mysql_data && mysql_data.length > 0) {
        // 检查数据量是否充足（如果请求了limit条，但MySQL只有少量数据，不算有效缓存）
        const requested_limit = limit || 100;
        const data_sufficiency_threshold = 0.5; // 至少50%的数据量才算有效

        if (mysql_data.length >= requested_limit * data_sufficiency_threshold) {
          // 数据量充足，将MySQL数据重新缓存到Redis
          const cache_ttl = this.CACHE_EXPIRE_HOURS * 3600;
          await this.redis!.setEx(cache_key, cache_ttl, JSON.stringify(mysql_data));
          return mysql_data;
        } else {
          // 数据量不足，返回null触发API调用
          return null;
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to check cache', error);
      return null;
    }
  }

  /**
   * 从MySQL查询K线数据
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   * @param limit - 数据条数限制
   */
  private async query_from_mysql(
    symbol: string,
    interval: string,
    start_time?: number,
    end_time?: number,
    limit?: number
  ): Promise<KlineData[] | null> {
    try {
      // 统一使用分表repository
      if (start_time || end_time) {
        return await this.kline_repository.find_by_time_range(symbol, interval, start_time, end_time, limit || 500);
      }
      return await this.kline_repository.find_latest(symbol, interval, limit || 100);

    } catch (error) {
      logger.error(`Failed to query from MySQL for ${symbol}:${interval}`, error);
      return null;
    }
  }


  /**
   * 将历史数据缓存到Redis和数据库中
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param data - K线数据数组
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   * @param fetch_duration - 获取数据耗时
   */
  private async cache_historical_data(
    symbol: string,
    interval: string,
    data: KlineData[],
    start_time?: number,
    end_time?: number,
    fetch_duration: number = 0
  ): Promise<void> {
    try {
      if (data.length === 0) {
        return;
      }

      // 构建缓存键
      const cache_key = this.build_cache_key(symbol, interval, start_time, end_time, data.length);

      // 缓存到Redis
      const cache_ttl = this.CACHE_EXPIRE_HOURS * 3600;
      await this.redis!.setEx(cache_key, cache_ttl, JSON.stringify(data));

      // 存储K线数据到MySQL（异步处理，不阻塞主流程）
      this.store_klines_to_mysql(data).catch(error => {
        logger.error('Failed to store klines to MySQL', error);
      });

      // 记录缓存信息到数据库
      const actual_start_time = new Date(data[0]?.open_time || start_time || Date.now());
      const actual_end_time = new Date(data[data.length - 1]?.close_time || end_time || Date.now());
      const expires_at = new Date(Date.now() + cache_ttl * 1000);

      await this.cache_repository.upsert({
        symbol,
        time_interval: interval,
        start_time: actual_start_time,
        end_time: actual_end_time,
        data_count: data.length,
        cache_key,
        expires_at,
        fetch_duration,
        data_source: 'binance_api'
      });

      // 缓存完成，无需日志输出

    } catch (error) {
      logger.error('Failed to cache historical data', error);
    }
  }

  /**
   * 将K线数据存储到MySQL
   * @param kline_data K线数据数组
   */
  private async store_klines_to_mysql(kline_data: KlineData[]): Promise<void> {
    try {
      if (kline_data.length === 0) {
        return;
      }

      // 统一使用分表存储
      await this.kline_repository.batch_insert(kline_data);

    } catch (error) {
      logger.error('Failed to store K-line data to MySQL', error);
      throw error;
    }
  }

  /**
   * 构建缓存键名，用于标识特定的历史数据请求
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   * @param limit - 数据条数限制
   */
  private build_cache_key(
    symbol: string,
    interval: string,
    start_time?: number,
    end_time?: number,
    limit?: number
  ): string {
    const parts = ['historical', symbol, interval];

    if (start_time) {
      parts.push(`start_${start_time}`);
    }

    if (end_time) {
      parts.push(`end_${end_time}`);
    }

    if (limit) {
      parts.push(`limit_${limit}`);
    }

    return parts.join(':');
  }

  /**
   * 获取指定币种的最新K线数据
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param limit - 数据条数限制
   */
  async get_latest_klines(symbol: string, interval: string, limit: number = 100): Promise<KlineData[]> {
    try {
      // 获取最新数据，不使用时间范围
      return await this.get_historical_klines(symbol, interval, undefined, undefined, limit);
    } catch (error) {
      logger.error(`Failed to get latest klines for ${symbol}:${interval}`, error);
      throw error;
    }
  }

  /**
   * 按时间范围获取K线数据
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   */
  async get_klines_by_time_range(
    symbol: string,
    interval: string,
    start_time: number,
    end_time: number
  ): Promise<KlineData[]> {
    try {
      // 计算需要获取的数据量
      const interval_ms = this.get_interval_milliseconds(interval);
      const estimated_count = Math.ceil((end_time - start_time) / interval_ms);
      const limit = Math.min(estimated_count, 1000);

      return await this.get_historical_klines(symbol, interval, start_time, end_time, limit);
    } catch (error) {
      logger.error(`Failed to get klines by time range for ${symbol}:${interval}`, error);
      throw error;
    }
  }

  /**
   * 将K线时间间隔字符串转换为毫秒数
   * @param interval - K线时间间隔（如: 1m, 5m, 1h）
   */
  private get_interval_milliseconds(interval: string): number {
    const interval_map: { [key: string]: number } = {
      '1m': 60 * 1000,
      '3m': 3 * 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '2h': 2 * 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '8h': 8 * 60 * 60 * 1000,
      '12h': 12 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
      '3d': 3 * 24 * 60 * 60 * 1000,
      '1w': 7 * 24 * 60 * 60 * 1000,
      '1mo': 30 * 24 * 60 * 60 * 1000
    };

    return interval_map[interval] || 60 * 1000; // 默认1分钟
  }

  /**
   * 清理过期的缓存数据（数据库和Redis）
   */
  async cleanup_expired_cache(): Promise<void> {
    try {
      // 清理数据库中过期的缓存记录
      const deleted_count = await this.cache_repository.delete_expired();

      // 清理Redis中的过期键
      const pattern = 'historical:*';
      const keys = await this.redis!.keys(pattern);
      let redis_deleted = 0;

      for (const key of keys) {
        const ttl = await this.redis!.ttl(key);
        if (ttl === -2) { // 键不存在
          redis_deleted++;
        } else if (ttl === -1) { // 键存在但没有过期时间
          await this.redis!.expire(key, this.CACHE_EXPIRE_HOURS * 3600);
        }
      }

      logger.info(`Cache cleanup completed: ${deleted_count} database records, checked ${keys.length} Redis keys`);

    } catch (error) {
      logger.error('Failed to cleanup expired cache', error);
    }
  }

  /**
   * 获取缓存统计信息，包括数据库和Redis的缓存状况
   */
  async get_cache_statistics(): Promise<any> {
    try {
      const db_stats = await this.cache_repository.get_statistics();
      const redis_pattern = 'historical:*';
      const redis_keys = await this.redis!.keys(redis_pattern);

      return {
        database: db_stats,
        redis_cached_keys: redis_keys.length,
        cache_expire_hours: this.CACHE_EXPIRE_HOURS
      };

    } catch (error) {
      logger.error('Failed to get cache statistics', error);
      return null;
    }
  }

  /**
   * 预加载热门币种的历史数据，提高首次访问速度
   */
  async preload_popular_symbols(): Promise<void> {
    try {
      const popular_symbols = ['BTCUSDT', 'ETHUSDT'];
      const intervals = ['1m', '5m', '15m', '1h', '4h', '1d'];

      logger.info('Starting preload of popular symbols...');

      for (const symbol of popular_symbols) {
        for (const interval of intervals) {
          try {
            await this.get_latest_klines(symbol, interval, 200);
            await new Promise(resolve => setTimeout(resolve, 100)); // 避免API限制
          } catch (error) {
            logger.error(`Failed to preload ${symbol}:${interval}`, error);
          }
        }
      }

      logger.info('Popular symbols preload completed');

    } catch (error) {
      logger.error('Failed to preload popular symbols', error);
    }
  }

  /**
   * 检查缓存中的数据是否足够满足需求
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param required_count - 需要的数据条数
   */
  async is_data_sufficient(symbol: string, interval: string, required_count: number = 100): Promise<boolean> {
    try {
      const cache_key = this.build_cache_key(symbol, interval, undefined, undefined, required_count);
      const cached = await this.redis!.get(cache_key);

      if (cached) {
        const data = JSON.parse(cached) as KlineData[];
        return data.length >= required_count;
      }

      return false;
    } catch (error) {
      logger.error(`Failed to check data sufficiency for ${symbol}:${interval}`, error);
      return false;
    }
  }

  /**
   * 强制刷新指定币种的缓存数据，删除旧数据并重新获取
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   */
  async force_refresh_cache(symbol: string, interval: string): Promise<KlineData[]> {
    try {
      // 删除相关缓存
      const pattern = `historical:${symbol}:${interval}*`;
      const keys = await this.redis!.keys(pattern);

      if (keys.length > 0) {
        await this.redis!.del(keys);
      }

      // 删除数据库缓存记录
      await this.cache_repository.delete_by_symbol_interval(symbol, interval);

      // 重新获取数据
      return await this.get_latest_klines(symbol, interval, 500);

    } catch (error) {
      logger.error(`Failed to force refresh cache for ${symbol}:${interval}`, error);
      throw error;
    }
  }

  /**
   * 回溯补全历史K线数据（向前补充）
   * @param symbol 币种符号
   * @param interval 时间周期
   * @param batch_size 每批拉取数量（默认1000）
   * @returns 回溯结果
   */
  async backfill_klines(
    symbol: string,
    interval: string,
    batch_size: number = 1000
  ): Promise<{
    success: boolean;
    mode: 'initial_load' | 'backfill';
    fetched_count: number;
    time_range?: {
      start: string;
      end: string;
    };
    database_status: {
      earliest_before: string | null;
      earliest_after: string | null;
      total_records: number;
    };
    message: string;
  }> {
    try {
      // 1. 查询数据库最早时间
      const earliest_time = await this.kline_repository.get_earliest_kline_time(symbol, interval);

      // 2. 如果数据库为空，拉取最新数据作为起点
      if (!earliest_time) {
        logger.info(`[Backfill] No existing data for ${symbol}:${interval}, fetching latest data`);

        const latest_data = await this.binance_api.get_klines(
          symbol,
          interval,
          undefined,
          undefined,
          batch_size
        );

        // 存储到MySQL
        if (latest_data.length > 0) {
          await this.kline_repository.batch_insert(latest_data);
        }

        const total_records = await this.kline_repository.get_total_count(symbol, interval);

        return {
          success: true,
          mode: 'initial_load',
          fetched_count: latest_data.length,
          time_range: latest_data.length > 0 ? {
            start: new Date(latest_data[0].open_time).toISOString(),
            end: new Date(latest_data[latest_data.length - 1].close_time).toISOString()
          } : undefined,
          database_status: {
            earliest_before: null,
            earliest_after: latest_data[0] ? new Date(latest_data[0].open_time).toISOString() : null,
            total_records
          },
          message: `初始加载${latest_data.length}根K线数据`
        };
      }

      // 3. 计算回溯时间范围
      const interval_ms = this.get_interval_milliseconds(interval);
      const end_time = earliest_time - 1; // 最早时间之前1毫秒
      const start_time = end_time - (batch_size * interval_ms);

      logger.info(`[Backfill] ${symbol}:${interval} - Fetching from ${new Date(start_time).toISOString()} to ${new Date(end_time).toISOString()}`);

      // 4. 调用币安API获取历史数据
      const historical_data = await this.binance_api.get_klines(
        symbol,
        interval,
        start_time,
        end_time,
        batch_size
      );

      // 5. 存储到MySQL
      if (historical_data.length > 0) {
        await this.kline_repository.batch_insert(historical_data);
      }

      // 6. 获取更新后的统计信息
      const total_records = await this.kline_repository.get_total_count(symbol, interval);
      const new_earliest = historical_data.length > 0 ? historical_data[0].open_time : earliest_time;

      return {
        success: true,
        mode: 'backfill',
        fetched_count: historical_data.length,
        time_range: historical_data.length > 0 ? {
          start: new Date(start_time).toISOString(),
          end: new Date(end_time).toISOString()
        } : undefined,
        database_status: {
          earliest_before: new Date(earliest_time).toISOString(),
          earliest_after: new Date(new_earliest).toISOString(),
          total_records
        },
        message: `成功向前补全${historical_data.length}根K线数据`
      };

    } catch (error) {
      logger.error(`Failed to backfill klines for ${symbol}:${interval}`, error);
      throw error;
    }
  }
}