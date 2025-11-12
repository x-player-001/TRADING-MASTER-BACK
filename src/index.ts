import dotenv from 'dotenv';
import {
  SymbolConfigManager,
  MultiSymbolManager,
  StreamDispatcher,
  HistoricalDataManager
} from '@/core/data';
import { OIDataManager } from '@/core/data/oi_data_manager';
import { APIServer } from '@/api/api_server';
import { logger, LogLevel } from '@/utils/logger';
import { DatabaseConfig } from '@/core/config/database';
import { ConfigManager } from '@/core/config/config_manager';
import { MonitoringManager } from '@/core/monitoring/monitoring_manager';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';
import { SignalManager } from '@/signals/signal_manager';
import { StrategyRegistry } from '@/quantitative/strategies/strategy_registry';

// 加载环境变量
dotenv.config();

// 初始化配置管理器
const config_manager = ConfigManager.getInstance();
config_manager.initialize();

// 注册量化策略
StrategyRegistry.initialize();

class TradingMasterApp {
  private symbol_config_manager: SymbolConfigManager;
  private multi_symbol_manager: MultiSymbolManager;
  private stream_dispatcher: StreamDispatcher;
  private historical_data_manager: HistoricalDataManager;
  private oi_data_manager: OIDataManager;
  private api_server: APIServer;
  private monitoring_manager: MonitoringManager;
  private top_symbols_manager: TopSymbolsManager;
  private signal_manager: SignalManager;

  constructor() {
    this.symbol_config_manager = SymbolConfigManager.getInstance();
    this.multi_symbol_manager = MultiSymbolManager.getInstance();
    this.stream_dispatcher = StreamDispatcher.getInstance();
    this.historical_data_manager = HistoricalDataManager.getInstance();
    this.oi_data_manager = new OIDataManager();
    this.monitoring_manager = MonitoringManager.getInstance();
    this.top_symbols_manager = TopSymbolsManager.get_instance();
    this.signal_manager = SignalManager.getInstance();

    const server_config = config_manager.get_server_config();
    this.api_server = new APIServer(this.oi_data_manager, server_config.port);
  }

  async initialize(): Promise<void> {
    try {
      logger.info('🚀 Starting Trading Master Backend...');

      // 设置日志级别
      const server_config = config_manager.get_server_config();
      logger.set_log_level(server_config.node_env === 'development' ? LogLevel.DEBUG : LogLevel.INFO);

      // 初始化各个管理器
      await this.symbol_config_manager.initialize();
      await this.top_symbols_manager.initialize();
      // 暂时跳过WebSocket相关组件
      // await this.stream_dispatcher.initialize();
      // 注释掉WebSocket订阅 - 停止实时数据订阅
      // await this.multi_symbol_manager.initialize();
      await this.historical_data_manager.initialize();

      // 初始化OI数据管理器
      await this.oi_data_manager.initialize();

      // 启动OI监控服务
      await this.oi_data_manager.start_monitoring();

      // 启动系统监控服务
      await this.monitoring_manager.start();

      // 初始化并启动信号管理器（暂时禁用）
      // await this.signal_manager.initialize();
      // logger.info('✅ Signal Manager started');

      // 启动API服务器
      await this.api_server.start();

      logger.info('✅ Trading Master Backend initialized successfully');

      // 设置优雅关闭
      this.setup_graceful_shutdown();

    } catch (error) {
      logger.error('❌ Failed to initialize Trading Master Backend', error);
      process.exit(1);
    }
  }

  private setup_graceful_shutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`📴 Received ${signal}, shutting down gracefully...`);

      try {
        // 1. 先停止API服务器（停止接收新请求）
        await this.api_server.stop();
        logger.info('✅ API server stopped');

        // 2. 停止系统监控服务
        await this.monitoring_manager.stop();
        logger.info('✅ Monitoring service stopped');

        // 3. 停止OI监控服务
        await this.oi_data_manager.stop_monitoring();
        logger.info('✅ OI monitoring stopped');

        // 4. 停止多币种管理器（会更新Redis订阅状态）
        // 注释掉WebSocket订阅停止操作
        // await this.multi_symbol_manager.stop();
        // logger.info('✅ Multi-symbol manager stopped');

        // 5. 清理缓存
        await this.historical_data_manager.cleanup_expired_cache();
        logger.info('✅ Cache cleaned');

        // 6. 最后关闭数据库连接池（确保前面的操作都完成）
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

    // 启动监控和统计
    this.start_monitoring();

    logger.info('🎯 Trading Master Backend is running...');
  }

  private start_monitoring(): void {
    // 移除了每5分钟输出统计信息的定时器

    // 每小时清理过期缓存
    setInterval(async () => {
      try {
        // await this.stream_dispatcher.cleanup_expired_cache();
        await this.historical_data_manager.cleanup_expired_cache();
        logger.info('🧹 Cache cleanup completed');
      } catch (error) {
        logger.error('Error during cache cleanup', error);
      }
    }, 60 * 60 * 1000);
  }
}

// 启动应用
const app = new TradingMasterApp();
app.start().catch((error) => {
  logger.error('Failed to start application', error);
  process.exit(1);
});