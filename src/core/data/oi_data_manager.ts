import { OIPollingService } from '../../services/oi_polling_service';
import { OIRepository } from '../../database/oi_repository';
import { BinanceFuturesAPI } from '../../api/binance_futures_api';
import { OIRoutes } from '../../api/routes/oi_routes';
import { OICacheManager } from '../cache/oi_cache_manager';
import { daily_table_manager } from '../../database/daily_table_manager';
import { Router } from 'express';
import { logger } from '../../utils/logger';
import { BusinessError, DatabaseError, APIError } from '../../utils/errors';

/**
 * OI数据管理器 - 统一管理OI相关功能
 */
export class OIDataManager {
  private oi_polling_service: OIPollingService;
  private oi_repository: OIRepository;
  private binance_api: BinanceFuturesAPI;
  private oi_routes: OIRoutes;
  private oi_cache_manager: OICacheManager;

  private is_initialized = false;

  constructor() {
    this.oi_cache_manager = new OICacheManager();
    this.oi_repository = new OIRepository();
    this.binance_api = new BinanceFuturesAPI();
    this.oi_polling_service = new OIPollingService();
    this.oi_routes = new OIRoutes(this.oi_polling_service);
  }

  /**
   * 初始化OI数据管理器
   */
  async initialize(): Promise<void> {
    if (this.is_initialized) {
      logger.debug('[OIDataManager] Already initialized');
      return;
    }

    try {
      logger.info('[OIDataManager] Initializing OI data management system...');

      // 初始化日期分表管理器（创建今天和明天的表）
      await daily_table_manager.initialize();

      // 启动定时清理任务（每天凌晨1点清理旧表）
      daily_table_manager.start_cleanup_scheduler();

      // 初始化缓存管理器
      await this.oi_cache_manager.initialize();

      // 将缓存管理器传递给各组件
      this.oi_repository.set_cache_manager(this.oi_cache_manager);
      this.oi_polling_service.set_cache_manager(this.oi_cache_manager);

      // 初始化情绪数据管理器
      const cache_manager = new (await import('../cache/cache_manager')).CacheManager();
      await cache_manager.initialize();
      this.oi_polling_service.initialize_sentiment_manager(cache_manager);

      // 测试数据库连接
      await this.test_database_connection();

      // 跳过币安API连接测试，在实际使用时再检查
      // await this.test_binance_api_connection();

      this.is_initialized = true;
      logger.info('[OIDataManager] Initialization completed successfully');
    } catch (error) {
      logger.error('[OIDataManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * 启动OI监控服务
   */
  async start_monitoring(): Promise<void> {
    if (!this.is_initialized) {
      throw new BusinessError('OIDataManager not initialized. Call initialize() first.');
    }

    try {
      await this.oi_polling_service.start();
      logger.info('[OIDataManager] OI monitoring service started');
    } catch (error) {
      logger.error('[OIDataManager] Failed to start monitoring service:', error);
      throw error;
    }
  }

  /**
   * 停止OI监控服务
   */
  async stop_monitoring(): Promise<void> {
    try {
      await this.oi_polling_service.stop();
      logger.info('[OIDataManager] OI monitoring service stopped');
    } catch (error) {
      logger.error('[OIDataManager] Failed to stop monitoring service:', error);
      throw error;
    }
  }

  /**
   * 获取API路由
   */
  get_api_routes(): Router {
    return this.oi_routes.get_router();
  }

  /**
   * 获取缓存管理器
   */
  get_cache_manager(): OICacheManager {
    return this.oi_cache_manager;
  }

  /**
   * 获取OI统计数据
   */
  async get_statistics(symbol?: string) {
    return await this.oi_repository.get_oi_statistics(symbol);
  }

  /**
   * 获取最新快照数据
   */
  async get_latest_snapshot(symbol: string) {
    return await this.oi_repository.get_latest_snapshot(symbol);
  }

  /**
   * 获取启用的币种列表
   */
  async get_enabled_symbols() {
    return await this.oi_repository.get_enabled_symbols();
  }

  /**
   * 获取服务状态
   */
  get_service_status() {
    return {
      is_initialized: this.is_initialized,
      polling_service_status: this.oi_polling_service.get_status(),
      api_stats: this.binance_api.get_api_stats()
    };
  }

  /**
   * 手动刷新币种列表
   */
  async refresh_symbols(): Promise<void> {
    try {
      const latest_symbols = await this.binance_api.get_usdt_perpetual_symbols();
      await this.oi_repository.save_symbol_configs(latest_symbols);
      logger.info(`[OIDataManager] Symbol list refreshed: ${latest_symbols.length} symbols`);
    } catch (error) {
      logger.error('[OIDataManager] Failed to refresh symbols:', error);
      throw error;
    }
  }

  /**
   * 手动获取OI数据
   */
  async get_manual_oi_data(symbols: string[]) {
    try {
      return await this.binance_api.get_batch_open_interest(symbols);
    } catch (error) {
      logger.error('[OIDataManager] Failed to get manual OI data:', error);
      throw error;
    }
  }

  /**
   * 清理过期数据
   */
  async cleanup_old_data(days_to_keep: number = 30): Promise<void> {
    try {
      await this.oi_repository.cleanup_old_data(days_to_keep);
      logger.info(`[OIDataManager] Cleaned up data older than ${days_to_keep} days`);
    } catch (error) {
      logger.error('[OIDataManager] Failed to cleanup old data:', error);
      throw error;
    }
  }

  /**
   * 更新监控配置
   */
  async update_monitoring_config(key: string, value: any): Promise<void> {
    try {
      await this.oi_polling_service.update_config(key, value);
      logger.info(`[OIDataManager] Updated config ${key}:`, value);
    } catch (error) {
      logger.error(`[OIDataManager] Failed to update config ${key}:`, error);
      throw error;
    }
  }

  /**
   * 测试数据库连接
   */
  private async test_database_connection(): Promise<void> {
    try {
      const test_configs = await this.oi_repository.get_monitoring_config();
      logger.info('[OIDataManager] Database connection test passed');
    } catch (error) {
      logger.error('[OIDataManager] Database connection test failed:', error);
      throw new DatabaseError('Database connection failed', error);
    }
  }

  /**
   * 测试币安API连接
   */
  private async test_binance_api_connection(): Promise<void> {
    try {
      const is_connected = await this.binance_api.ping();
      if (!is_connected) {
        throw new APIError('Binance API ping failed');
      }
      logger.info('[OIDataManager] Binance API connection test passed');
    } catch (error) {
      logger.error('[OIDataManager] Binance API connection test failed:', error);
      throw new APIError('Binance API connection failed', undefined, undefined, error);
    }
  }

  /**
   * 获取系统健康状态
   */
  async get_health_status(): Promise<any> {
    const status = {
      is_initialized: this.is_initialized,
      database_healthy: false,
      api_healthy: false,
      service_running: false,
      timestamp: new Date().toISOString()
    };

    try {
      // 检查数据库健康状态
      await this.oi_repository.get_monitoring_config();
      status.database_healthy = true;
    } catch (error) {
      logger.error('[OIDataManager] Database health check failed:', error);
    }

    try {
      // 检查API健康状态 (可选，避免初始化时的连接问题)
      status.api_healthy = await this.binance_api.ping();
    } catch (error) {
      logger.warn('[OIDataManager] API health check skipped due to connection issues');
      status.api_healthy = false;
    }

    try {
      // 检查服务运行状态
      const service_status = this.oi_polling_service.get_status();
      status.service_running = service_status.is_running;
    } catch (error) {
      logger.error('[OIDataManager] Service health check failed:', error);
    }

    return status;
  }

  /**
   * 销毁管理器
   */
  async destroy(): Promise<void> {
    try {
      await this.stop_monitoring();
      this.is_initialized = false;
      logger.info('[OIDataManager] Destroyed successfully');
    } catch (error) {
      logger.error('[OIDataManager] Error during destruction:', error);
      throw error;
    }
  }
}