/**
 * 交易日志服务
 * 负责聚合市场数据、调用 AI API 进行入场评估、持仓再评估和平仓复盘
 * 支持 Claude（@anthropic-ai/sdk）和 OpenAI，通过 AI_PROVIDER 环境变量切换
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { HistoricalDataManager } from '@/core/data/historical_data_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { BinanceAPI } from '@/api';
import { SRLevelRepository } from '@/database/sr_level_repository';
import { TradeJournalRepository, TradeJournal, TradeDirection } from '@/database/trade_journal_repository';
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
  end_time?: number;      // 可选截止时间戳(ms)，不传则使用当前时间，用于测试历史数据
  timeframe?: string;     // 入场周期，决定提供哪些K线：5m/15m/1h/4h，不传则全部
}

export interface ReassessParams {
  journal_id: number;
  current_price: number;
  concern: string;  // 持仓中的疑虑描述，如"跌破了入场支撑位"
}

export interface CloseTradeParams {
  journal_id: number;
  actual_exit_price: number;
  exit_reason: string;
  planned_entry_price?: number;  // 用于计算盈亏（无入场价时由前端传入）
}

// 入场风险点的持仓中复核结果
export interface RiskReviewItem {
  risk: string;                                      // 入场时列的风险点原文
  status: 'materialized' | 'cleared' | 'pending';   // 兑现 / 解除 / 待定
  note: string;                                      // 依据（含价格）
}

// 入场评估的可执行清单结论（强制 AI 给可证伪的具体价格）
export interface EntryDecision {
  action: 'enter' | 'wait' | 'skip';
  entry_zone: [number, number] | null;   // [下沿, 上沿]
  invalidation_price: number | null;      // 失效价：跌破/涨破即想法证伪
  targets: number[];                      // 分批目标
  rr_ratio: number | null;
}

// Claude 分析结果通用结构
interface ClaudeAnalysisResult {
  analysis: string;
  risk_points: string[];
  opportunities: string[];
  overall_assessment: string;
  confidence_score: number;
  risk_review?: RiskReviewItem[];   // 仅再评估时返回：对入场风险点逐条复核
  decision?: EntryDecision;         // 仅入场评估时返回：可执行清单
}

// ==================== Service ====================

export class TradeJournalService {
  private static instance: TradeJournalService;

  private repository: TradeJournalRepository;
  private historical_data_manager: HistoricalDataManager;
  private kline_aggregator: KlineAggregator;
  private binance_api: BinanceAPI;
  private sr_repository: SRLevelRepository;
  private trading_api: BinanceFuturesTradingAPI;
  private claude: Anthropic;
  private openai: OpenAI;
  private deepseek: OpenAI;

  // 历史错误清单缓存（平仓生成新复盘时失效）
  private lessons_digest_cache: string | null = null;

  private constructor() {
    this.repository = new TradeJournalRepository();
    this.historical_data_manager = HistoricalDataManager.getInstance();
    this.kline_aggregator = new KlineAggregator();
    this.binance_api = BinanceAPI.getInstance();
    this.sr_repository = new SRLevelRepository();
    // 同步持仓用分析专用只读密钥（BINANCE_ANALYZE_*），回退到通用密钥
    this.trading_api = new BinanceFuturesTradingAPI(
      process.env.BINANCE_ANALYZE_KEY || process.env.BINANCE_API_KEY,
      process.env.BINANCE_ANALYZE_SECRET || process.env.BINANCE_API_SECRET,
      false
    );
    this.claude = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    // DeepSeek 兼容 OpenAI SDK，只需换 baseURL 和 key
    this.deepseek = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
  }

  static get_instance(): TradeJournalService {
    if (!TradeJournalService.instance) {
      TradeJournalService.instance = new TradeJournalService();
    }
    return TradeJournalService.instance;
  }

  /**
   * 初始化（建表）
   */
  async init(): Promise<void> {
    await this.repository.init_tables();
  }

  // ==================== 核心方法 ====================

  /**
   * 入场前评估：立即创建记录并返回 journal_id，AI 分析异步在后台执行
   * 前端拿到 journal_id 后轮询 GET /api/journal/:id，analyses 有数据即分析完成
   */
  async analyze_entry(params: AnalyzeEntryParams): Promise<{ journal_id: number }> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, end_time, timeframe } = params;

    const journal_id = await this.repository.create_journal({
      symbol,
      direction,
      entry_reason,
      planned_entry_price,
      planned_stop_loss,
      planned_take_profit,
      status: 'analyzing',
    });

    // 异步执行，不阻塞响应；失败时标记 failed，避免前端永远轮询不到结果
    this.run_entry_analysis(journal_id, params).catch(async err => {
      logger.error(`[TradeJournal] Background analysis failed for journal #${journal_id}:`, err);
      await this.repository.mark_failed(journal_id).catch(mark_err => {
        logger.error(`[TradeJournal] mark_failed error for journal #${journal_id}:`, mark_err);
      });
    });

    return { journal_id };
  }

  /**
   * 后台执行入场分析（拉K线 + 调AI + 存库）
   */
  private async run_entry_analysis(journal_id: number, params: AnalyzeEntryParams): Promise<void> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, end_time, timeframe } = params;

    const [market_snapshot, lessons_digest] = await Promise.all([
      this.build_market_snapshot(symbol, end_time, timeframe),
      this.build_lessons_digest(),
    ]);

    const claude_result = await this.call_claude_for_entry({
      symbol, direction, entry_reason,
      planned_entry_price, planned_stop_loss, planned_take_profit,
      market_snapshot,
      lessons_digest,
    });

    const decision = claude_result.decision;
    await this.repository.save_analysis({
      journal_id,
      analysis_type: 'entry',
      market_snapshot,
      claude_analysis: claude_result.analysis,
      risk_points: claude_result.risk_points,
      opportunities: claude_result.opportunities,
      overall_assessment: claude_result.overall_assessment,
      confidence_score: claude_result.confidence_score,
      action: decision?.action ?? null,
      entry_zone_low: decision?.entry_zone?.[0] ?? null,
      entry_zone_high: decision?.entry_zone?.[1] ?? null,
      invalidation_price: decision?.invalidation_price ?? null,
      target_1: decision?.targets?.[0] ?? null,
      target_2: decision?.targets?.[1] ?? null,
      rr_ratio: decision?.rr_ratio ?? null,
    });

    logger.info(`[TradeJournal] Entry analysis done for journal #${journal_id}${decision ? `, action=${decision.action}` : ''}`);
  }

  /**
   * 确认开仓：analyzing → open
   */
  async confirm_open(journal_id: number): Promise<void> {
    const journal = await this.repository.find_by_id(journal_id);
    if (!journal) throw new Error(`Journal #${journal_id} not found`);
    if (journal.status !== 'analyzing') throw new Error(`Journal #${journal_id} is not in analyzing status`);
    await this.repository.mark_open(journal_id);
  }

  /**
   * 放弃开仓：analyzing → dismissed
   */
  async dismiss(journal_id: number): Promise<void> {
    const journal = await this.repository.find_by_id(journal_id);
    if (!journal) throw new Error(`Journal #${journal_id} not found`);
    if (journal.status !== 'analyzing') throw new Error(`Journal #${journal_id} is not in analyzing status`);
    await this.repository.mark_dismissed(journal_id);
  }

  /**
   * 持仓中再评估：校验后立即返回，AI 分析异步执行
   * 前端轮询 GET /api/journal/:id，analyses 中新增 reassess 记录即完成
   */
  async reassess(params: ReassessParams): Promise<{ journal_id: number }> {
    const { journal_id } = params;

    const journal = await this.repository.find_by_id(journal_id);
    if (!journal) throw new Error(`Journal #${journal_id} not found`);
    if (journal.status !== 'open') throw new Error(`Journal #${journal_id} is not open`);

    // 异步执行，不阻塞响应
    this.run_reassess(journal, params).catch(err => {
      logger.error(`[TradeJournal] Background reassess failed for journal #${journal_id}:`, err);
    });

    return { journal_id };
  }

  /**
   * 后台执行持仓再评估（拉K线 + 调AI + 存库）
   */
  private async run_reassess(journal: TradeJournal, params: ReassessParams): Promise<void> {
    const { journal_id, current_price, concern } = params;

    const market_snapshot = await this.build_market_snapshot(journal.symbol);

    // 计算当前浮动盈亏
    const entry_price = journal.planned_entry_price;
    let floating_pnl_text = '未知';
    if (entry_price) {
      const pnl_pct = journal.direction === 'LONG'
        ? (current_price - entry_price) / entry_price * 100
        : (entry_price - current_price) / entry_price * 100;
      floating_pnl_text = `${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(2)}%`;
    }

    // 取入场评估时 AI 列出的风险点，让本次再评估逐条对照（兑现/解除/待定）
    const analyses = await this.repository.find_analyses_by_journal(journal_id);
    const entry_analysis = analyses.find(a => a.analysis_type === 'entry');
    const entry_risk_points = entry_analysis?.risk_points ?? [];

    const claude_result = await this.call_claude_for_reassess({
      journal,
      current_price,
      floating_pnl_text,
      concern,
      market_snapshot,
      entry_risk_points,
    });

    await this.repository.save_analysis({
      journal_id,
      analysis_type: 'reassess',
      market_snapshot,
      claude_analysis: claude_result.analysis,
      risk_points: claude_result.risk_points,
      opportunities: claude_result.opportunities,
      overall_assessment: claude_result.overall_assessment,
      confidence_score: claude_result.confidence_score,
      risk_review: claude_result.risk_review,
    });

    logger.info(`[TradeJournal] Reassess done for journal #${journal_id}`);
  }

  /**
   * 手动平仓并生成复盘
   */
  async close_and_review(params: CloseTradeParams): Promise<{
    review: string;
    what_went_well: string[];
    what_went_wrong: string[];
    lessons: string[];
    pnl_pct: number;
  }> {
    const { journal_id, actual_exit_price, exit_reason, planned_entry_price } = params;

    const journal = await this.repository.find_by_id(journal_id);
    if (!journal) throw new Error(`Journal #${journal_id} not found`);
    if (journal.status !== 'open') throw new Error(`Journal #${journal_id} is not open`);

    // 用计划入场价或前端传入的价格计算盈亏
    const entry_price = journal.planned_entry_price ?? planned_entry_price;
    let pnl_pct = 0;
    if (entry_price) {
      pnl_pct = journal.direction === 'LONG'
        ? (actual_exit_price - entry_price) / entry_price * 100
        : (entry_price - actual_exit_price) / entry_price * 100;
    }

    await this.repository.mark_closed(journal_id, actual_exit_price, pnl_pct);

    const review_result = await this.generate_and_save_review(
      { ...journal, actual_exit_price, pnl_pct },
      exit_reason,
      pnl_pct
    );

    logger.info(`[TradeJournal] Review generated for journal #${journal_id}, pnl_pct=${pnl_pct.toFixed(2)}%`);
    return { ...review_result, pnl_pct };
  }

  /**
   * 生成并保存平仓复盘（手动平仓和同步平仓共用）。
   * 调 AI 复盘 → 存库 → 失效历史错误清单缓存。
   */
  private async generate_and_save_review(
    journal: TradeJournal & { actual_exit_price: number; pnl_pct: number },
    exit_reason: string,
    pnl_pct: number
  ): Promise<{ review: string; what_went_well: string[]; what_went_wrong: string[]; lessons: string[] }> {
    const journal_id = journal.id!;

    // 取最近一次入场评估用于复盘对比
    const analyses = await this.repository.find_analyses_by_journal(journal_id);
    const entry_analysis = analyses.find(a => a.analysis_type === 'entry');

    const review_result = await this.call_claude_for_review({
      journal,
      exit_reason,
      pnl_pct,
      original_analysis: entry_analysis?.claude_analysis,
    });

    await this.repository.save_review({
      journal_id,
      exit_reason,
      claude_review: review_result.review,
      what_went_well: review_result.what_went_well,
      what_went_wrong: review_result.what_went_wrong,
      lessons: review_result.lessons,
    });

    // 有新复盘 → 历史错误清单缓存失效，下次入场评估重新聚合
    this.lessons_digest_cache = null;
    return review_result;
  }

  // ==================== 交易所持仓同步 ====================

  /**
   * 全局同步：拉取交易所所有真实持仓，与系统内 journal 对齐。
   * - 交易所有持仓、系统有对应 open/analyzing journal → 回填真实成交数据
   * - 交易所有持仓、系统无对应 journal → 新建一条 open 记录（未评估的持仓，供复盘）
   * - 系统有 open journal、交易所已无对应持仓 → 标记平仓 + 拉真实盈亏 + 触发 AI 复盘
   *
   * 前端「公共同步持仓」按钮调用。
   */
  async sync_all_positions(): Promise<{
    filled: number;    // 回填到已有 journal 的数量
    created: number;   // 新建的未评估持仓数量
    closed: number;    // 检测到并平仓的数量
  }> {
    const positions = await this.fetch_live_positions();

    // 用 symbol+direction 建索引，便于平仓检测时反查交易所是否还持有
    const live_keys = new Set(positions.map(p => `${p.symbol}_${p.direction}`));

    let filled = 0;
    let created = 0;

    // 1) 交易所每个真实持仓 → 回填或新建
    for (const pos of positions) {
      const journal = await this.repository.find_open_or_analyzing_by_symbol_direction(pos.symbol, pos.direction);
      if (journal) {
        await this.repository.apply_real_position(journal.id!, {
          actual_entry_price: pos.entry_price,
          actual_qty: pos.qty,
          leverage: pos.leverage,
        });
        filled++;
      } else {
        await this.repository.create_synced_journal({
          symbol: pos.symbol,
          direction: pos.direction,
          entry_reason: '未评估，系统从交易所同步的持仓',
          actual_entry_price: pos.entry_price,
          actual_qty: pos.qty,
          leverage: pos.leverage,
        });
        created++;
      }
    }

    // 2) 系统内 open journal，交易所已无对应持仓 → 已平仓
    const active = await this.repository.find_all_active();
    let closed = 0;
    for (const journal of active) {
      if (journal.status !== 'open') continue;  // analyzing 还没开仓，不算平仓
      const key = `${journal.symbol}_${journal.direction}`;
      if (live_keys.has(key)) continue;          // 交易所还持有，跳过
      const ok = await this.close_journal_from_exchange(journal);
      if (ok) closed++;
    }

    logger.info(`[TradeJournal] sync_all_positions done: filled=${filled}, created=${created}, closed=${closed}`);
    return { filled, created, closed };
  }

  /**
   * 单条同步：只同步指定 journal 对应币种的真实持仓。
   * - 交易所仍持有同向持仓 → 回填真实成交数据
   * - 交易所已无持仓 → 当作已平仓，拉真实盈亏 + 触发复盘
   *
   * 前端每条评估里的「同步」按钮调用（journal_id 与币种均确定）。
   */
  async sync_one(journal_id: number): Promise<{ action: 'filled' | 'closed' | 'noop'; journal_id: number }> {
    const journal = await this.repository.find_by_id(journal_id);
    if (!journal) throw new Error(`Journal #${journal_id} not found`);
    if (journal.status === 'closed' || journal.status === 'dismissed') {
      return { action: 'noop', journal_id };
    }

    const positions = await this.fetch_live_positions(journal.symbol);
    const match = positions.find(p => p.symbol === journal.symbol && p.direction === journal.direction);

    if (match) {
      await this.repository.apply_real_position(journal_id, {
        actual_entry_price: match.entry_price,
        actual_qty: match.qty,
        leverage: match.leverage,
      });
      return { action: 'filled', journal_id };
    }

    // 交易所已无持仓：open 的当作已平仓；analyzing 的还没真正开过仓，不动
    if (journal.status === 'open') {
      const ok = await this.close_journal_from_exchange(journal);
      return { action: ok ? 'closed' : 'noop', journal_id };
    }
    return { action: 'noop', journal_id };
  }

  /**
   * 拉取交易所真实持仓并归一化（过滤空仓，按 positionAmt 正负定方向）。
   * 单向持仓模式下 positionSide=BOTH，方向由数量正负判定。
   */
  private async fetch_live_positions(symbol?: string): Promise<Array<{
    symbol: string;
    direction: TradeDirection;
    entry_price: number;
    qty: number;
    leverage?: number;
  }>> {
    const raw: PositionInfo[] = await this.trading_api.get_position_info(symbol);
    return raw
      .filter(p => Math.abs(Number(p.positionAmt)) > 0)
      .map(p => {
        const amt = Number(p.positionAmt);
        // 双向持仓用 positionSide 判定，单向持仓(BOTH)用数量正负判定
        const direction: TradeDirection =
          p.positionSide === 'LONG' ? 'LONG'
          : p.positionSide === 'SHORT' ? 'SHORT'
          : amt >= 0 ? 'LONG' : 'SHORT';
        return {
          symbol: p.symbol,
          direction,
          entry_price: Number(p.entryPrice),
          qty: Math.abs(amt),
          leverage: p.leverage ? Number(p.leverage) : undefined,
        };
      });
  }

  /**
   * 从交易所真实成交记录推断平仓价与已实现盈亏，落库并触发 AI 复盘。
   * 返回是否成功平仓（false 表示拉不到平仓成交，状态保持不变，待下次同步）。
   */
  private async close_journal_from_exchange(journal: TradeJournal): Promise<boolean> {
    const journal_id = journal.id!;
    try {
      // 取开仓后的成交记录，方向相反的即平仓成交（单向持仓：LONG 仓由 SELL 平）
      const start_time = journal.opened_at ? new Date(journal.opened_at).getTime() : undefined;
      const trades = await this.trading_api.get_user_trades(journal.symbol, {
        startTime: start_time,
        limit: 1000,
      });

      const close_side = journal.direction === 'LONG' ? 'SELL' : 'BUY';
      const close_trades = trades.filter(t => t.side === close_side);
      if (close_trades.length === 0) {
        logger.warn(`[TradeJournal] No closing trades found for journal #${journal_id} (${journal.symbol}), skip close`);
        return false;
      }

      // 加权平均平仓价 + 累计已实现盈亏（已扣手续费由 realizedPnl 体现，手续费另计）
      let qty_sum = 0;
      let quote_sum = 0;
      let realized_pnl = 0;
      let commission = 0;
      for (const t of close_trades) {
        const qty = Number(t.qty);
        qty_sum += qty;
        quote_sum += Number(t.price) * qty;
        realized_pnl += Number(t.realizedPnl);
        commission += Number(t.commission);
      }
      const avg_exit_price = qty_sum > 0 ? quote_sum / qty_sum : 0;
      // realizedPnl 不含手续费，扣掉得到净盈亏
      const net_pnl = realized_pnl - commission;

      // 价格变动%（不含杠杆），入场价优先用真实成交价
      const entry_price = journal.actual_entry_price ?? journal.planned_entry_price;
      let pnl_pct = 0;
      if (entry_price) {
        pnl_pct = journal.direction === 'LONG'
          ? (avg_exit_price - entry_price) / entry_price * 100
          : (entry_price - avg_exit_price) / entry_price * 100;
      }

      await this.repository.apply_real_close(journal_id, {
        actual_exit_price: avg_exit_price,
        realized_pnl: net_pnl,
        pnl_pct,
      });

      // 触发 AI 复盘（同手动平仓）
      const exit_reason = '系统从交易所同步检测到已平仓';
      await this.generate_and_save_review(
        { ...journal, status: 'closed', actual_exit_price: avg_exit_price, realized_pnl: net_pnl, pnl_pct },
        exit_reason,
        pnl_pct
      );

      logger.info(`[TradeJournal] Closed journal #${journal_id} from exchange: exit=${avg_exit_price.toFixed(4)}, net_pnl=${net_pnl.toFixed(4)}`);
      return true;
    } catch (err) {
      logger.error(`[TradeJournal] close_journal_from_exchange failed for #${journal_id}:`, err);
      return false;
    }
  }

  /**
   * 聚合「该用户历史高频错误清单」，注入入场评估 prompt。
   * 取最近若干条复盘的 lessons + what_went_wrong，去重后缓存；平仓生成新复盘时失效。
   * 返回空串表示暂无历史数据。
   */
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
      // 最多保留 12 条，避免 prompt 过长
      const list = Array.from(items).slice(0, 12);
      if (list.length > 0) {
        digest = list.map((x, i) => `  ${i + 1}. ${x}`).join('\n');
      }
    } catch (err) {
      logger.warn('[TradeJournal] build_lessons_digest failed:', err);
    }
    this.lessons_digest_cache = digest;
    return digest;
  }

  // ==================== 数据聚合 ====================

  /**
   * 聚合当前市场快照：多周期K线 + 支撑阻力位
   */
  private async build_market_snapshot(symbol: string, end_time?: number, timeframe?: string): Promise<object> {
    const now = end_time ?? Date.now();
    const klines_data: Record<string, any[]> = {};

    // 根据入场周期决定提供哪些周期的K线
    const interval_map: Record<string, string[]> = {
      '5m':  ['5m', '15m', '1h'],
      '15m': ['15m', '1h', '4h'],
      '1h':  ['1h', '4h'],
      '4h':  ['4h'],
    };
    const active_intervals = timeframe && interval_map[timeframe]
      ? interval_map[timeframe]
      : ['5m', '15m', '1h', '4h'];

    // 各周期数量配置
    const limit_map: Record<string, number> = {
      '5m': 100, '15m': 96, '1h': 100, '4h': 90,
    };

    // 全部直接从币安 API 拉取，确保包含当前未收盘K线，数据最新
    await Promise.all(
      active_intervals.map(async (interval) => {
        try {
          const klines = await this.binance_api.get_klines(
            symbol, interval, undefined, end_time, limit_map[interval] ?? 100
          );
          klines_data[interval] = klines.map(k => ({
            open_time: k.open_time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume,
          }));
        } catch {
          logger.warn(`[TradeJournal] Failed to fetch ${interval} klines for ${symbol}`);
          klines_data[interval] = [];
        }
      })
    );

    let sr_levels: any[] = [];
    try {
      const levels = await this.sr_repository.get_active_levels(symbol, '1h');
      sr_levels = levels.slice(0, 10).map(l => ({
        type: l.level_type,
        price: l.price,
        strength: l.strength,
        touch_count: l.touch_count,
      }));
    } catch {
      logger.warn(`[TradeJournal] Failed to fetch SR levels for ${symbol}`);
    }

    // 当前价格取最小周期最后一根 K 线的收盘价（包含未收盘K线的实时价）
    const price_interval = active_intervals[0];
    const last_kline = klines_data[price_interval]?.slice(-1)[0];
    const current_price: number | null = last_kline?.close ? Number(last_kline.close) : null;

    return {
      symbol,
      current_price,
      snapshot_time: new Date(now).toISOString(),
      klines: klines_data,
      sr_levels,
    };
  }

  // ==================== Claude 调用 ====================

  /**
   * 入场评估 prompt
   */
  private async call_claude_for_entry(params: {
    symbol: string;
    direction: TradeDirection;
    entry_reason: string;
    planned_entry_price?: number;
    planned_stop_loss?: number;
    planned_take_profit?: number;
    market_snapshot: object;
    lessons_digest?: string;
  }): Promise<ClaudeAnalysisResult> {
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

1. **4h/1h 大周期结构**
   - 当前趋势方向（上涨/下跌/震荡），依据是哪几根K线形成的高低点
   - 价格当前处于结构中的什么位置（突破后回测/支撑反弹/阻力压制/趋势中继等）

2. **15m/5m 小周期入场结构**
   - 小周期与大周期结构是否一致
   - 入场点附近的K线形态（具体说出是哪根K线的时间、形态名称）
   - 量价关系：成交量是否配合走势

3. **关键价格位分析**
   - 当前价格与最近支撑/阻力位的距离和关系
   - 止损位是否设在结构之外（关键低点/高点下方或上方）
   - 如有止盈，是否在下一个阻力/支撑位之前

4. **入场逻辑评估**
   - 用户的入场理由与当前价格结构是否吻合
   - 这个位置入场的胜算依据是什么

## 输出要求
交易决策需要的是可执行的清单式结论，不是模糊的散文。请给出**可证伪的具体价格**。
其中 invalidation_price（失效价）最重要：它是一个具体价格——价格一旦到达/突破它，就证明这个交易想法是错的，应当离场。必须给出，不能含糊。

严格按以下 JSON 格式返回，不要有任何其他内容：
{
  "action": "enter | wait | skip（明确动作：现在入场 / 等待更好位置 / 放弃）",
  "entry_zone": [入场区间下沿价, 入场区间上沿价],
  "invalidation_price": 失效价（具体数字，到此价证明想法错误）,
  "targets": [目标1价, 目标2价],
  "rr_ratio": 盈亏比数字（用 entry / invalidation / target1 估算）,
  "analysis": "价格行为分析，引用具体价格和K线时间（精简到 150-250 字，只讲关键依据）",
  "risk_points": ["具体风险点，包含价格参考", "..."],
  "opportunities": ["具体机会点，包含价格参考", "..."],
  "overall_assessment": "综合结论与明确动作建议（50-100字）",
  "confidence_score": 75
}
`.trim();

    return this.call_claude(prompt);
  }

  /**
   * 持仓中再评估 prompt
   */
  private async call_claude_for_reassess(params: {
    journal: TradeJournal;
    current_price: number;
    floating_pnl_text: string;
    concern: string;
    market_snapshot: object;
    entry_risk_points: string[];
  }): Promise<ClaudeAnalysisResult> {
    const { journal, current_price, floating_pnl_text, concern, market_snapshot, entry_risk_points } = params;
    const snapshot = market_snapshot as any;

    const sr_text = snapshot.sr_levels?.length > 0
      ? snapshot.sr_levels.map((l: any) => `  - ${l.type} @ ${l.price}（强度 ${l.strength}）`).join('\n')
      : '  暂无数据';

    const kline_section = this.format_klines_for_prompt(snapshot.klines ?? {});

    // 入场时列出的风险点，逐条带回让 AI 复核
    const has_entry_risks = entry_risk_points.length > 0;
    const entry_risks_text = has_entry_risks
      ? entry_risk_points.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
      : '  （入场时未记录风险点）';

    const risk_review_requirement = has_entry_risks
      ? `

## 入场时你列出的风险点（必须逐条复核）
${entry_risks_text}

请对上面每一条风险点，结合当前价格走势判断它现在的状态：
- materialized（已兑现）：这个风险实际发生了
- cleared（已解除）：这个风险已不再成立
- pending（仍待定）：尚未发生但仍需警惕
每条都要给出依据（引用具体价格）。`
      : '';

    const risk_review_json = has_entry_risks
      ? `,
  "risk_review": [
    { "risk": "入场风险点原文", "status": "materialized|cleared|pending", "note": "依据（含价格）" }
  ]`
      : '';

    const prompt = `
你是一位专注于价格行为（Price Action）的专业加密货币交易员，擅长通过裸K和多周期结构判断市场。
我目前持有一笔仓位，行情出现了变化，请从价格行为角度帮我评估是否应该继续持仓或平仓。

## 当前持仓
- 币种：${journal.symbol}
- 方向：${journal.direction === 'LONG' ? '做多' : '做空'}
- 入场理由：${journal.entry_reason}
- 计划入场价：${journal.planned_entry_price ?? '未指定'}
- 计划止损：${journal.planned_stop_loss ?? '未指定'}
- 计划止盈：${journal.planned_take_profit ?? '未指定'}
- 当前价格：${current_price}
- 当前浮动盈亏：${floating_pnl_text}
- 我的疑虑：${concern}

## 最新市场数据（${snapshot.snapshot_time}）
字段说明：每行开头为北京时间 MMDD/HHMM，o=开盘 h=最高 l=最低 c=收盘 v=成交量，按时间从旧到新排列（越靠后越新）。
引用K线时请用时间标注（如 0616/2200）。

${kline_section}

支撑阻力位：
${sr_text}
${risk_review_requirement}

## 分析要求
请从价格行为角度，结合多周期结构评估持仓状态：
1. **结构是否完好**：入场时的价格结构是否仍然成立，还是已被破坏
2. **关键位置**：当前价格与止损/止盈/关键支撑阻力的位置关系
3. **近期K线信号**：是否出现反转或加速信号
4. **与入场逻辑的一致性**：当前走势是否还符合原始入场逻辑

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

    return this.call_claude(prompt);
  }

  /**
   * 平仓复盘 prompt
   */
  private async call_claude_for_review(params: {
    journal: TradeJournal & { actual_exit_price: number; pnl_pct: number };
    exit_reason: string;
    pnl_pct: number;
    original_analysis?: string;
  }): Promise<{
    review: string;
    what_went_well: string[];
    what_went_wrong: string[];
    lessons: string[];
  }> {
    const { journal, exit_reason, pnl_pct, original_analysis } = params;

    const result_text = pnl_pct >= 0
      ? `盈利 ${pnl_pct.toFixed(2)}%`
      : `亏损 ${Math.abs(pnl_pct).toFixed(2)}%`;

    const analysis_section = original_analysis
      ? `\n## 入场时的 AI 评估\n${original_analysis}\n`
      : '';

    const prompt = `
你是一位拥有10年经验的专业加密货币交易员。
请对以下已完成的交易进行复盘分析。

## 交易信息
- 币种：${journal.symbol}
- 方向：${journal.direction === 'LONG' ? '做多' : '做空'}
- 入场理由：${journal.entry_reason}
- 计划入场价：${journal.planned_entry_price ?? '未指定'}
- 实际出场价：${journal.actual_exit_price}
- 出场原因：${exit_reason}
- 交易结果：${result_text}
- 开仓时间：${journal.opened_at ? new Date(journal.opened_at).toISOString() : '未知'}
- 平仓时间：${new Date().toISOString()}
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
      logger.error('[TradeJournal] AI review failed:', error);
      throw new Error('AI review failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }
  }

  /**
   * 通用 AI 分析调用（入场评估和再评估）
   */
  private async call_claude(prompt: string): Promise<ClaudeAnalysisResult> {
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
            ? [Number(parsed.entry_zone[0]), Number(parsed.entry_zone[1])]
            : null,
          invalidation_price: parsed.invalidation_price != null ? Number(parsed.invalidation_price) : null,
          targets: Array.isArray(parsed.targets) ? parsed.targets.map((t: any) => Number(t)) : [],
          rr_ratio: parsed.rr_ratio != null ? Number(parsed.rr_ratio) : null,
        } : undefined,
      };
    } catch (error) {
      logger.error('[TradeJournal] AI call failed:', error);
      throw new Error('AI call failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }
  }

  /**
   * 调用 AI 并解析 JSON 结果，失败（截断/格式错误/网络异常）自动重试一次
   */
  private async call_ai_json(prompt: string, max_attempts: number = 2): Promise<any> {
    let last_error: unknown;
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      try {
        const raw = await this.call_ai(prompt);
        return JSON.parse(this.extract_json(raw));
      } catch (error) {
        last_error = error;
        logger.warn(`[TradeJournal] AI call/parse attempt ${attempt}/${max_attempts} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    throw last_error;
  }

  /**
   * 底层 AI 调用，通过 AI_PROVIDER 环境变量切换
   * 支持：claude（默认）、openai、deepseek
   */
  private async call_ai(prompt: string): Promise<string> {
    const provider = process.env.AI_PROVIDER || 'claude';

    if (provider === 'openai') {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content ?? '';
    }

    if (provider === 'deepseek') {
      const response = await this.deepseek.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content ?? '';
    }

    const response = await this.claude.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    return (response.content[0] as any).text as string;
  }

  /**
   * 将 K 线数据格式化为带北京时间的文本，并附带 EMA20 和 MACD 指标
   * 每根格式：MMDD/HHMM o h l c v (实体涨跌%)，全量输出，时间供AI引用定位
   */
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

  /**
   * 计算 EMA
   */
  private calc_ema(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  /**
   * 计算标准 MACD（12/26/9）
   */
  private calc_macd(closes: number[]): { macd: number; signal: number; histogram: number } | null {
    if (closes.length < 35) return null;

    const k12 = 2 / 13;
    const k26 = 2 / 27;
    const k9  = 2 / 10;

    // 计算每根的 EMA12 和 EMA26
    let ema12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let ema26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

    const macd_line: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      if (i < 12) { ema12 = closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1); }
      else { ema12 = closes[i] * k12 + ema12 * (1 - k12); }

      if (i < 26) { ema26 = closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1); }
      else { ema26 = closes[i] * k26 + ema26 * (1 - k26); }

      if (i >= 25) macd_line.push(ema12 - ema26);
    }

    if (macd_line.length < 9) return null;

    // 信号线 = MACD 的 9 期 EMA
    let signal = macd_line.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    for (let i = 9; i < macd_line.length; i++) {
      signal = macd_line[i] * k9 + signal * (1 - k9);
    }

    const macd = macd_line[macd_line.length - 1];
    return { macd, signal, histogram: macd - signal };
  }

  /**
   * 从 Claude 返回文本中提取 JSON，兼容 markdown 代码块包裹的情况
   */
  private extract_json(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) return text.slice(start, end + 1);
    return text;
  }

  // ==================== 查询方法（供路由层调用）====================

  async get_journal_detail(id: number) {
    const [journal, analyses, review] = await Promise.all([
      this.repository.find_by_id(id),
      this.repository.find_analyses_by_journal(id),
      this.repository.find_review_by_journal(id),
    ]);
    const analyses_without_snapshot = analyses.map(({ market_snapshot, ...rest }) => rest);
    return { journal, analyses: analyses_without_snapshot, review };
  }

  async get_journal_list(status?: string, limit = 20, offset = 0) {
    return this.repository.find_list(status as any, limit, offset);
  }

  async get_stats() {
    return this.repository.get_stats();
  }

  /** 置信度校准：分桶看高置信度是否真的更赚（满 30 笔后才有参考意义） */
  async get_calibration() {
    return this.repository.get_confidence_calibration();
  }
}
