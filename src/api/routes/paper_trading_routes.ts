/**
 * 模拟盘 API 路由（只读；交易由 pm2 paper 进程产生）
 *
 * GET /api/paper/status            paper 进程运行状态（是否在线、数据延迟、挂单/持仓数）
 * GET /api/paper/strategies        策略与账户配置
 * GET /api/paper/summary           各策略统计 + 当前持仓（含浮动盈亏）
 * GET /api/paper/trades            交易列表（筛选、分页）
 * GET /api/paper/trades/:id        单笔交易 + 画图用K线（按策略周期）
 * GET /api/paper/equity            已实现资金曲线
 * GET /api/paper/daily             按日统计（北京时间，按平仓日）
 *
 * 详细说明见 docs/PAPER_TRADING_API.md
 */

import { Router, Request, Response } from 'express';
import { PaperTradingRepository } from '@/database/paper_trading_repository';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { PAPER_ACCOUNT, PAPER_STRATEGIES, TIMEFRAME_MS } from '@/services/paper_trading/paper_strategies';
import { compute_stats, daily_stats, equity_curve } from '@/services/paper_trading/paper_stats';
import { PaperTrade, PaperTradeStatus } from '@/services/paper_trading/paper_types';
import { logger } from '@/utils/logger';

const router = Router();
const STATUSES: PaperTradeStatus[] = ['pending', 'open', 'closed', 'cancelled', 'expired', 'skipped'];
const MAX_CHART_5M_BARS = 3000;
const HEARTBEAT_STALE_MS = 3 * 60_000;     // 超过 3 分钟无心跳视为离线
const DATA_LAG_WARN_MINUTES = 15;          // 最新K线落后超过 15 分钟视为数据延迟

let repository: PaperTradingRepository | null = null;
let kline_repository: Kline5mRepository | null = null;

/** 由 APIServer 启动时注入（同时完成建表） */
export function set_paper_trading_repository(repo: PaperTradingRepository): void {
  repository = repo;
}

function get_repo(): PaperTradingRepository {
  if (!repository) repository = new PaperTradingRepository();
  return repository;
}

function get_kline_repo(): Kline5mRepository {
  if (!kline_repository) {
    kline_repository = new Kline5mRepository();
    kline_repository.stop_flush_timer();
  }
  return kline_repository;
}

/** 解析可选数字参数 */
function opt_number(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 5m 聚合为指定周期（UTC 对齐） */
function aggregate(klines: Kline5mData[], tf_ms: number) {
  const out: { open_time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (const k of klines) {
    const t = Math.floor(k.open_time / tf_ms) * tf_ms;
    const last = out[out.length - 1];
    if (!last || last.open_time !== t) {
      out.push({ open_time: t, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume });
    } else {
      last.high = Math.max(last.high, k.high);
      last.low = Math.min(last.low, k.low);
      last.close = k.close;
      last.volume += k.volume;
    }
  }
  return out;
}

/** 为持仓附加最新价与浮动盈亏（取库中最新一根 5m 收盘价） */
async function with_unrealized(trades: PaperTrade[]) {
  return Promise.all(trades.map(async t => {
    if (t.status !== 'open' || t.fill_price === null || t.qty === null) return { ...t, last_price: null, unrealized_pnl: null, unrealized_r: null };
    const last = (await get_kline_repo().get_recent_klines(t.symbol, 1))[0];
    if (!last) return { ...t, last_price: null, unrealized_pnl: null, unrealized_r: null };
    const dir = t.side === 'short' ? -1 : 1;
    const pnl = dir * (last.close - t.fill_price) * t.qty - (t.fill_price + last.close) * t.qty * PAPER_ACCOUNT.fee_rate;
    return { ...t, last_price: last.close, unrealized_pnl: pnl, unrealized_r: pnl / t.risk_usdt };
  }));
}

/**
 * GET /api/paper/status
 * phase: offline（无心跳）/ starting（预热中）/ reconnecting（WS 断开）/ lagging（数据延迟）/ running
 */
router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const s = await get_repo().get_runtime_status();
    const now = Date.now();
    if (!s) { res.json({ success: true, data: { phase: 'offline', online: false, status: null } }); return; }
    const online = now - s.heartbeat_at < HEARTBEAT_STALE_MS;
    const data_lag_minutes = s.last_bar_time ? Math.max(0, (now - (s.last_bar_time + 300_000)) / 60_000) : null;
    const phase = !online ? 'offline'
      : !s.last_bar_time ? 'starting'
      : !s.ws_connected ? 'reconnecting'
      : (data_lag_minutes ?? 0) > DATA_LAG_WARN_MINUTES ? 'lagging'
      : 'running';
    res.json({
      success: true,
      data: { phase, online, data_lag_minutes, uptime_minutes: Math.round((now - s.started_at) / 60_000), server_time: now, status: s },
    });
  } catch (error: any) {
    logger.error('[Paper API] status failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/paper/strategies
 */
router.get('/strategies', (_req: Request, res: Response) => {
  res.json({ success: true, data: { account: PAPER_ACCOUNT, strategies: PAPER_STRATEGIES } });
});

/**
 * GET /api/paper/summary
 * Query: from / to（按平仓时间过滤统计，毫秒）
 */
router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const from = opt_number(req.query.from), to = opt_number(req.query.to);
    const repo = get_repo();
    const [closed, counts, active] = await Promise.all([
      repo.get_closed_trades({ from, to }),
      repo.count_by_status(),
      repo.get_active_trades(),
    ]);

    const strategies = PAPER_STRATEGIES.map(s => {
      const status_counts: Record<string, number> = Object.fromEntries(STATUSES.map(x => [x, 0]));
      for (const c of counts) if (c.strategy_id === s.id) status_counts[c.status] = c.n;
      return { strategy_id: s.id, name: s.name, enabled: s.enabled, status_counts, stats: compute_stats(closed.filter(t => t.strategy_id === s.id)) };
    });

    const open_positions = await with_unrealized(active.filter(t => t.status === 'open'));
    res.json({
      success: true,
      data: {
        account: PAPER_ACCOUNT,
        total: compute_stats(closed),
        strategies,
        open_positions,
        pending_orders: active.filter(t => t.status === 'pending'),
        unrealized_pnl: open_positions.reduce((a, p) => a + (p.unrealized_pnl ?? 0), 0),
      },
    });
  } catch (error: any) {
    logger.error('[Paper API] summary failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/paper/trades
 * Query: status（逗号分隔多选）/ strategy_id / symbol / from / to（按挂单时间，毫秒）/ limit（默认 50，最大 500）/ offset
 */
router.get('/trades', async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const status = (q.status || '').split(',').map(s => s.trim()).filter((s): s is PaperTradeStatus => STATUSES.includes(s as PaperTradeStatus));
    const { total, rows } = await get_repo().list_trades({
      status: status.length ? status : undefined,
      strategy_id: q.strategy_id || undefined,
      symbol: q.symbol ? q.symbol.toUpperCase() : undefined,
      from: opt_number(q.from),
      to: opt_number(q.to),
      limit: opt_number(q.limit),
      offset: opt_number(q.offset),
    });
    res.json({ success: true, data: await with_unrealized(rows), total });
  } catch (error: any) {
    logger.error('[Paper API] list trades failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/paper/trades/:id
 * Query: bars_before（默认 120）/ bars_after（默认 30），单位为策略周期根数
 */
router.get('/trades/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const trade = await get_repo().get_trade(Number(req.params.id));
    if (!trade) { res.status(404).json({ success: false, error: 'trade not found' }); return; }

    const tf_ms = TIMEFRAME_MS[trade.timeframe];
    const before = Math.min(opt_number(req.query.bars_before) ?? 120, 500);
    const after = Math.min(opt_number(req.query.bars_after) ?? 30, 500);
    const end_anchor = trade.exit_time ?? (trade.status === 'pending' || trade.status === 'open' ? Date.now() : trade.last_bar_time);
    const start = trade.setup_time - before * tf_ms;
    const end = Math.min(Date.now(), end_anchor + after * tf_ms, start + MAX_CHART_5M_BARS * 300_000);
    const klines_5m = await get_kline_repo().get_klines_by_time_range(trade.symbol, start, end);
    const klines = trade.timeframe === '5m'
      ? klines_5m.map(k => ({ open_time: k.open_time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }))
      : aggregate(klines_5m, tf_ms);

    const [enriched] = await with_unrealized([trade]);
    res.json({ success: true, data: { trade: enriched, timeframe: trade.timeframe, klines } });
  } catch (error: any) {
    logger.error('[Paper API] get trade failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/paper/equity
 * Query: strategy_id（不传为全部）/ from / to（按平仓时间）
 */
router.get('/equity', async (req: Request, res: Response): Promise<void> => {
  try {
    const closed = await get_repo().get_closed_trades({
      strategy_id: (req.query.strategy_id as string) || undefined,
      from: opt_number(req.query.from),
      to: opt_number(req.query.to),
    });
    res.json({ success: true, data: equity_curve(closed) });
  } catch (error: any) {
    logger.error('[Paper API] equity failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/paper/daily
 * Query: strategy_id（不传为全部）/ days（最近 N 天，默认 90）
 */
router.get('/daily', async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Math.min(Math.max(opt_number(req.query.days) ?? 90, 1), 3650);
    const closed = await get_repo().get_closed_trades({
      strategy_id: (req.query.strategy_id as string) || undefined,
      from: Date.now() - days * 86_400_000,
    });
    res.json({ success: true, data: daily_stats(closed) });
  } catch (error: any) {
    logger.error('[Paper API] daily failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
