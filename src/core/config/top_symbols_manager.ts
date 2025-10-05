import { TopSymbolsRepository } from '@/database/top_symbols_repository';
import { TopSymbolConfig } from '@/types/common';
import { logger } from '@/utils/logger';

/**
 * TOP币种配置管理器
 */
export class TopSymbolsManager {
  private static instance: TopSymbolsManager;
  private repository: TopSymbolsRepository;

  private constructor() {
    this.repository = new TopSymbolsRepository();
  }

  /**
   * 获取管理器单例实例
   */
  static get_instance(): TopSymbolsManager {
    if (!TopSymbolsManager.instance) {
      TopSymbolsManager.instance = new TopSymbolsManager();
    }
    return TopSymbolsManager.instance;
  }

  /**
   * 初始化管理器
   */
  async initialize(): Promise<void> {
    try {
      await this.repository.create_table();
      await this.repository.initialize_default_data();
      logger.info('TopSymbolsManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize TopSymbolsManager', error);
      throw error;
    }
  }

  /**
   * 获取所有TOP币种配置
   */
  async get_all_symbols(): Promise<TopSymbolConfig[]> {
    try {
      return await this.repository.get_all_symbols();
    } catch (error) {
      logger.error('Failed to get all TOP symbols', error);
      throw error;
    }
  }

  /**
   * 获取启用的TOP币种配置
   */
  async get_enabled_symbols(): Promise<TopSymbolConfig[]> {
    try {
      return await this.repository.get_enabled_symbols();
    } catch (error) {
      logger.error('Failed to get enabled TOP symbols', error);
      throw error;
    }
  }

  /**
   * 根据符号获取配置
   */
  async get_symbol_by_name(symbol: string): Promise<TopSymbolConfig | null> {
    try {
      return await this.repository.get_symbol_by_name(symbol);
    } catch (error) {
      logger.error(`Failed to get TOP symbol: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 创建币种配置
   */
  async create_symbol(config: Omit<TopSymbolConfig, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    try {
      // 验证订阅周期
      this.validate_subscription_intervals(config.subscription_intervals);

      const id = await this.repository.create_symbol(config);
      logger.info(`Created TOP symbol: ${config.symbol}`);
      return id;
    } catch (error) {
      logger.error(`Failed to create TOP symbol: ${config.symbol}`, error);
      throw error;
    }
  }

  /**
   * 更新币种配置
   */
  async update_symbol(symbol: string, updates: Partial<TopSymbolConfig>): Promise<void> {
    try {
      // 验证订阅周期
      if (updates.subscription_intervals) {
        this.validate_subscription_intervals(updates.subscription_intervals);
      }

      await this.repository.update_symbol(symbol, updates);
      logger.info(`Updated TOP symbol: ${symbol}`);
    } catch (error) {
      logger.error(`Failed to update TOP symbol: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 删除币种配置
   */
  async delete_symbol(symbol: string): Promise<void> {
    try {
      await this.repository.delete_symbol(symbol);
      logger.info(`Deleted TOP symbol: ${symbol}`);
    } catch (error) {
      logger.error(`Failed to delete TOP symbol: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 批量更新排序
   */
  async update_symbols_order(updates: Array<{ symbol: string; rank_order: number }>): Promise<void> {
    try {
      // 验证排序数据
      this.validate_rank_orders(updates);

      await this.repository.batch_update_order(updates);
      logger.info(`Updated ${updates.length} symbols order`);
    } catch (error) {
      logger.error('Failed to update symbols order', error);
      throw error;
    }
  }

  /**
   * 启用/禁用币种
   */
  async toggle_symbol_enabled(symbol: string, enabled: boolean): Promise<void> {
    try {
      await this.repository.update_symbol(symbol, { enabled });
      logger.info(`${enabled ? 'Enabled' : 'Disabled'} TOP symbol: ${symbol}`);
    } catch (error) {
      logger.error(`Failed to toggle TOP symbol: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 获取订阅流配置
   * 用于WebSocket订阅
   */
  async get_subscription_streams(): Promise<string[]> {
    try {
      const enabled_symbols = await this.get_enabled_symbols();
      const streams: string[] = [];

      for (const config of enabled_symbols) {
        const symbol_lower = config.symbol.toLowerCase();

        for (const interval of config.subscription_intervals) {
          // K线流
          streams.push(`${symbol_lower}@kline_${interval}`);

          // 为重要币种添加ticker流
          if (config.rank_order <= 5) {
            streams.push(`${symbol_lower}@ticker`);
          }
        }
      }

      logger.info(`Generated ${streams.length} subscription streams`);
      return streams;
    } catch (error) {
      logger.error('Failed to get subscription streams', error);
      throw error;
    }
  }

  /**
   * 获取统计信息
   */
  async get_statistics(): Promise<{
    total_symbols: number;
    enabled_symbols: number;
    total_streams: number;
    intervals_distribution: Record<string, number>;
  }> {
    try {
      const all_symbols = await this.get_all_symbols();
      const enabled_symbols = all_symbols.filter(s => s.enabled);

      const intervals_distribution: Record<string, number> = {};
      let total_streams = 0;

      for (const symbol of enabled_symbols) {
        for (const interval of symbol.subscription_intervals) {
          intervals_distribution[interval] = (intervals_distribution[interval] || 0) + 1;
          total_streams++;
        }
      }

      return {
        total_symbols: all_symbols.length,
        enabled_symbols: enabled_symbols.length,
        total_streams,
        intervals_distribution
      };
    } catch (error) {
      logger.error('Failed to get statistics', error);
      throw error;
    }
  }

  /**
   * 验证订阅周期
   */
  private validate_subscription_intervals(intervals: string[]): void {
    const valid_intervals = ['1m', '5m', '15m', '1h'];

    for (const interval of intervals) {
      if (!valid_intervals.includes(interval)) {
        throw new Error(`Invalid subscription interval: ${interval}. Valid intervals: ${valid_intervals.join(', ')}`);
      }
    }
  }

  /**
   * 验证排序数据
   */
  private validate_rank_orders(updates: Array<{ symbol: string; rank_order: number }>): void {
    const ranks = updates.map(u => u.rank_order);
    const unique_ranks = [...new Set(ranks)];

    if (ranks.length !== unique_ranks.length) {
      throw new Error('Duplicate rank orders found');
    }

    for (const rank of ranks) {
      if (rank < 1 || rank > 100) {
        throw new Error(`Invalid rank order: ${rank}. Must be between 1-100`);
      }
    }
  }
}