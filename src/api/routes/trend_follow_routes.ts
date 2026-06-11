/**
 * 趋势跟随报警 API 路由
 *
 * GET /api/trend-follow/alerts          查询报警列表
 * GET /api/trend-follow/alerts/recent   最近 N 条报警（前端轮询用）
 * DELETE /api/trend-follow/alerts/cleanup  清理旧数据
 */

import { Router, Request, Response } from 'express';
import { TrendFollowRepository } from '@/database/trend_follow_repository';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { Kline5mRepository } from '@/database/kline_5m_repository';
import { logger } from '@/utils/logger';

const kline_aggregator = new KlineAggregator();
const kline_5m_repo = new Kline5mRepository();

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
 *   deleted   - true 时只返回手动删除的记录
 *   limit     - 返回条数，默认 200
 */
router.get('/watch-contexts', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      symbol,
      timeframe,
      state,
      deleted,
      limit = '200',
    } = req.query as Record<string, string>;

    const is_deleted = deleted === 'true';
    const contexts = await get_repository().get_watch_contexts({
      symbol,
      timeframe,
      state,
      deleted: is_deleted,
      limit: Number(limit),
    });

    // 已删除的记录 state 统一返回 DELETED
    const data = is_deleted
      ? contexts.map(c => ({ ...c, state: 'DELETED' }))
      : contexts;

    res.json({
      success: true,
      data,
      count: data.length,
    });
  } catch (error: any) {
    logger.error('[TrendFollow API] get_watch_contexts failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/trend-follow/watch-contexts/:id/remark
 * 更新观察区记录备注
 *
 * Body: { remark: string | null }
 */
router.patch('/watch-contexts/:id/remark', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      res.status(400).json({ success: false, error: 'id 无效' });
      return;
    }
    const { remark } = req.body as { remark?: string | null };
    if (remark !== undefined && remark !== null && typeof remark !== 'string') {
      res.status(400).json({ success: false, error: 'remark 必须是字符串或 null' });
      return;
    }
    const affected = await get_repository().update_watch_context_remark(id, remark ?? null);
    if (affected) {
      res.json({ success: true, message: `id=${id} 备注已更新` });
    } else {
      res.status(404).json({ success: false, error: '记录不存在或已删除' });
    }
  } catch (error: any) {
    logger.error('[TrendFollow API] update_remark failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/trend-follow/watch-contexts/:id
 * 软删除观察区记录（标记 is_deleted，不物理删除）
 *
 * Path params:
 *   id - 记录 id
 */
router.delete('/watch-contexts/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      res.status(400).json({ success: false, error: 'id 无效' });
      return;
    }
    const affected = await get_repository().soft_delete_watch_context(id);
    if (affected) {
      res.json({ success: true, message: `id=${id} 已标记删除` });
    } else {
      res.status(404).json({ success: false, error: '记录不存在或已删除' });
    }
  } catch (error: any) {
    logger.error('[TrendFollow API] soft_delete_watch_context failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/trend-follow/outcome-stats
 * 报警事后标签统计：按 等级 × 周期 (× 信号组合) 汇总胜率/盈亏比/MFE/MAE
 *
 * Query params:
 *   stop        - 止损口径：low（回调低点，默认）/ wave（起涨价）
 *   timeframe   - 周期过滤（可选）
 *   alert_level - 等级过滤（可选）
 *   by_signals  - true 时把 缩量/止跌/EMA20支撑 也纳入分组，便于看信号组合差异
 */
router.get('/outcome-stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      stop,
      timeframe,
      alert_level,
      by_signals,
    } = req.query as Record<string, string>;

    const rows = await get_repository().get_outcome_stats({
      stop: stop === 'wave' ? 'wave' : 'low',
      timeframe,
      alert_level: alert_level !== undefined ? Number(alert_level) : undefined,
      group_by_signals: by_signals === 'true',
    });

    res.json({
      success: true,
      stop: stop === 'wave' ? 'wave' : 'low',
      data: rows,
      count: rows.length,
    });
  } catch (error: any) {
    logger.error('[TrendFollow API] outcome_stats failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/trend-follow/triggers
 * 扳机入场确认事件列表（按确认时间倒序），含评估器回填的事后结果
 *
 * Query params:
 *   symbol           - 币种过滤（可选）
 *   parent_timeframe - 父周期过滤 1h/4h（可选）
 *   outcome          - 结果过滤 win/loss/open/unevaluated（可选，unevaluated=尚未评估）
 *   start_time       - 确认K线时间起始(ms)（可选）
 *   limit            - 返回条数，默认 50
 */
router.get('/triggers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol, parent_timeframe, outcome, start_time, limit } = req.query as Record<string, string>;
    const rows = await get_repository().get_triggers({
      symbol,
      parent_timeframe,
      outcome,
      start_time: start_time !== undefined ? Number(start_time) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error: any) {
    logger.error('[TrendFollow API] get_triggers failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/trend-follow/trigger-stats
 * 扳机入场确认的事后统计：按 父周期 × 父等级 汇总
 * 与 /outcome-stats（裸报警入场）对比，验证「5m确认入场」是否更优
 */
router.get('/trigger-stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await get_repository().get_trigger_outcome_stats();
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error: any) {
    logger.error('[TrendFollow API] trigger_stats failed:', error);
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

/**
 * GET /api/trend-follow/klines/:symbol/:timeframe
 * 查询观察区币种K线数据（支持5m/15m/1h/4h聚合分表）
 *
 * Path params:
 *   symbol    - 币种，如 BTCUSDT
 *   timeframe - 周期，5m / 15m / 1h / 4h
 *
 * Query params:
 *   limit     - 返回根数，默认 150，最大 500
 */
router.get('/klines/:symbol/:timeframe', async (req: Request, res: Response): Promise<void> => {
  try {
    const { symbol, timeframe } = req.params;
    const limit = Math.min(Number(req.query.limit ?? 150), 500);
    const symbol_upper = symbol.toUpperCase();

    let klines: any[] = [];

    if (timeframe === '5m') {
      const rows = await kline_5m_repo.get_recent_klines(symbol_upper, limit);
      klines = rows.map(k => ({
        open_time:  k.open_time,
        close_time: k.close_time,
        open:       k.open,
        high:       k.high,
        low:        k.low,
        close:      k.close,
        volume:     k.volume,
      }));
    } else if (['15m', '1h', '4h'].includes(timeframe)) {
      const end_time = Date.now();
      const interval_ms: Record<string, number> = { '15m': 15*60*1000, '1h': 60*60*1000, '4h': 4*60*60*1000 };
      const start_time = end_time - limit * interval_ms[timeframe] * 1.5; // 多取一些保证够数
      const rows = await kline_aggregator.get_klines_from_db(symbol_upper, timeframe, start_time, end_time);
      // 取最新 limit 根
      klines = rows.slice(-limit).map(k => ({
        open_time:  k.open_time,
        close_time: k.close_time,
        open:       k.open,
        high:       k.high,
        low:        k.low,
        close:      k.close,
        volume:     k.volume,
      }));
    } else {
      res.status(400).json({ success: false, error: `不支持的周期: ${timeframe}` });
      return;
    }

    res.json({ success: true, data: klines, count: klines.length });
  } catch (error: any) {
    logger.error('[TrendFollow API] get_klines failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
