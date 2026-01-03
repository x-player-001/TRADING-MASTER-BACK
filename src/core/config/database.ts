import { createPool, Pool, PoolConnection } from 'mysql2/promise';
import { createClient, RedisClientType } from 'redis';
import { ConfigManager } from './config_manager';

export class DatabaseConfig {
  private static mysql_pool: Pool | null = null;
  private static redis_client: RedisClientType | null = null;
  private static config_manager = ConfigManager.getInstance();

  static async get_mysql_connection(): Promise<PoolConnection> {
    if (!this.mysql_pool) {
      const mysql_config = this.config_manager.get_database_config().mysql;

      this.mysql_pool = createPool({
        host: mysql_config.host,
        port: mysql_config.port,
        user: mysql_config.user,
        password: mysql_config.password,
        database: mysql_config.database,
        timezone: mysql_config.timezone,
        dateStrings: false,

        // 连接池配置
        connectionLimit: mysql_config.pool_size,
        waitForConnections: true,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000, // 10秒后开始保活
        connectTimeout: mysql_config.connect_timeout,

        // 新增：防止连接超时被MySQL关闭
        maxIdle: 10, // 最大空闲连接数
        idleTimeout: 60000 // 空闲60秒后释放连接（避免超过MySQL的wait_timeout）
      });
    }

    // 返回带有 release() 方法的连接池连接
    return await this.mysql_pool.getConnection();
  }

  static async get_redis_client(): Promise<RedisClientType> {
    if (!this.redis_client) {
      const redis_config = this.config_manager.get_database_config().redis;

      const redisUrl = redis_config.password
        ? `redis://:${encodeURIComponent(redis_config.password)}@${redis_config.host}:${redis_config.port}/${redis_config.db}`
        : `redis://${redis_config.host}:${redis_config.port}/${redis_config.db}`;

      this.redis_client = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 5000,       // 连接超时5秒
          reconnectStrategy: (retries) => {
            if (retries > 3) {
              console.error('[Redis] Max retries reached, giving up');
              return new Error('Max retries reached');
            }
            return Math.min(retries * 500, 3000);  // 重试间隔
          }
        }
      });

      // 错误处理
      this.redis_client.on('error', (err) => {
        console.error('[Redis] Connection error:', err.message);
      });

      await this.redis_client.connect();
    }
    return this.redis_client;
  }

  static get_mysql_pool_status() {
    if (!this.mysql_pool) {
      return { total: 0, free: 0, used: 0 };
    }

    return {
      total: this.mysql_pool.config.connectionLimit || 0,
      free: (this.mysql_pool as any).pool?._freeConnections?.length || 0,
      used: (this.mysql_pool as any).pool?._allConnections?.length || 0
    };
  }

  static async close_connections(): Promise<void> {
    if (this.mysql_pool) {
      try {
        await this.mysql_pool.end();
      } catch (err) {
        console.error('[MySQL] Error closing pool:', err);
      }
      this.mysql_pool = null;
    }

    if (this.redis_client) {
      try {
        if (this.redis_client.isOpen) {
          await this.redis_client.quit();
        }
      } catch (err) {
        console.error('[Redis] Error closing connection:', err);
      }
      this.redis_client = null;
    }
  }
}