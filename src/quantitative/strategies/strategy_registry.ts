import { StrategyManager } from './strategy_manager';
import { StrategyType } from '../types/strategy_types';
import { BreakoutStrategy } from './implementations/breakout_strategy';
import { TrendFollowingStrategy } from './implementations/trend_following_strategy';
import { logger } from '@/utils/logger';

/**
 * 策略注册表
 * 在应用启动时注册所有可用策略
 */
export class StrategyRegistry {
  private static is_initialized: boolean = false;

  /**
   * 注册所有策略
   */
  static initialize(): void {
    if (this.is_initialized) {
      logger.warn('[StrategyRegistry] Already initialized');
      return;
    }

    const strategy_manager = StrategyManager.get_instance();

    try {
      // 注册突破策略
      strategy_manager.register_strategy(StrategyType.BREAKOUT, BreakoutStrategy);
      logger.info('[StrategyRegistry] Registered strategy: breakout');

      // 注册趋势跟踪策略
      strategy_manager.register_strategy(StrategyType.TREND_FOLLOWING, TrendFollowingStrategy);
      logger.info('[StrategyRegistry] Registered strategy: trend_following');

      this.is_initialized = true;
      logger.info('[StrategyRegistry] All strategies registered successfully');
    } catch (error) {
      logger.error('[StrategyRegistry] Failed to register strategies', error);
      throw error;
    }
  }

  /**
   * 检查是否已初始化
   */
  static is_ready(): boolean {
    return this.is_initialized;
  }
}
