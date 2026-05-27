/**
 * 趋势跟随报警 API 路由
 *
 * GET /api/trend-follow/alerts          查询报警列表
 * GET /api/trend-follow/alerts/recent   最近 N 条报警（前端轮询用）
 * DELETE /api/trend-follow/alerts/cleanup  清理旧数据
 */

import { Router, Request, Response } from 'express';
import { TrendFollowRepository } from '@/database/trend_follow_repository';
import { logger } from '@/utils/logger';

const router = Router();

let repository: TrendFollowRepository | null = null;

export function set_trend_follow_repository(repo: TrendFollowRepository): void {
  repository = repo;
}

function get_repository(): TrendFollowRepository {
  if (!repository) {
    repository = new TrendFollowRepository();
  }
  return repository;
}

/**
 * GET /api/trend-follow/alerts
 * 查询报警列表
 *
 * Query params:
 *   symbol      - 币种，如 BTCUSDT
 *   timeframe   - 周期，5m / 15m / 1h / 4h
 *   alert_level - 报警等级 1 / 2 / 3
 *   date        - 日期 YYYY-MM-DD（北京时间）
 *   start_time  - 开始时间戳(ms)
 *   end_time    - 结束时间戳(ms)
 *   limit       - 返回条数，默认 100
 */
router.get('/alerts', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      symbol,
      timeframe,
      alert_level,
      date,
      start_time,
      end_time,
      limit = '100',
    } = req.query as Record<string, string>;

    const alerts = await get_repository().get_alerts({
      symbol:      symbol?.toUpperCase(),
      timeframe,
      alert_level: alert_level !== undefined ? Number(alert_level) : undefined,
      date,
      start_time:  start_time !== undefined ? Number(start_time) : undefined,
      end_time:    end_time   !== undefined ? Number(end_time)   : undefined,
      limit:       Number(limit),
    });

    res.json({
      success: true,
      data:  alerts,
      count: alerts.length,
    });
  } catch (error: any) {
    logger.error('[TrendFollow API] get_alerts failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/trend-follow/alerts/recent
 * 最近 N 条报警，前端轮询使用
 *
 * Query params:
 *   limit      - 返回条数，默认 50
 *   timeframe  - 周期过滤（可选）
 *   alert_level- 等级过滤（可选）
 */
router.get('/alerts/recent', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      limit = '50',
      timeframe,
      alert_level,
    } = req.query as Record<string, string>;

    const alerts = await get_repository().get_alerts({
      timeframe,
      alert_level: alert_level !== undefined ? Number(alert_level) : undefined,
      limit: Number(limit),
    });

    res.json({
      success: true,
      data:  alerts,
      count: alerts.length,
    });
  } catch (error: any) {
    logger.error('[TrendFollow API] get_recent_alerts failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/trend-follow/watch-contexts
 * 查询当前观察区快照
 *
 * Query params:
 *   symbol    - 币种，如 BTCUSDT
 *   timeframe - 周期，5m / 15m / 1h / 4h
 *   state     - 状态过滤（WATCHING / ALERTED / ABANDONED），不传则返回非废弃的
 *   limit     - 返回条数，默认 200
 */
router.get('/watch-contexts', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      symbol,
      timeframe,
      state,
      limit = '200',
    } = req.query as Record<string, string>;

    const contexts = await get_repository().get_watch_contexts({
      symbol,
      timeframe,
      state,
      limit: Number(limit),
    });

    res.json({
      success: true,
      data:  contexts,
      count: contexts.length,
    });
  } catch (error: any) {
    logger.error('[TrendFollow API] get_watch_contexts failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/trend-follow/watch-contexts/:symbol/:timeframe
 * 软删除某币种某周期的观察区记录（标记 is_deleted，不物理删除）
 *
 * Path params:
 *   symbol    - 币种，如 BTCUSDT
 *   timeframe - 周期，5m / 15m / 1h / 4h
 */
router.delete('/watch-contexts/:symbol/:timeframe', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol, timeframe } = req.params;
    const affected = await get_repository().soft_delete_watch_context(symbol, timeframe);
    if (affected) {
      res.json({ success: true, message: `${symbol.toUpperCase()} ${timeframe} 已标记删除` });
    } else {
      res.status(404).json({ success: false, error: '记录不存在或已删除' });
    }
  } catch (error: any) {
    logger.error('[TrendFollow API] soft_delete_watch_context failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/trend-follow/alerts/cleanup
 * 清理旧报警记录
 *
 * Query params:
 *   days - 保留天数，默认 30
 */
router.delete('/alerts/cleanup', async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Number(req.query.days ?? 30);
    const deleted = await get_repository().cleanup(days);
    res.json({ success: true, deleted });
  } catch (error: any) {
    logger.error('[TrendFollow API] cleanup failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
