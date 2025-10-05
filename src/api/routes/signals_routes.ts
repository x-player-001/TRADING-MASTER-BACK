import { Router, Request, Response } from 'express';
import { SignalRepository } from '@/database/signal_repository';
import { SignalGenerator } from '@/signals/signal_generator';
import { KlineMultiTableRepository } from '@/database/kline_multi_table_repository';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';
import { logger } from '@/utils/logger';

/**
 * 信号API路由
 */
export class SignalsRoutes {
  private router: Router;
  private signal_repository: SignalRepository;
  private kline_repository: KlineMultiTableRepository;
  private top_symbols_manager: TopSymbolsManager;

  constructor() {
    this.router = Router();
    this.signal_repository = new SignalRepository();
    this.kline_repository = new KlineMultiTableRepository();
    this.top_symbols_manager = TopSymbolsManager.get_instance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 获取最新信号
    this.router.get('/:symbol/:interval/latest', this.get_latest_signal.bind(this));

    // 获取历史信号
    this.router.get('/:symbol/:interval/history', this.get_signal_history.bind(this));

    // 获取多币种信号概览
    this.router.get('/overview/:interval', this.get_signals_overview.bind(this));

    // 手动生成信号（用于测试）
    this.router.post('/:symbol/:interval/generate', this.generate_signal_manually.bind(this));

    // 获取形态识别记录
    this.router.get('/:symbol/:interval/patterns', this.get_patterns.bind(this));
  }

  /**
   * 获取最新信号
   */
  private async get_latest_signal(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { limit = 1 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 1, 50);

      const signals = await this.signal_repository.get_latest_signals(
        symbol_upper,
        interval,
        parsed_limit
      );

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          count: signals.length,
          signals
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get latest signal', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取历史信号
   */
  private async get_signal_history(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { start_time, end_time, limit = 50 } = req.query;

      const symbol_upper = symbol.toUpperCase();

      let signals;
      if (start_time && end_time) {
        const parsed_start = parseInt(start_time as string);
        const parsed_end = parseInt(end_time as string);

        if (isNaN(parsed_start) || isNaN(parsed_end)) {
          res.status(400).json({
            success: false,
            error: 'Invalid timestamp format'
          });
          return;
        }

        signals = await this.signal_repository.get_signals_by_time_range(
          symbol_upper,
          interval,
          parsed_start,
          parsed_end
        );
      } else {
        const parsed_limit = Math.min(parseInt(limit as string) || 50, 200);
        signals = await this.signal_repository.get_latest_signals(
          symbol_upper,
          interval,
          parsed_limit
        );
      }

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          count: signals.length,
          signals
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get signal history', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取多币种信号概览
   */
  private async get_signals_overview(req: Request, res: Response): Promise<void> {
    try {
      const { interval } = req.params;
      const { limit = 10 } = req.query;

      // 获取启用的TOP币种
      const top_symbols = await this.top_symbols_manager.get_enabled_symbols();
      const symbols = top_symbols.slice(0, parseInt(limit as string) || 10).map(s => s.symbol);

      const signals = await this.signal_repository.get_signals_overview(symbols, interval);

      res.json({
        success: true,
        data: {
          interval,
          count: signals.length,
          signals
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get signals overview', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 手动生成信号（用于测试）
   */
  private async generate_signal_manually(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { kline_count = 100 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_count = Math.min(parseInt(kline_count as string) || 100, 500);

      // 获取K线数据
      const klines = await this.kline_repository.find_latest(symbol_upper, interval, parsed_count);

      if (klines.length < 60) {
        res.status(400).json({
          success: false,
          error: 'Insufficient kline data',
          message: `Need at least 60 klines, got ${klines.length}`
        });
        return;
      }

      // 生成信号
      const signal = await SignalGenerator.generate_signal(symbol_upper, interval, klines);

      if (!signal) {
        res.json({
          success: true,
          data: {
            symbol: symbol_upper,
            interval,
            signal: null,
            message: 'No signal generated (strength too weak or neutral)'
          },
          timestamp: Date.now()
        });
        return;
      }

      // 保存信号
      const signal_id = await this.signal_repository.save_signal(signal);

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          signal: { ...signal, id: signal_id },
          message: 'Signal generated and saved successfully'
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to generate signal manually', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取形态识别记录
   */
  private async get_patterns(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, interval } = req.params;
      const { limit = 10 } = req.query;

      const symbol_upper = symbol.toUpperCase();
      const parsed_limit = Math.min(parseInt(limit as string) || 10, 50);

      const patterns = await this.signal_repository.get_recent_patterns(
        symbol_upper,
        interval,
        parsed_limit
      );

      res.json({
        success: true,
        data: {
          symbol: symbol_upper,
          interval,
          count: patterns.length,
          patterns
        },
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to get patterns', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  get_router(): Router {
    return this.router;
  }
}
