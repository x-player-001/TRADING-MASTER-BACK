/**
 * K线密集区突破信号 API 路由
 */

import { Router, Request, Response } from 'express';
import { KlineBreakoutRepository, KlineBreakoutSignal } from '@/database/kline_breakout_repository';
import { logger } from '@/utils/logger';

export class BreakoutRoutes {
  private router: Router;
  private repository: KlineBreakoutRepository;

  constructor() {
    this.router = Router();
    this.repository = new KlineBreakoutRepository();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 获取最近的突破信号
    this.router.get('/recent', this.get_recent_signals.bind(this));

    // 获取指定币种的突破信号
    this.router.get('/symbol/:symbol', this.get_signals_by_symbol.bind(this));

    // 按方向获取突破信号
    this.router.get('/direction/:direction', this.get_signals_by_direction.bind(this));

    // 按时间范围获取突破信号
    this.router.get('/range', this.get_signals_by_time_range.bind(this));

    // 获取统计信息
    this.router.get('/statistics', this.get_statistics.bind(this));
  }

  /**
   * 获取最近的突破信号
   * GET /api/breakout/recent?limit=50
   */
  private async get_recent_signals(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 50 } = req.query;
      const parsed_limit = Math.min(parseInt(limit as string) || 50, 200);

      const signals = await this.repository.get_recent_signals(parsed_limit);

      res.json({
        success: true,
        data: {
          count: signals.length,
          signals: this.format_signals(signals)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BreakoutAPI] Failed to get recent signals:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取指定币种的突破信号
   * GET /api/breakout/symbol/:symbol?limit=20
   */
  private async get_signals_by_symbol(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { limit = 20 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 20, 100);

      const signals = await this.repository.get_signals_by_symbol(symbol_upper, parsed_limit);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          count: signals.length,
          signals: this.format_signals(signals)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BreakoutAPI] Failed to get signals by symbol:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 按方向获取突破信号
   * GET /api/breakout/direction/:direction?limit=50
   */
  private async get_signals_by_direction(req: Request, res: Response): Promise<void> {
    try {
      const { direction } = req.params;
      const { limit = 50 } = req.query;

      const dir_upper = direction.toUpperCase() as 'UP' | 'DOWN';
      if (dir_upper !== 'UP' && dir_upper !== 'DOWN') {
        res.status(400).json({
          success: false,
          error: 'Invalid direction',
          message: 'Direction must be UP or DOWN'
        });
        return;
      }

      const parsed_limit = Math.min(parseInt(limit as string) || 50, 200);
      const signals = await this.repository.get_signals_by_direction(dir_upper, parsed_limit);

      res.json({
        success: true,
        data: {
          direction: dir_upper,
          count: signals.length,
          signals: this.format_signals(signals)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BreakoutAPI] Failed to get signals by direction:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 按时间范围获取突破信号
   * GET /api/breakout/range?start=2025-12-15T00:00:00&end=2025-12-15T23:59:59&limit=100
   */
  private async get_signals_by_time_range(req: Request, res: Response): Promise<void> {
    try {
      const { start, end, limit = 100 } = req.query;

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

      const parsed_limit = Math.min(parseInt(limit as string) || 100, 500);
      const signals = await this.repository.get_signals_by_time_range(start_time, end_time, parsed_limit);

      res.json({
        success: true,
        data: {
          start_time: start_time.toISOString(),
          end_time: end_time.toISOString(),
          count: signals.length,
          signals: this.format_signals(signals)
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BreakoutAPI] Failed to get signals by time range:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取统计信息
   * GET /api/breakout/statistics?hours=24
   */
  private async get_statistics(req: Request, res: Response): Promise<void> {
    try {
      const { hours = 24 } = req.query;
      const parsed_hours = Math.min(parseInt(hours as string) || 24, 168); // 最多7天

      const stats = await this.repository.get_statistics(parsed_hours);

      res.json({
        success: true,
        data: {
          period_hours: parsed_hours,
          ...stats
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[BreakoutAPI] Failed to get statistics:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 格式化信号数据
   */
  private format_signals(signals: KlineBreakoutSignal[]): any[] {
    return signals.map(signal => ({
      id: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      breakout_price: parseFloat(signal.breakout_price as any),
      breakout_pct: parseFloat(signal.breakout_pct as any),
      volume_ratio: parseFloat(signal.volume_ratio as any),
      zone: {
        upper_bound: parseFloat(signal.upper_bound as any),
        lower_bound: parseFloat(signal.lower_bound as any),
        center_price: signal.center_price ? parseFloat(signal.center_price as any) : null,
        start_time: signal.zone_start_time,
        end_time: signal.zone_end_time,
        kline_count: signal.zone_kline_count,
        atr: signal.atr ? parseFloat(signal.atr as any) : null
      },
      kline: {
        open: signal.kline_open ? parseFloat(signal.kline_open as any) : null,
        high: signal.kline_high ? parseFloat(signal.kline_high as any) : null,
        low: signal.kline_low ? parseFloat(signal.kline_low as any) : null,
        close: signal.kline_close ? parseFloat(signal.kline_close as any) : null
      },
      signal_time: signal.signal_time,
      created_at: signal.created_at
    }));
  }

  get_router(): Router {
    return this.router;
  }
}
