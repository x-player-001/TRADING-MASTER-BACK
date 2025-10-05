import * as os from 'os';
import { DatabaseConfig } from '@/core/config/database';
import { ConfigManager } from '@/core/config/config_manager';
import { SystemMetrics, MonitoringConfig } from './monitoring_types';
import { logger } from '@/utils/logger';

export class MetricsCollector {
  private static instance: MetricsCollector;
  private config_manager = ConfigManager.getInstance();
  private start_time = Date.now();
  private api_metrics = {
    request_count: 0,
    error_count: 0,
    total_response_time: 0,
    active_connections: 0
  };
  private websocket_metrics = {
    connected: false,
    subscribed_streams: 0,
    message_count: 0,
    reconnect_count: 0
  };

  private constructor() {}

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  /**
   * 收集完整的系统指标
   */
  async collect_system_metrics(): Promise<SystemMetrics> {
    const timestamp = new Date();
    const uptime = Date.now() - this.start_time;

    try {
      const [memory_metrics, cpu_metrics, database_metrics] = await Promise.all([
        this.collect_memory_metrics(),
        this.collect_cpu_metrics(),
        this.collect_database_metrics()
      ]);

      const metrics: SystemMetrics = {
        timestamp,
        uptime,
        memory: memory_metrics,
        cpu: cpu_metrics,
        database: database_metrics,
        api: this.collect_api_metrics(),
        websocket: this.collect_websocket_metrics(),
        oi_monitoring: await this.collect_oi_metrics()
      };

      return metrics;
    } catch (error) {
      logger.error('收集系统指标失败', error);
      throw error;
    }
  }

  /**
   * 收集内存使用指标
   */
  private collect_memory_metrics() {
    const total_memory = os.totalmem();
    const free_memory = os.freemem();
    const used_memory = total_memory - free_memory;

    return {
      used: used_memory,
      total: total_memory,
      free: free_memory,
      usage_percentage: Math.round((used_memory / total_memory) * 100)
    };
  }

  /**
   * 收集CPU使用指标
   */
  private collect_cpu_metrics() {
    const load_avg = os.loadavg();
    const cpu_count = os.cpus().length;

    // 简化的CPU使用率计算（基于负载平均值）
    const usage_percentage = Math.min(Math.round((load_avg[0] / cpu_count) * 100), 100);

    return {
      usage_percentage,
      load_average: load_avg
    };
  }

  /**
   * 收集数据库连接指标
   */
  private async collect_database_metrics() {
    const mysql_metrics = {
      active_connections: 0,
      max_connections: 0,
      connection_usage_percentage: 0,
      query_count: 0,
      avg_query_time: 0
    };

    const redis_metrics = {
      connected: false,
      memory_used: 0,
      key_count: 0,
      hit_rate: 0
    };

    try {
      // MySQL指标收集
      const mysql_config = this.config_manager.get_database_config().mysql;
      mysql_metrics.max_connections = mysql_config.pool_size;
      mysql_metrics.active_connections = 1; // 简化处理，实际需要查询连接池状态
      mysql_metrics.connection_usage_percentage = Math.round((mysql_metrics.active_connections / mysql_metrics.max_connections) * 100);

      // Redis指标收集
      try {
        const redis_client = await DatabaseConfig.get_redis_client();
        redis_metrics.connected = true;

        // 获取Redis内存信息
        const info = await redis_client.info('memory');
        const memory_match = info.match(/used_memory:(\d+)/);
        if (memory_match) {
          redis_metrics.memory_used = parseInt(memory_match[1]);
        }

        // 获取键数量
        const db_info = await redis_client.info('keyspace');
        const keys_match = db_info.match(/keys=(\d+)/);
        if (keys_match) {
          redis_metrics.key_count = parseInt(keys_match[1]);
        }

        // 获取命中率
        const stats_info = await redis_client.info('stats');
        const hits_match = stats_info.match(/keyspace_hits:(\d+)/);
        const misses_match = stats_info.match(/keyspace_misses:(\d+)/);
        if (hits_match && misses_match) {
          const hits = parseInt(hits_match[1]);
          const misses = parseInt(misses_match[1]);
          redis_metrics.hit_rate = hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0;
        }

      } catch (redis_error) {
        logger.warn('Redis指标收集失败', redis_error);
      }

    } catch (error) {
      logger.error('数据库指标收集失败', error);
    }

    return {
      mysql: mysql_metrics,
      redis: redis_metrics
    };
  }

  /**
   * 收集API指标
   */
  private collect_api_metrics() {
    const avg_response_time = this.api_metrics.request_count > 0
      ? Math.round(this.api_metrics.total_response_time / this.api_metrics.request_count)
      : 0;

    return {
      request_count: this.api_metrics.request_count,
      error_count: this.api_metrics.error_count,
      avg_response_time,
      active_connections: this.api_metrics.active_connections
    };
  }

  /**
   * 收集WebSocket指标
   */
  private collect_websocket_metrics() {
    return { ...this.websocket_metrics };
  }

  /**
   * 收集OI监控指标
   */
  private async collect_oi_metrics() {
    // 这里需要与OIDataManager集成，暂时返回默认值
    return {
      active_symbols: 0,
      polling_interval: 30000,
      last_update: null,
      error_count: 0,
      is_running: false
    };
  }

  /**
   * 记录API请求
   */
  record_api_request(response_time: number, is_error: boolean = false) {
    this.api_metrics.request_count++;
    this.api_metrics.total_response_time += response_time;

    if (is_error) {
      this.api_metrics.error_count++;
    }
  }

  /**
   * 更新API活跃连接数
   */
  update_api_connections(count: number) {
    this.api_metrics.active_connections = count;
  }

  /**
   * 更新WebSocket指标
   */
  update_websocket_metrics(connected: boolean, streams: number, messages: number, reconnects: number) {
    this.websocket_metrics.connected = connected;
    this.websocket_metrics.subscribed_streams = streams;
    this.websocket_metrics.message_count = messages;
    this.websocket_metrics.reconnect_count = reconnects;
  }

  /**
   * 重置统计计数器
   */
  reset_counters() {
    this.api_metrics.request_count = 0;
    this.api_metrics.error_count = 0;
    this.api_metrics.total_response_time = 0;
    this.websocket_metrics.message_count = 0;
  }

  /**
   * 获取监控配置
   */
  get_monitoring_config(): MonitoringConfig {
    return {
      collection_interval: 600000, // 10分钟
      health_check_interval: 600000, // 10分钟
      metrics_retention_hours: 24,
      alert_thresholds: {
        memory_usage: 80, // 80%
        cpu_usage: 75, // 75%
        mysql_connection_usage: 90, // 90%
        api_response_time: 1000, // 1秒
        redis_memory_mb: 500 // 500MB
      }
    };
  }
}