import { BaseStrategy } from './base_strategy';
import { StrategyConfig, StrategyType } from '../types/strategy_types';
import { StrategyRepository } from '@/database/quantitative/strategy_repository';
import { logger } from '@/utils/logger';

/**
 * 策略管理器
 * 负责策略的注册、创建和管理
 */
export class StrategyManager {
  private static instance: StrategyManager;
  private strategy_repository: StrategyRepository;
  private strategy_classes: Map<StrategyType, new (config: StrategyConfig) => BaseStrategy>;
  private active_strategies: Map<number, BaseStrategy>;

  private constructor() {
    this.strategy_repository = new StrategyRepository();
    this.strategy_classes = new Map();
    this.active_strategies = new Map();
  }

  /**
   * 获取单例实例
   */
  static get_instance(): StrategyManager {
    if (!StrategyManager.instance) {
      StrategyManager.instance = new StrategyManager();
    }
    return StrategyManager.instance;
  }

  /**
   * 注册策略类
   */
  register_strategy(
    type: StrategyType,
    strategy_class: new (config: StrategyConfig) => BaseStrategy
  ): void {
    this.strategy_classes.set(type, strategy_class);
    logger.info(`Registered strategy type: ${type}`);
  }

  /**
   * 创建策略实例
   */
  async create_strategy_instance(strategy_id: number): Promise<BaseStrategy> {
    // 检查是否已创建
    if (this.active_strategies.has(strategy_id)) {
      return this.active_strategies.get(strategy_id)!;
    }

    // 从数据库加载策略配置
    const config = await this.strategy_repository.find_by_id(strategy_id);
    if (!config) {
      throw new Error(`Strategy not found: ${strategy_id}`);
    }

    // 获取策略类
    const StrategyClass = this.strategy_classes.get(config.type);
    if (!StrategyClass) {
      throw new Error(`Strategy type not registered: ${config.type}`);
    }

    // 创建实例
    const strategy = new StrategyClass(config);
    this.active_strategies.set(strategy_id, strategy);

    logger.info(`Created strategy instance: ${config.name} (ID: ${strategy_id})`);
    return strategy;
  }

  /**
   * 获取策略实例
   */
  get_strategy_instance(strategy_id: number): BaseStrategy | null {
    return this.active_strategies.get(strategy_id) || null;
  }

  /**
   * 移除策略实例
   */
  remove_strategy_instance(strategy_id: number): void {
    this.active_strategies.delete(strategy_id);
    logger.info(`Removed strategy instance: ${strategy_id}`);
  }

  /**
   * 获取所有活跃策略
   */
  get_active_strategies(): BaseStrategy[] {
    return Array.from(this.active_strategies.values());
  }

  /**
   * 获取策略配置
   */
  async get_strategy_config(strategy_id: number): Promise<StrategyConfig | null> {
    return await this.strategy_repository.find_by_id(strategy_id);
  }

  /**
   * 获取所有策略配置
   */
  async get_all_strategy_configs(): Promise<StrategyConfig[]> {
    return await this.strategy_repository.find_all();
  }

  /**
   * 获取启用的策略配置
   */
  async get_enabled_strategy_configs(): Promise<StrategyConfig[]> {
    return await this.strategy_repository.find_enabled();
  }

  /**
   * 清理所有策略实例
   */
  clear_all(): void {
    this.active_strategies.clear();
    logger.info('Cleared all strategy instances');
  }
}
