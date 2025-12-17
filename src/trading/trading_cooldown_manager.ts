/**
 * 交易冷却期管理器
 * 用于限制同一币种在指定时间内只能开仓一次
 */

import { RedisClientType } from 'redis';
import { DatabaseConfig } from '../core/config/database';
import { logger } from '../utils/logger';

export class TradingCooldownManager {
  private redis: RedisClientType | null = null;

  // 默认冷却时间: 6小时
  private cooldown_hours: number = 6;

  // Redis 键前缀
  private static readonly PREFIX = 'trading:cooldown:';

  constructor(cooldown_hours: number = 6) {
    this.cooldown_hours = cooldown_hours;
  }

  /**
   * 初始化 Redis 连接
   */
  async initialize(): Promise<void> {
    if (!this.redis) {
      this.redis = await DatabaseConfig.get_redis_client();
      logger.info(`[TradingCooldown] Initialized with ${this.cooldown_hours}h cooldown period`);
    }
  }

  /**
   * 获取 Redis 客户端
   */
  private async get_redis(): Promise<RedisClientType> {
    if (!this.redis) {
      await this.initialize();
    }
    return this.redis!;
  }

  /**
   * 检查币种是否在冷却期内
   * @returns { in_cooldown: boolean, remaining_minutes?: number, last_open_time?: number }
   */
  async check_cooldown(symbol: string): Promise<{
    in_cooldown: boolean;
    remaining_minutes?: number;
    last_open_time?: number;
  }> {
    try {
      const redis = await this.get_redis();
      const key = `${TradingCooldownManager.PREFIX}${symbol}`;
      const value = await redis.get(key);

      if (!value) {
        return { in_cooldown: false };
      }

      const last_open_time = parseInt(value, 10);
      const elapsed_ms = Date.now() - last_open_time;
      const cooldown_ms = this.cooldown_hours * 3600 * 1000;

      if (elapsed_ms < cooldown_ms) {
        const remaining_ms = cooldown_ms - elapsed_ms;
        const remaining_minutes = Math.ceil(remaining_ms / 60000);

        return {
          in_cooldown: true,
          remaining_minutes,
          last_open_time
        };
      }

      // 冷却期已过，但 key 还没过期（理论上不会发生，但处理一下）
      return { in_cooldown: false };

    } catch (error) {
      logger.error(`[TradingCooldown] Failed to check cooldown for ${symbol}:`, error);
      // 出错时不阻止交易
      return { in_cooldown: false };
    }
  }

  /**
   * 记录开仓时间，开始冷却期
   */
  async record_open_position(symbol: string): Promise<void> {
    try {
      const redis = await this.get_redis();
      const key = `${TradingCooldownManager.PREFIX}${symbol}`;
      const ttl_seconds = this.cooldown_hours * 3600;

      await redis.setEx(key, ttl_seconds, Date.now().toString());

      logger.info(`[TradingCooldown] Recorded open position for ${symbol}, cooldown ${this.cooldown_hours}h`);

    } catch (error) {
      logger.error(`[TradingCooldown] Failed to record cooldown for ${symbol}:`, error);
    }
  }

  /**
   * 手动清除币种的冷却状态（测试或特殊情况使用）
   */
  async clear_cooldown(symbol: string): Promise<boolean> {
    try {
      const redis = await this.get_redis();
      const key = `${TradingCooldownManager.PREFIX}${symbol}`;
      await redis.del(key);

      logger.info(`[TradingCooldown] Cleared cooldown for ${symbol}`);
      return true;

    } catch (error) {
      logger.error(`[TradingCooldown] Failed to clear cooldown for ${symbol}:`, error);
      return false;
    }
  }

  /**
   * 获取所有正在冷却的币种
   */
  async get_all_cooldowns(): Promise<Array<{
    symbol: string;
    last_open_time: number;
    remaining_minutes: number;
  }>> {
    try {
      const redis = await this.get_redis();
      const pattern = `${TradingCooldownManager.PREFIX}*`;
      const keys = await redis.keys(pattern);

      const cooldowns: Array<{
        symbol: string;
        last_open_time: number;
        remaining_minutes: number;
      }> = [];

      const cooldown_ms = this.cooldown_hours * 3600 * 1000;

      for (const key of keys) {
        const symbol = key.replace(TradingCooldownManager.PREFIX, '');
        const value = await redis.get(key);

        if (value) {
          const last_open_time = parseInt(value, 10);
          const elapsed_ms = Date.now() - last_open_time;
          const remaining_ms = cooldown_ms - elapsed_ms;

          if (remaining_ms > 0) {
            cooldowns.push({
              symbol,
              last_open_time,
              remaining_minutes: Math.ceil(remaining_ms / 60000)
            });
          }
        }
      }

      return cooldowns;

    } catch (error) {
      logger.error('[TradingCooldown] Failed to get all cooldowns:', error);
      return [];
    }
  }

  /**
   * 设置冷却时间（小时）
   */
  set_cooldown_hours(hours: number): void {
    this.cooldown_hours = hours;
    logger.info(`[TradingCooldown] Cooldown period updated to ${hours}h`);
  }

  /**
   * 获取当前冷却时间配置
   */
  get_cooldown_hours(): number {
    return this.cooldown_hours;
  }
}
