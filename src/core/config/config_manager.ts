import { AppConfig, ConfigDefaults, ConfigKey } from './config_schema';
import { logger } from '@/utils/logger';

export class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig;
  private initialized: boolean = false;

  private constructor() {
    this.config = { ...ConfigDefaults };
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 初始化配置管理器，从环境变量加载配置
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    try {
      this.load_from_env();
      this.validate_config();
      this.initialized = true;

      logger.info('配置管理器初始化成功');
    } catch (error) {
      logger.error('配置管理器初始化失败', error);
      throw error;
    }
  }

  /**
   * 从环境变量加载配置
   */
  private load_from_env(): void {
    // 数据库配置
    this.config.database.mysql = {
      host: process.env.MYSQL_HOST || ConfigDefaults.database.mysql.host,
      port: parseInt(process.env.MYSQL_PORT || String(ConfigDefaults.database.mysql.port)),
      user: process.env.MYSQL_USER || ConfigDefaults.database.mysql.user,
      password: process.env.MYSQL_PASSWORD || ConfigDefaults.database.mysql.password,
      database: process.env.MYSQL_DATABASE || ConfigDefaults.database.mysql.database,
      pool_size: parseInt(process.env.MYSQL_POOL_SIZE || String(ConfigDefaults.database.mysql.pool_size)),
      timezone: ConfigDefaults.database.mysql.timezone,
      connect_timeout: ConfigDefaults.database.mysql.connect_timeout,
      acquire_timeout: ConfigDefaults.database.mysql.acquire_timeout
    };

    this.config.database.redis = {
      host: process.env.REDIS_HOST || ConfigDefaults.database.redis.host,
      port: parseInt(process.env.REDIS_PORT || String(ConfigDefaults.database.redis.port)),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || String(ConfigDefaults.database.redis.db))
    };

    // 币安配置
    this.config.binance = {
      api_key: process.env.BINANCE_API_KEY || ConfigDefaults.binance.api_key,
      api_secret: process.env.BINANCE_API_SECRET || ConfigDefaults.binance.api_secret,
      api_base_url: process.env.BINANCE_API_BASE_URL || ConfigDefaults.binance.api_base_url,
      ws_base_url: process.env.BINANCE_WS_BASE_URL || ConfigDefaults.binance.ws_base_url
    };

    // 服务器配置
    this.config.server = {
      node_env: (process.env.NODE_ENV as any) || ConfigDefaults.server.node_env,
      port: parseInt(process.env.PORT || String(ConfigDefaults.server.port)),
      log_level: (process.env.LOG_LEVEL as any) || ConfigDefaults.server.log_level
    };

    // 缓存配置
    this.config.cache = {
      expire_hours: parseInt(process.env.CACHE_EXPIRE_HOURS || String(ConfigDefaults.cache.expire_hours)),
      preload_popular_symbols: process.env.PRELOAD_POPULAR_SYMBOLS === 'true'
    };

    // OI监控配置
    this.config.oi_monitoring = {
      cache_ttl: {
        latest_oi: parseInt(process.env.OI_CACHE_TTL_LATEST_OI || String(ConfigDefaults.oi_monitoring.cache_ttl.latest_oi)),
        config: parseInt(process.env.OI_CACHE_TTL_CONFIG || String(ConfigDefaults.oi_monitoring.cache_ttl.config)),
        symbols: parseInt(process.env.OI_CACHE_TTL_SYMBOLS || String(ConfigDefaults.oi_monitoring.cache_ttl.symbols)),
        stats: parseInt(process.env.OI_CACHE_TTL_STATS || String(ConfigDefaults.oi_monitoring.cache_ttl.stats)),
        anomalies: parseInt(process.env.OI_CACHE_TTL_ANOMALIES || String(ConfigDefaults.oi_monitoring.cache_ttl.anomalies)),
        history_1m: parseInt(process.env.OI_CACHE_TTL_HISTORY_1M || String(ConfigDefaults.oi_monitoring.cache_ttl.history_1m)),
        history_5m: parseInt(process.env.OI_CACHE_TTL_HISTORY_5M || String(ConfigDefaults.oi_monitoring.cache_ttl.history_5m)),
        dedup_by_period: process.env.OI_CACHE_DEDUP_BY_PERIOD === 'false' ? false : ConfigDefaults.oi_monitoring.cache_ttl.dedup_by_period
      }
    };
  }

  /**
   * 验证配置的有效性
   */
  private validate_config(): void {
    const errors: string[] = [];

    // 验证必填项
    if (!this.config.database.mysql.host) {
      errors.push('MySQL主机地址不能为空');
    }

    if (!this.config.database.mysql.database) {
      errors.push('MySQL数据库名不能为空');
    }

    if (!this.config.binance.api_key) {
      errors.push('币安API Key不能为空');
    }

    if (!this.config.binance.api_secret) {
      errors.push('币安API Secret不能为空');
    }

    // 验证端口范围
    if (this.config.database.mysql.port < 1 || this.config.database.mysql.port > 65535) {
      errors.push('MySQL端口号无效');
    }

    if (this.config.database.redis.port < 1 || this.config.database.redis.port > 65535) {
      errors.push('Redis端口号无效');
    }

    if (this.config.server.port < 1 || this.config.server.port > 65535) {
      errors.push('服务器端口号无效');
    }

    // 验证连接池大小
    if (this.config.database.mysql.pool_size < 1 || this.config.database.mysql.pool_size > 100) {
      errors.push('MySQL连接池大小应在1-100之间');
    }

    if (errors.length > 0) {
      throw new Error(`配置验证失败:\n${errors.join('\n')}`);
    }
  }

  /**
   * 获取完整配置
   */
  get_config(): AppConfig {
    if (!this.initialized) {
      throw new Error('配置管理器未初始化，请先调用initialize()');
    }
    return this.config;
  }

  /**
   * 获取指定分类的配置
   */
  get<T extends ConfigKey>(key: T): AppConfig[T] {
    if (!this.initialized) {
      throw new Error('配置管理器未初始化，请先调用initialize()');
    }
    return this.config[key];
  }

  /**
   * 获取数据库配置
   */
  get_database_config() {
    return this.get('database');
  }

  /**
   * 获取币安配置
   */
  get_binance_config() {
    return this.get('binance');
  }

  /**
   * 获取服务器配置
   */
  get_server_config() {
    return this.get('server');
  }

  /**
   * 获取缓存配置
   */
  get_cache_config() {
    return this.get('cache');
  }

  /**
   * 获取OI监控配置
   */
  get_oi_monitoring_config() {
    return this.get('oi_monitoring');
  }

  /**
   * 检查是否为生产环境
   */
  is_production(): boolean {
    return this.get('server').node_env === 'production';
  }

  /**
   * 检查是否为开发环境
   */
  is_development(): boolean {
    return this.get('server').node_env === 'development';
  }

  /**
   * 获取配置摘要（隐藏敏感信息）
   */
  get_config_summary(): any {
    const config = this.get_config();

    return {
      database: {
        mysql: {
          host: config.database.mysql.host,
          port: config.database.mysql.port,
          user: config.database.mysql.user,
          database: config.database.mysql.database,
          pool_size: config.database.mysql.pool_size
        },
        redis: {
          host: config.database.redis.host,
          port: config.database.redis.port,
          db: config.database.redis.db
        }
      },
      binance: {
        api_base_url: config.binance.api_base_url,
        ws_base_url: config.binance.ws_base_url,
        api_key_configured: !!config.binance.api_key,
        api_secret_configured: !!config.binance.api_secret
      },
      server: config.server,
      cache: config.cache
    };
  }
}