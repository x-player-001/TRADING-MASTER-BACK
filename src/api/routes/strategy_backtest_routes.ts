/**
 * 策略回测结果 API（只读；结果由 scripts/run_strategy_backtest.ts 在服务器上生成入库）
 *
 * GET /api/strategy-backtest/strategies          已注册策略（默认参数、出场原因说明）
 * GET /api/strategy-backtest/runs                回测运行列表
 * GET /api/strategy-backtest/runs/:id            单次运行（参数、汇总统计）
 * GET /api/strategy-backtest/runs/:id/trades     交易列表（筛选、排序、分页；不含标注）
 * GET /api/strategy-backtest/runs/:id/stats      按条件重算统计（汇总 / 按月 / 按出场原因 / 按币种）
 * GET /api/strategy-backtest/trades/:id          单笔交易 + 画图标注 + K线（可切 5m/15m/1h/4h）+ 上一笔/下一笔
 *
 * 详细说明见 docs/STRATEGY_BACKTEST_API.md
 */

import { Router, Request, Response } from 'express';
import { BacktestTradeFilter, StrategyBacktestRepository } from '@/database/strategy_backtest_repository';
import { Kline5mRepository } from '@/database/kline_5m_repository';
import { list_strategies, get_strategy } from '@/services/strategy_backtest/strategy_registry';
import { compute_full_stats, group_stats } from '@/services/strategy_backtest/backtest_stats';
import { BacktestTimeframe, BacktestTradeStatus, ChartAnnotation, TIMEFRAME_MS } from '@/services/strategy_backtest/backtest_types';
import { ReplayKlineLoader } from '@/services/kline_replay/replay_kline_loader';
import { logger } from '@/utils/logger';

const router = Router();
const MAX_CHART_5M_BARS = 3000;
const MAX_CHART_BARS = 1500;          // 15m/1h/4h 单次最多根数
const CHART_INTERVALS: BacktestTimeframe[] = ['5m', '15m', '1h', '4h'];
const STATUSES: BacktestTradeStatus[] = ['closed', 'unfilled'];

let repository: StrategyBacktestRepository | null = null;
let kline_repository: Kline5mRepository | null = null;
let kline_loader: ReplayKlineLoader | null = null;

/** 由 APIServer 启动时注入（同时完成建表） */
export function set_strategy_backtest_repository(repo: StrategyBacktestRepository): void {
  repository = repo;
}

function get_repo(): StrategyBacktestRepository {
  if (!repository) repository = new StrategyBacktestRepository();
  return repository;
}

function get_kline_repo(): Kline5mRepository {
  if (!kline_repository) {
    kline_repository = new Kline5mRepository();
    kline_repository.stop_flush_timer();
  }
  return kline_repository;
}

/** 大周期K线读取（聚合表 + 5m 补缺，复用K线回放的加载器） */
function get_kline_loader(): ReplayKlineLoader {
  if (!kline_loader) kline_loader = new ReplayKlineLoader();
  return kline_loader;
}

/** 把标注时间对齐到周期桶起点（大周期图上标记要落在K线上） */
function snap_annotations(list: ChartAnnotation[], iv_ms: number): ChartAnnotation[] {
  if (iv_ms === 300_000) return list;
  const f = (t: number) => Math.floor(t / iv_ms) * iv_ms;
  return list.map(a => {
    if (a.type === 'marker') return { ...a, time: f(a.time) };
    if (a.type === 'segment') return { ...a, points: a.points.map(p => ({ ...p, time: f(p.time) })) };
    return { ...a, from_time: f(a.from_time), to_time: f(a.to_time) };
  });
}

/** 解析可选数字参数 */
function opt_number(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 逗号分隔多选 */
function opt_list(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const list = v.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** 从 query 解析交易筛选条件（列表与详情翻页共用） */
function parse_filter(q: Record<string, unknown>): BacktestTradeFilter {
  const status = opt_list(q.status)?.filter((s): s is BacktestTradeStatus => STATUSES.includes(s as BacktestTradeStatus));
  return {
    status: status?.length ? status : undefined,
    symbol: typeof q.symbol === 'string' && q.symbol ? q.symbol.toUpperCase() : undefined,
    exit_reason: opt_list(q.exit_reason),
    result: q.result === 'win' || q.result === 'loss' ? q.result : undefined,
    from: opt_number(q.from),
    to: opt_number(q.to),
    sort: typeof q.sort === 'string' ? q.sort as BacktestTradeFilter['sort'] : undefined,
    order: q.order === 'asc' ? 'asc' : 'desc',
    limit: opt_number(q.limit),
    offset: opt_number(q.offset),
  };
}

/** 策略说明（不含 run 函数） */
function describe_strategy(id: string) {
  const s = get_strategy(id);
  if (!s) return null;
  return {
    id: s.id, name: s.name, description: s.description, timeframe: s.timeframe, version: s.version,
    default_params: s.default_params, param_docs: s.param_docs, exit_reasons: s.exit_reasons,
  };
}

/**
 * GET /api/strategy-backtest/strategies
 */
router.get('/strategies', (_req: Request, res: Response) => {
  res.json({ success: true, data: list_strategies().map(s => describe_strategy(s.id)) });
});

/**
 * GET /api/strategy-backtest/runs
 * Query: strategy_id / limit（默认 50，最大 200）/ offset
 */
router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  try {
    const { total, rows } = await get_repo().list_runs({
      strategy_id: (req.query.strategy_id as string) || undefined,
      limit: opt_number(req.query.limit),
      offset: opt_number(req.query.offset),
    });
    res.json({ success: true, data: rows, total });
  } catch (error: any) {
    logger.error('[StrategyBacktest API] list runs failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/strategy-backtest/runs/:id
 */
router.get('/runs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const run = await get_repo().get_run(Number(req.params.id));
    if (!run) { res.status(404).json({ success: false, error: 'run not found' }); return; }
    res.json({ success: true, data: { run, strategy: describe_strategy(run.strategy_id) } });
  } catch (error: any) {
    logger.error('[StrategyBacktest API] get run failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/strategy-backtest/runs/:id/trades
 * Query: status（closed,unfilled 多选）/ symbol / exit_reason（多选）/ result（win|loss）/ from / to（按信号时间，毫秒）
 *        sort（signal_time|pnl|r_multiple|mfe_pct|mae_pct，默认 signal_time）/ order（asc|desc，默认 desc）/ limit（默认 50，最大 500）/ offset
 */
router.get('/runs/:id/trades', async (req: Request, res: Response): Promise<void> => {
  try {
    const { total, rows } = await get_repo().list_trades(Number(req.params.id), parse_filter(req.query as Record<string, unknown>));
    res.json({ success: true, data: rows.map(({ annotations, ...t }) => t), total });
  } catch (error: any) {
    logger.error('[StrategyBacktest API] list trades failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/strategy-backtest/runs/:id/stats
 * Query: symbol / from / to（按信号时间，毫秒）
 */
router.get('/runs/:id/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const trades = await get_repo().get_stat_trades(Number(req.params.id), {
      symbol: typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol.toUpperCase() : undefined,
      from: opt_number(req.query.from),
      to: opt_number(req.query.to),
    });
    const full = compute_full_stats(trades);
    const by_symbol = group_stats(trades, t => t.symbol).sort((a, b) => b.total_pnl - a.total_pnl);
    res.json({ success: true, data: { ...full, by_symbol } });
  } catch (error: any) {
    logger.error('[StrategyBacktest API] stats failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/strategy-backtest/trades/:id
 * Query: interval（5m|15m|1h|4h，默认交易周期）/ bars_before（默认 150）/ bars_after（默认 40），根数单位为 interval；
 *        其余与列表相同的筛选参数（用于计算同条件下的 prev_id / next_id）
 */
router.get('/trades/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const repo = get_repo();
    const trade = await repo.get_trade(Number(req.params.id));
    if (!trade) { res.status(404).json({ success: false, error: 'trade not found' }); return; }

    const q_interval = req.query.interval as BacktestTimeframe;
    const interval: BacktestTimeframe = CHART_INTERVALS.includes(q_interval) ? q_interval : (trade.timeframe as BacktestTimeframe);
    const iv_ms = TIMEFRAME_MS[interval] ?? 300_000;
    const before = Math.min(opt_number(req.query.bars_before) ?? 150, 1000);
    const after = Math.min(opt_number(req.query.bars_after) ?? 40, 1000);
    // 画图范围覆盖全部标注
    const times: number[] = [trade.signal_time];
    for (const a of trade.annotations) {
      if (a.type === 'marker') times.push(a.time);
      else if (a.type === 'segment') times.push(...a.points.map(p => p.time));
      else times.push(a.from_time, a.to_time);
    }
    const floor = (t: number) => Math.floor(t / iv_ms) * iv_ms;
    const start = floor(Math.min(...times)) - before * iv_ms;
    let end = Math.min(floor(Math.max(...times)) + after * iv_ms, Date.now());

    let klines: { open_time: number; open: number; high: number; low: number; close: number; volume: number }[];
    if (interval === '5m') {
      end = Math.min(end, start + MAX_CHART_5M_BARS * 300_000);
      klines = (await get_kline_repo().get_klines_by_time_range(trade.symbol, start, end))
        .map(k => ({ open_time: k.open_time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
    } else {
      const limit = Math.min(Math.floor((end - start) / iv_ms) + 1, MAX_CHART_BARS);
      const cursor = Math.min(floor(end) + iv_ms - 300_000, Math.floor(Date.now() / 300_000) * 300_000 - 300_000);
      klines = (await get_kline_loader().get_interval_bars(trade.symbol, interval, cursor, limit))
        .filter(k => k.open_time >= start)
        .map(k => ({ open_time: k.open_time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
    }

    const neighbors = await repo.get_neighbors(trade, parse_filter(req.query as Record<string, unknown>));
    res.json({
      success: true,
      data: { trade: { ...trade, annotations: snap_annotations(trade.annotations, iv_ms) }, interval, intervals: CHART_INTERVALS, klines, ...neighbors },
    });
  } catch (error: any) {
    logger.error('[StrategyBacktest API] get trade failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
