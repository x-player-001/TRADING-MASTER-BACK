/**
 * 边界报警 API 路由
 *
 * 当价格触碰区间上下边界时生成的报警信号
 */

import { Router, Request, Response } from 'express';
import { BoundaryAlertRepository, BoundaryAlertData } from '@/database/boundary_alert_repository';
import { logger } from '@/utils/logger';

export class BoundaryAlertRoutes {
  private router: Router;
  private repository: BoundaryAlertRepository;

  constructor() {
    this.router = Router();
    this.repository = new BoundaryAlertRepository();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 获取最近的边界报警
    this.router.get('/recent', this.get_recent_alerts.bind(this));

    // 获取指定币种的边界报警
    this.router.get('/symbol/:symbol', this.get_alerts_by_symbol.bind(this));

    // 按类型获取边界报警
    this.router.get('/type/:type', this.get_alerts_by_type.bind(this));

    // 按时间范围获取边界报警
    this.router.get('/range', this.get_alerts_by_time_range.bind(this));

    // 获取统计信息
    this.router.get('/statistics', this.get_statistics.bind(this));
  }

  /**
   * 获取最近的边界报警
   * GET /api/boundary-alerts/recent?limit=50
   */
  private async get_recent_alerts(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 50 } = req.query;
      const parsed_limit = Math.min(parseInt(limit as string) || 50, 200);

      const alerts = await this.repository.get_recent_alerts(parsed_limit);

      res.json({
        success: true,
        data: {
          count: alerts.length,
          alerts: this.format_alerts(alerts)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BoundaryAlertAPI] Failed to get recent alerts:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取指定币种的边界报警
   * GET /api/boundary-alerts/symbol/:symbol?limit=20
   */
  private async get_alerts_by_symbol(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { limit = 20 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 20, 100);

      const alerts = await this.repository.get_alerts_by_symbol(symbol_upper, parsed_limit);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          count: alerts.length,
          alerts: this.format_alerts(alerts)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BoundaryAlertAPI] Failed to get alerts by symbol:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 按类型获取边界报警
   * GET /api/boundary-alerts/type/:type?limit=50
   * type: TOUCH_UPPER | TOUCH_LOWER
   */
  private async get_alerts_by_type(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;
      const { limit = 50 } = req.query;

      const type_upper = type.toUpperCase() as 'TOUCH_UPPER' | 'TOUCH_LOWER';
      if (type_upper !== 'TOUCH_UPPER' && type_upper !== 'TOUCH_LOWER') {
        res.status(400).json({
          success: false,
          error: 'Invalid type',
          message: 'Type must be TOUCH_UPPER or TOUCH_LOWER'
        });
        return;
      }

      const parsed_limit = Math.min(parseInt(limit as string) || 50, 200);

      // 使用时间范围查询来过滤类型
      const end_time = new Date();
      const start_time = new Date(end_time.getTime() - 24 * 60 * 60 * 1000); // 最近24小时

      const all_alerts = await this.repository.get_alerts_by_time_range(start_time, end_time);
      const filtered_alerts = all_alerts
        .filter(a => a.alert_type === type_upper)
        .slice(0, parsed_limit);

      res.json({
        success: true,
        data: {
          type: type_upper,
          count: filtered_alerts.length,
          alerts: this.format_alerts(filtered_alerts)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BoundaryAlertAPI] Failed to get alerts by type:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 按时间范围获取边界报警
   * GET /api/boundary-alerts/range?start=2025-12-15T00:00:00&end=2025-12-15T23:59:59&symbol=BTCUSDT
   */
  private async get_alerts_by_time_range(req: Request, res: Response): Promise<void> {
    try {
      const { start, end, symbol } = req.query;

      if (!start || !end) {
        res.status(400).json({
          success: false,
          error: 'Missing parameters',
          message: 'start and end are required'
        });
        return;
      }

      const start_time = new Date(start as string);
      const end_time = new Date(end as string);

      if (isNaN(start_time.getTime()) || isNaN(end_time.getTime())) {
        res.status(400).json({
          success: false,
          error: 'Invalid date format',
          message: 'Please use ISO 8601 format (e.g., 2025-12-15T00:00:00)'
        });
        return;
      }

      const symbol_filter = symbol ? (symbol as string).toUpperCase() : undefined;
      const alerts = await this.repository.get_alerts_by_time_range(start_time, end_time, symbol_filter);

      res.json({
        success: true,
        data: {
          start_time: start_time.toISOString(),
          end_time: end_time.toISOString(),
          symbol: symbol_filter || 'ALL',
          count: alerts.length,
          alerts: this.format_alerts(alerts)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BoundaryAlertAPI] Failed to get alerts by time range:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取统计信息
   * GET /api/boundary-alerts/statistics
   */
  private async get_statistics(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.repository.get_today_statistics();

      res.json({
        success: true,
        data: {
          period: 'today',
          total_alerts: stats.total_count,
          upper_alerts: stats.upper_count,
          lower_alerts: stats.lower_count,
          unique_symbols: stats.symbols_count
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BoundaryAlertAPI] Failed to get statistics:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 格式化报警数据
   */
  private format_alerts(alerts: BoundaryAlertData[]): any[] {
    return alerts.map(alert => ({
      id: alert.id,
      symbol: alert.symbol,
      alert_type: alert.alert_type,
      alert_price: parseFloat(alert.alert_price as any),
      zone: {
        upper_bound: parseFloat(alert.upper_bound as any),
        lower_bound: parseFloat(alert.lower_bound as any),
        extended_high: parseFloat(alert.extended_high as any),
        extended_low: parseFloat(alert.extended_low as any),
        zone_score: alert.zone_score,
        start_time: alert.zone_start_time,
        end_time: alert.zone_end_time,
        kline_count: alert.zone_kline_count
      },
      kline: {
        open: parseFloat(alert.kline_open as any),
        high: parseFloat(alert.kline_high as any),
        low: parseFloat(alert.kline_low as any),
        close: parseFloat(alert.kline_close as any),
        volume: parseFloat(alert.kline_volume as any)
      },
      alert_time: alert.alert_time,
      created_at: alert.created_at
    }));
  }

  get_router(): Router {
    return this.router;
  }
}
