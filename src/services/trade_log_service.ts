/**
 * 交易日志服务（AI 复盘业务，以币安真实成交为主体）
 *
 * 数据主从：trade_log（真实交易记录）为主，AI 评估/复盘为辅。
 * 同步流程：get_user_trades → 落库 binance_trades(去重) → 按 symbol 切回合 → upsert trade_log → 已平仓补复盘。
 *
 * 支持 Claude（@anthropic-ai/sdk）/ OpenAI / DeepSeek，通过 AI_PROVIDER 环境变量切换。
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { BinanceAPI } from '@/api';
import { SRLevelRepository } from '@/database/sr_level_repository';
import { TradeLogRepository, TradeLog, TradeDirection } from '@/database/trade_log_repository';
import { BinanceTradesRepository, BinanceTrade } from '@/database/binance_trades_repository';
import { BinanceFuturesTradingAPI, PositionInfo } from '@/api/binance_futures_trading_api';
import { logger } from '@/utils/logger';

// ==================== 入参类型 ====================

export interface AnalyzeEntryParams {
  symbol: string;
  direction: TradeDirection;
  entry_reason: string;
  planned_entry_price?: number;
  planned_stop_loss?: number;
  planned_take_profit?: number;
  end_time?: number;
  timeframe?: string;
}

export interface ReassessParams {
  log_id: number;
  current_price: number;
  concern: string;
}

export interface RiskReviewItem {
  risk: string;
  status: 'materialized' | 'cleared' | 'pending';
  note: string;
}

export interface EntryDecision {
  action: 'enter' | 'wait' | 'skip';
  entry_zone: [number, number] | null;
  invalidation_price: number | null;
  targets: number[];
  rr_ratio: number | null;
}

interface AiAnalysisResult {
  analysis: string;
  risk_points: string[];
  opportunities: string[];
  overall_assessment: string;
  confidence_score: number;
  risk_review?: RiskReviewItem[];
  decision?: EntryDecision;
}

// 从成交流水切分出的一个完整开平回合
interface TradeRound {
  symbol: string;
  direction: TradeDirection;
  entry_price: number;
  exit_price: number;
  qty: number;
  leverage?: number;
  realized_pnl: number;   // 净值（已扣手续费）
  pnl_pct: number;
  first_trade_id: number;
  last_trade_id: number;
  opened_time: number;
  closed_time: number;
  is_open: boolean;
}

// ==================== Service ====================

export class TradeLogService {
  private static instance: TradeLogService;

  private repository: TradeLogRepository;
  private trades_repo: BinanceTradesRepository;
  private binance_api: BinanceAPI;
  private sr_repository: SRLevelRepository;
  private trading_api: BinanceFuturesTradingAPI;
  private claude: Anthropic;
  private openai: OpenAI;
  private deepseek: OpenAI;

  private lessons_digest_cache: string | null = null;

  /** 同步扫描成交回溯窗口：币安 userTrades 单次查询跨度不超过 7 天 */
  private static readonly SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

  private constructor() {
    this.repository = new TradeLogRepository();
    this.trades_repo = new BinanceTradesRepository();
    this.binance_api = BinanceAPI.getInstance();
    this.sr_repository = new SRLevelRepository();
    this.trading_api = new BinanceFuturesTradingAPI(
      process.env.BINANCE_ANALYZE_KEY || process.env.BINANCE_API_KEY,
      process.env.BINANCE_ANALYZE_SECRET || process.env.BINANCE_API_SECRET,
      false
    );
    this.claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  }

  static get_instance(): TradeLogService {
    if (!TradeLogService.instance) TradeLogService.instance = new TradeLogService();
    return TradeLogService.instance;
  }

  async init(): Promise<void> {
    await this.trades_repo.init_tables();
    await this.repository.init_tables();
  }

  // ==================== 评估 ====================

  /**
   * 入场前评估：立即创建 analyzing 记录返回 log_id，AI 分析异步执行。
   */
  async analyze_entry(params: AnalyzeEntryParams): Promise<{ log_id: number }> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit } = params;

    const log_id = await this.repository.create_analyzing({
      symbol, direction, entry_reason,
      planned_entry_price, planned_stop_loss, planned_take_profit,
    });

    this.run_entry_analysis(log_id, params).catch(err => {
      logger.error(`[TradeLog] Background analysis failed for log #${log_id}:`, err);
    });

    return { log_id };
  }

  private async run_entry_analysis(log_id: number, params: AnalyzeEntryParams): Promise<void> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, end_time, timeframe } = params;

    const [market_snapshot, lessons_digest] = await Promise.all([
      this.build_market_snapshot(symbol, end_time, timeframe),
      this.build_lessons_digest(),
    ]);

    const result = await this.call_ai_for_entry({
      symbol, direction, entry_reason,
      planned_entry_price, planned_stop_loss, planned_take_profit,
      market_snapshot, lessons_digest,
    });

    const decision = result.decision;
    await this.repository.save_analysis({
      log_id,
      analysis_type: 'entry',
      market_snapshot,
      ai_analysis: result.analysis,
      risk_points: result.risk_points,
      opportunities: result.opportunities,
      overall_assessment: result.overall_assessment,
      confidence_score: result.confidence_score,
      action: decision?.action ?? null,
      entry_zone_low: decision?.entry_zone?.[0] ?? null,
      entry_zone_high: decision?.entry_zone?.[1] ?? null,
      invalidation_price: decision?.invalidation_price ?? null,
      target_1: decision?.targets?.[0] ?? null,
      target_2: decision?.targets?.[1] ?? null,
      rr_ratio: decision?.rr_ratio ?? null,
    });

    logger.info(`[TradeLog] Entry analysis done for log #${log_id}${decision ? `, action=${decision.action}` : ''}`);
  }

  /** 放弃评估：analyzing → dismissed */
  async dismiss(log_id: number): Promise<void> {
    const log = await this.repository.find_by_id(log_id);
    if (!log) throw new Error(`Log #${log_id} not found`);
    if (log.status !== 'analyzing') throw new Error(`Log #${log_id} is not in analyzing status`);
    await this.repository.mark_dismissed(log_id);
  }

  /**
   * 持仓中再评估：校验后立即返回，AI 分析异步执行。
   */
  async reassess(params: ReassessParams): Promise<{ log_id: number }> {
    const { log_id } = params;
    const log = await this.repository.find_by_id(log_id);
    if (!log) throw new Error(`Log #${log_id} not found`);
    if (log.status !== 'open') throw new Error(`Log #${log_id} is not open`);

    this.run_reassess(log, params).catch(err => {
      logger.error(`[TradeLog] Background reassess failed for log #${log_id}:`, err);
    });

    return { log_id };
  }

  private async run_reassess(log: TradeLog, params: ReassessParams): Promise<void> {
    const { log_id, current_price, concern } = params;

    const market_snapshot = await this.build_market_snapshot(log.symbol);

    const entry_price = log.entry_price ?? log.planned_entry_price;
    let floating_pnl_text = '未知';
    if (entry_price) {
      const pnl_pct = log.direction === 'LONG'
        ? (current_price - entry_price) / entry_price * 100
        : (entry_price - current_price) / entry_price * 100;
      floating_pnl_text = `${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(2)}%`;
    }

    const analyses = await this.repository.find_analyses_by_log(log_id);
    const entry_analysis = analyses.find(a => a.analysis_type === 'entry');
    const entry_risk_points = entry_analysis?.risk_points ?? [];

    const result = await this.call_ai_for_reassess({
      log, current_price, floating_pnl_text, concern, market_snapshot, entry_risk_points,
    });

    await this.repository.save_analysis({
      log_id,
      analysis_type: 'reassess',
      market_snapshot,
      ai_analysis: result.analysis,
      risk_points: result.risk_points,
      opportunities: result.opportunities,
      overall_assessment: result.overall_assessment,
      confidence_score: result.confidence_score,
      risk_review: result.risk_review,
    });

    logger.info(`[TradeLog] Reassess done for log #${log_id}`);
  }

  /**
   * 生成并保存平仓复盘（同步平仓时调用）。
   */
  private async generate_and_save_review(
    log: TradeLog, exit_reason: string
  ): Promise<void> {
    const log_id = log.id!;
    if (await this.repository.has_review(log_id)) return;  // 已有复盘不重复生成

    const analyses = await this.repository.find_analyses_by_log(log_id);
    const entry_analysis = analyses.find(a => a.analysis_type === 'entry');

    const review = await this.call_ai_for_review({
      log, exit_reason, original_analysis: entry_analysis?.ai_analysis,
    });

    await this.repository.save_review({
      log_id,
      exit_reason,
      ai_review: review.review,
      what_went_well: review.what_went_well,
      what_went_wrong: review.what_went_wrong,
      lessons: review.lessons,
    });

    this.lessons_digest_cache = null;
    logger.info(`[TradeLog] Review generated for log #${log_id}, pnl=${log.realized_pnl ?? '?'}`);
  }

  // ==================== 交易所同步 ====================

  /**
   * 全局同步：拉最近 7 天所有有成交的币种 → 落库去重 → 切回合 → upsert trade_log → 已平仓补复盘。
   * 前端「公共同步持仓」按钮调用。
   */
  async sync_all(): Promise<{ filled: number; created: number; closed: number; new_trades: number }> {
    const since = Date.now() - TradeLogService.SYNC_LOOKBACK_MS;
    const symbols = await this.collect_sync_symbols(since);

    let filled = 0, created = 0, closed = 0, new_trades = 0;

    for (const symbol of symbols) {
      try {
        new_trades += await this.pull_and_store_trades(symbol, since);
        const rounds = await this.build_rounds(symbol, since);
        for (const round of rounds) {
          const r = await this.reconcile_round(round);
          filled += r.filled; created += r.created; closed += r.closed;
        }
      } catch (err) {
        logger.error(`[TradeLog] sync ${symbol} failed:`, err);
      }
    }

    logger.info(`[TradeLog] sync_all done: new_trades=${new_trades}, filled=${filled}, created=${created}, closed=${closed}`);
    return { filled, created, closed, new_trades };
  }

  /**
   * 单条同步：只同步该 log 对应币种，拉成交→落库→切回合→匹配该 log。
   * 前端每条记录的「同步」按钮调用。
   */
  async sync_one(log_id: number): Promise<{ action: 'filled' | 'closed' | 'noop'; log_id: number }> {
    const log = await this.repository.find_by_id(log_id);
    if (!log) throw new Error(`Log #${log_id} not found`);
    if (log.status === 'closed' || log.status === 'dismissed') return { action: 'noop', log_id };

    const since = Date.now() - TradeLogService.SYNC_LOOKBACK_MS;
    await this.pull_and_store_trades(log.symbol, since);
    const rounds = (await this.build_rounds(log.symbol, since)).filter(r => r.direction === log.direction);

    const open_round = rounds.find(r => r.is_open);
    if (open_round) {
      await this.repository.apply_open_round(log_id, {
        entry_price: open_round.entry_price, qty: open_round.qty, leverage: open_round.leverage,
        first_trade_id: open_round.first_trade_id, opened_at: new Date(open_round.opened_time),
      });
      return { action: 'filled', log_id };
    }

    if (log.status === 'open') {
      const closed_round = rounds.filter(r => !r.is_open).sort((a, b) => b.closed_time - a.closed_time)[0];
      if (closed_round && !(await this.repository.find_by_last_trade_id(closed_round.last_trade_id))) {
        await this.close_log_with_round(log, closed_round);
        return { action: 'closed', log_id };
      }
    }
    return { action: 'noop', log_id };
  }

  /** 收集要扫的币种：当前持仓 + 7天有成交 + 系统活跃记录 */
  private async collect_sync_symbols(since: number): Promise<string[]> {
    const set = new Set<string>();
    try {
      const positions = await this.fetch_live_positions();
      positions.forEach(p => set.add(p.symbol));
    } catch (err) {
      logger.warn('[TradeLog] fetch positions for symbol collect failed:', err);
    }
    try {
      const incomes = await this.trading_api.get_income({ startTime: since, limit: 1000 });
      incomes.forEach(i => { if (i.symbol) set.add(i.symbol); });
    } catch (err) {
      logger.warn('[TradeLog] get_income for symbol collect failed:', err);
    }
    const active = await this.repository.find_all_active();
    active.forEach(l => set.add(l.symbol));
    return Array.from(set);
  }

  /** 拉某币种成交并去重落库，返回新增条数 */
  private async pull_and_store_trades(symbol: string, since: number): Promise<number> {
    const raw = await this.trading_api.get_user_trades(symbol, { startTime: since, limit: 1000 });
    if (raw.length === 0) return 0;
    const trades: BinanceTrade[] = raw.map(t => ({
      trade_id: t.id,
      order_id: t.orderId,
      symbol: t.symbol,
      side: t.side as 'BUY' | 'SELL',
      price: Number(t.price),
      qty: Number(t.qty),
      quote_qty: Number(t.quoteQty),
      realized_pnl: Number(t.realizedPnl),
      commission: Number(t.commission),
      commission_asset: t.commissionAsset,
      position_side: t.positionSide,
      is_buyer: t.buyer,
      is_maker: t.maker,
      trade_time: t.time,
    }));
    return this.trades_repo.upsert_trades(trades);
  }

  /**
   * 从本地成交表读某币种成交，按「持仓归零」切成独立回合。
   */
  private async build_rounds(symbol: string, since: number): Promise<TradeRound[]> {
    const trades = await this.trades_repo.find_by_symbol(symbol, since);
    const rounds: TradeRound[] = [];
    let pos = 0;
    let buf: BinanceTrade[] = [];

    for (const t of trades) {
      const signed = t.side === 'BUY' ? t.qty : -t.qty;
      const prev = pos;
      pos += signed;
      buf.push(t);
      if (prev !== 0 && Math.abs(pos) < 1e-9) {
        rounds.push(this.aggregate_round(symbol, buf, false));
        buf = [];
      }
    }
    if (buf.length > 0 && Math.abs(pos) > 1e-9) {
      rounds.push(this.aggregate_round(symbol, buf, true));
    }
    return rounds;
  }

  /** 把一个回合的成交聚合成 entry/exit 均价、数量、已实现盈亏 */
  private aggregate_round(symbol: string, trades: BinanceTrade[], is_open: boolean): TradeRound {
    const direction: TradeDirection = trades[0].side === 'BUY' ? 'LONG' : 'SHORT';
    const entry_side = direction === 'LONG' ? 'BUY' : 'SELL';

    let entry_qty = 0, entry_quote = 0, exit_qty = 0, exit_quote = 0, realized_pnl = 0, commission = 0;
    for (const t of trades) {
      realized_pnl += t.realized_pnl;
      commission += t.commission;
      if (t.side === entry_side) { entry_qty += t.qty; entry_quote += t.price * t.qty; }
      else { exit_qty += t.qty; exit_quote += t.price * t.qty; }
    }

    const entry_price = entry_qty > 0 ? entry_quote / entry_qty : 0;
    const exit_price = exit_qty > 0 ? exit_quote / exit_qty : 0;
    const net_pnl = realized_pnl - commission;

    let pnl_pct = 0;
    if (entry_price > 0 && !is_open) {
      pnl_pct = direction === 'LONG'
        ? (exit_price - entry_price) / entry_price * 100
        : (entry_price - exit_price) / entry_price * 100;
    }

    return {
      symbol, direction, entry_price, exit_price, qty: entry_qty,
      realized_pnl: net_pnl, pnl_pct,
      first_trade_id: trades[0].trade_id,
      last_trade_id: trades[trades.length - 1].trade_id,
      opened_time: trades[0].trade_time,
      closed_time: trades[trades.length - 1].trade_time,
      is_open,
    };
  }

  /** 单回合落库：未闭合→回填/新建 open；已闭合→平仓已有 log 或新建 closed */
  private async reconcile_round(round: TradeRound): Promise<{ filled: number; created: number; closed: number }> {
    if (round.is_open) {
      const log = await this.repository.find_open_or_analyzing(round.symbol, round.direction);
      if (log) {
        await this.repository.apply_open_round(log.id!, {
          entry_price: round.entry_price, qty: round.qty, leverage: round.leverage,
          first_trade_id: round.first_trade_id, opened_at: new Date(round.opened_time),
        });
        return { filled: 1, created: 0, closed: 0 };
      }
      await this.repository.create_open_round({
        symbol: round.symbol, direction: round.direction,
        entry_reason: '未评估，系统从交易所同步的持仓',
        entry_price: round.entry_price, qty: round.qty, leverage: round.leverage,
        first_trade_id: round.first_trade_id, opened_at: new Date(round.opened_time),
      });
      return { filled: 0, created: 1, closed: 0 };
    }

    // 已平仓回合：last_trade_id 精确去重
    if (await this.repository.find_by_last_trade_id(round.last_trade_id)) {
      return { filled: 0, created: 0, closed: 0 };
    }

    // 有对应 open log（评估过/已回填的持仓）→ 平掉并复盘
    const open_log = await this.repository.find_open_or_analyzing(round.symbol, round.direction);
    if (open_log && open_log.status === 'open') {
      await this.close_log_with_round(open_log, round);
      return { filled: 1, created: 0, closed: 1 };
    }

    // 完全没评估、开了又平 → 新建 closed 并补复盘
    const id = await this.repository.create_closed_round({
      symbol: round.symbol, direction: round.direction,
      entry_reason: '未评估，系统从交易所同步的已平仓交易',
      entry_price: round.entry_price, exit_price: round.exit_price, qty: round.qty, leverage: round.leverage,
      realized_pnl: round.realized_pnl, pnl_pct: round.pnl_pct,
      first_trade_id: round.first_trade_id, last_trade_id: round.last_trade_id,
      opened_at: new Date(round.opened_time), closed_at: new Date(round.closed_time),
    });
    const log = await this.repository.find_by_id(id);
    if (log) {
      await this.generate_and_save_review(log, '系统从交易所同步检测到已平仓')
        .catch(err => logger.error(`[TradeLog] review for synced closed #${id} failed:`, err));
    }
    return { filled: 0, created: 1, closed: 1 };
  }

  /** 用已闭合回合把现有 open log 平仓并复盘 */
  private async close_log_with_round(log: TradeLog, round: TradeRound): Promise<void> {
    await this.repository.apply_closed_round(log.id!, {
      entry_price: round.entry_price || log.entry_price || 0,
      exit_price: round.exit_price,
      qty: round.qty || log.qty || 0,
      leverage: round.leverage ?? log.leverage,
      realized_pnl: round.realized_pnl,
      pnl_pct: round.pnl_pct,
      first_trade_id: round.first_trade_id,
      last_trade_id: round.last_trade_id,
      opened_at: log.opened_at ?? new Date(round.opened_time),
      closed_at: new Date(round.closed_time),
    });
    const updated = await this.repository.find_by_id(log.id!);
    if (updated) await this.generate_and_save_review(updated, '系统从交易所同步检测到已平仓');
    logger.info(`[TradeLog] Closed log #${log.id} from round: exit=${round.exit_price.toFixed(4)}, net_pnl=${round.realized_pnl.toFixed(4)}`);
  }

  /** 拉取真实持仓并归一化（过滤空仓，按 positionAmt 正负定方向） */
  private async fetch_live_positions(symbol?: string): Promise<Array<{ symbol: string; direction: TradeDirection; entry_price: number; qty: number; leverage?: number }>> {
    const raw: PositionInfo[] = await this.trading_api.get_position_info(symbol);
    return raw
      .filter(p => Math.abs(Number(p.positionAmt)) > 0)
      .map(p => {
        const amt = Number(p.positionAmt);
        const direction: TradeDirection =
          p.positionSide === 'LONG' ? 'LONG'
          : p.positionSide === 'SHORT' ? 'SHORT'
          : amt >= 0 ? 'LONG' : 'SHORT';
        return { symbol: p.symbol, direction, entry_price: Number(p.entryPrice), qty: Math.abs(amt), leverage: p.leverage ? Number(p.leverage) : undefined };
      });
  }

  // ==================== 历史错误清单 ====================

  private async build_lessons_digest(): Promise<string> {
    if (this.lessons_digest_cache !== null) return this.lessons_digest_cache;
    let digest = '';
    try {
      const reviews = await this.repository.get_recent_lessons(20);
      const items = new Set<string>();
      for (const r of reviews) {
        for (const l of r.lessons) if (l?.trim()) items.add(l.trim());
        for (const w of r.what_went_wrong) if (w?.trim()) items.add(w.trim());
      }
      const list = Array.from(items).slice(0, 12);
      if (list.length > 0) digest = list.map((x, i) => `  ${i + 1}. ${x}`).join('\n');
    } catch (err) {
      logger.warn('[TradeLog] build_lessons_digest failed:', err);
    }
    this.lessons_digest_cache = digest;
    return digest;
  }

  // ==================== 数据聚合 ====================

  private async build_market_snapshot(symbol: string, end_time?: number, timeframe?: string): Promise<object> {
    const now = end_time ?? Date.now();
    const klines_data: Record<string, any[]> = {};

    const interval_map: Record<string, string[]> = {
      '5m': ['5m', '15m', '1h'], '15m': ['15m', '1h', '4h'], '1h': ['1h', '4h'], '4h': ['4h'],
    };
    const active_intervals = timeframe && interval_map[timeframe] ? interval_map[timeframe] : ['5m', '15m', '1h', '4h'];
    const limit_map: Record<string, number> = { '5m': 100, '15m': 96, '1h': 100, '4h': 90 };

    await Promise.all(
      active_intervals.map(async (interval) => {
        try {
          const klines = await this.binance_api.get_klines(symbol, interval, undefined, end_time, limit_map[interval] ?? 100);
          klines_data[interval] = klines.map(k => ({ open_time: k.open_time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
        } catch {
          logger.warn(`[TradeLog] Failed to fetch ${interval} klines for ${symbol}`);
          klines_data[interval] = [];
        }
      })
    );

    let sr_levels: any[] = [];
    try {
      const levels = await this.sr_repository.get_active_levels(symbol, '1h');
      sr_levels = levels.slice(0, 10).map(l => ({ type: l.level_type, price: l.price, strength: l.strength, touch_count: l.touch_count }));
    } catch {
      logger.warn(`[TradeLog] Failed to fetch SR levels for ${symbol}`);
    }

    const price_interval = active_intervals[0];
    const last_kline = klines_data[price_interval]?.slice(-1)[0];
    const current_price: number | null = last_kline?.close ? Number(last_kline.close) : null;

    return { symbol, current_price, snapshot_time: new Date(now).toISOString(), klines: klines_data, sr_levels };
  }

  // ==================== AI 调用（prompt 与原 trade_journal 一致）====================

  private async call_ai_for_entry(params: {
    symbol: string; direction: TradeDirection; entry_reason: string;
    planned_entry_price?: number; planned_stop_loss?: number; planned_take_profit?: number;
    market_snapshot: object; lessons_digest?: string;
  }): Promise<AiAnalysisResult> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, market_snapshot, lessons_digest } = params;
    const snapshot = market_snapshot as any;

    const sr_text = snapshot.sr_levels?.length > 0
      ? snapshot.sr_levels.map((l: any) => `  - ${l.type} @ ${l.price}（强度 ${l.strength}，触碰 ${l.touch_count} 次）`).join('\n')
      : '  暂无数据';
    const kline_section = this.format_klines_for_prompt(snapshot.klines ?? {});
    const lessons_section = lessons_digest
      ? `\n## 该用户历史上常犯的错误（来自过往复盘，请重点检查本次是否重蹈覆辙）\n${lessons_digest}\n\n如果本次计划命中其中任何一条，请在 risk_points 里明确点名指出。\n`
      : '';

    const prompt = `
你是一位专注于价格行为（Price Action）的专业加密货币交易员。
请基于以下多周期K线数据，对该交易计划进行详细的价格行为分析。

## 交易计划
- 币种：${symbol}
- 方向：${direction === 'LONG' ? '做多' : '做空'}
- 当前价格：${snapshot.current_price ?? '未知'}
- 计划入场价：${planned_entry_price ?? '未指定'}
- 计划止损：${planned_stop_loss ?? '未指定'}
- 计划止盈：${planned_take_profit ?? '未指定'}
- 入场理由：${entry_reason}

## 多周期K线数据（每行开头为北京时间 MMDD/HHMM，按时间从旧到新排列，最后一根为最新K线）
${kline_section}

## 关键支撑阻力位
${sr_text}
${lessons_section}
## 分析要求
请严格按照以下结构逐项分析，每项必须引用具体价格和K线时间（如「1h 0616/2200」表示1h周期该时间的K线）：

1. **4h/1h 大周期结构**：当前趋势方向及依据、价格处于结构中的位置
2. **15m/5m 小周期入场结构**：与大周期是否一致、入场点附近K线形态、量价关系
3. **关键价格位分析**：与最近支撑/阻力的距离、止损是否在结构之外、止盈是否在下一阻力/支撑前
4. **入场逻辑评估**：入场理由与结构是否吻合、胜算依据

## 输出要求
交易决策需要可执行的清单式结论。请给出可证伪的具体价格。
其中 invalidation_price（失效价）最重要：价格一旦到达/突破它即证明想法错误、应离场。必须给出。

严格按以下 JSON 格式返回，不要有任何其他内容：
{
  "action": "enter | wait | skip",
  "entry_zone": [入场区间下沿价, 入场区间上沿价],
  "invalidation_price": 失效价,
  "targets": [目标1价, 目标2价],
  "rr_ratio": 盈亏比数字,
  "analysis": "价格行为分析（精简 150-250 字）",
  "risk_points": ["具体风险点，含价格参考"],
  "opportunities": ["具体机会点，含价格参考"],
  "overall_assessment": "综合结论与明确动作建议（50-100字）",
  "confidence_score": 75
}
`.trim();

    return this.parse_ai_result(prompt);
  }

  private async call_ai_for_reassess(params: {
    log: TradeLog; current_price: number; floating_pnl_text: string; concern: string;
    market_snapshot: object; entry_risk_points: string[];
  }): Promise<AiAnalysisResult> {
    const { log, current_price, floating_pnl_text, concern, market_snapshot, entry_risk_points } = params;
    const snapshot = market_snapshot as any;

    const sr_text = snapshot.sr_levels?.length > 0
      ? snapshot.sr_levels.map((l: any) => `  - ${l.type} @ ${l.price}（强度 ${l.strength}）`).join('\n')
      : '  暂无数据';
    const kline_section = this.format_klines_for_prompt(snapshot.klines ?? {});

    const has_entry_risks = entry_risk_points.length > 0;
    const entry_risks_text = has_entry_risks
      ? entry_risk_points.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
      : '  （入场时未记录风险点）';
    const risk_review_requirement = has_entry_risks
      ? `\n\n## 入场时你列出的风险点（必须逐条复核）\n${entry_risks_text}\n\n请对每条结合当前价格判断状态：materialized（已兑现）/ cleared（已解除）/ pending（仍待定），每条给依据（引用具体价格）。`
      : '';
    const risk_review_json = has_entry_risks
      ? `,\n  "risk_review": [\n    { "risk": "入场风险点原文", "status": "materialized|cleared|pending", "note": "依据（含价格）" }\n  ]`
      : '';

    const prompt = `
你是一位专注于价格行为（Price Action）的专业加密货币交易员，擅长通过裸K和多周期结构判断市场。
我目前持有一笔仓位，行情出现了变化，请从价格行为角度帮我评估是否应该继续持仓或平仓。

## 当前持仓
- 币种：${log.symbol}
- 方向：${log.direction === 'LONG' ? '做多' : '做空'}
- 入场理由：${log.entry_reason ?? '（同步持仓，无评估）'}
- 真实入场价：${log.entry_price ?? log.planned_entry_price ?? '未指定'}
- 计划止损：${log.planned_stop_loss ?? '未指定'}
- 计划止盈：${log.planned_take_profit ?? '未指定'}
- 当前价格：${current_price}
- 当前浮动盈亏：${floating_pnl_text}
- 我的疑虑：${concern}

## 最新市场数据（${snapshot.snapshot_time}）
字段说明：每行开头为北京时间 MMDD/HHMM，o=开盘 h=最高 l=最低 c=收盘 v=成交量，按时间从旧到新排列。
引用K线请用时间标注（如 0616/2200）。

${kline_section}

支撑阻力位：
${sr_text}
${risk_review_requirement}

## 分析要求
结合多周期结构评估持仓：1.结构是否完好 2.关键位置关系 3.近期K线信号 4.与入场逻辑一致性

## 输出要求
严格按以下 JSON 格式返回，不要有任何其他内容：
{
  "analysis": "多周期价格行为分析（300-500字）",
  "risk_points": ["当前风险点1", "当前风险点2"],
  "opportunities": ["支持继续持仓的理由1", "理由2"],
  "overall_assessment": "明确建议：继续持仓 / 部分减仓 / 立即平仓，并说明理由（50-100字）",
  "confidence_score": 60${risk_review_json}
}
`.trim();

    return this.parse_ai_result(prompt);
  }

  private async call_ai_for_review(params: {
    log: TradeLog; exit_reason: string; original_analysis?: string;
  }): Promise<{ review: string; what_went_well: string[]; what_went_wrong: string[]; lessons: string[] }> {
    const { log, exit_reason, original_analysis } = params;

    const pnl = log.realized_pnl ?? 0;
    const pnl_pct = log.pnl_pct ?? 0;
    const result_text = pnl >= 0
      ? `盈利 ${pnl.toFixed(2)} USDT（价格变动 ${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(2)}%）`
      : `亏损 ${Math.abs(pnl).toFixed(2)} USDT（价格变动 ${pnl_pct.toFixed(2)}%）`;
    const analysis_section = original_analysis ? `\n## 入场时的 AI 评估\n${original_analysis}\n` : '';

    const prompt = `
你是一位拥有10年经验的专业加密货币交易员。
请对以下已完成的交易进行复盘分析。

## 交易信息
- 币种：${log.symbol}
- 方向：${log.direction === 'LONG' ? '做多' : '做空'}
- 入场理由：${log.entry_reason ?? '（同步持仓，无评估）'}
- 真实入场价：${log.entry_price ?? '未知'}
- 真实出场价：${log.exit_price ?? '未知'}
- 出场原因：${exit_reason}
- 交易结果：${result_text}
- 开仓时间：${log.opened_at ? new Date(log.opened_at).toISOString() : '未知'}
- 平仓时间：${log.closed_at ? new Date(log.closed_at).toISOString() : new Date().toISOString()}
${analysis_section}

## 输出要求
严格按以下 JSON 格式返回，不要有任何其他内容：
{
  "review": "详细复盘分析（200-400字）",
  "what_went_well": ["做对的地方1", "做对的地方2"],
  "what_went_wrong": ["做错的地方1", "做错的地方2"],
  "lessons": ["经验教训1", "经验教训2"]
}
`.trim();

    try {
      const parsed = await this.call_ai_json(prompt);
      return {
        review: parsed.review ?? '',
        what_went_well: parsed.what_went_well ?? [],
        what_went_wrong: parsed.what_went_wrong ?? [],
        lessons: parsed.lessons ?? [],
      };
    } catch (error) {
      logger.error('[TradeLog] AI review failed:', error);
      throw new Error('AI review failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }
  }

  private async parse_ai_result(prompt: string): Promise<AiAnalysisResult> {
    try {
      const parsed = await this.call_ai_json(prompt);
      return {
        analysis: parsed.analysis ?? '',
        risk_points: parsed.risk_points ?? [],
        opportunities: parsed.opportunities ?? [],
        overall_assessment: parsed.overall_assessment ?? '',
        confidence_score: Number(parsed.confidence_score ?? 50),
        risk_review: Array.isArray(parsed.risk_review) ? parsed.risk_review : undefined,
        decision: parsed.action ? {
          action: parsed.action,
          entry_zone: Array.isArray(parsed.entry_zone) && parsed.entry_zone.length === 2
            ? [Number(parsed.entry_zone[0]), Number(parsed.entry_zone[1])] : null,
          invalidation_price: parsed.invalidation_price != null ? Number(parsed.invalidation_price) : null,
          targets: Array.isArray(parsed.targets) ? parsed.targets.map((t: any) => Number(t)) : [],
          rr_ratio: parsed.rr_ratio != null ? Number(parsed.rr_ratio) : null,
        } : undefined,
      };
    } catch (error) {
      logger.error('[TradeLog] AI call failed:', error);
      throw new Error('AI call failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }
  }

  private async call_ai_json(prompt: string, max_attempts = 2): Promise<any> {
    let last_error: unknown;
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      try {
        const raw = await this.call_ai(prompt);
        return JSON.parse(this.extract_json(raw));
      } catch (error) {
        last_error = error;
        logger.warn(`[TradeLog] AI call/parse attempt ${attempt}/${max_attempts} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    throw last_error;
  }

  private async call_ai(prompt: string): Promise<string> {
    const provider = process.env.AI_PROVIDER || 'claude';
    if (provider === 'openai') {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o', max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content ?? '';
    }
    if (provider === 'deepseek') {
      const response = await this.deepseek.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content ?? '';
    }
    const response = await this.claude.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    return (response.content[0] as any).text as string;
  }

  // ==================== K线格式化与指标 ====================

  private format_klines_for_prompt(klines: Record<string, any[]>): string {
    return ['5m', '15m', '1h', '4h'].map(interval => {
      const ks = klines[interval] ?? [];
      if (ks.length === 0) return `### ${interval}\n暂无数据`;
      const closes = ks.map((k: any) => Number(k.close));
      const ema20 = this.calc_ema(closes, 20);
      const macd = this.calc_macd(closes);
      const indicator_text = [
        ema20 != null ? `EMA20=${ema20.toFixed(4)}` : null,
        macd != null ? `MACD=${macd.macd.toFixed(4)} 信号线=${macd.signal.toFixed(4)} 柱=${macd.histogram.toFixed(4)}` : null,
      ].filter(Boolean).join('  ');
      const rows = ks.map((k: any) => {
        const t = new Date(k.open_time);
        const time_str = `${String(t.getUTCMonth() + 1).padStart(2,'0')}${String(t.getUTCDate()).padStart(2,'0')}/${String((t.getUTCHours() + 8) % 24).padStart(2,'0')}${String(t.getUTCMinutes()).padStart(2,'0')}`;
        const body_pct = k.open > 0 ? ((k.close - k.open) / k.open * 100).toFixed(2) : '0';
        return `${time_str} o:${k.open} h:${k.high} l:${k.low} c:${k.close} v:${Number(k.volume).toFixed(0)} (${Number(body_pct) >= 0 ? '+' : ''}${body_pct}%)`;
      }).join('\n');
      return `### ${interval}（${ks.length}根，北京时间 MMDD/HHMM）  ${indicator_text}\n${rows}`;
    }).join('\n\n');
  }

  private calc_ema(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
    return ema;
  }

  private calc_macd(closes: number[]): { macd: number; signal: number; histogram: number } | null {
    if (closes.length < 35) return null;
    const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
    let ema12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let ema26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    const macd_line: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (i < 12) ema12 = closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
      else ema12 = closes[i] * k12 + ema12 * (1 - k12);
      if (i < 26) ema26 = closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
      else ema26 = closes[i] * k26 + ema26 * (1 - k26);
      if (i >= 25) macd_line.push(ema12 - ema26);
    }
    if (macd_line.length < 9) return null;
    let signal = macd_line.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    for (let i = 9; i < macd_line.length; i++) signal = macd_line[i] * k9 + signal * (1 - k9);
    const macd = macd_line[macd_line.length - 1];
    return { macd, signal, histogram: macd - signal };
  }

  private extract_json(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) return text.slice(start, end + 1);
    return text;
  }

  // ==================== 查询 ====================

  async get_detail(id: number) {
    const [log, analyses, review] = await Promise.all([
      this.repository.find_by_id(id),
      this.repository.find_analyses_by_log(id),
      this.repository.find_review_by_log(id),
    ]);
    const analyses_without_snapshot = analyses.map(({ market_snapshot, ...rest }) => rest);
    return { log, analyses: analyses_without_snapshot, review };
  }

  async get_list(status?: string, limit = 20, offset = 0) {
    return this.repository.find_list(status as any, limit, offset);
  }

  async get_stats() {
    return this.repository.get_stats();
  }

  async get_calibration() {
    return this.repository.get_confidence_calibration();
  }
}
