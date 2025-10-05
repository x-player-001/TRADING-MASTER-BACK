import { Router, Request, Response } from 'express';
import { MonitoringManager } from '@/core/monitoring/monitoring_manager';
import { HealthChecker } from '@/core/monitoring/health_checker';
import { logger } from '@/utils/logger';

export class MonitoringRoutes {
  private router: Router;
  private monitoring_manager: MonitoringManager;
  private health_checker: HealthChecker;

  constructor() {
    this.router = Router();
    this.monitoring_manager = MonitoringManager.getInstance();
    this.health_checker = HealthChecker.getInstance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 系统健康检查接口
    this.router.get('/health', this.get_system_health.bind(this));
    this.router.get('/health/:service', this.get_service_health.bind(this));

    // 系统指标接口
    this.router.get('/metrics', this.get_system_metrics.bind(this));
    this.router.get('/metrics/latest', this.get_latest_metrics.bind(this));

    // 告警接口
    this.router.get('/alerts', this.get_active_alerts.bind(this));
    this.router.get('/alerts/history', this.get_alerts_history.bind(this));

    // 监控服务状态
    this.router.get('/status', this.get_monitoring_status.bind(this));

    // 性能统计接口
    this.router.get('/stats', this.get_performance_stats.bind(this));
    this.router.get('/stats/summary', this.get_stats_summary.bind(this));
  }

  /**
   * 获取系统整体健康状态
   */
  private async get_system_health(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.health_checker.check_system_health();

      res.json({
        success: true,
        data: health,
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取系统健康状态失败', error);
      res.status(500).json({
        success: false,
        error: '系统健康检查失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取特定服务健康状态
   */
  private async get_service_health(req: Request, res: Response): Promise<void> {
    try {
      const { service } = req.params;
      const health = await this.health_checker.check_service_health(service);

      res.json({
        success: true,
        data: health,
        timestamp: new Date()
      });

    } catch (error) {
      logger.error(`获取服务${req.params.service}健康状态失败`, error);
      res.status(500).json({
        success: false,
        error: '服务健康检查失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取系统指标
   */
  private async get_system_metrics(req: Request, res: Response): Promise<void> {
    try {
      // 支持查询参数
      const limit = parseInt(req.query.limit as string) || 10;
      const hours = parseInt(req.query.hours as string) || 1;

      // 这里可以从Redis获取历史指标数据
      const latest_metrics = this.monitoring_manager.get_latest_metrics();

      res.json({
        success: true,
        data: {
          latest: latest_metrics,
          query: {
            limit,
            hours,
            note: '历史数据查询功能待实现'
          }
        },
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取系统指标失败', error);
      res.status(500).json({
        success: false,
        error: '系统指标获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取最新系统指标
   */
  private async get_latest_metrics(req: Request, res: Response): Promise<void> {
    try {
      const metrics = this.monitoring_manager.get_latest_metrics();

      if (!metrics) {
        res.status(404).json({
          success: false,
          error: '暂无系统指标数据',
          timestamp: new Date()
        });
        return;
      }

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取最新系统指标失败', error);
      res.status(500).json({
        success: false,
        error: '最新指标获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取活跃告警
   */
  private async get_active_alerts(req: Request, res: Response): Promise<void> {
    try {
      const alerts = this.monitoring_manager.get_active_alerts();

      res.json({
        success: true,
        data: {
          alerts,
          count: alerts.length,
          critical_count: alerts.filter(a => a.severity === 'critical').length,
          warning_count: alerts.filter(a => a.severity === 'warning').length
        },
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取活跃告警失败', error);
      res.status(500).json({
        success: false,
        error: '告警数据获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取告警历史
   */
  private async get_alerts_history(req: Request, res: Response): Promise<void> {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const limit = parseInt(req.query.limit as string) || 50;

      // 从Redis获取告警历史（待实现）
      res.json({
        success: true,
        data: {
          alerts: [],
          query: { hours, limit },
          note: '告警历史查询功能待实现'
        },
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取告警历史失败', error);
      res.status(500).json({
        success: false,
        error: '告警历史获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取监控服务状态
   */
  private async get_monitoring_status(req: Request, res: Response): Promise<void> {
    try {
      const status = this.monitoring_manager.get_service_status();

      res.json({
        success: true,
        data: status,
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取监控服务状态失败', error);
      res.status(500).json({
        success: false,
        error: '监控服务状态获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取性能统计
   */
  private async get_performance_stats(req: Request, res: Response): Promise<void> {
    try {
      const latest_metrics = this.monitoring_manager.get_latest_metrics();
      const latest_health = this.monitoring_manager.get_latest_health();

      if (!latest_metrics || !latest_health) {
        res.status(404).json({
          success: false,
          error: '性能统计数据不足',
          timestamp: new Date()
        });
        return;
      }

      const stats = {
        system: {
          uptime: latest_metrics.uptime,
          memory_usage: latest_metrics.memory.usage_percentage,
          cpu_usage: latest_metrics.cpu.usage_percentage
        },
        database: {
          mysql_connections: latest_metrics.database.mysql.connection_usage_percentage,
          redis_connected: latest_metrics.database.redis.connected,
          redis_memory_mb: Math.round(latest_metrics.database.redis.memory_used / 1024 / 1024)
        },
        api: {
          total_requests: latest_metrics.api.request_count,
          error_rate: latest_metrics.api.request_count > 0
            ? Math.round((latest_metrics.api.error_count / latest_metrics.api.request_count) * 100)
            : 0,
          avg_response_time: latest_metrics.api.avg_response_time
        },
        websocket: {
          connected: latest_metrics.websocket.connected,
          streams: latest_metrics.websocket.subscribed_streams,
          messages: latest_metrics.websocket.message_count
        },
        health: {
          overall_status: latest_health.overall_status,
          healthy_services: latest_health.checks.filter(c => c.status === 'healthy').length,
          total_services: latest_health.checks.length
        }
      };

      res.json({
        success: true,
        data: stats,
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取性能统计失败', error);
      res.status(500).json({
        success: false,
        error: '性能统计获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取统计摘要
   */
  private async get_stats_summary(req: Request, res: Response): Promise<void> {
    try {
      const latest_metrics = this.monitoring_manager.get_latest_metrics();
      const latest_health = this.monitoring_manager.get_latest_health();
      const active_alerts = this.monitoring_manager.get_active_alerts();
      const monitoring_status = this.monitoring_manager.get_service_status();

      const summary = {
        system_status: latest_health?.overall_status || 'unknown',
        monitoring_active: monitoring_status.is_running,
        active_alerts: active_alerts.length,
        critical_alerts: active_alerts.filter(a => a.severity === 'critical').length,
        uptime_hours: latest_metrics ? Math.round(latest_metrics.uptime / (1000 * 60 * 60)) : 0,
        memory_usage: latest_metrics?.memory.usage_percentage || 0,
        api_requests: latest_metrics?.api.request_count || 0,
        last_update: latest_metrics?.timestamp || null
      };

      res.json({
        success: true,
        data: summary,
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('获取统计摘要失败', error);
      res.status(500).json({
        success: false,
        error: '统计摘要获取失败',
        message: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * 获取路由器实例
   */
  get_router(): Router {
    return this.router;
  }
}