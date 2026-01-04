/**
 * 成交量监控 API 路由
 *
 * 接口:
 * - GET    /api/volume-monitor/symbols          获取监控币种列表
 * - POST   /api/volume-monitor/symbols          添加监控币种
 * - PUT    /api/volume-monitor/symbols/:symbol  更新币种配置
 * - DELETE /api/volume-monitor/symbols/:symbol  删除监控币种
 * - PUT    /api/volume-monitor/symbols/:symbol/toggle  启用/禁用币种
 * - POST   /api/volume-monitor/symbols/batch    批量添加币种
 * - GET    /api/volume-monitor/alerts           查询放量报警
 * - GET    /api/volume-monitor/pattern-alerts   查询形态报警（倒锤头等）
 * - DELETE /api/volume-monitor/pattern-alerts/cleanup  清理旧形态报警
 * - GET    /api/volume-monitor/status           获取监控状态
 */

import { Router, Request, Response } from 'express';
import { VolumeMonitorRepository } from '@/database/volume_monitor_repository';
import { logger } from '@/utils/logger';

const router = Router();

// 全局repository实例（由主脚本注入）
let repository: VolumeMonitorRepository | null = null;

/**
 * 设置Repository实例
 */
export function set_volume_monitor_repository(repo: VolumeMonitorRepository): void {
  repository = repo;
}

/**
 * 获取Repository实例
 */
function get_repository(): VolumeMonitorRepository {
  if (!repository) {
    repository = new VolumeMonitorRepository();
  }
  return repository;
}

/**
 * GET /api/volume-monitor/symbols
 * 获取所有监控币种
 */
router.get('/symbols', async (req: Request, res: Response) => {
  try {
    const enabled_only = req.query.enabled === 'true';
    const repo = get_repository();

    const symbols = enabled_only
      ? await repo.get_enabled_symbols()
      : await repo.get_all_symbols();

    res.json({
      success: true,
      data: symbols,
      count: symbols.length
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Get symbols failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/volume-monitor/symbols
 * 添加监控币种
 */
router.post('/symbols', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      symbol,
      enabled = true,
      volume_multiplier = 2.5,
      lookback_bars = 20,
      min_volume_usdt = 100000
    } = req.body;

    if (!symbol) {
      res.status(400).json({
        success: false,
        error: 'symbol is required'
      });
      return;
    }

    const repo = get_repository();
    const id = await repo.add_symbol({
      symbol: symbol.toUpperCase(),
      enabled,
      volume_multiplier,
      lookback_bars,
      min_volume_usdt
    });

    res.json({
      success: true,
      data: { id, symbol: symbol.toUpperCase() }
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Add symbol failed:', error);

    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({
        success: false,
        error: 'Symbol already exists'
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/volume-monitor/symbols/:symbol
 * 更新币种配置
 */
router.put('/symbols/:symbol', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol } = req.params;
    const updates = req.body;

    const repo = get_repository();
    const success = await repo.update_symbol(symbol, updates);

    if (!success) {
      res.status(404).json({
        success: false,
        error: 'Symbol not found'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Symbol updated'
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Update symbol failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/volume-monitor/symbols/:symbol
 * 删除监控币种
 */
router.delete('/symbols/:symbol', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol } = req.params;

    const repo = get_repository();
    const success = await repo.delete_symbol(symbol);

    if (!success) {
      res.status(404).json({
        success: false,
        error: 'Symbol not found'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Symbol deleted'
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Delete symbol failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/volume-monitor/symbols/:symbol/toggle
 * 切换币种启用状态
 */
router.put('/symbols/:symbol/toggle', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol } = req.params;

    const repo = get_repository();
    const success = await repo.toggle_symbol(symbol);

    if (!success) {
      res.status(404).json({
        success: false,
        error: 'Symbol not found'
      });
      return;
    }

    // 获取更新后的状态
    const updated = await repo.get_symbol(symbol);

    res.json({
      success: true,
      data: updated
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Toggle symbol failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/volume-monitor/symbols/batch
 * 批量添加币种
 */
router.post('/symbols/batch', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbols } = req.body;

    if (!Array.isArray(symbols) || symbols.length === 0) {
      res.status(400).json({
        success: false,
        error: 'symbols array is required'
      });
      return;
    }

    const repo = get_repository();
    const added = await repo.add_symbols_batch(symbols);

    res.json({
      success: true,
      data: {
        requested: symbols.length,
        added
      }
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Batch add symbols failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/volume-monitor/alerts
 * 查询放量报警记录
 *
 * 查询参数:
 * - date: 日期 (格式: YYYY-MM-DD)，如 2026-01-03
 * - symbol: 币种符号
 * - start_time: 开始时间戳 (ms)
 * - end_time: 结束时间戳 (ms)
 * - min_ratio: 最小放量倍数
 * - direction: 方向 (UP/DOWN)
 * - limit: 返回数量限制
 *
 * 返回字段:
 * - daily_alert_index: 该币种当天第几次报警
 */
router.get('/alerts', async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      date,
      start_time,
      end_time,
      min_ratio,
      direction,
      limit = '100'
    } = req.query;

    const repo = get_repository();
    const alerts = await repo.get_alerts({
      symbol: symbol as string,
      date: date as string,  // 格式: YYYY-MM-DD
      start_time: start_time ? parseInt(start_time as string) : undefined,
      end_time: end_time ? parseInt(end_time as string) : undefined,
      min_ratio: min_ratio ? parseFloat(min_ratio as string) : undefined,
      direction: direction as 'UP' | 'DOWN' | undefined,
      limit: parseInt(limit as string)
    });

    // 格式化返回数据
    const formatted_alerts = alerts.map(alert => ({
      symbol: alert.symbol.replace('USDT', ''),
      kline_time: alert.kline_time,
      current_volume: alert.current_volume,
      avg_volume: alert.avg_volume,
      volume_ratio: parseFloat(alert.volume_ratio.toFixed(2)),
      price_change_pct: parseFloat(alert.price_change_pct.toFixed(2)),
      direction: alert.direction,
      current_price: alert.current_price,
      daily_alert_index: alert.daily_alert_index,
      is_important: alert.is_important,  // 从数据库读取
      created_at: alert.created_at
    }));

    res.json({
      success: true,
      data: formatted_alerts,
      count: formatted_alerts.length,
      params: {
        date: date || null,
        symbol: symbol || null,
        limit: parseInt(limit as string)
      }
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Get alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/volume-monitor/alerts/cleanup
 * 清理旧报警记录
 */
router.delete('/alerts/cleanup', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;

    const repo = get_repository();
    const deleted = await repo.cleanup_old_alerts(days);

    res.json({
      success: true,
      data: { deleted }
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Cleanup alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/volume-monitor/pattern-alerts
 * 查询形态报警记录（倒锤头穿越EMA120等）
 *
 * 查询参数:
 * - date: 日期 (格式: YYYY-MM-DD)，如 2026-01-04
 * - symbol: 币种符号
 * - start_time: 开始时间戳 (ms)
 * - end_time: 结束时间戳 (ms)
 * - pattern_type: 形态类型 (HAMMER_CROSS_EMA)
 * - is_final: 是否为完结K线 (true/false)
 * - limit: 返回数量限制
 *
 * 返回字段:
 * - daily_alert_index: 该币种当天第几次报警
 */
router.get('/pattern-alerts', async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      date,
      start_time,
      end_time,
      pattern_type,
      is_final,
      limit = '100'
    } = req.query;

    const repo = get_repository();
    const alerts = await repo.get_pattern_alerts({
      symbol: symbol as string,
      date: date as string,
      start_time: start_time ? parseInt(start_time as string) : undefined,
      end_time: end_time ? parseInt(end_time as string) : undefined,
      pattern_type: pattern_type as string,
      is_final: is_final !== undefined ? is_final === 'true' : undefined,
      limit: parseInt(limit as string)
    });

    // 格式化返回数据
    const formatted_alerts = alerts.map(alert => ({
      symbol: alert.symbol.replace('USDT', ''),
      kline_time: alert.kline_time,
      pattern_type: alert.pattern_type,
      current_price: alert.current_price,
      price_change_pct: parseFloat(alert.price_change_pct.toFixed(2)),
      ema120: alert.ema120,
      lower_shadow_pct: parseFloat(alert.lower_shadow_pct.toFixed(2)),
      upper_shadow_pct: parseFloat(alert.upper_shadow_pct.toFixed(2)),
      is_final: alert.is_final,
      daily_alert_index: alert.daily_alert_index,
      created_at: alert.created_at
    }));

    res.json({
      success: true,
      data: formatted_alerts,
      count: formatted_alerts.length,
      params: {
        date: date || null,
        symbol: symbol || null,
        pattern_type: pattern_type || null,
        limit: parseInt(limit as string)
      }
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Get pattern alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/volume-monitor/pattern-alerts/cleanup
 * 清理旧形态报警记录
 */
router.delete('/pattern-alerts/cleanup', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;

    const repo = get_repository();
    const deleted = await repo.cleanup_old_pattern_alerts(days);

    res.json({
      success: true,
      data: { deleted }
    });
  } catch (error: any) {
    logger.error('[VolumeMonitor API] Cleanup pattern alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
