import { Router, Request, Response } from 'express';
import { SRLevelRepository, SRAlert, SRAlertType } from '@/database/sr_level_repository';
import { SRAlertService } from '@/services/sr_alert_service';
import { KlineMultiTableRepository } from '@/database/kline_multi_table_repository';
import { logger } from '@/utils/logger';

/**
 * 支撑阻力位 API 路由
 *
 * 提供支撑阻力位和报警信号的查询接口
 */
export class SRLevelRoutes {
  private router: Router;
  private sr_repository: SRLevelRepository;
  private kline_repository: KlineMultiTableRepository;
  private alert_service: SRAlertService;

  constructor() {
    this.router = Router();
    this.sr_repository = new SRLevelRepository();
    this.kline_repository = new KlineMultiTableRepository();
    this.alert_service = new SRAlertService();
    this.setup_routes();
  }

  private setup_routes(): void {
    // ==================== 报警相关 ====================

    // 获取最近的报警信号
    this.router.get('/alerts/recent', this.get_recent_alerts.bind(this));

    // 获取指定币种的报警信号
    this.router.get('/alerts/:symbol', this.get_alerts_by_symbol.bind(this));

    // 获取指定币种和周期的报警信号
    this.router.get('/alerts/:symbol/:interval', this.get_alerts_by_symbol_interval.bind(this));

    // ==================== 支撑阻力位相关 ====================

    // 获取指定币种的活跃支撑阻力位
    this.router.get('/levels/:symbol/:interval', this.get_active_levels.bind(this));

    // 获取指定价格范围内的支撑阻力位
    this.router.get('/levels/:symbol/:interval/range', this.get_levels_in_range.bind(this));

    // 实时计算支撑阻力位（不存储）
    this.router.get('/detect/:symbol/:interval', this.detect_levels.bind(this));

    // ==================== 管理操作 ====================

    // 初始化数据库表
    this.router.post('/init-tables', this.init_tables.bind(this));

    // 清空报警表
    this.router.delete('/alerts/truncate', this.truncate_alerts.bind(this));
  }

  /**
   * 获取最近的报警信号
   * GET /api/sr/alerts/recent?limit=1000&symbol=BTC&keyword=粘合
   */
  private async get_recent_alerts(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 1000, alert_type, level_type, symbol, keyword } = req.query;
      const parsed_limit = parseInt(limit as string) || 1000;

      // 在数据库层面进行模糊搜索，而不是先取再过滤
      let alerts = await this.sr_repository.get_recent_alerts(
        undefined,
        undefined,
        parsed_limit,
        symbol as string | undefined,
        keyword as string | undefined
      );

      // 可选过滤（这些是精确匹配，数据量小可以在内存过滤）
      if (alert_type) {
        alerts = alerts.filter(a => a.alert_type === alert_type);
      }
      if (level_type) {
        alerts = alerts.filter(a => a.level_type === level_type);
      }

      res.json({
        success: true,
        data: {
          count: alerts.length,
          alerts: alerts.map(a => this.format_alert(a))
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get recent SR alerts', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取指定币种的报警信号
   * GET /api/sr/alerts/:symbol?limit=1000
   */
  private async get_alerts_by_symbol(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { limit = 1000 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = parseInt(limit as string) || 1000;

      const alerts = await this.sr_repository.get_recent_alerts(symbol_upper, undefined, parsed_limit);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          count: alerts.length,
          alerts: alerts.map(a => this.format_alert(a))
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get SR alerts by symbol', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取指定币种和周期的报警信号
   * GET /api/sr/alerts/:symbol/:interval?limit=1000
   */
  private async get_alerts_by_symbol_interval(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { limit = 1000 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = parseInt(limit as string) || 1000;

      const alerts = await this.sr_repository.get_recent_alerts(symbol_upper, interval, parsed_limit);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          count: alerts.length,
          alerts: alerts.map(a => this.format_alert(a))
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get SR alerts by symbol and interval', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取活跃的支撑阻力位
   * GET /api/sr/levels/:symbol/:interval
   */
  private async get_active_levels(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const symbol_upper = symbol.toUpperCase();

      const levels = await this.sr_repository.get_active_levels(symbol_upper, interval);

      // 分离支撑和阻力
      const supports = levels.filter(l => l.level_type === 'SUPPORT').sort((a, b) => b.price - a.price);
      const resistances = levels.filter(l => l.level_type === 'RESISTANCE').sort((a, b) => a.price - b.price);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          total_count: levels.length,
          supports: supports.map(l => this.format_level(l)),
          resistances: resistances.map(l => this.format_level(l))
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get active SR levels', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取指定价格范围内的支撑阻力位
   * GET /api/sr/levels/:symbol/:interval/range?min_price=100&max_price=110
   */
  private async get_levels_in_range(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { min_price, max_price } = req.query;

      if (!min_price || !max_price) {
        res.status(400).json({
          success: false,
          error: 'Missing required parameters: min_price and max_price'
        });
        return;
      }

      const symbol_upper = symbol.toUpperCase();
      const parsed_min = parseFloat(min_price as string);
      const parsed_max = parseFloat(max_price as string);

      if (isNaN(parsed_min) || isNaN(parsed_max)) {
        res.status(400).json({
          success: false,
          error: 'Invalid price format'
        });
        return;
      }

      const levels = await this.sr_repository.get_levels_in_range(
        symbol_upper,
        interval,
        parsed_min,
        parsed_max
      );

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          price_range: { min: parsed_min, max: parsed_max },
          count: levels.length,
          levels: levels.map(l => this.format_level(l))
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get SR levels in range', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 实时计算支撑阻力位（不存储到数据库）
   * GET /api/sr/detect/:symbol/:interval?kline_count=200
   */
  private async detect_levels(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { kline_count = 200 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_count = Math.min(parseInt(kline_count as string) || 200, 500);

      // 获取K线数据
      const klines = await this.kline_repository.find_latest(symbol_upper, interval, parsed_count);

      if (klines.length < 20) {
        res.status(400).json({
          success: false,
          error: 'Insufficient kline data',
          message: `Need at least 20 klines, got ${klines.length}`
        });
        return;
      }

      // 转换格式
      const kline_data = klines.map(k => ({
        open_time: k.open_time,
        close_time: k.close_time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume
      }));

      const current_price = kline_data[kline_data.length - 1].close;

      // 检测支撑阻力位
      const levels = this.alert_service.update_levels(symbol_upper, interval, kline_data);

      // 获取附近的支撑阻力位
      const nearby = this.alert_service.get_nearby_levels(symbol_upper, interval, current_price, 5);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          current_price,
          kline_count: klines.length,
          total_levels: levels.length,
          nearby_supports: nearby.supports.map(l => ({
            price: l.price,
            strength: l.strength,
            touch_count: l.touch_count,
            distance_pct: ((current_price - l.price) / current_price * 100).toFixed(2) + '%'
          })),
          nearby_resistances: nearby.resistances.map(l => ({
            price: l.price,
            strength: l.strength,
            touch_count: l.touch_count,
            distance_pct: ((l.price - current_price) / current_price * 100).toFixed(2) + '%'
          })),
          all_levels: levels.map(l => ({
            price: l.price,
            type: l.type,
            strength: l.strength,
            touch_count: l.touch_count,
            first_touch_time: l.first_touch_time,
            last_touch_time: l.last_touch_time
          }))
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to detect SR levels', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 初始化数据库表
   * POST /api/sr/init-tables
   */
  private async init_tables(req: Request, res: Response): Promise<void> {
    try {
      await this.sr_repository.init_tables();

      res.json({
        success: true,
        message: 'SR tables initialized successfully',
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to initialize SR tables', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 清空报警表
   * DELETE /api/sr/alerts/truncate
   */
  private async truncate_alerts(req: Request, res: Response): Promise<void> {
    try {
      await this.sr_repository.truncate_alerts();

      res.json({
        success: true,
        message: 'SR alerts table truncated successfully',
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to truncate SR alerts', error);
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
  private format_alert(alert: SRAlert): any {
    return {
      id: alert.id,
      symbol: alert.symbol,
      interval: alert.interval,
      alert_type: alert.alert_type,
      level_type: alert.level_type,
      level_price: alert.level_price,
      current_price: alert.current_price,
      distance_pct: alert.distance_pct,
      level_strength: alert.level_strength,
      kline_time: alert.kline_time,
      kline_time_str: new Date(alert.kline_time).toISOString(),
      description: alert.description,
      created_at: alert.created_at
    };
  }

  /**
   * 格式化支撑阻力位数据
   */
  private format_level(level: any): any {
    return {
      id: level.id,
      price: level.price,
      type: level.level_type,
      strength: level.strength,
      touch_count: level.touch_count,
      first_touch_time: level.first_touch_time,
      first_touch_time_str: new Date(level.first_touch_time).toISOString(),
      last_touch_time: level.last_touch_time,
      last_touch_time_str: new Date(level.last_touch_time).toISOString(),
      is_active: level.is_active
    };
  }

  get_router(): Router {
    return this.router;
  }
}
