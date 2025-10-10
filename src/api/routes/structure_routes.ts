import { Router, Request, Response } from 'express';
import { StructureRepository } from '@/database/structure_repository';
import { StructureConfigManager } from '@/core/config/structure_config';
import { logger } from '@/utils/logger';

/**
 * 结构形态检测路由
 */
export class StructureRoutes {
  private router: Router;
  private structure_repository: StructureRepository;
  private config_manager: StructureConfigManager;

  constructor() {
    this.router = Router();
    this.structure_repository = new StructureRepository();
    this.config_manager = StructureConfigManager.getInstance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 获取区间形态
    this.router.get('/ranges/:symbol/:interval', async (req: Request, res: Response) => {
      try {
        const { symbol, interval } = req.params;
        const limit = parseInt(req.query.limit as string) || 10;
        const status = req.query.status as any;

        let ranges;
        if (status === 'forming') {
          ranges = await this.structure_repository.get_forming_ranges(symbol, interval, limit);
        } else {
          ranges = await this.structure_repository.get_latest_ranges(symbol, interval, limit);
        }

        res.json({
          success: true,
          data: ranges,
          count: ranges.length
        });
      } catch (error) {
        logger.error('[API] Get ranges error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get ranges'
        });
      }
    });

    // 获取突破信号
    this.router.get('/breakouts/:symbol/:interval', async (req: Request, res: Response) => {
      try {
        const { symbol, interval } = req.params;
        const limit = parseInt(req.query.limit as string) || 20;

        const signals = await this.structure_repository.get_latest_breakout_signals(symbol, interval, limit);

        res.json({
          success: true,
          data: signals,
          count: signals.length
        });
      } catch (error) {
        logger.error('[API] Get breakout signals error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get breakout signals'
        });
      }
    });

    // 获取统计数据
    this.router.get('/statistics/:symbol/:interval', async (req: Request, res: Response) => {
      try {
        const { symbol, interval } = req.params;
        const days = parseInt(req.query.days as string) || 30;

        const stats = await this.structure_repository.get_signal_statistics(symbol, interval, days);

        res.json({
          success: true,
          data: stats
        });
      } catch (error) {
        logger.error('[API] Get statistics error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get statistics'
        });
      }
    });

    // 更新信号结果
    this.router.post('/update-signal-result/:signal_id', async (req: Request, res: Response) => {
      try {
        const signal_id = parseInt(req.params.signal_id);
        const { result, actual_exit_price } = req.body;

        if (!['hit_target', 'hit_stop', 'failed'].includes(result)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid result value'
          });
        }

        await this.structure_repository.update_signal_result(
          signal_id,
          result,
          actual_exit_price ? parseFloat(actual_exit_price) : undefined
        );

        res.json({
          success: true,
          message: 'Signal result updated'
        });
      } catch (error) {
        logger.error('[API] Update signal result error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to update signal result'
        });
      }
    });

    // 获取配置
    this.router.get('/config', (req: Request, res: Response) => {
      try {
        const config = this.config_manager.get_config();

        res.json({
          success: true,
          data: config
        });
      } catch (error) {
        logger.error('[API] Get config error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get config'
        });
      }
    });

    // 更新配置
    this.router.put('/config', (req: Request, res: Response) => {
      try {
        const updates = req.body;

        this.config_manager.update_config(updates);

        res.json({
          success: true,
          message: 'Configuration updated',
          data: this.config_manager.get_config()
        });
      } catch (error) {
        logger.error('[API] Update config error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to update config'
        });
      }
    });

    // 重置配置
    this.router.post('/config/reset', (req: Request, res: Response) => {
      try {
        this.config_manager.reset_to_default();

        res.json({
          success: true,
          message: 'Configuration reset to default',
          data: this.config_manager.get_config()
        });
      } catch (error) {
        logger.error('[API] Reset config error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to reset config'
        });
      }
    });

    // 获取缠论分析数据 (供前端图表展示)
    this.router.get('/chan-analysis/:symbol/:interval', async (req: Request, res: Response) => {
      try {
        const { symbol, interval } = req.params;
        const lookback = parseInt(req.query.lookback as string) || 200;

        // 验证参数
        if (!symbol || !interval) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: symbol and interval'
          });
        }

        // 验证周期
        const valid_intervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
        if (!valid_intervals.includes(interval)) {
          return res.status(400).json({
            success: false,
            error: `Invalid interval. Allowed values: ${valid_intervals.join(', ')}`
          });
        }

        // 导入必要的模块
        const { KlineMultiTableRepository } = await import('@/database/kline_multi_table_repository');
        const { ChanAnalyzerV2 } = await import('@/analysis/chan_theory');

        const kline_repo = new KlineMultiTableRepository();

        // 使用V2版本 - 标准缠论算法
        const chan_analyzer = new ChanAnalyzerV2();

        // 获取K线数据
        const klines = await kline_repo.find_latest(symbol, interval, lookback);

        if (klines.length < 50) {
          return res.status(400).json({
            success: false,
            error: `Insufficient K-line data. Got ${klines.length}, need at least 50`
          });
        }

        // 缠论分析 (数据库返回降序，需要反转)
        const ordered_klines = [...klines].reverse();
        const chan_result = chan_analyzer.analyze(ordered_klines);

        // 转换为前端可视化数据
        const visualization_data = {
          symbol: chan_result.symbol,
          interval: chan_result.interval,
          analysis_time: chan_result.analysis_time,
          kline_count: chan_result.kline_count,

          // 分型数据 (用于图表标记)
          fractals: chan_result.fractals.map(f => ({
            type: f.type,
            kline_index: f.kline_index,
            price: f.price,
            time: f.time,
            strength: f.strength,
            is_confirmed: f.is_confirmed
          })),

          // 笔数据 (用于画线)
          strokes: chan_result.strokes.map(s => ({
            id: s.id,
            direction: s.direction,
            start: {
              index: s.start_index,
              price: s.start_fractal.price,
              time: s.start_time
            },
            end: {
              index: s.end_index,
              price: s.end_fractal.price,
              time: s.end_time
            },
            amplitude_percent: s.amplitude_percent,
            duration_bars: s.duration_bars,
            is_valid: s.is_valid
          })),

          // 中枢数据 (用于画矩形区域)
          centers: chan_result.centers.map(c => ({
            id: c.id,
            high: c.high,
            low: c.low,
            middle: c.middle,
            height_percent: c.height_percent,
            start_time: c.start_time,
            end_time: c.end_time,
            start_index: c.start_index,
            end_index: c.end_index,
            duration_bars: c.duration_bars,
            strength: c.strength,
            stroke_count: c.stroke_count,
            is_active: !c.is_completed,
            is_extending: c.is_extending,
            extension_count: c.extension_count
          })),

          // 当前状态
          current_state: {
            in_center: !!chan_result.current_center,
            center_id: chan_result.current_center?.id,
            last_stroke_direction: chan_result.last_stroke?.direction,
            last_fractal_type: chan_result.last_fractal?.type
          },

          // 统计信息
          statistics: {
            total_fractals: chan_result.fractals.length,
            valid_fractals: chan_result.valid_fractal_count,
            total_strokes: chan_result.strokes.length,
            valid_strokes: chan_result.valid_stroke_count,
            total_centers: chan_result.centers.length,
            valid_centers: chan_result.valid_center_count
          }
        };

        res.json({
          success: true,
          data: visualization_data
        });

      } catch (error) {
        logger.error('[API] Chan analysis error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to analyze',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // 手动触发区间检测
    this.router.post('/detect/:symbol/:interval', async (req: Request, res: Response) => {
      try {
        const { symbol, interval } = req.params;
        const force = req.query.force === 'true'; // 是否强制重新检测

        // 验证参数
        if (!symbol || !interval) {
          return res.status(400).json({
            success: false,
            error: 'Missing required parameters: symbol and interval'
          });
        }

        // 验证周期
        const valid_intervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
        if (!valid_intervals.includes(interval)) {
          return res.status(400).json({
            success: false,
            error: `Invalid interval. Allowed values: ${valid_intervals.join(', ')}`
          });
        }

        // 导入必要的模块
        const { KlineMultiTableRepository } = await import('@/database/kline_multi_table_repository');
        const { RangeDetector } = await import('@/analysis/range_detector');

        const kline_repo = new KlineMultiTableRepository();
        const range_detector = new RangeDetector();

        // 使用配置中的lookback值
        const lookback = this.config_manager.get_config().range_detection.lookback;

        // 获取K线数据（多获取一些以确保有足够数据）
        const klines = await kline_repo.find_latest(symbol, interval, lookback);

        if (klines.length < 50) {
          return res.status(400).json({
            success: false,
            error: `Insufficient K-line data. Got ${klines.length}, need at least 50`
          });
        }

        // 检测区间（使用配置的lookback值）
        const ranges = range_detector.detect_ranges(klines, lookback);

        if (ranges.length === 0) {
          return res.json({
            success: true,
            message: 'No ranges detected',
            data: {
              symbol,
              interval,
              kline_count: klines.length,
              ranges: [],
              detected_count: 0
            }
          });
        }

        // 保存区间（根据force参数决定是否去重）
        let saved_count = 0;
        const saved_ranges = [];

        for (const range of ranges) {
          if (!force) {
            // 检查是否存在相似区间
            const existing_ranges = await this.structure_repository.get_forming_ranges(symbol, interval, 10);
            let is_duplicate = false;

            for (const existing of existing_ranges) {
              const support_diff = Math.abs(range.support - existing.support) / existing.support;
              const resistance_diff = Math.abs(range.resistance - existing.resistance) / existing.resistance;

              if (support_diff < 0.01 && resistance_diff < 0.01) {
                // 检查时间重叠
                const time_overlap =
                  (range.start_time >= existing.start_time && range.start_time <= existing.end_time) ||
                  (range.end_time >= existing.start_time && range.end_time <= existing.end_time) ||
                  (range.start_time <= existing.start_time && range.end_time >= existing.end_time);

                if (time_overlap) {
                  is_duplicate = true;
                  break;
                }
              }
            }

            if (is_duplicate) {
              continue; // 跳过重复区间
            }
          }

          // 保存区间
          const range_id = await this.structure_repository.save_range(range);
          saved_ranges.push({ ...range, id: range_id });
          saved_count++;
        }

        res.json({
          success: true,
          message: `Detected ${ranges.length} ranges, saved ${saved_count} unique ranges`,
          data: {
            symbol,
            interval,
            kline_count: klines.length,
            detected_count: ranges.length,
            saved_count,
            ranges: saved_ranges
          }
        });

      } catch (error) {
        logger.error('[API] Manual detection error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to detect ranges',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  get_router(): Router {
    return this.router;
  }
}
