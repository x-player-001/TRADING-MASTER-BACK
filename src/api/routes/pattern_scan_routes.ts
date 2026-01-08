/**
 * 形态扫描 API 路由
 *
 * 接口:
 * - POST   /api/pattern-scan/start           启动扫描任务
 * - POST   /api/pattern-scan/pullback        扫描上涨回调形态（自定义参数）
 * - POST   /api/pattern-scan/consolidation   扫描横盘震荡形态（自定义参数）
 * - POST   /api/pattern-scan/double-bottom   扫描双底形态（自定义参数）
 * - POST   /api/pattern-scan/surge-w-bottom  扫描上涨后W底形态（自定义参数）
 * - POST   /api/pattern-scan/surge-ema-pullback 扫描上涨回调靠近EMA形态（自定义参数）
 * - GET    /api/pattern-scan/tasks           获取任务列表
 * - GET    /api/pattern-scan/tasks/:task_id  获取任务状态
 * - GET    /api/pattern-scan/results/:task_id 获取扫描结果
 * - GET    /api/pattern-scan/latest          获取最新扫描结果
 * - GET    /api/pattern-scan/pattern-types   获取支持的形态类型
 * - GET    /api/pattern-scan/blacklist       获取黑名单列表
 * - POST   /api/pattern-scan/blacklist       添加币种到黑名单
 * - DELETE /api/pattern-scan/blacklist/:symbol 从黑名单移除币种
 * - DELETE /api/pattern-scan/tasks/cleanup   清理旧任务
 * - DELETE /api/pattern-scan/all             删除所有扫描结果和任务
 */

import { Router, Request, Response } from 'express';
import { PatternScanService } from '@/services/pattern_scan_service';
import { PatternType } from '@/database/pattern_scan_repository';
import { logger } from '@/utils/logger';

const router = Router();

// 全局service实例（由主脚本注入）
let scan_service: PatternScanService | null = null;

/**
 * 设置Service实例
 */
export function set_pattern_scan_service(service: PatternScanService): void {
  scan_service = service;
}

/**
 * 获取Service实例
 */
function get_service(): PatternScanService {
  if (!scan_service) {
    scan_service = new PatternScanService();
  }
  return scan_service;
}

/**
 * POST /api/pattern-scan/start
 * 启动形态扫描任务
 */
router.post('/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      interval = '1h',
      lookback_bars = 100
    } = req.body;

    // 验证参数
    const valid_intervals = ['5m', '15m', '1h', '4h'];
    if (!valid_intervals.includes(interval)) {
      res.status(400).json({
        success: false,
        error: `Invalid interval. Valid options: ${valid_intervals.join(', ')}`
      });
      return;
    }

    if (lookback_bars < 30 || lookback_bars > 500) {
      res.status(400).json({
        success: false,
        error: 'lookback_bars must be between 30 and 500'
      });
      return;
    }

    const service = get_service();

    // 检查是否有任务在运行
    if (service.get_running_count() > 0) {
      res.status(409).json({
        success: false,
        error: 'A scan task is already running'
      });
      return;
    }

    // 启动扫描
    const task_id = await service.start_scan({ interval, lookback_bars });

    res.json({
      success: true,
      data: {
        task_id,
        interval,
        lookback_bars,
        message: 'Scan task started'
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Start scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/pattern-scan/pullback
 * 扫描上涨回调形态（自定义参数，同步返回结果）
 *
 * 请求体参数:
 * - interval: K线周期 (5m, 15m, 1h, 4h)，默认 1h
 * - lookback_bars: 分析的K线数量，默认 100
 * - min_surge_pct: 最小上涨幅度 (%)，默认 20
 * - max_retrace_pct: 最大回调幅度 (%)，默认 50
 * - end_time: 最后一根K线时间 (ms)，默认当前时间
 */
router.post('/pullback', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      interval = '1h',
      lookback_bars = 100,
      min_surge_pct = 20,
      max_retrace_pct = 50,
      end_time
    } = req.body;

    // 验证参数
    const valid_intervals = ['5m', '15m', '1h', '4h'];
    if (!valid_intervals.includes(interval)) {
      res.status(400).json({
        success: false,
        error: `Invalid interval. Valid options: ${valid_intervals.join(', ')}`
      });
      return;
    }

    if (lookback_bars < 30 || lookback_bars > 500) {
      res.status(400).json({
        success: false,
        error: 'lookback_bars must be between 30 and 500'
      });
      return;
    }

    if (min_surge_pct < 5 || min_surge_pct > 200) {
      res.status(400).json({
        success: false,
        error: 'min_surge_pct must be between 5 and 200'
      });
      return;
    }

    if (max_retrace_pct < 10 || max_retrace_pct > 100) {
      res.status(400).json({
        success: false,
        error: 'max_retrace_pct must be between 10 and 100'
      });
      return;
    }

    // 验证 end_time
    const parsed_end_time = end_time ? Number(end_time) : undefined;
    if (parsed_end_time !== undefined && (isNaN(parsed_end_time) || parsed_end_time <= 0)) {
      res.status(400).json({
        success: false,
        error: 'end_time must be a valid timestamp in milliseconds'
      });
      return;
    }

    const service = get_service();

    // 执行扫描
    const results = await service.scan_pullback({
      interval,
      lookback_bars,
      min_surge_pct,
      max_retrace_pct,
      end_time: parsed_end_time
    });

    res.json({
      success: true,
      data: {
        params: {
          interval,
          lookback_bars,
          min_surge_pct,
          max_retrace_pct,
          end_time: parsed_end_time
        },
        results,
        count: results.length
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Pullback scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/pattern-scan/consolidation
 * 扫描横盘震荡形态（自定义参数，同步返回结果）
 *
 * 请求体参数:
 * - interval: K线周期 (5m, 15m, 1h, 4h)，默认 1h
 * - min_bars: 最小横盘K线数量，默认 20
 * - max_range_pct: 最大震荡幅度 (%)，默认 10
 * - require_fake_breakdown: 是否要求有向下假突破，默认 false
 * - end_time: 最后一根K线时间 (ms)，默认当前时间
 */
router.post('/consolidation', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      interval = '1h',
      min_bars = 20,
      max_range_pct = 10,
      require_fake_breakdown = false,
      end_time
    } = req.body;

    // 验证参数
    const valid_intervals = ['5m', '15m', '1h', '4h'];
    if (!valid_intervals.includes(interval)) {
      res.status(400).json({
        success: false,
        error: `Invalid interval. Valid options: ${valid_intervals.join(', ')}`
      });
      return;
    }

    if (min_bars < 10 || min_bars > 200) {
      res.status(400).json({
        success: false,
        error: 'min_bars must be between 10 and 200'
      });
      return;
    }

    if (max_range_pct < 1 || max_range_pct > 50) {
      res.status(400).json({
        success: false,
        error: 'max_range_pct must be between 1 and 50'
      });
      return;
    }

    // 验证 end_time
    const parsed_end_time = end_time ? Number(end_time) : undefined;
    if (parsed_end_time !== undefined && (isNaN(parsed_end_time) || parsed_end_time <= 0)) {
      res.status(400).json({
        success: false,
        error: 'end_time must be a valid timestamp in milliseconds'
      });
      return;
    }

    const service = get_service();

    // 执行扫描
    const results = await service.scan_consolidation({
      interval,
      min_bars,
      max_range_pct,
      require_fake_breakdown: !!require_fake_breakdown,
      end_time: parsed_end_time
    });

    res.json({
      success: true,
      data: {
        params: {
          interval,
          min_bars,
          max_range_pct,
          require_fake_breakdown,
          end_time: parsed_end_time
        },
        results,
        count: results.length
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Consolidation scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/pattern-scan/double-bottom
 * 扫描双底形态（自定义参数，同步返回结果）
 *
 * 请求体参数:
 * - interval: K线周期 (5m, 15m, 1h, 4h)，默认 1h
 * - lookback_bars: 分析的K线数量，默认 100
 * - min_bars_between: 两个底之间最小K线数量，默认 10
 * - bottom_tolerance_pct: 底部价差容忍度 (%)，默认 2
 * - end_time: 最后一根K线时间 (ms)，默认当前时间
 */
router.post('/double-bottom', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      interval = '1h',
      lookback_bars = 100,
      min_bars_between = 10,
      bottom_tolerance_pct = 2,
      end_time
    } = req.body;

    // 验证参数
    const valid_intervals = ['5m', '15m', '1h', '4h'];
    if (!valid_intervals.includes(interval)) {
      res.status(400).json({
        success: false,
        error: `Invalid interval. Valid options: ${valid_intervals.join(', ')}`
      });
      return;
    }

    if (lookback_bars < 30 || lookback_bars > 500) {
      res.status(400).json({
        success: false,
        error: 'lookback_bars must be between 30 and 500'
      });
      return;
    }

    if (min_bars_between < 5 || min_bars_between > 100) {
      res.status(400).json({
        success: false,
        error: 'min_bars_between must be between 5 and 100'
      });
      return;
    }

    if (bottom_tolerance_pct < 0.5 || bottom_tolerance_pct > 10) {
      res.status(400).json({
        success: false,
        error: 'bottom_tolerance_pct must be between 0.5 and 10'
      });
      return;
    }

    // 验证 end_time
    const parsed_end_time = end_time ? Number(end_time) : undefined;
    if (parsed_end_time !== undefined && (isNaN(parsed_end_time) || parsed_end_time <= 0)) {
      res.status(400).json({
        success: false,
        error: 'end_time must be a valid timestamp in milliseconds'
      });
      return;
    }

    const service = get_service();

    // 执行扫描
    const results = await service.scan_double_bottom({
      interval,
      lookback_bars,
      min_bars_between,
      bottom_tolerance_pct,
      end_time: parsed_end_time
    });

    res.json({
      success: true,
      data: {
        params: {
          interval,
          lookback_bars,
          min_bars_between,
          bottom_tolerance_pct,
          end_time: parsed_end_time
        },
        results,
        count: results.length
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Double bottom scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/pattern-scan/surge-w-bottom
 * 扫描上涨后W底形态（自定义参数，同步返回结果）
 *
 * 请求体参数:
 * - interval: K线周期 (5m, 15m, 1h, 4h)，默认 1h
 * - lookback_bars: 分析的K线数量，默认 100
 * - min_surge_pct: 最小上涨幅度 (%)，默认 20
 * - max_retrace_pct: 最大回调幅度 (%)，默认 50
 * - max_distance_to_bottom_pct: 当前价格距W底底部的最大距离 (%)，默认 5
 * - end_time: 最后一根K线时间 (ms)，默认当前时间
 */
router.post('/surge-w-bottom', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      interval = '1h',
      lookback_bars = 100,
      min_surge_pct = 20,
      max_retrace_pct = 50,
      max_distance_to_bottom_pct = 5,
      end_time
    } = req.body;

    // 验证参数
    const valid_intervals = ['5m', '15m', '1h', '4h'];
    if (!valid_intervals.includes(interval)) {
      res.status(400).json({
        success: false,
        error: `Invalid interval. Valid options: ${valid_intervals.join(', ')}`
      });
      return;
    }

    if (lookback_bars < 50 || lookback_bars > 500) {
      res.status(400).json({
        success: false,
        error: 'lookback_bars must be between 50 and 500'
      });
      return;
    }

    if (min_surge_pct < 5 || min_surge_pct > 200) {
      res.status(400).json({
        success: false,
        error: 'min_surge_pct must be between 5 and 200'
      });
      return;
    }

    if (max_retrace_pct < 10 || max_retrace_pct > 80) {
      res.status(400).json({
        success: false,
        error: 'max_retrace_pct must be between 10 and 80'
      });
      return;
    }

    if (max_distance_to_bottom_pct < 1 || max_distance_to_bottom_pct > 20) {
      res.status(400).json({
        success: false,
        error: 'max_distance_to_bottom_pct must be between 1 and 20'
      });
      return;
    }

    // 验证 end_time
    const parsed_end_time = end_time ? Number(end_time) : undefined;
    if (parsed_end_time !== undefined && (isNaN(parsed_end_time) || parsed_end_time <= 0)) {
      res.status(400).json({
        success: false,
        error: 'end_time must be a valid timestamp in milliseconds'
      });
      return;
    }

    const service = get_service();

    // 执行扫描
    const results = await service.scan_surge_w_bottom({
      interval,
      lookback_bars,
      min_surge_pct,
      max_retrace_pct,
      max_distance_to_bottom_pct,
      end_time: parsed_end_time
    });

    res.json({
      success: true,
      data: {
        params: {
          interval,
          lookback_bars,
          min_surge_pct,
          max_retrace_pct,
          max_distance_to_bottom_pct,
          end_time: parsed_end_time
        },
        results,
        count: results.length
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Surge W bottom scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/pattern-scan/surge-ema-pullback
 * 扫描上涨回调靠近EMA形态（自定义参数，同步返回结果）
 *
 * 请求体参数:
 * - interval: K线周期 (5m, 15m, 1h, 4h)，默认 4h
 * - lookback_bars: 分析的K线数量，默认 200
 * - min_surge_pct: 最小上涨幅度 (%)，默认 30
 * - max_retrace_pct: 最大回调幅度 (%)，默认 50
 * - min_retrace_bars: 最小回调K线数，默认 10
 * - max_distance_to_ema_pct: 当前价格距EMA的最大距离 (%)，默认 5
 * - ema_period: EMA周期，默认 120
 * - end_time: 最后一根K线时间 (ms)，默认当前时间
 */
router.post('/surge-ema-pullback', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      interval = '4h',
      lookback_bars = 200,
      min_surge_pct = 30,
      max_retrace_pct = 50,
      min_retrace_bars = 10,
      max_distance_to_ema_pct = 5,
      ema_period = 120,
      end_time
    } = req.body;

    // 验证参数
    const valid_intervals = ['5m', '15m', '1h', '4h'];
    if (!valid_intervals.includes(interval)) {
      res.status(400).json({
        success: false,
        error: `Invalid interval. Valid options: ${valid_intervals.join(', ')}`
      });
      return;
    }

    if (lookback_bars < 50 || lookback_bars > 1000) {
      res.status(400).json({
        success: false,
        error: 'lookback_bars must be between 50 and 1000'
      });
      return;
    }

    if (min_surge_pct < 5 || min_surge_pct > 500) {
      res.status(400).json({
        success: false,
        error: 'min_surge_pct must be between 5 and 500'
      });
      return;
    }

    if (max_retrace_pct < 10 || max_retrace_pct > 100) {
      res.status(400).json({
        success: false,
        error: 'max_retrace_pct must be between 10 and 100'
      });
      return;
    }

    if (min_retrace_bars < 1 || min_retrace_bars > 100) {
      res.status(400).json({
        success: false,
        error: 'min_retrace_bars must be between 1 and 100'
      });
      return;
    }

    if (max_distance_to_ema_pct < 0.1 || max_distance_to_ema_pct > 30) {
      res.status(400).json({
        success: false,
        error: 'max_distance_to_ema_pct must be between 0.1 and 30'
      });
      return;
    }

    if (ema_period < 10 || ema_period > 500) {
      res.status(400).json({
        success: false,
        error: 'ema_period must be between 10 and 500'
      });
      return;
    }

    // 验证 lookback_bars 是否足够计算 EMA
    if (lookback_bars < ema_period + 20) {
      res.status(400).json({
        success: false,
        error: `lookback_bars must be at least ${ema_period + 20} (ema_period + 20) to calculate EMA${ema_period}`
      });
      return;
    }

    // 验证 end_time
    const parsed_end_time = end_time ? Number(end_time) : undefined;
    if (parsed_end_time !== undefined && (isNaN(parsed_end_time) || parsed_end_time <= 0)) {
      res.status(400).json({
        success: false,
        error: 'end_time must be a valid timestamp in milliseconds'
      });
      return;
    }

    const service = get_service();

    // 执行扫描
    const results = await service.scan_surge_ema_pullback({
      interval,
      lookback_bars,
      min_surge_pct,
      max_retrace_pct,
      min_retrace_bars,
      max_distance_to_ema_pct,
      ema_period,
      end_time: parsed_end_time
    });

    res.json({
      success: true,
      data: {
        params: {
          interval,
          lookback_bars,
          min_surge_pct,
          max_retrace_pct,
          min_retrace_bars,
          max_distance_to_ema_pct,
          ema_period,
          end_time: parsed_end_time
        },
        results,
        count: results.length
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Surge EMA pullback scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/pattern-scan/tasks
 * 获取任务列表
 */
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const {
      status,
      limit = '20'
    } = req.query;

    const service = get_service();
    const tasks = await service.get_tasks({
      status: status as 'pending' | 'running' | 'completed' | 'failed' | undefined,
      limit: parseInt(limit as string)
    });

    res.json({
      success: true,
      data: tasks,
      count: tasks.length
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Get tasks failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/pattern-scan/tasks/:task_id
 * 获取任务状态
 */
router.get('/tasks/:task_id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { task_id } = req.params;

    const service = get_service();
    const task = await service.get_task(task_id);

    if (!task) {
      res.status(404).json({
        success: false,
        error: 'Task not found'
      });
      return;
    }

    res.json({
      success: true,
      data: task
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Get task failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/pattern-scan/results/:task_id
 * 获取扫描结果
 */
router.get('/results/:task_id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { task_id } = req.params;
    const {
      pattern_type,
      min_score,
      symbol,
      limit = '100'
    } = req.query;

    const service = get_service();

    // 先检查任务是否存在
    const task = await service.get_task(task_id);
    if (!task) {
      res.status(404).json({
        success: false,
        error: 'Task not found'
      });
      return;
    }

    const results = await service.get_results(task_id, {
      pattern_type: pattern_type as PatternType | undefined,
      min_score: min_score ? parseInt(min_score as string) : undefined,
      symbol: symbol as string | undefined,
      limit: parseInt(limit as string)
    });

    res.json({
      success: true,
      data: {
        task,
        results,
        count: results.length
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Get results failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/pattern-scan/latest
 * 获取最新扫描结果
 */
router.get('/latest', async (req: Request, res: Response) => {
  try {
    const {
      pattern_type,
      min_score,
      limit = '500'
    } = req.query;

    const service = get_service();
    const results = await service.get_latest_results({
      pattern_type: pattern_type as PatternType | undefined,
      min_score: min_score ? parseInt(min_score as string) : undefined,
      limit: parseInt(limit as string)
    });

    res.json({
      success: true,
      data: results,
      count: results.length
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Get latest results failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/pattern-scan/pattern-types
 * 获取支持的形态类型列表
 */
router.get('/pattern-types', (req: Request, res: Response) => {
  const pattern_types = [
    { type: 'DOUBLE_BOTTOM', name: '双底 (W底)', description: '两个相近低点形成的底部形态，等待突破颈线' },
    { type: 'TRIPLE_BOTTOM', name: '三底', description: '三个相近低点形成的更强底部形态，等待突破颈线' },
    { type: 'PULLBACK', name: '上涨回调', description: '主升浪后回调至斐波那契位置企稳' },
    { type: 'CONSOLIDATION', name: '横盘震荡', description: '窄幅区间长时间横盘，等待突破' },
    { type: 'SURGE_W_BOTTOM', name: '上涨后W底', description: '先有明显上涨，回调后形成W底形态，当前价格接近底部' },
    { type: 'SURGE_EMA_PULLBACK', name: '上涨回调靠近EMA', description: '先有明显上涨，回调后靠近EMA均线，当前价格在EMA上方' }
  ];

  res.json({
    success: true,
    data: pattern_types
  });
});

/**
 * DELETE /api/pattern-scan/tasks/cleanup
 * 清理旧任务
 */
router.delete('/tasks/cleanup', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;

    const service = get_service();
    const deleted = await service.get_repository().cleanup_old_tasks(days);

    res.json({
      success: true,
      data: { deleted }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Cleanup tasks failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/pattern-scan/blacklist
 * 获取黑名单列表
 */
router.get('/blacklist', (req: Request, res: Response) => {
  try {
    const service = get_service();
    const blacklist = service.get_blacklist();

    res.json({
      success: true,
      data: blacklist,
      count: blacklist.length
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Get blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/pattern-scan/blacklist
 * 添加币种到黑名单
 */
router.post('/blacklist', (req: Request, res: Response): void => {
  try {
    const { symbol } = req.body;

    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({
        success: false,
        error: 'symbol is required'
      });
      return;
    }

    const service = get_service();
    const upper_symbol = symbol.toUpperCase();

    if (service.is_blacklisted(upper_symbol)) {
      res.status(409).json({
        success: false,
        error: `${upper_symbol} is already in blacklist`
      });
      return;
    }

    service.add_to_blacklist(upper_symbol);

    res.json({
      success: true,
      data: {
        symbol: upper_symbol,
        message: `${upper_symbol} added to blacklist`
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Add to blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/pattern-scan/blacklist/:symbol
 * 从黑名单移除币种
 */
router.delete('/blacklist/:symbol', (req: Request, res: Response): void => {
  try {
    const { symbol } = req.params;
    const service = get_service();
    const upper_symbol = symbol.toUpperCase();

    if (!service.is_blacklisted(upper_symbol)) {
      res.status(404).json({
        success: false,
        error: `${upper_symbol} is not in blacklist`
      });
      return;
    }

    service.remove_from_blacklist(upper_symbol);

    res.json({
      success: true,
      data: {
        symbol: upper_symbol,
        message: `${upper_symbol} removed from blacklist`
      }
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Remove from blacklist failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/pattern-scan/all
 * 删除所有扫描结果和任务
 */
router.delete('/all', async (req: Request, res: Response) => {
  try {
    const service = get_service();

    // 检查是否有任务在运行
    if (service.get_running_count() > 0) {
      res.status(409).json({
        success: false,
        error: 'Cannot delete while a scan task is running'
      });
      return;
    }

    const result = await service.get_repository().delete_all();

    res.json({
      success: true,
      data: result,
      message: `Deleted ${result.deleted_results} results and ${result.deleted_tasks} tasks`
    });
  } catch (error: any) {
    logger.error('[PatternScan API] Delete all failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
