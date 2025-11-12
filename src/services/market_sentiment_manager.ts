/**
 * 市场情绪数据管理器
 * 负责获取、缓存和管理市场情绪指标数据
 */

import { BinanceFuturesAPI } from '../api/binance_futures_api';
import { CacheManager } from '../core/cache/cache_manager';
import { MarketSentimentData } from '../types/oi_types';
import { logger } from '../utils/logger';

export class MarketSentimentManager {
  private binance_api: BinanceFuturesAPI;
  private cache_manager: CacheManager | null;
  private readonly cache_ttl = 300; // 5分钟缓存
  private readonly cache_key_prefix = 'sentiment';

  constructor(binance_api: BinanceFuturesAPI, cache_manager?: CacheManager) {
    this.binance_api = binance_api;
    this.cache_manager = cache_manager || null;
  }

  /**
   * 获取市场情绪数据（带缓存）
   * @param symbol 交易对符号
   * @param period 时间周期，默认5m
   * @param force_refresh 是否强制刷新（忽略缓存）
   */
  async get_sentiment_data(
    symbol: string,
    period: string = '5m',
    force_refresh: boolean = false
  ): Promise<MarketSentimentData | null> {
    const cache_key = `${this.cache_key_prefix}:${symbol}:${period}`;

    // 1. 尝试从缓存获取
    if (!force_refresh && this.cache_manager) {
      try {
        const cached_data = await this.cache_manager.get(cache_key);
        if (cached_data) {
          const sentiment_data = JSON.parse(cached_data) as MarketSentimentData;
          const cache_age = Date.now() - sentiment_data.fetched_at;

          // 如果缓存未过期，直接返回
          if (cache_age < this.cache_ttl * 1000) {
            logger.debug(`[SentimentManager] Using cached sentiment for ${symbol} (age: ${Math.floor(cache_age / 1000)}s)`);
            return sentiment_data;
          }
        }
      } catch (error) {
        logger.warn(`[SentimentManager] Failed to get cached sentiment for ${symbol}:`, error);
      }
    }

    // 2. 缓存未命中或已过期，调用API获取新数据
    try {
      logger.debug(`[SentimentManager] Fetching fresh sentiment data for ${symbol}...`);

      // 并行调用4个API接口
      const [
        top_position_ratio,
        top_account_ratio,
        global_account_ratio,
        taker_volume
      ] = await Promise.all([
        this.binance_api.get_top_long_short_position_ratio(symbol, period, 1),
        this.binance_api.get_top_long_short_account_ratio(symbol, period, 1),
        this.binance_api.get_global_long_short_account_ratio(symbol, period, 1),
        this.binance_api.get_taker_buy_sell_volume(symbol, period, 1)
      ]);

      // 检查是否所有API都返回了数据
      if (
        !top_position_ratio[0] ||
        !top_account_ratio[0] ||
        !global_account_ratio[0] ||
        !taker_volume[0]
      ) {
        logger.warn(`[SentimentManager] Incomplete sentiment data for ${symbol}`);
        return null;
      }

      // 3. 构建情绪数据对象
      const sentiment_data: MarketSentimentData = {
        symbol,
        top_trader_long_short_ratio: parseFloat(top_position_ratio[0].longShortRatio),
        top_account_long_short_ratio: parseFloat(top_account_ratio[0].longShortRatio),
        global_long_short_ratio: parseFloat(global_account_ratio[0].longShortRatio),
        taker_buy_sell_ratio: parseFloat(taker_volume[0].buySellRatio),
        timestamp: top_position_ratio[0].timestamp,
        fetched_at: Date.now()
      };

      // 4. 存入缓存
      if (this.cache_manager) {
        try {
          await this.cache_manager.set(
            cache_key,
            JSON.stringify(sentiment_data),
            this.cache_ttl
          );
          logger.debug(`[SentimentManager] Cached sentiment for ${symbol} (TTL: ${this.cache_ttl}s)`);
        } catch (error) {
          logger.warn(`[SentimentManager] Failed to cache sentiment for ${symbol}:`, error);
        }
      }

      logger.info(`[SentimentManager] ✅ ${symbol} - TopTrader: ${sentiment_data.top_trader_long_short_ratio.toFixed(4)}, TopAccount: ${sentiment_data.top_account_long_short_ratio.toFixed(4)}, Global: ${sentiment_data.global_long_short_ratio.toFixed(4)}, Taker: ${sentiment_data.taker_buy_sell_ratio.toFixed(4)}`);

      return sentiment_data;

    } catch (error: any) {
      logger.error(`[SentimentManager] Failed to fetch sentiment for ${symbol}:`, error.message);
      return null;
    }
  }

  /**
   * 批量获取多个币种的情绪数据
   * @param symbols 交易对符号数组
   * @param period 时间周期
   */
  async get_batch_sentiment_data(
    symbols: string[],
    period: string = '5m'
  ): Promise<Map<string, MarketSentimentData>> {
    const result_map = new Map<string, MarketSentimentData>();

    // 并发获取所有币种的情绪数据（使用Promise.allSettled避免一个失败影响全部）
    const results = await Promise.allSettled(
      symbols.map(symbol => this.get_sentiment_data(symbol, period))
    );

    // 处理结果
    results.forEach((result, index) => {
      const symbol = symbols[index];
      if (result.status === 'fulfilled' && result.value) {
        result_map.set(symbol, result.value);
      } else {
        logger.warn(`[SentimentManager] Failed to get sentiment for ${symbol}`);
      }
    });

    logger.info(`[SentimentManager] Fetched sentiment for ${result_map.size}/${symbols.length} symbols`);
    return result_map;
  }

  /**
   * 清除指定币种的缓存
   */
  async clear_cache(symbol: string, period: string = '5m'): Promise<void> {
    if (!this.cache_manager) return;

    const cache_key = `${this.cache_key_prefix}:${symbol}:${period}`;
    try {
      await this.cache_manager.del(cache_key);
      logger.debug(`[SentimentManager] Cleared cache for ${symbol}`);
    } catch (error) {
      logger.warn(`[SentimentManager] Failed to clear cache for ${symbol}:`, error);
    }
  }

  /**
   * 清除所有情绪数据缓存
   */
  async clear_all_cache(): Promise<void> {
    if (!this.cache_manager) return;

    try {
      // Redis keys pattern
      const pattern = `${this.cache_key_prefix}:*`;
      await this.cache_manager.deletePattern(pattern);
      logger.info(`[SentimentManager] Cleared all sentiment cache`);
    } catch (error) {
      logger.warn(`[SentimentManager] Failed to clear all cache:`, error);
    }
  }

  /**
   * 获取缓存统计信息
   */
  get_cache_config(): { ttl: number; prefix: string } {
    return {
      ttl: this.cache_ttl,
      prefix: this.cache_key_prefix
    };
  }
}
