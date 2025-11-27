import dotenv from 'dotenv';
import {
  SymbolConfigManager,
  HistoricalDataManager
} from '@/core/data';
import { OIDataManager } from '@/core/data/oi_data_manager';
import { APIServer } from '@/api/api_server';
import { logger, LogLevel } from '@/utils/logger';
import { DatabaseConfig } from '@/core/config/database';
import { ConfigManager } from '@/core/config/config_manager';
import { MonitoringManager } from '@/core/monitoring/monitoring_manager';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';

// 加载环境变量
dotenv.config();

// 初始化配置管理器
const config_manager = ConfigManager.getInstance();
config_manager.initialize();

/**
 * 仅API服务模式
 * 不启动OI监控，只提供API查询功能
 */
class APIOnlyApp {
  private symbol_config_manager: SymbolConfigManager;
  private historical_data_manager: HistoricalDataManager;
  private oi_data_manager: OIDataManager;
  private api_server: APIServer;
  private monitoring_manager: MonitoringManager;
  private top_symbols_manager: TopSymbolsManager;

  constructor() {
    this.symbol_config_manager = SymbolConfigManager.getInstance();
    this.historical_data_manager = HistoricalDataManager.getInstance();
    this.oi_data_manager = new OIDataManager();
    this.monitoring_manager = MonitoringManager.getInstance();
    this.top_symbols_manager = TopSymbolsManager.get_instance();

    const server_config = config_manager.get_server_config();
    this.api_server = new APIServer(this.oi_data_manager, server_config.port);
  }

  async initialize(): Promise<void> {
    try {
      logger.info('🚀 Starting API Server (API Only Mode)...');

      // 设置日志级别
      const server_config = config_manager.get_server_config();
      logger.set_log_level(server_config.node_env === 'development' ? LogLevel.DEBUG : LogLevel.INFO);

      // 初始化必要的管理器
      await this.symbol_config_manager.initialize();
      await this.top_symbols_manager.initialize();
      await this.historical_data_manager.initialize();

      // 初始化OI数据管理器（但不启动监控）
      await this.oi_data_manager.initialize();
      logger.info('✅ OI Data Manager initialized (monitoring NOT started)');

      // 启动系统监控服务
      await this.monitoring_manager.start();

      // 启动API服务器
      await this.api_server.start();

      logger.info('✅ API Server started successfully (API Only Mode)');
      logger.info('ℹ️  OI monitoring is NOT running - data is read-only from database');

      // 设置优雅关闭
      this.setup_graceful_shutdown();

    } catch (error) {
      logger.error('❌ Failed to initialize API Server', error);
      process.exit(1);
    }
  }

  private setup_graceful_shutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`📴 Received ${signal}, shutting down gracefully...`);

      try {
        // 1. 停止API服务器
        await this.api_server.stop();
        logger.info('✅ API server stopped');

        // 2. 停止系统监控服务
        await this.monitoring_manager.stop();
        logger.info('✅ Monitoring service stopped');

        // 3. 清理缓存
        await this.historical_data_manager.cleanup_expired_cache();
        logger.info('✅ Cache cleaned');

        // 4. 关闭数据库连接池
        await DatabaseConfig.close_connections();
        logger.info('✅ Database connections closed');

        logger.info('✅ Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('❌ Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  async start(): Promise<void> {
    await this.initialize();

    // 每小时清理过期缓存
    setInterval(async () => {
      try {
        await this.historical_data_manager.cleanup_expired_cache();
        logger.info('🧹 Cache cleanup completed');
      } catch (error) {
        logger.error('Error during cache cleanup', error);
      }
    }, 60 * 60 * 1000);

    logger.info('🎯 API Server is running (read-only mode)...');
  }
}

// 启动应用
const app = new APIOnlyApp();
app.start().catch((error) => {
  logger.error('Failed to start application', error);
  process.exit(1);
});
