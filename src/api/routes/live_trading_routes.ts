/**
 * 实盘 API 路由（只读；交易由 pm2 live 进程产生，控制开关只能在服务器用 scripts/live_control.ts 修改）
 *
 * GET /api/live/status            live 进程运行状态（模式、控制开关、两条 WS、余额、进行中笔数）
 * GET /api/live/config            资金风控配置与接入策略
 * GET /api/live/summary           统计（总计 / 分策略）+ 状态与原因分布 + 当前持仓（含浮动盈亏）/ 挂单 / 待人工处理
 * GET /api/live/trades            交易列表（筛选、分页）
 * GET /api/live/trades/:id        单笔交易 + 审计事件 + 同信号模拟盘交易 + 画图K线与标注
 * GET /api/live/equity            已实现资金曲线
 * GET /api/live/daily             按日统计（北京时间，按平仓日）
 *
 * 详细说明见 docs/LIVE_TRADING_API.md
 */

import { Router, Request, Response } from 'express';
import { LiveTradingRepository } from '@/database/live_trading_repository';
import { PaperTradingRepository } from '@/database/paper_trading_repository';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { LIVE_CONFIG, live_strategies } from '@/services/live_trading/live_config';
import { LiveTrade, LiveTradeStatus } from '@/services/live_trading/live_types';
import { beijing_day_start } from '@/services/live_trading/exchange_rules';
import { compute_stats, daily_stats, equity_curve } from '@/services/paper_trading/paper_stats';
import { logger } from '@/utils/logger';

const router = Router();
const STATUSES: LiveTradeStatus[] = ['placing', 'pending', 'entering', 'open', 'closing', 'closed', 'cancelled', 'skipped', 'shadow', 'error'];
const ACTIVE: LiveTradeStatus[] = ['placing', 'pending', 'entering', 'open', 'closing'];
const INTERVAL_MS: Record<string, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const MAX_CHART_5M_BARS = 3000;
const HEARTBEAT_STALE_MS = 3 * 60_000;
const DATA_LAG_WARN_MINUTES = 15;
const FEE_RATE_ESTIMATE = 0.0005;           // 浮动盈亏估算用的平仓手续费率（taker）

let repository: LiveTradingRepository | null = null;
let paper_repository: PaperTradingRepository | null = null;
let kline_repository: Kline5mRepository | null = null;

/** 由 APIServer 启动时注入（同时完成建表） */
export function set_live_trading_repository(repo: LiveTradingRepository): void {
  repository = repo;
}

function get_repo(): LiveTradingRepository {
  if (!repository) repository = new LiveTradingRepository();
  return repository;
}

function get_paper_repo(): PaperTradingRepository {
  if (!paper_repository) paper_repository = new PaperTradingRepository();
  return paper_repository;
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

/** 为持仓附加最新价与浮动盈亏（库中最新一根 5m 收盘价；手续费按开仓实收 + 平仓 taker 估算） */
async function with_unrealized(trades: LiveTrade[]) {
  return Promise.all(trades.map(async t => {
    const empty = { ...t, last_price: null, unrealized_pnl: null, unrealized_r: null };
    if (t.status !== 'open' || t.fill_price === null || t.filled_qty === null) return empty;
    const last = (await get_kline_repo().get_recent_klines(t.symbol, 1))[0];
    if (!last) return empty;
    const qty = t.filled_qty;
    const pnl = (t.fill_price - last.close) * qty - (t.fill_price + last.close) * qty * FEE_RATE_ESTIMATE;
    const risk = qty * (t.stop_price - t.fill_price);
    return { ...t, last_price: last.close, unrealized_pnl: pnl, unrealized_r: risk > 0 ? pnl / risk : null };
  }));
}

/**
 * GET /api/live/status
 * phase: offline（无心跳）/ starting（预热中）/ reconnecting（WS 断开）/ lagging（数据延迟）/ running
 */
router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const s = await get_repo().get_runtime_status();
    const control = await get_repo().get_control();
    const now = Date.now();
    if (!s) { res.json({ success: true, data: { phase: 'offline', online: false, control, status: null } }); return; }
    const online = now - s.heartbeat_at < HEARTBEAT_STALE_MS;
    const data_lag_minutes = s.last_bar_time ? Math.max(0, (now - (s.last_bar_time + 300_000)) / 60_000) : null;
    const ws_ok = s.market_ws && (s.mode !== 'live' || s.user_ws);
    const phase = !online ? 'offline'
      : !s.last_bar_time ? 'starting'
      : !ws_ok ? 'reconnecting'
      : (data_lag_minutes ?? 0) > DATA_LAG_WARN_MINUTES ? 'lagging'
      : 'running';
    const today_pnl = (await get_repo().get_closed_trades({ from: beijing_day_start(now) })).reduce((a, t) => a + (t.pnl ?? 0), 0);
    res.json({
      success: true,
      data: {
        phase, online, mode: s.mode, control, data_lag_minutes,
        uptime_minutes: Math.round((now - s.started_at) / 60_000), server_time: now,
        today_pnl, daily_loss_limit: LIVE_CONFIG.daily_loss_limit_usdt,
        status: s,
      },
    });
  } catch (error: any) {
    logger.error('[Live API] status failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/live/config
 */
router.get('/config', (_req: Request, res: Response) => {
  res.json({ success: true, data: { config: LIVE_CONFIG, strategies: live_strategies() } });
});

/**
 * GET /api/live/summary
 * Query: from / to（毫秒；统计按平仓时间，状态与原因分布按信号时间）
 */
router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const from = opt_number(req.query.from), to = opt_number(req.query.to);
    const repo = get_repo();
    const [closed, counts, active, errors] = await Promise.all([
      repo.get_closed_trades({ from, to }),
      repo.count_by_status_reason({ from, to }),
      repo.list_trades({ status: ACTIVE, limit: 100 }),
      repo.list_trades({ status: ['error'], limit: 100 }),
    ]);

    /** 某策略（不传为全部）的状态计数与取消 / 跳过原因分布 */
    const breakdown = (strategy_id?: string) => {
      const status_counts: Record<string, number> = Object.fromEntries(STATUSES.map(x => [x, 0]));
      const cancel_reasons: Record<string, number> = {};
      const skip_reasons: Record<string, number> = {};
      for (const c of counts) {
        if (strategy_id && c.strategy_id !== strategy_id) continue;
        status_counts[c.status] = (status_counts[c.status] ?? 0) + c.n;
        const key = c.reason ?? 'unknown';
        if (c.status === 'cancelled') cancel_reasons[key] = (cancel_reasons[key] ?? 0) + c.n;
        if (c.status === 'skipped') skip_reasons[key] = (skip_reasons[key] ?? 0) + c.n;
      }
      return { status_counts, cancel_reasons, skip_reasons };
    };

    const strategies = live_strategies().map(s => ({
      strategy_id: s.id, name: s.name, timeframe: s.timeframe,
      ...breakdown(s.id),
      stats: compute_stats(closed.filter(t => t.strategy_id === s.id)),
    }));
    const open_positions = await with_unrealized(active.rows.filter(t => t.status === 'open'));
    res.json({
      success: true,
      data: {
        config: LIVE_CONFIG,
        total: { ...breakdown(), stats: compute_stats(closed), total_funding: closed.reduce((a, t) => a + (t.funding ?? 0), 0) },
        strategies,
        open_positions,
        pending_orders: active.rows.filter(t => t.status !== 'open'),
        error_trades: errors.rows,
        unrealized_pnl: open_positions.reduce((a, p) => a + (p.unrealized_pnl ?? 0), 0),
      },
    });
  } catch (error: any) {
    logger.error('[Live API] summary failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/live/trades
 * Query: status（逗号分隔多选）/ strategy_id / symbol / from / to（按信号时间，毫秒）/ limit（默认 50，最大 500）/ offset
 */
router.get('/trades', async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const status = (q.status || '').split(',').map(s => s.trim()).filter((s): s is LiveTradeStatus => STATUSES.includes(s as LiveTradeStatus));
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
    logger.error('[Live API] list trades failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/live/trades/:id
 * Query: interval（5m / 15m / 1h / 4h，默认策略周期）/ bars_before（默认 120）/ bars_after（默认 30），单位为所选周期根数
 */
router.get('/trades/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const trade = await get_repo().get_trade(Number(req.params.id));
    if (!trade) { res.status(404).json({ success: false, error: 'trade not found' }); return; }

    const interval = typeof req.query.interval === 'string' && INTERVAL_MS[req.query.interval] ? req.query.interval : trade.timeframe;
    const tf_ms = INTERVAL_MS[interval];
    const before = Math.min(opt_number(req.query.bars_before) ?? 120, 500);
    const after = Math.min(opt_number(req.query.bars_after) ?? 30, 500);
    const end_anchor = trade.exit_time ?? (ACTIVE.includes(trade.status) ? Date.now() : Math.max(trade.last_bar_time, trade.signal_time));
    const start = Math.floor((trade.setup_time - before * tf_ms) / tf_ms) * tf_ms;
    const end = Math.min(Date.now(), end_anchor + after * tf_ms, start + MAX_CHART_5M_BARS * 300_000);
    const klines_5m = await get_kline_repo().get_klines_by_time_range(trade.symbol, start, end);
    const klines = interval === '5m'
      ? klines_5m.map(k => ({ open_time: k.open_time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }))
      : aggregate(klines_5m, tf_ms);

    const [events, paper_trade, enriched] = await Promise.all([
      get_repo().get_events(trade.id!),
      get_paper_repo().get_trade_by_key(trade.strategy_id, trade.symbol, trade.setup_time),
      with_unrealized([trade]).then(r => r[0]),
    ]);

    // 画图标注：价位线 + 时间点
    const levels = [
      { kind: 'entry_trigger', price: trade.entry_trigger },
      { kind: 'entry_limit', price: trade.entry_limit },
      { kind: 'base_stop', price: trade.base_stop },
      { kind: 'stop', price: trade.stop_price },
      ...(trade.take_profit !== null ? [{ kind: 'take_profit', price: trade.take_profit }] : []),
    ];
    const markers = [
      { kind: 'trigger', time: trade.trigger_time, price: null },
      { kind: 'setup', time: trade.setup_time, price: null },
      ...(trade.fill_time !== null ? [{ kind: 'entry', time: trade.fill_time, price: trade.fill_price }] : []),
      ...(trade.exit_time !== null ? [{ kind: 'exit', time: trade.exit_time, price: trade.exit_price, reason: trade.exit_reason }] : []),
    ];

    res.json({ success: true, data: { trade: enriched, interval, klines, levels, markers, events, paper_trade } });
  } catch (error: any) {
    logger.error('[Live API] get trade failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/live/equity
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
    logger.error('[Live API] equity failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/live/daily
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
    logger.error('[Live API] daily failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
