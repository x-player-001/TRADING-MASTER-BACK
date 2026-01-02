/**
 * 形态扫描 API 路由
 *
 * 接口:
 * - POST   /api/pattern-scan/start           启动扫描任务
 * - GET    /api/pattern-scan/tasks           获取任务列表
 * - GET    /api/pattern-scan/tasks/:task_id  获取任务状态
 * - GET    /api/pattern-scan/results/:task_id 获取扫描结果
 * - GET    /api/pattern-scan/latest          获取最新扫描结果
 * - GET    /api/pattern-scan/pattern-types   获取支持的形态类型
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
      limit = '50'
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
    { type: 'CONSOLIDATION', name: '横盘震荡', description: '窄幅区间长时间横盘，等待突破' }
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
