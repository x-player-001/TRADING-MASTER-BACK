/**
 * EMA20 均线推动 API 路由
 *
 * GET /api/ema20-push/contexts          查询推动上下文列表
 * GET /api/ema20-push/contexts/:symbol/:timeframe/records  查询某币种推动详细记录
 * DELETE /api/ema20-push/contexts/:symbol/:timeframe       重置推动计数
 */

import { Router, Request, Response } from 'express';
import { EMA20PushRepository } from '@/database/ema20_push_repository';
import { logger } from '@/utils/logger';

const router = Router();
let repository: EMA20PushRepository | null = null;

export function set_ema20_push_repository(repo: EMA20PushRepository): void {
  repository = repo;
}

function get_repository(): EMA20PushRepository {
  if (!repository) repository = new EMA20PushRepository();
  return repository;
}

/**
 * GET /api/ema20-push/contexts
 * 查询推动上下文列表
 *
 * Query params:
 *   symbol         - 币种
 *   timeframe      - 周期 15m/1h/4h
 *   min_push_count - 最少推动次数过滤，默认 2
 *   limit          - 返回条数，默认 100
 */
router.get('/contexts', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol, timeframe, min_push_count = '2', limit = '100' } = req.query as Record<string, string>;
    const contexts = await get_repository().get_contexts({
      symbol,
      timeframe,
      min_push_count: Number(min_push_count),
      limit:          Number(limit),
    });
    res.json({ success: true, data: contexts, count: contexts.length });
  } catch (error: any) {
    logger.error('[EMA20Push API] get_contexts failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ema20-push/contexts/:symbol/:timeframe/records
 * 查询某币种某周期的推动详细记录
 */
router.get('/contexts/:symbol/:timeframe/records', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol, timeframe } = req.params;
    const records = await get_repository().get_push_records(symbol, timeframe);
    res.json({ success: true, data: records, count: records.length });
  } catch (error: any) {
    logger.error('[EMA20Push API] get_push_records failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ema20-push/contexts/:symbol/:timeframe
 * 重置某币种某周期的推动计数
 */
router.delete('/contexts/:symbol/:timeframe', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol, timeframe } = req.params;
    await get_repository().reset(symbol, timeframe);
    res.json({ success: true, message: `${symbol.toUpperCase()} ${timeframe} 推动记录已重置` });
  } catch (error: any) {
    logger.error('[EMA20Push API] reset failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
