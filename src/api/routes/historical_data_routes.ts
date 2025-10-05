import { Router, Request, Response } from 'express';
import { HistoricalDataManager } from '@/core/data/historical_data_manager';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';
import { logger } from '@/utils/logger';

export class HistoricalDataRoutes {
  private router: Router;
  private historical_data_manager: HistoricalDataManager;
  private top_symbols_manager: TopSymbolsManager;

  constructor() {
    this.router = Router();
    this.historical_data_manager = HistoricalDataManager.getInstance();
    this.top_symbols_manager = TopSymbolsManager.get_instance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 获取历史K线数据
    this.router.get('/klines/:symbol', this.get_historical_klines.bind(this));

    // 获取最新K线数据
    this.router.get('/klines/:symbol/latest', this.get_latest_klines.bind(this));

    // 按时间范围获取K线数据
    this.router.get('/klines/:symbol/range', this.get_klines_by_range.bind(this));

    // 预加载热门币种历史数据
    this.router.post('/preload/popular', this.preload_popular_symbols.bind(this));

    // 获取缓存统计信息
    this.router.get('/cache/stats', this.get_cache_stats.bind(this));
  }

  /**
   * 获取历史K线数据
   * @param req - 请求对象
   * @param res - 响应对象
   */
  private async get_historical_klines(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const {
        interval = '1m',
        start_time,
        end_time,
        limit = 300
      } = req.query;

      // 验证参数
      if (!symbol) {
        res.status(400).json({
          error: 'Symbol is required',
          code: 'INVALID_SYMBOL'
        });
        return;
      }

      // 验证interval是否为支持的格式
      const valid_intervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1mo'];
      if (!valid_intervals.includes(interval as string)) {
        res.status(400).json({
          error: `Invalid interval. Supported intervals: ${valid_intervals.join(', ')}`,
          code: 'INVALID_INTERVAL'
        });
        return;
      }

      const symbol_upper = symbol.toUpperCase();
      const parsed_start_time = start_time ? parseInt(start_time as string) : undefined;
      const parsed_end_time = end_time ? parseInt(end_time as string) : undefined;
      const parsed_limit = Math.min(parseInt(limit as string) || 300, 1000); // 最大1000条

      logger.info(`Fetching historical klines for ${symbol_upper}:${interval}, limit: ${parsed_limit}`);

      const klines = await this.historical_data_manager.get_historical_klines(
        symbol_upper,
        interval as string,
        parsed_start_time,
        parsed_end_time,
        parsed_limit
      );

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
      logger.error('Failed to get historical klines', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'SERVER_ERROR'
      });
    }
  }

  /**
   * 获取最新K线数据
   * @param req - 请求对象
   * @param res - 响应对象
   */
  private async get_latest_klines(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { interval = '1m', limit = 100 } = req.query;

      if (!symbol) {
        res.status(400).json({
          error: 'Symbol is required',
          code: 'INVALID_SYMBOL'
        });
        return;
      }

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 100, 500); // 最大500条

      const klines = await this.historical_data_manager.get_latest_klines(
        symbol_upper,
        interval as string,
        parsed_limit
      );

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
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'SERVER_ERROR'
      });
    }
  }

  /**
   * 按时间范围获取K线数据
   * @param req - 请求对象
   * @param res - 响应对象
   */
  private async get_klines_by_range(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { interval = '1m', start_time, end_time } = req.query;

      if (!symbol || !start_time || !end_time) {
        res.status(400).json({
          error: 'Symbol, start_time and end_time are required',
          code: 'MISSING_PARAMETERS'
        });
        return;
      }

      const symbol_upper = symbol.toUpperCase();
      const parsed_start_time = parseInt(start_time as string);
      const parsed_end_time = parseInt(end_time as string);

      if (isNaN(parsed_start_time) || isNaN(parsed_end_time)) {
        res.status(400).json({
          error: 'Invalid timestamp format',
          code: 'INVALID_TIMESTAMP'
        });
        return;
      }

      if (parsed_start_time >= parsed_end_time) {
        res.status(400).json({
          error: 'start_time must be less than end_time',
          code: 'INVALID_TIME_RANGE'
        });
        return;
      }

      const klines = await this.historical_data_manager.get_klines_by_time_range(
        symbol_upper,
        interval as string,
        parsed_start_time,
        parsed_end_time
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
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'SERVER_ERROR'
      });
    }
  }

  /**
   * 预加载热门币种历史数据
   * @param req - 请求对象
   * @param res - 响应对象
   */
  private async preload_popular_symbols(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Starting to preload popular symbols data');

      await this.historical_data_manager.preload_popular_symbols();

      res.json({
        success: true,
        message: 'Popular symbols data preloaded successfully',
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to preload popular symbols', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'SERVER_ERROR'
      });
    }
  }

  /**
   * 获取缓存统计信息
   * @param req - 请求对象
   * @param res - 响应对象
   */
  private async get_cache_stats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.historical_data_manager.get_cache_statistics();

      res.json({
        success: true,
        data: stats,
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get cache stats', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'SERVER_ERROR'
      });
    }
  }

  get_router(): Router {
    return this.router;
  }
}