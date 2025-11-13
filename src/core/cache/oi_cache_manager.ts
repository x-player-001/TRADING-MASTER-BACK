import { RedisClientType } from 'redis';
import { DatabaseConfig } from '../config/database';
import { ConfigManager } from '../config/config_manager';
import { logger } from '../../utils/logger';
import { ContractSymbolConfig, OpenInterestSnapshot, OIStatistics, OIAnomalyRecord, OIStatisticsQueryParams, OIAnomalyQueryParams } from '../../types/oi_types';

/**
 * OI数据Redis缓存管理器
 */
export class OICacheManager {
  private redis: RedisClientType | null = null;
  private ttl: any;
  private dedup_by_period: boolean;

  // 缓存键前缀
  private static readonly PREFIXES = {
    LATEST_OI: 'oi:latest:',           // 最新OI数据
    CONFIG: 'oi:config:',              // 监控配置
    SYMBOLS: 'oi:symbols:',            // 币种列表
    STATS: 'oi:stats:',                // 统计数据
    HISTORY: 'oi:history:',            // 历史数据(短期)
    ANOMALY_LATEST: 'anomaly:latest:'  // 最新异动记录（用于去重）
  };

  constructor() {
    // 从ConfigManager加载TTL配置
    const oi_config = ConfigManager.getInstance().get_oi_monitoring_config();
    this.ttl = oi_config.cache_ttl;
    this.dedup_by_period = oi_config.cache_ttl.dedup_by_period;

    logger.debug('[OICacheManager] TTL config loaded:', this.ttl);
  }

  /**
   * 初始化Redis连接
   */
  async initialize(): Promise<void> {
    if (!this.redis) {
      this.redis = await DatabaseConfig.get_redis_client();
      logger.cache('Redis connection initialized');
    }
  }

  /**
   * 获取Redis客户端
   */
  private async get_redis(): Promise<RedisClientType> {
    if (!this.redis) {
      await this.initialize();
    }
    return this.redis!;
  }

  // ===================== 最新OI数据缓存 =====================

  /**
   * 缓存最新OI数据
   */
  async cache_latest_oi(symbol: string, snapshot: OpenInterestSnapshot): Promise<void> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.LATEST_OI}${symbol}`;
    const value = JSON.stringify({
      open_interest: snapshot.open_interest,
      timestamp_ms: snapshot.timestamp_ms,
      snapshot_time: snapshot.snapshot_time
    });

    await redis.setEx(key, this.ttl.latest_oi, value);
  }

  /**
   * 获取最新OI数据
   */
  async get_latest_oi(symbol: string): Promise<OpenInterestSnapshot | null> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.LATEST_OI}${symbol}`;
    const value = await redis.get(key);

    if (!value) return null;

    try {
      const data = JSON.parse(value);
      return {
        symbol,
        open_interest: data.open_interest,
        timestamp_ms: data.timestamp_ms,
        snapshot_time: data.snapshot_time,
        data_source: 'cache'
      };
    } catch (error) {
      console.error(`[OICache] Failed to parse latest OI for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * 批量缓存最新OI数据
   */
  async batch_cache_latest_oi(snapshots: OpenInterestSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;

    const redis = await this.get_redis();
    const pipeline = redis.multi();

    for (const snapshot of snapshots) {
      const key = `${OICacheManager.PREFIXES.LATEST_OI}${snapshot.symbol}`;
      const value = JSON.stringify({
        open_interest: snapshot.open_interest,
        timestamp_ms: snapshot.timestamp_ms,
        snapshot_time: snapshot.snapshot_time
      });

      pipeline.setEx(key, this.ttl.latest_oi, value);
    }

    await pipeline.exec();
  }

  // ===================== 监控配置缓存 =====================

  /**
   * 缓存监控配置
   */
  async cache_config(key: string, value: any): Promise<void> {
    const redis = await this.get_redis();
    const cache_key = `${OICacheManager.PREFIXES.CONFIG}${key}`;
    await redis.setEx(cache_key, this.ttl.config, JSON.stringify(value));
  }

  /**
   * 获取监控配置
   */
  async get_config(key: string): Promise<any | null> {
    const redis = await this.get_redis();
    const cache_key = `${OICacheManager.PREFIXES.CONFIG}${key}`;
    const value = await redis.get(cache_key);

    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch (error) {
      console.error(`[OICache] Failed to parse config ${key}:`, error);
      return null;
    }
  }

  // ===================== 启用币种列表缓存 =====================

  /**
   * 缓存启用的币种列表
   */
  async cache_enabled_symbols(symbols: string[]): Promise<void> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.SYMBOLS}enabled`;
    await redis.setEx(key, this.ttl.symbols, JSON.stringify(symbols));
  }

  /**
   * 获取启用的币种列表
   */
  async get_enabled_symbols(): Promise<string[] | null> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.SYMBOLS}enabled`;
    const value = await redis.get(key);

    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch (error) {
      console.error('[OICache] Failed to parse enabled symbols:', error);
      return null;
    }
  }

  // ===================== 统计数据缓存 =====================


  // ===================== 历史数据缓存(短期) =====================

  /**
   * 添加历史OI值用于变化率计算
   */
  async add_history_value(symbol: string, period_seconds: number, value: number): Promise<void> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.HISTORY}${symbol}:${period_seconds}s`;
    const ttl = period_seconds <= 120 ? this.ttl.history_1m : this.ttl.history_5m;

    // 使用列表存储，保持时间顺序
    await redis.lPush(key, value.toString());
    await redis.lTrim(key, 0, 20); // 只保留最近20个值
    await redis.expire(key, ttl);
  }

  /**
   * 获取历史OI值
   */
  async get_history_values(symbol: string, period_seconds: number, count: number = 5): Promise<number[]> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.HISTORY}${symbol}:${period_seconds}s`;
    const values = await redis.lRange(key, 0, count - 1);

    return values.map(v => parseFloat(v)).filter(v => !isNaN(v));
  }

  // ===================== 异动记录缓存（用于去重） =====================

  /**
   * 缓存最新异动记录（用于去重检测）
   */
  async cache_latest_anomaly(symbol: string, period_seconds: number, percent_change: number): Promise<void> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.ANOMALY_LATEST}${symbol}:${period_seconds}`;

    // 根据配置选择TTL策略
    let ttl: number;
    if (this.dedup_by_period) {
      // 按周期时间过期: 1分钟周期=60秒, 5分钟=300秒, 15分钟=900秒
      ttl = period_seconds;
    } else {
      // 固定时间过期(旧逻辑)
      if (period_seconds <= 120) {
        ttl = 120;   // 1-2分钟周期: 2分钟
      } else if (period_seconds <= 300) {
        ttl = 300;   // 5分钟周期: 5分钟
      } else {
        ttl = 900;  // 15分钟周期: 15分钟
      }
    }

    const cache_value = {
      percent_change,
      timestamp: Date.now()
    };

    await redis.setEx(key, ttl, JSON.stringify(cache_value));
    logger.debug(`[OICacheManager] Cached anomaly: ${symbol} ${period_seconds}s, TTL: ${ttl}s (dedup_by_period: ${this.dedup_by_period})`);
  }

  /**
   * 获取最新异动记录缓存（用于去重检测）
   * @returns 返回 percent_change 或 null（缓存不存在）
   */
  async get_latest_anomaly(symbol: string, period_seconds: number): Promise<number | null> {
    const redis = await this.get_redis();
    const key = `${OICacheManager.PREFIXES.ANOMALY_LATEST}${symbol}:${period_seconds}`;
    const cached = await redis.get(key);

    if (!cached) {
      return null;
    }

    try {
      const cache_value = JSON.parse(cached);
      return cache_value.percent_change;
    } catch (error) {
      logger.error(`[OICacheManager] Failed to parse anomaly cache for ${symbol}:${period_seconds}`, error);
      return null;
    }
  }

  // ===================== 缓存管理 =====================

  /**
   * 清理过期缓存
   */
  async cleanup_expired_cache(): Promise<void> {
    const redis = await this.get_redis();
    const patterns = [
      `${OICacheManager.PREFIXES.LATEST_OI}*`,
      `${OICacheManager.PREFIXES.STATS}*`,
      `${OICacheManager.PREFIXES.HISTORY}*`
    ];

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        // Redis会自动清理过期键，这里只是日志记录
        console.log(`[OICache] Found ${keys.length} keys matching pattern: ${pattern}`);
      }
    }
  }

  /**
   * 缓存OI统计数据（只缓存当天数据）
   */
  async cache_statistics(params: OIStatisticsQueryParams, stats: OIStatistics[]): Promise<void> {
    // 只缓存当天的数据
    if (!this.is_today(params.date)) {
      return;
    }

    const cache_key = this.generate_stats_cache_key(params);
    const redis = await this.get_redis();

    const cache_data = {
      data: stats,
      cached_at: new Date().toISOString(),
      params: params
    };

    await redis.setEx(cache_key, this.ttl.stats, JSON.stringify(cache_data));
    logger.debug(`[OICacheManager] Cached statistics: ${cache_key}, count: ${stats.length}, TTL: ${this.ttl.stats}s`);
  }

  /**
   * 获取OI统计数据缓存
   */
  async get_statistics(params: OIStatisticsQueryParams): Promise<OIStatistics[] | null> {
    // 只查询当天数据的缓存
    if (!this.is_today(params.date)) {
      return null;
    }

    const cache_key = this.generate_stats_cache_key(params);
    const redis = await this.get_redis();
    const cached = await redis.get(cache_key);

    if (cached) {
      const cache_data = JSON.parse(cached);
      logger.debug(`[OICacheManager] Cache hit for statistics: ${cache_key}`);
      return cache_data.data;
    }

    return null;
  }

  /**
   * 缓存异动记录数据（只缓存当天数据）
   */
  async cache_anomalies(params: OIAnomalyQueryParams, anomalies: OIAnomalyRecord[]): Promise<void> {
    // 只缓存当天的数据
    if (!this.is_today(params.date)) {
      return;
    }

    const cache_key = this.generate_anomalies_cache_key(params);
    const redis = await this.get_redis();

    const cache_data = {
      data: anomalies,
      cached_at: new Date().toISOString(),
      params: params
    };

    await redis.setEx(cache_key, this.ttl.anomalies, JSON.stringify(cache_data));
    logger.debug(`[OICacheManager] Cached anomalies: ${cache_key}, count: ${anomalies.length}, TTL: ${this.ttl.anomalies}s`);
  }

  /**
   * 获取异动记录数据缓存
   */
  async get_anomalies(params: OIAnomalyQueryParams): Promise<OIAnomalyRecord[] | null> {
    // 只查询当天数据的缓存
    if (!this.is_today(params.date)) {
      return null;
    }

    const cache_key = this.generate_anomalies_cache_key(params);
    const redis = await this.get_redis();
    const cached = await redis.get(cache_key);

    if (cached) {
      const cache_data = JSON.parse(cached);
      logger.debug(`[OICacheManager] Cache hit for anomalies: ${cache_key}`);
      return cache_data.data;
    }

    return null;
  }

  /**
   * 判断是否为今天的日期
   */
  private is_today(date_string?: string): boolean {
    if (!date_string) {
      return true; // 没有指定日期，认为是查询最近数据，可以缓存
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return date_string === today;
  }

  /**
   * 生成统计数据缓存键
   * 优化：忽略symbol参数，统一缓存全部数据，由前端自行过滤
   */
  private generate_stats_cache_key(params: OIStatisticsQueryParams): string {
    const parts = [OICacheManager.PREFIXES.STATS];

    // ✅ 统一使用'all'，不再按币种分别缓存
    // 前端获取全部数据后自行过滤，避免缓存碎片化
    parts.push('all');

    if (params.date) {
      parts.push('date', params.date);
    } else {
      parts.push('recent');
    }

    return parts.join(':');
  }

  /**
   * 生成异动记录缓存键
   * 优化：完全简化，忽略symbol/severity/limit参数，统一缓存全部数据
   * 前端获取全部数据后自行过滤，最大化缓存命中率
   */
  private generate_anomalies_cache_key(params: OIAnomalyQueryParams): string {
    const parts = ['oi', 'anomalies'];

    // ✅ 统一使用'all'，不再按币种分别缓存
    parts.push('all');

    if (params.date) {
      parts.push('date', params.date);
    } else {
      parts.push('recent');
    }

    // ✅ 完全移除severity和limit参数，统一缓存键
    // 这样无论前端传什么参数，都能复用同一份缓存
    // 缓存中存储所有异动记录，由前端或Repository层过滤

    return parts.join(':');
  }

  /**
   * 获取缓存统计信息
   */
  async get_cache_stats(): Promise<any> {
    const redis = await this.get_redis();
    const info = await redis.info('memory');
    const keyspace = await redis.info('keyspace');

    return {
      memory_info: info,
      keyspace_info: keyspace,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 测试Redis连接
   */
  async ping(): Promise<boolean> {
    try {
      const redis = await this.get_redis();
      const result = await redis.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('[OICache] Redis ping failed:', error);
      return false;
    }
  }

  /**
   * 通用get方法（用于其他模块如MarketSentimentManager）
   */
  async get(key: string): Promise<string | null> {
    try {
      const redis = await this.get_redis();
      return await redis.get(key);
    } catch (error) {
      console.error(`[OICache] Failed to get key ${key}:`, error);
      return null;
    }
  }

  /**
   * 通用set方法（用于其他模块如MarketSentimentManager）
   */
  async set(key: string, value: string, ttl_seconds?: number): Promise<void> {
    try {
      const redis = await this.get_redis();
      if (ttl_seconds) {
        await redis.setEx(key, ttl_seconds, value);
      } else {
        await redis.set(key, value);
      }
    } catch (error) {
      console.error(`[OICache] Failed to set key ${key}:`, error);
    }
  }
}