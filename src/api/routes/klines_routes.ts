import { Router, Request, Response } from 'express';
import { KlineMultiTableRepository } from '@/database';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';
import { logger } from '@/utils/logger';

export class KlinesRoutes {
  private router: Router;
  private kline_repository: KlineMultiTableRepository;
  private top_symbols_manager: TopSymbolsManager;

  constructor() {
    this.router = Router();
    this.kline_repository = new KlineMultiTableRepository();
    this.top_symbols_manager = TopSymbolsManager.get_instance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // ⚠️ 重要：具体路径必须在参数化路由之前，避免被通配符误匹配

    // 获取支持的时间周期列表
    this.router.get('/config/intervals', this.get_supported_intervals.bind(this));

    // 获取TOP币种的K线数据概览
    this.router.get('/overview/top-symbols', this.get_top_symbols_overview.bind(this));

    // 批量获取多个币种的最新K线
    this.router.post('/batch/latest', this.get_batch_latest_klines.bind(this));

    // 获取最新K线数据
    this.router.get('/:symbol/:interval/latest', this.get_latest_klines.bind(this));

    // 按时间范围查询K线数据
    this.router.get('/:symbol/:interval/range', this.get_klines_by_range.bind(this));

    // 检查数据完整性
    this.router.get('/:symbol/:interval/integrity', this.check_data_integrity.bind(this));

    // 获取K线数据统计信息
    this.router.get('/:symbol/statistics', this.get_kline_statistics.bind(this));

    // 获取K线数据（智能选择存储表）- 必须放最后，避免误匹配
    this.router.get('/:symbol/:interval', this.get_klines.bind(this));
  }

  /**
   * 获取K线数据（智能选择存储表）
   */
  private async get_klines(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { limit = 300, start_time, end_time } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 300, 1000);

      // 统一使用分表repository
      let klines = [];

      if (start_time || end_time) {
        const parsed_start_time = start_time ? parseInt(start_time as string) : undefined;
        const parsed_end_time = end_time ? parseInt(end_time as string) : undefined;
        klines = await this.kline_repository.find_by_time_range(
          symbol_upper, interval, parsed_start_time, parsed_end_time, parsed_limit
        );
      } else {
        klines = await this.kline_repository.find_latest(symbol_upper, interval, parsed_limit);
      }

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval: interval,
          count: klines.length,
          storage_type: 'multi_table',
          klines: klines
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get klines', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取最新K线数据
   */
  private async get_latest_klines(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { limit = 100 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 100, 500);

      // 统一使用分表repository
      const klines = await this.kline_repository.find_latest(symbol_upper, interval, parsed_limit);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval: interval,
          count: klines.length,
          klines: klines
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get latest klines', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 按时间范围查询K线数据
   */
  private async get_klines_by_range(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { start_time, end_time, limit = 1000 } = req.query;

      if (!start_time || !end_time) {
        res.status(400).json({
          error: 'start_time and end_time are required'
        });
        return;
      }

      const symbol_upper = symbol.toUpperCase();
      const parsed_start_time = parseInt(start_time as string);
      const parsed_end_time = parseInt(end_time as string);
      const parsed_limit = Math.min(parseInt(limit as string) || 1000, 2000);

      if (isNaN(parsed_start_time) || isNaN(parsed_end_time)) {
        res.status(400).json({
          error: 'Invalid timestamp format'
        });
        return;
      }

      // 统一使用分表repository
      const klines = await this.kline_repository.find_by_time_range(
        symbol_upper, interval, parsed_start_time, parsed_end_time, parsed_limit
      );

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval: interval,
          start_time: parsed_start_time,
          end_time: parsed_end_time,
          count: klines.length,
          klines: klines
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get klines by range', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取K线数据统计信息
   */
  private async get_kline_statistics(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const symbol_upper = symbol.toUpperCase();

      // 获取分表统计
      const stats = await this.kline_repository.get_symbol_statistics(symbol_upper);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          storage: stats,
          supported_intervals: this.kline_repository.get_supported_intervals()
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get kline statistics', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 检查数据完整性
   */
  private async check_data_integrity(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { days = 1 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_days = Math.min(parseInt(days as string) || 1, 30); // 最大30天

      const supported_intervals = this.kline_repository.get_supported_intervals();

      if (!supported_intervals.includes(interval)) {
        res.status(400).json({
          error: `Data integrity check only supported for intervals: ${supported_intervals.join(', ')}`
        });
        return;
      }

      const integrity_result = await this.kline_repository.check_data_integrity(
        symbol_upper, interval, parsed_days
      );

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval: interval,
          days_checked: parsed_days,
          ...integrity_result
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to check data integrity', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取支持的时间周期列表
   */
  private async get_supported_intervals(req: Request, res: Response): Promise<void> {
    try {
      const supported_intervals = this.kline_repository.get_supported_intervals();

      res.json({
        success: true,
        data: {
          supported_intervals: supported_intervals
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get supported intervals', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取TOP币种的K线数据概览
   */
  private async get_top_symbols_overview(req: Request, res: Response): Promise<void> {
    try {
      const { interval = '1m', limit = 10 } = req.query;

      const top_symbols = await this.top_symbols_manager.get_enabled_symbols();
      const overview = [];

      for (const symbol_config of top_symbols.slice(0, parseInt(limit as string) || 10)) {
        try {
          // 统一使用分表repository
          const klines = await this.kline_repository.find_latest(symbol_config.symbol, interval as string, 1);
          const latest_kline = klines.length > 0 ? klines[0] : null;

          overview.push({
            symbol: symbol_config.symbol,
            display_name: symbol_config.display_name,
            rank_order: symbol_config.rank_order,
            latest_kline: latest_kline,
            has_data: latest_kline !== null
          });

        } catch (error) {
          logger.warn(`Failed to get data for ${symbol_config.symbol}`, error);
          overview.push({
            symbol: symbol_config.symbol,
            display_name: symbol_config.display_name,
            rank_order: symbol_config.rank_order,
            latest_kline: null,
            has_data: false,
            error: 'Failed to fetch data'
          });
        }
      }

      res.json({
        success: true,
        data: {
          interval: interval,
          overview: overview
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get top symbols overview', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 批量获取多个币种的最新K线
   */
  private async get_batch_latest_klines(req: Request, res: Response): Promise<void> {
    try {
      const { symbols, interval = '1m', limit = 1 } = req.body;

      if (!Array.isArray(symbols) || symbols.length === 0) {
        res.status(400).json({
          error: 'symbols array is required'
        });
        return;
      }

      if (symbols.length > 20) {
        res.status(400).json({
          error: 'Maximum 20 symbols per request'
        });
        return;
      }

      const parsed_limit = Math.min(parseInt(limit) || 1, 100);
      const results = [];

      for (const symbol of symbols) {
        const symbol_upper = symbol.toUpperCase();
        try {
          // 统一使用分表repository
          const klines = await this.kline_repository.find_latest(symbol_upper, interval, parsed_limit);

          results.push({
            symbol: symbol_upper,
            success: true,
            count: klines.length,
            klines: klines
          });

        } catch (error) {
          logger.warn(`Failed to get klines for ${symbol_upper}`, error);
          results.push({
            symbol: symbol_upper,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            klines: []
          });
        }
      }

      res.json({
        success: true,
        data: {
          interval: interval,
          requested_symbols: symbols.length,
          results: results
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get batch latest klines', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  get_router(): Router {
    return this.router;
  }
}