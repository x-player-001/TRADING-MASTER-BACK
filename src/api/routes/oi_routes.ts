import { Router, Request, Response } from 'express';
import { OIRepository } from '../../database/oi_repository';
import { OIPollingService } from '../../services/oi_polling_service';
import { ConfigManager } from '../../core/config/config_manager';
import {
  OISnapshotQueryParams,
  OIAnomalyQueryParams,
  OIStatisticsQueryParams,
  OIStatistics
} from '../../types/oi_types';

/**
 * OI相关API路由
 */
export class OIRoutes {
  private router: Router;
  private oi_repository: OIRepository;
  private oi_polling_service: OIPollingService;

  constructor(oi_polling_service: OIPollingService) {
    this.router = Router();
    this.oi_repository = oi_polling_service.get_repository(); // 使用已配置缓存的repository
    this.oi_polling_service = oi_polling_service;
    this.setup_routes();
  }

  /**
   * 设置路由
   */
  private setup_routes(): void {
    // 获取OI统计数据
    this.router.get('/statistics', this.get_oi_statistics.bind(this));

    // 获取OI快照数据
    this.router.get('/snapshots', this.get_snapshots.bind(this));

    // 获取异动记录
    this.router.get('/anomalies', this.get_anomalies.bind(this));

    // 获取最近异动列表
    this.router.get('/recent-anomalies', this.get_recent_anomalies.bind(this));

    // 获取启用的币种列表
    this.router.get('/symbols', this.get_enabled_symbols.bind(this));

    // 获取服务状态
    this.router.get('/status', this.get_service_status.bind(this));

    // 手动触发轮询
    this.router.post('/trigger-poll', this.trigger_manual_poll.bind(this));

    // ⚠️ 具体路径必须在参数化路由之前
    // 获取完整配置(聚合接口)
    this.router.get('/config/all', this.get_all_config.bind(this));

    // OI曲线数据（前端绘图）
    this.router.get('/curve', this.get_oi_curve.bind(this));

    // 更新配置
    this.router.put('/config/:key', this.update_config.bind(this));

    // 获取配置
    this.router.get('/config', this.get_config.bind(this));

    // 黑名单管理
    this.router.get('/blacklist', this.get_blacklist.bind(this));
    this.router.post('/blacklist', this.add_to_blacklist.bind(this));
    this.router.delete('/blacklist/:symbol', this.remove_from_blacklist.bind(this));
  }

  /**
   * 获取OI统计数据
   */
  private async get_oi_statistics(req: Request, res: Response): Promise<void> {
    try {
      const params: OIStatisticsQueryParams = {
        symbol: req.query.symbol as string,
        date: req.query.date as string // 格式: YYYY-MM-DD
      };

      const statistics = await this.oi_repository.get_oi_statistics(params);

      // 处理symbol字段，去掉USDT后缀
      const formatted_statistics = statistics.map(stat => ({
        ...stat,
        symbol: stat.symbol ? stat.symbol.replace('USDT', '') : stat.symbol
      }));

      res.json({
        success: true,
        data: formatted_statistics,
        params: {
          symbol: params.symbol,
          date: params.date || 'latest_24h'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get OI statistics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get OI statistics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取OI快照数据
   */
  private async get_snapshots(req: Request, res: Response): Promise<void> {
    try {
      const params: OISnapshotQueryParams = {
        symbol: req.query.symbol as string,
        start_time: req.query.start_time ? new Date(req.query.start_time as string) : undefined,
        end_time: req.query.end_time ? new Date(req.query.end_time as string) : undefined,
        order: (req.query.order as 'ASC' | 'DESC') || 'DESC'
      };

      const snapshots = await this.oi_repository.get_snapshots(params);

      // 处理symbol字段，去掉USDT后缀
      const formatted_snapshots = snapshots.map(snapshot => ({
        ...snapshot,
        symbol: snapshot.symbol ? snapshot.symbol.replace('USDT', '') : snapshot.symbol
      }));

      res.json({
        success: true,
        data: formatted_snapshots,
        count: formatted_snapshots.length,
        params: params,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get snapshots:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get snapshots',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取异动记录
   */
  private async get_anomalies(req: Request, res: Response): Promise<void> {
    try {
      const params: OIAnomalyQueryParams = {
        symbol: req.query.symbol as string,
        period_seconds: req.query.period_seconds ? parseInt(req.query.period_seconds as string) : undefined,
        severity: req.query.severity as 'low' | 'medium' | 'high',
        start_time: req.query.start_time ? new Date(req.query.start_time as string) : undefined,
        end_time: req.query.end_time ? new Date(req.query.end_time as string) : undefined,
        order: (req.query.order as 'ASC' | 'DESC') || 'DESC'
      };

      const anomalies = await this.oi_repository.get_anomaly_records(params);

      // 处理symbol字段，去掉USDT后缀
      const formatted_anomalies = anomalies.map(anomaly => ({
        ...anomaly,
        symbol: anomaly.symbol ? anomaly.symbol.replace('USDT', '') : anomaly.symbol
      }));

      res.json({
        success: true,
        data: formatted_anomalies,
        count: formatted_anomalies.length,
        params: params,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get anomalies:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get anomalies',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取最近50条异动记录
   */
  private async get_recent_anomalies(req: Request, res: Response): Promise<void> {
    try {
      const params: OIAnomalyQueryParams = {
        symbol: req.query.symbol as string,
        date: req.query.date as string, // 格式: YYYY-MM-DD
        severity: req.query.severity as 'low' | 'medium' | 'high',
        order: 'DESC'
      };

      // 如果传入了日期，计算该日期的开始和结束时间
      if (params.date) {
        const date = new Date(params.date);
        params.start_time = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
        params.end_time = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
      }

      const anomalies = await this.oi_repository.get_anomaly_records(params);

      // 格式化数据，添加显示友好的字段
      const formatted_data = anomalies.map(anomaly => ({
        symbol: anomaly.symbol ? anomaly.symbol.replace('USDT', '') : anomaly.symbol,
        period_minutes: anomaly.period_seconds / 60,
        percent_change: parseFloat(Number(anomaly.percent_change).toFixed(2)),
        oi_before: anomaly.oi_before,
        oi_after: anomaly.oi_after,
        oi_change: anomaly.oi_change,
        severity: anomaly.severity,
        anomaly_time: anomaly.anomaly_time,
        threshold_value: anomaly.threshold_value,
        // 价格变化字段
        price_before: anomaly.price_before,
        price_after: anomaly.price_after,
        price_change: anomaly.price_change,
        price_change_percent: anomaly.price_change_percent,
        // 市场情绪字段
        top_trader_long_short_ratio: anomaly.top_trader_long_short_ratio,
        top_account_long_short_ratio: anomaly.top_account_long_short_ratio,
        global_long_short_ratio: anomaly.global_long_short_ratio,
        taker_buy_sell_ratio: anomaly.taker_buy_sell_ratio
      }));

      res.json({
        success: true,
        data: formatted_data,
        count: formatted_data.length,
        params: {
          symbol: params.symbol,
          date: params.date || 'recent',
          severity: params.severity
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get recent anomalies:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get recent anomalies',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取启用的币种列表
   */
  private async get_enabled_symbols(req: Request, res: Response): Promise<void> {
    try {
      const symbols = await this.oi_repository.get_enabled_symbols();

      res.json({
        success: true,
        data: symbols,
        count: symbols.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get enabled symbols:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get enabled symbols',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取服务状态
   */
  private async get_service_status(req: Request, res: Response): Promise<void> {
    try {
      const status = this.oi_polling_service.get_status();

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get service status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get service status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 手动触发轮询
   */
  private async trigger_manual_poll(req: Request, res: Response): Promise<void> {
    try {
      await this.oi_polling_service.trigger_manual_poll();

      res.json({
        success: true,
        message: 'Manual poll triggered successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to trigger manual poll:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to trigger manual poll',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取OI曲线数据（用于前端绘图）
   * 查询参数：
   *   - symbol: 币种符号（必填，如：BTCUSDT）
   *   - date: 日期（必填，格式：YYYY-MM-DD）
   */
  private async get_oi_curve(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, date } = req.query;

      // 参数验证
      if (!symbol || typeof symbol !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Missing or invalid parameter: symbol',
          message: 'symbol is required and must be a string (e.g., BTCUSDT)'
        });
        return;
      }

      if (!date || typeof date !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Missing or invalid parameter: date',
          message: 'date is required and must be in format YYYY-MM-DD (e.g., 2025-11-11)'
        });
        return;
      }

      // 验证日期格式
      const date_regex = /^\d{4}-\d{2}-\d{2}$/;
      if (!date_regex.test(date)) {
        res.status(400).json({
          success: false,
          error: 'Invalid date format',
          message: 'date must be in format YYYY-MM-DD (e.g., 2025-11-11)'
        });
        return;
      }

      // 查询OI曲线数据
      const curve_data = await this.oi_repository.get_symbol_oi_curve(symbol, date);

      // 格式化返回数据：移除USDT后缀，并转换为前端需要的格式
      const formatted_data = curve_data.map(item => ({
        timestamp: item.timestamp_ms,
        snapshot_time: item.snapshot_time,
        open_interest: parseFloat(item.open_interest.toString()),
        data_source: item.data_source,
        mark_price: item.mark_price ? parseFloat(item.mark_price.toString()) : null,
        funding_rate: item.funding_rate ? parseFloat(item.funding_rate.toString()) : null,
        next_funding_time: item.next_funding_time || null
      }));

      res.json({
        success: true,
        data: {
          symbol: symbol.replace('USDT', ''),
          date: date,
          curve: formatted_data,
          count: formatted_data.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get OI curve:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get OI curve',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 更新配置
   */
  private async update_config(req: Request, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      const { value } = req.body;

      if (!key || value === undefined) {
        res.status(400).json({
          success: false,
          error: 'Missing key or value'
        });
        return;
      }

      await this.oi_polling_service.update_config(key, value);

      res.json({
        success: true,
        message: `Config ${key} updated successfully`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to update config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update config',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取配置
   */
  private async get_config(req: Request, res: Response): Promise<void> {
    try {
      const configs = await this.oi_repository.get_monitoring_config();

      const config_map: Record<string, any> = {};
      for (const config of configs) {
        try {
          config_map[config.config_key] = JSON.parse(config.config_value);
        } catch {
          config_map[config.config_key] = config.config_value;
        }
      }

      res.json({
        success: true,
        data: config_map,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get config',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取完整配置(聚合接口)
   * 包含数据库配置和静态缓存配置
   */
  private async get_all_config(req: Request, res: Response): Promise<void> {
    try {
      // 1. 从数据库获取动态配置
      const db_configs = await this.oi_repository.get_monitoring_config();
      const config_map: Record<string, any> = {};

      for (const config of db_configs) {
        try {
          config_map[config.config_key] = JSON.parse(config.config_value);
        } catch {
          config_map[config.config_key] = config.config_value;
        }
      }

      // 2. 从ConfigManager获取静态缓存配置
      const cache_ttl_config = ConfigManager.getInstance().get_oi_monitoring_config().cache_ttl;

      // 3. 聚合返回
      const all_config = {
        monitoring: {
          polling_interval_ms: config_map.polling_interval_ms || 60000,
          symbol_refresh_interval_ms: config_map.symbol_refresh_interval_ms || 7200000,
          max_concurrent_requests: config_map.max_concurrent_requests || 50,
          off_hours_config: config_map.off_hours_config || { start: 0, end: 7, interval_ms: 900000 }
        },
        thresholds: {
          anomaly_detection: config_map.thresholds || { "60": 3, "120": 3, "300": 3, "900": 10 },
          deduplication: {
            change_diff_percent: parseFloat(config_map.dedup_change_diff_threshold || '1')
          },
          severity: config_map.severity_thresholds || { high: 30, medium: 15 }
        },
        cache_ttl: {
          latest_oi: cache_ttl_config.latest_oi,
          config: cache_ttl_config.config,
          symbols: cache_ttl_config.symbols,
          stats: cache_ttl_config.stats,
          anomalies: cache_ttl_config.anomalies,
          history_1m: cache_ttl_config.history_1m,
          history_5m: cache_ttl_config.history_5m,
          dedup_by_period: cache_ttl_config.dedup_by_period
        },
        editable: {
          monitoring: true,                          // 可通过 PUT /api/oi/config 修改
          'thresholds.anomaly_detection': true,      // 可修改
          'thresholds.deduplication': true,          // 可修改
          'thresholds.severity': true,               // 可修改
          cache_ttl: false                           // 需修改.env重启
        }
      };

      res.json({
        success: true,
        data: all_config,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get all config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get all config',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取黑名单
   */
  private async get_blacklist(req: Request, res: Response): Promise<void> {
    try {
      const blacklist = await this.oi_repository.get_monitoring_config('symbol_blacklist');

      res.json({
        success: true,
        data: {
          blacklist: blacklist || [],
          count: Array.isArray(blacklist) ? blacklist.length : 0
        }
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to get blacklist:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get blacklist',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 添加币种到黑名单
   */
  private async add_to_blacklist(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.body;

      if (!symbol || typeof symbol !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Invalid request body',
          message: 'symbol is required and must be a string'
        });
        return;
      }

      // 获取当前黑名单
      const current_blacklist = await this.oi_repository.get_monitoring_config('symbol_blacklist') || [];

      // 检查是否已存在
      if (current_blacklist.includes(symbol)) {
        res.status(400).json({
          success: false,
          error: 'Symbol already in blacklist',
          message: `${symbol} is already in the blacklist`
        });
        return;
      }

      // 添加到黑名单
      const new_blacklist = [...current_blacklist, symbol];
      await this.oi_repository.update_monitoring_config('symbol_blacklist', new_blacklist);

      res.json({
        success: true,
        message: `Added ${symbol} to blacklist`,
        data: {
          blacklist: new_blacklist,
          count: new_blacklist.length
        }
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to add to blacklist:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to add to blacklist',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 从黑名单移除币种
   */
  private async remove_from_blacklist(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;

      if (!symbol) {
        res.status(400).json({
          success: false,
          error: 'Invalid request',
          message: 'symbol parameter is required'
        });
        return;
      }

      // 获取当前黑名单
      const current_blacklist = await this.oi_repository.get_monitoring_config('symbol_blacklist') || [];

      // 检查是否存在
      if (!current_blacklist.includes(symbol)) {
        res.status(404).json({
          success: false,
          error: 'Symbol not found in blacklist',
          message: `${symbol} is not in the blacklist`
        });
        return;
      }

      // 从黑名单移除
      const new_blacklist = current_blacklist.filter((s: string) => s !== symbol);
      await this.oi_repository.update_monitoring_config('symbol_blacklist', new_blacklist);

      res.json({
        success: true,
        message: `Removed ${symbol} from blacklist`,
        data: {
          blacklist: new_blacklist,
          count: new_blacklist.length
        }
      });
    } catch (error) {
      console.error('[OIRoutes] Failed to remove from blacklist:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to remove from blacklist',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取路由实例
   */
  get_router(): Router {
    return this.router;
  }
}