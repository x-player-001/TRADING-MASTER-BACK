import { EventEmitter } from 'events';
import { DatabaseConfig } from '@/core/config/database';
import { MetricsCollector } from './metrics_collector';
import { HealthChecker } from './health_checker';
import { SystemMetrics, ServiceHealth, PerformanceAlert, MonitoringConfig } from './monitoring_types';
import { logger } from '@/utils/logger';

export class MonitoringManager extends EventEmitter {
  private static instance: MonitoringManager;
  private metrics_collector: MetricsCollector;
  private health_checker: HealthChecker;
  private redis_client: any = null;

  private collection_timer: NodeJS.Timeout | null = null;
  private health_check_timer: NodeJS.Timeout | null = null;
  private cleanup_timer: NodeJS.Timeout | null = null;

  private is_running = false;
  private latest_metrics: SystemMetrics | null = null;
  private latest_health: ServiceHealth | null = null;
  private active_alerts: PerformanceAlert[] = [];
  private config: MonitoringConfig;

  private constructor() {
    super();
    this.metrics_collector = MetricsCollector.getInstance();
    this.health_checker = HealthChecker.getInstance();
    this.config = this.metrics_collector.get_monitoring_config();
  }

  static getInstance(): MonitoringManager {
    if (!MonitoringManager.instance) {
      MonitoringManager.instance = new MonitoringManager();
    }
    return MonitoringManager.instance;
  }

  /**
   * 启动监控服务
   */
  async start(): Promise<void> {
    if (this.is_running) {
      logger.warn('监控服务已在运行');
      return;
    }

    try {
      // 初始化Redis连接
      this.redis_client = await DatabaseConfig.get_redis_client();

      // 启动定时任务
      this.start_metrics_collection();
      this.start_health_checks();
      this.start_cleanup_task();

      this.is_running = true;
      logger.info('📊 监控服务启动成功');

      // 立即执行一次收集
      await this.collect_and_store_metrics();
      await this.check_and_store_health();

    } catch (error) {
      logger.error('监控服务启动失败', error);
      throw error;
    }
  }

  /**
   * 停止监控服务
   */
  async stop(): Promise<void> {
    if (!this.is_running) {
      return;
    }

    logger.info('正在停止监控服务...');

    // 清理定时器
    if (this.collection_timer) {
      clearInterval(this.collection_timer);
      this.collection_timer = null;
    }

    if (this.health_check_timer) {
      clearInterval(this.health_check_timer);
      this.health_check_timer = null;
    }

    if (this.cleanup_timer) {
      clearInterval(this.cleanup_timer);
      this.cleanup_timer = null;
    }

    this.is_running = false;
    logger.info('✅ 监控服务已停止');
  }

  /**
   * 启动指标收集定时任务
   */
  private start_metrics_collection(): void {
    this.collection_timer = setInterval(async () => {
      try {
        await this.collect_and_store_metrics();
      } catch (error) {
        logger.error('指标收集失败', error);
      }
    }, this.config.collection_interval);
  }

  /**
   * 启动健康检查定时任务
   */
  private start_health_checks(): void {
    this.health_check_timer = setInterval(async () => {
      try {
        await this.check_and_store_health();
      } catch (error) {
        logger.error('健康检查失败', error);
      }
    }, this.config.health_check_interval);
  }

  /**
   * 启动清理任务
   */
  private start_cleanup_task(): void {
    // 每小时清理一次过期数据
    this.cleanup_timer = setInterval(async () => {
      try {
        await this.cleanup_expired_data();
      } catch (error) {
        logger.error('数据清理失败', error);
      }
    }, 60 * 60 * 1000);
  }

  /**
   * 收集并存储指标
   */
  private async collect_and_store_metrics(): Promise<void> {
    try {
      const metrics = await this.metrics_collector.collect_system_metrics();
      this.latest_metrics = metrics;

      // 存储到Redis
      const cache_key = `monitoring:metrics:${Date.now()}`;
      await this.redis_client.setEx(
        cache_key,
        this.config.metrics_retention_hours * 3600,
        JSON.stringify(metrics)
      );

      // 存储最新指标
      await this.redis_client.setEx(
        'monitoring:metrics:latest',
        300, // 5分钟过期
        JSON.stringify(metrics)
      );

      // 检查告警条件
      await this.check_alert_conditions(metrics);

      // 发出事件
      this.emit('metrics_collected', metrics);

      logger.debug('系统指标收集完成', {
        memory_usage: metrics.memory.usage_percentage,
        cpu_usage: metrics.cpu.usage_percentage,
        api_requests: metrics.api.request_count
      });

    } catch (error) {
      logger.error('指标收集和存储失败', error);
    }
  }

  /**
   * 检查并存储健康状态
   */
  private async check_and_store_health(): Promise<void> {
    try {
      const health = await this.health_checker.check_system_health();
      this.latest_health = health;

      // 存储到Redis
      const cache_key = `monitoring:health:${Date.now()}`;
      await this.redis_client.setEx(
        cache_key,
        this.config.metrics_retention_hours * 3600,
        JSON.stringify(health)
      );

      // 存储最新健康状态
      await this.redis_client.setEx(
        'monitoring:health:latest',
        300, // 5分钟过期
        JSON.stringify(health)
      );

      // 发出事件
      this.emit('health_checked', health);

      logger.debug('系统健康检查完成', {
        overall_status: health.overall_status,
        failed_checks: health.checks.filter(c => c.status !== 'healthy').length
      });

    } catch (error) {
      logger.error('健康检查和存储失败', error);
    }
  }

  /**
   * 检查告警条件
   */
  private async check_alert_conditions(metrics: SystemMetrics): Promise<void> {
    const alerts: PerformanceAlert[] = [];
    const thresholds = this.config.alert_thresholds;

    // 内存使用率告警
    if (metrics.memory.usage_percentage > thresholds.memory_usage) {
      alerts.push({
        id: `memory_${Date.now()}`,
        type: 'memory',
        severity: metrics.memory.usage_percentage > 90 ? 'critical' : 'warning',
        message: `内存使用率过高: ${metrics.memory.usage_percentage}%`,
        value: metrics.memory.usage_percentage,
        threshold: thresholds.memory_usage,
        timestamp: new Date(),
        resolved: false
      });
    }

    // CPU使用率告警
    if (metrics.cpu.usage_percentage > thresholds.cpu_usage) {
      alerts.push({
        id: `cpu_${Date.now()}`,
        type: 'cpu',
        severity: metrics.cpu.usage_percentage > 90 ? 'critical' : 'warning',
        message: `CPU使用率过高: ${metrics.cpu.usage_percentage}%`,
        value: metrics.cpu.usage_percentage,
        threshold: thresholds.cpu_usage,
        timestamp: new Date(),
        resolved: false
      });
    }

    // MySQL连接池使用率告警
    if (metrics.database.mysql.connection_usage_percentage > thresholds.mysql_connection_usage) {
      alerts.push({
        id: `mysql_${Date.now()}`,
        type: 'database',
        severity: 'warning',
        message: `MySQL连接池使用率过高: ${metrics.database.mysql.connection_usage_percentage}%`,
        value: metrics.database.mysql.connection_usage_percentage,
        threshold: thresholds.mysql_connection_usage,
        timestamp: new Date(),
        resolved: false
      });
    }

    // API响应时间告警
    if (metrics.api.avg_response_time > thresholds.api_response_time) {
      alerts.push({
        id: `api_${Date.now()}`,
        type: 'api',
        severity: 'warning',
        message: `API响应时间过长: ${metrics.api.avg_response_time}ms`,
        value: metrics.api.avg_response_time,
        threshold: thresholds.api_response_time,
        timestamp: new Date(),
        resolved: false
      });
    }

    // Redis内存使用告警
    const redis_memory_mb = Math.round(metrics.database.redis.memory_used / 1024 / 1024);
    if (redis_memory_mb > thresholds.redis_memory_mb) {
      alerts.push({
        id: `redis_${Date.now()}`,
        type: 'database',
        severity: 'warning',
        message: `Redis内存使用过高: ${redis_memory_mb}MB`,
        value: redis_memory_mb,
        threshold: thresholds.redis_memory_mb,
        timestamp: new Date(),
        resolved: false
      });
    }

    // 处理新告警
    for (const alert of alerts) {
      await this.handle_new_alert(alert);
    }
  }

  /**
   * 处理新告警
   */
  private async handle_new_alert(alert: PerformanceAlert): Promise<void> {
    // 添加到活跃告警列表
    this.active_alerts.push(alert);

    // 存储到Redis
    const cache_key = `monitoring:alert:${alert.id}`;
    await this.redis_client.setEx(
      cache_key,
      24 * 3600, // 24小时过期
      JSON.stringify(alert)
    );

    // 发出告警事件
    this.emit('alert_triggered', alert);

    logger.warn(`🚨 性能告警: ${alert.message}`, {
      type: alert.type,
      severity: alert.severity,
      value: alert.value,
      threshold: alert.threshold
    });
  }

  /**
   * 清理过期数据
   */
  private async cleanup_expired_data(): Promise<void> {
    try {
      // 清理过期的指标数据
      const metrics_pattern = 'monitoring:metrics:*';
      const metrics_keys = await this.redis_client.keys(metrics_pattern);

      for (const key of metrics_keys) {
        const ttl = await this.redis_client.ttl(key);
        if (ttl === -1) {
          // 为没有过期时间的key设置过期时间
          await this.redis_client.expire(key, this.config.metrics_retention_hours * 3600);
        }
      }

      // 清理过期的健康检查数据
      const health_pattern = 'monitoring:health:*';
      const health_keys = await this.redis_client.keys(health_pattern);

      for (const key of health_keys) {
        const ttl = await this.redis_client.ttl(key);
        if (ttl === -1) {
          await this.redis_client.expire(key, this.config.metrics_retention_hours * 3600);
        }
      }

      // 清理已解决的告警
      this.active_alerts = this.active_alerts.filter(alert => !alert.resolved);

      logger.debug('监控数据清理完成');

    } catch (error) {
      logger.error('监控数据清理失败', error);
    }
  }

  /**
   * 获取最新系统指标
   */
  get_latest_metrics(): SystemMetrics | null {
    return this.latest_metrics;
  }

  /**
   * 获取最新健康状态
   */
  get_latest_health(): ServiceHealth | null {
    return this.latest_health;
  }

  /**
   * 获取活跃告警
   */
  get_active_alerts(): PerformanceAlert[] {
    return [...this.active_alerts];
  }

  /**
   * 获取监控服务状态
   */
  get_service_status() {
    return {
      is_running: this.is_running,
      uptime: this.is_running ? Date.now() - (this.latest_metrics?.timestamp.getTime() || Date.now()) : 0,
      latest_collection: this.latest_metrics?.timestamp || null,
      latest_health_check: this.latest_health?.timestamp || null,
      active_alerts_count: this.active_alerts.length,
      config: this.config
    };
  }

  /**
   * 记录API请求（供中间件调用）
   */
  record_api_request(response_time: number, is_error: boolean = false) {
    this.metrics_collector.record_api_request(response_time, is_error);
  }

  /**
   * 更新WebSocket指标（供WebSocket管理器调用）
   */
  update_websocket_metrics(connected: boolean, streams: number, messages: number, reconnects: number) {
    this.metrics_collector.update_websocket_metrics(connected, streams, messages, reconnects);
  }
}