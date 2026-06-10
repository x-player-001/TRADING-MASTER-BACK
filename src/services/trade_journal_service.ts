/**
 * 交易日志服务
 * 负责聚合市场数据、调用 AI API 进行入场评估、持仓再评估和平仓复盘
 * 支持 Claude（@anthropic-ai/sdk）和 OpenAI，通过 AI_PROVIDER 环境变量切换
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { HistoricalDataManager } from '@/core/data/historical_data_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { SRLevelRepository } from '@/database/sr_level_repository';
import { TradeJournalRepository, TradeJournal, TradeDirection } from '@/database/trade_journal_repository';
import { logger } from '@/utils/logger';

// ==================== 入参类型 ====================

export interface AnalyzeEntryParams {
  symbol: string;
  direction: TradeDirection;
  entry_reason: string;
  planned_entry_price?: number;
  planned_stop_loss?: number;
  planned_take_profit?: number;
  end_time?: number;  // 可选截止时间戳(ms)，不传则使用当前时间，用于测试历史数据
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

// Claude 分析结果通用结构
interface ClaudeAnalysisResult {
  analysis: string;
  risk_points: string[];
  opportunities: string[];
  overall_assessment: string;
  confidence_score: number;
}

// ==================== Service ====================

export class TradeJournalService {
  private static instance: TradeJournalService;

  private repository: TradeJournalRepository;
  private historical_data_manager: HistoricalDataManager;
  private kline_aggregator: KlineAggregator;
  private sr_repository: SRLevelRepository;
  private claude: Anthropic;
  private openai: OpenAI;
  private deepseek: OpenAI;

  private constructor() {
    this.repository = new TradeJournalRepository();
    this.historical_data_manager = HistoricalDataManager.getInstance();
    this.kline_aggregator = new KlineAggregator();
    this.sr_repository = new SRLevelRepository();
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
   * 入场前评估：创建记录（analyzing）→ 聚合市场数据 → Claude 分析 → 保存
   */
  async analyze_entry(params: AnalyzeEntryParams): Promise<ClaudeAnalysisResult & {
    journal_id: number;
    market_snapshot: object;
  }> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, end_time } = params;

    const journal_id = await this.repository.create_journal({
      symbol,
      direction,
      entry_reason,
      planned_entry_price,
      planned_stop_loss,
      planned_take_profit,
      status: 'analyzing',
    });

    const market_snapshot = await this.build_market_snapshot(symbol, end_time);

    const claude_result = await this.call_claude_for_entry({
      symbol, direction, entry_reason,
      planned_entry_price, planned_stop_loss, planned_take_profit,
      market_snapshot,
    });

    await this.repository.save_analysis({
      journal_id,
      analysis_type: 'entry',
      market_snapshot,
      claude_analysis: claude_result.analysis,
      risk_points: claude_result.risk_points,
      opportunities: claude_result.opportunities,
      overall_assessment: claude_result.overall_assessment,
      confidence_score: claude_result.confidence_score,
    });

    logger.info(`[TradeJournal] Entry analysis done for journal #${journal_id}`);
    return { journal_id, market_snapshot, ...claude_result };
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
   * 持仓中再评估：基于当前市场数据 + 你的疑虑，Claude 给出是否平仓的意见
   */
  async reassess(params: ReassessParams): Promise<ClaudeAnalysisResult & { market_snapshot: object }> {
    const { journal_id, current_price, concern } = params;

    const journal = await this.repository.find_by_id(journal_id);
    if (!journal) throw new Error(`Journal #${journal_id} not found`);
    if (journal.status !== 'open') throw new Error(`Journal #${journal_id} is not open`);

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

    const claude_result = await this.call_claude_for_reassess({
      journal,
      current_price,
      floating_pnl_text,
      concern,
      market_snapshot,
    });

    // 保存这次再评估记录
    await this.repository.save_analysis({
      journal_id,
      analysis_type: 'reassess',
      market_snapshot,
      claude_analysis: claude_result.analysis,
      risk_points: claude_result.risk_points,
      opportunities: claude_result.opportunities,
      overall_assessment: claude_result.overall_assessment,
      confidence_score: claude_result.confidence_score,
    });

    return { market_snapshot, ...claude_result };
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

    // 取最近一次入场评估用于复盘对比
    const analyses = await this.repository.find_analyses_by_journal(journal_id);
    const entry_analysis = analyses.find(a => a.analysis_type === 'entry');

    const review_result = await this.call_claude_for_review({
      journal: { ...journal, actual_exit_price, pnl_pct },
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

    logger.info(`[TradeJournal] Review generated for journal #${journal_id}, pnl_pct=${pnl_pct.toFixed(2)}%`);
    return { ...review_result, pnl_pct };
  }

  // ==================== 数据聚合 ====================

  /**
   * 聚合当前市场快照：多周期K线 + 支撑阻力位
   */
  private async build_market_snapshot(symbol: string, end_time?: number): Promise<object> {
    const now = end_time ?? Date.now();
    const klines_data: Record<string, any[]> = {};

    // 各周期数量配置
    const db_intervals: { interval: string; limit: number }[] = [
      { interval: '5m',  limit: 100 },  // 约8小时
      { interval: '15m', limit: 96  },  // 约1天
      { interval: '1h',  limit: 100 },  // 约4天
    ];

    // 5m/15m/1h 走 HistoricalDataManager（Redis→MySQL→API 降级）
    await Promise.all(
      db_intervals.map(async ({ interval, limit }) => {
        try {
          const klines = await this.historical_data_manager.get_historical_klines(
            symbol, interval, undefined, now, limit
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

    // 4h 走 KlineAggregator（kline_4h_agg 聚合表）
    try {
      const start_4h = now - 90 * 4 * 60 * 60 * 1000; // 约15天
      const klines_4h = await this.kline_aggregator.get_klines_from_db(symbol, '4h', start_4h, now);
      klines_data['4h'] = klines_4h.map(k => ({
        open_time: k.open_time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      }));
    } catch {
      logger.warn(`[TradeJournal] Failed to fetch 4h klines for ${symbol}`);
      klines_data['4h'] = [];
    }

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

    const last_kline = klines_data['1h']?.slice(-1)[0];
    const current_price = last_kline?.close ?? null;

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
  }): Promise<ClaudeAnalysisResult> {
    const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, market_snapshot } = params;
    const snapshot = market_snapshot as any;

    const sr_text = snapshot.sr_levels?.length > 0
      ? snapshot.sr_levels.map((l: any) => `  - ${l.type} @ ${l.price}（强度 ${l.strength}，触碰 ${l.touch_count} 次）`).join('\n')
      : '  暂无数据';

    const kline_summary = ['5m', '15m', '1h', '4h'].map(interval => {
      const ks = (snapshot.klines?.[interval] ?? []).slice(-5);
      if (ks.length === 0) return `  ${interval}: 暂无数据`;
      const last = ks[ks.length - 1];
      const pct = last.open > 0 ? ((last.close - last.open) / last.open * 100).toFixed(2) : 'N/A';
      return `  ${interval}: 收盘 ${last.close}，涨跌 ${pct}%`;
    }).join('\n');

    const prompt = `
你是一位拥有10年经验的专业加密货币交易员，擅长技术分析。
请对以下交易计划进行独立评估。

## 交易计划
- 币种：${symbol}
- 方向：${direction === 'LONG' ? '做多' : '做空'}
- 当前价格：${snapshot.current_price ?? '未知'}
- 计划入场价：${planned_entry_price ?? '未指定'}
- 计划止损：${planned_stop_loss ?? '未指定'}
- 计划止盈：${planned_take_profit ?? '未指定'}
- 入场理由：${entry_reason}

## 市场数据（${snapshot.snapshot_time}）
各周期K线（最近5根）：
${kline_summary}

支撑阻力位：
${sr_text}

## 输出要求
严格按以下 JSON 格式返回，不要有任何其他内容：
{
  "analysis": "详细分析（200-400字）",
  "risk_points": ["风险点1", "风险点2"],
  "opportunities": ["机会点1", "机会点2"],
  "overall_assessment": "综合评估与建议（50-100字）",
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
  }): Promise<ClaudeAnalysisResult> {
    const { journal, current_price, floating_pnl_text, concern, market_snapshot } = params;
    const snapshot = market_snapshot as any;

    const sr_text = snapshot.sr_levels?.length > 0
      ? snapshot.sr_levels.map((l: any) => `  - ${l.type} @ ${l.price}（强度 ${l.strength}）`).join('\n')
      : '  暂无数据';

    const kline_summary = ['5m', '15m', '1h', '4h'].map(interval => {
      const ks = (snapshot.klines?.[interval] ?? []).slice(-5);
      if (ks.length === 0) return `  ${interval}: 暂无数据`;
      const last = ks[ks.length - 1];
      const pct = last.open > 0 ? ((last.close - last.open) / last.open * 100).toFixed(2) : 'N/A';
      return `  ${interval}: 收盘 ${last.close}，涨跌 ${pct}%`;
    }).join('\n');

    const prompt = `
你是一位拥有10年经验的专业加密货币交易员。
我目前持有一笔仓位，行情出现了一些变化，请帮我评估是否应该继续持仓或平仓。

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
各周期K线（最近5根）：
${kline_summary}

支撑阻力位：
${sr_text}

## 输出要求
严格按以下 JSON 格式返回，不要有任何其他内容：
{
  "analysis": "详细分析，重点评估当前持仓是否符合原始逻辑（200-400字）",
  "risk_points": ["当前风险点1", "当前风险点2"],
  "opportunities": ["支持继续持仓的理由1", "理由2"],
  "overall_assessment": "明确建议：继续持仓 / 部分减仓 / 立即平仓，并说明理由（50-100字）",
  "confidence_score": 60
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
      const raw = await this.call_ai(prompt);
      const parsed = JSON.parse(this.extract_json(raw));
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
      const raw = await this.call_ai(prompt);
      const parsed = JSON.parse(this.extract_json(raw));
      return {
        analysis: parsed.analysis ?? '',
        risk_points: parsed.risk_points ?? [],
        opportunities: parsed.opportunities ?? [],
        overall_assessment: parsed.overall_assessment ?? '',
        confidence_score: Number(parsed.confidence_score ?? 50),
      };
    } catch (error) {
      logger.error('[TradeJournal] AI call failed:', error);
      throw new Error('AI call failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }
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
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content ?? '';
    }

    if (provider === 'deepseek') {
      const response = await this.deepseek.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0].message.content ?? '';
    }

    const response = await this.claude.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    return (response.content[0] as any).text as string;
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
    return { journal, analyses, review };
  }

  async get_journal_list(status?: string, limit = 20, offset = 0) {
    return this.repository.find_list(status as any, limit, offset);
  }

  async get_stats() {
    return this.repository.get_stats();
  }
}
