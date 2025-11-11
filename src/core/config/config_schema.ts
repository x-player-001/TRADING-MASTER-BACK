export interface DatabaseConfig {
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    pool_size: number;
    timezone: string;
    connect_timeout: number;
    acquire_timeout: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
  };
}

export interface BinanceConfig {
  api_key: string;
  api_secret: string;
  api_base_url: string;
  ws_base_url: string;
}

export interface ServerConfig {
  node_env: 'development' | 'production' | 'test';
  port: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

export interface CacheConfig {
  expire_hours: number;
  preload_popular_symbols: boolean;
}

/**
 * OI监控系统配置
 */
export interface OIMonitoringConfig {
  cache_ttl: {
    latest_oi: number;      // 最新OI快照缓存时间(秒)
    config: number;         // 监控配置缓存时间(秒)
    symbols: number;        // 币种列表缓存时间(秒)
    stats: number;          // 统计数据缓存时间(秒)
    anomalies: number;      // 异动记录缓存时间(秒)
    history_1m: number;     // 1分钟历史数据缓存(秒)
    history_5m: number;     // 5分钟历史数据缓存(秒)
    dedup_by_period: boolean; // 去重缓存是否按周期时间过期(true=周期时间, false=固定时间)
  };
}

export interface AppConfig {
  database: DatabaseConfig;
  binance: BinanceConfig;
  server: ServerConfig;
  cache: CacheConfig;
  oi_monitoring: OIMonitoringConfig;
}

export const ConfigDefaults: AppConfig = {
  database: {
    mysql: {
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
      database: 'trading_master',
      pool_size: 10,
      timezone: '+00:00',
      connect_timeout: 10000,
      acquire_timeout: 10000
    },
    redis: {
      host: '127.0.0.1',
      port: 6379,
      db: 0
    }
  },
  binance: {
    api_key: '',
    api_secret: '',
    api_base_url: 'https://api.binance.com/api/v3',
    ws_base_url: 'wss://fstream.binance.com/ws'
  },
  server: {
    node_env: 'development',
    port: 3000,
    log_level: 'debug'
  },
  cache: {
    expire_hours: 24,
    preload_popular_symbols: true
  },
  oi_monitoring: {
    cache_ttl: {
      latest_oi: 300,        // 5分钟 (优化：从2分钟延长到5分钟)
      config: 3600,          // 1小时
      symbols: 1800,         // 30分钟
      stats: 600,            // 10分钟 (优化：从5分钟延长到10分钟)
      anomalies: 600,        // 10分钟 (优化：从2分钟延长到10分钟)
      history_1m: 1200,      // 20分钟
      history_5m: 7200,      // 2小时
      dedup_by_period: true  // 去重缓存按周期时间过期
    }
  }
};

export type ConfigKey = keyof AppConfig;