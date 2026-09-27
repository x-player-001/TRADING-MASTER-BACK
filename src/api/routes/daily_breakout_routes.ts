/**
 * 日线趋势线 / 盘整上沿突破 API 路由（独立于趋势跟随）
 *
 * GET /api/daily-breakout/signals             突破事件列表（支持筛选/排序）
 * GET /api/daily-breakout/signals/:id         单条事件 + 画图用日线
 * GET /api/daily-breakout/klines/:symbol      日线K线
 *
 * 每条事件附带 avg_quote_volume_10d：最近 10 根已收盘日线平均成交额（USDT，实时计算）
 * 每条事件附带 line 字段：[{time, value}, ...]，前端直接连线即可
 * （首触点 → 最新日，线性坐标为直线；对数坐标已按日插值成折线）
 */

import { Router, Request, Response } from 'express';
import { DailyBreakoutRepository, DailyBreakoutRecord, DailyBreakoutFilter } from '@/database/daily_breakout_repository';
import { logger } from '@/utils/logger';

const DAY_MS = 86_400_000;
const router = Router();
let repository: DailyBreakoutRepository | null = null;

export function set_daily_breakout_repository(repo: DailyBreakoutRepository): void {
  repository = repo;
}

function get_repository(): DailyBreakoutRepository {
  if (!repository) repository = new DailyBreakoutRepository();
  return repository;
}

/** 解析可选数字参数（空/非法返回 undefined） */
function opt_number(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 生成画线点：首触点 → 最新日
 * 两个精确点为 (line_start_time, line_start_value) 与 (last_time, last_line_value)
 */
function build_line_points(r: DailyBreakoutRecord): { time: number; value: number }[] {
  const t0 = r.line_start_time, v0 = r.line_start_value;
  const t1 = r.last_time, v1 = r.last_line_value;
  if (r.price_scale !== 'log' || v0 <= 0 || v1 <= 0 || t1 <= t0) {
    return [{ time: t0, value: v0 }, { time: t1, value: v1 }];
  }
  // 对数坐标：线在价格空间是曲线，按日插值
  const points: { time: number; value: number }[] = [];
  const k = Math.log(v1 / v0) / (t1 - t0);
  for (let t = t0; t < t1; t += DAY_MS) points.push({ time: t, value: v0 * Math.exp(k * (t - t0)) });
  points.push({ time: t1, value: v1 });
  return points;
}

/**
 * GET /api/daily-breakout/signals
 * 查询突破事件
 *
 * Query params:
 *   status            - breakout / retest / failed，逗号分隔多选（默认 breakout,retest）
 *   days              - 最近 N 天内突破，默认 30
 *   line_type         - descending / horizontal
 *   symbol            - 币种
 *   min_volume_ratio  - 突破日最小量比
 *   min_breakout_pct  - 突破日收盘最少高出线（%）
 *   min_touches       - 最少触点数
 *   min_span_days     - 最小跨度（天）
 *   max_distance_pct  - 最新收盘离线最大距离（%），找还在回踩位置的
 *   min_avg_volume    - 最近 10 天日均成交额下限（USDT）
 *   sort              - breakout_time（默认）/ distance / volume_ratio / touches / avg_volume
 *   limit             - 默认 200，最大 1000
 */
router.get('/signals', async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const days = opt_number(q.days) ?? 30;
    const sorts = ['breakout_time', 'distance', 'volume_ratio', 'touches', 'avg_volume'];

    const filter: DailyBreakoutFilter = {
      symbol: q.symbol || undefined,
      statuses: (q.status || 'breakout,retest').split(',').map(s => s.trim()).filter(Boolean),
      line_type: q.line_type || undefined,
      since_time: days > 0 ? Date.now() - days * DAY_MS : undefined,
      min_volume_ratio: opt_number(q.min_volume_ratio),
      min_breakout_pct: opt_number(q.min_breakout_pct),
      min_touches: opt_number(q.min_touches),
      min_span_days: opt_number(q.min_span_days),
      max_distance_pct: opt_number(q.max_distance_pct),
      min_avg_volume_10d: opt_number(q.min_avg_volume),
      sort: sorts.includes(q.sort) ? q.sort as DailyBreakoutFilter['sort'] : 'breakout_time',
      limit: opt_number(q.limit),
    };

    const records = await get_repository().list_breakouts(filter);
    const data = records.map(r => ({ ...r, line: build_line_points(r) }));
    res.json({ success: true, data, count: data.length });
  } catch (error: any) {
    logger.error('[DailyBreakout API] list signals failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/daily-breakout/signals/:id
 * 单条事件 + 日线（从首触点前 30 天到最新）
 */
router.get('/signals/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'id 非法' });
      return;
    }
    const record = await get_repository().get_breakout(id);
    if (!record) {
      res.status(404).json({ success: false, error: '事件不存在' });
      return;
    }
    const klines = await get_repository().get_daily_klines(record.symbol, record.line_start_time - 30 * DAY_MS);
    res.json({ success: true, data: { ...record, line: build_line_points(record), klines } });
  } catch (error: any) {
    logger.error('[DailyBreakout API] get signal failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/daily-breakout/klines/:symbol
 * 日线K线（已收盘，升序）
 *
 * Query params:
 *   days - 回看天数，默认 500，最大 1500
 */
router.get('/klines/:symbol', async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Math.min(Math.max(opt_number(req.query.days) ?? 500, 1), 1500);
    const symbol = req.params.symbol.toUpperCase();
    const klines = await get_repository().get_daily_klines(symbol, Date.now() - days * DAY_MS);
    res.json({ success: true, data: klines, count: klines.length });
  } catch (error: any) {
    logger.error('[DailyBreakout API] get klines failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
