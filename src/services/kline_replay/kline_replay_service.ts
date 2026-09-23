/**
 * K线回放 + 模拟交易 服务（编排层）
 *
 * 职责：会话生命周期、逐根推进、下单/撤单/改止损/平仓、统计。
 * 撮合逻辑在 ReplayMatchingEngine（纯内存），本层负责管理会话的内存状态并落库。
 *
 * 设计要点：
 *   - 服务端权威：游标之后的K线从不下发，前端无法「偷看」未来
 *   - 同一会话的操作串行执行（防止连点并发导致状态错乱）
 *   - 活跃会话常驻内存（账户状态 + 5m K线缓存），步进只改内存：
 *       · 有成交/委托变化的步进、以及下单撤单改单平仓等操作 → 立即落库
 *       · 纯推进（只动游标和持仓的 MFE/MAE）→ 每 FLUSH_INTERVAL_MS 批量落库
 *       · 进程正常退出时 shutdown() 落库全部；异常崩溃最多丢最近几秒的纯推进进度
 *   - 读取型接口（列表/统计）先落库再查，保证读到最新
 */

import { KlineReplayRepository, ReplayPositionQuery } from '@/database/kline_replay_repository';
import { logger } from '@/utils/logger';
import { ReplayMatchingEngine, ReplayEngineState, ReplayFillRecord, calc_unrealized_pnl } from './replay_matching_engine';
import { ReplayKlineLoader, aggregate_bars, bucket_start } from './replay_kline_loader';
import { build_stats_report, ReplayStatsReport } from './replay_stats';
import {
  ReplayBar,
  ReplayEvent,
  ReplayFill,
  ReplayIntervalBar,
  ReplayOrder,
  ReplayOrderStatus,
  ReplayOrderType,
  ReplayPosition,
  ReplaySession,
  ReplaySessionStatus,
  ReplaySide,
  REPLAY_BASE_INTERVAL_MS,
  REPLAY_INTERVALS,
} from './replay_types';

/** 单次 step 最多推进的根数 */
const MAX_STEP_BARS = 2000;
/** 缓存保留游标前多久的 5m（需覆盖一个 4h 桶，用于聚合大周期当前K线） */
const CACHE_KEEP_BEFORE_MS = REPLAY_INTERVALS['4h'];
/** 「已到数据末尾」判定的有效期（实时数据每 5 分钟会新增） */
const END_OF_DATA_TTL_MS = 60 * 1000;
/** 纯推进进度的批量落库间隔 */
const FLUSH_INTERVAL_MS = 3 * 1000;
/** 会话闲置多久后移出内存 */
const IDLE_EVICT_MS = 30 * 60 * 1000;

/** 业务错误（带 HTTP 状态码） */
export class ReplayError extends Error {
  constructor(message: string, readonly status_code: number = 400) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** 创建会话参数 */
export interface CreateSessionInput {
  symbol: string;
  start_time: number;
  name?: string;
  initial_balance?: number;
  leverage?: number;
  taker_fee_rate?: number;
  maker_fee_rate?: number;
  slippage_rate?: number;
  note?: string | null;
}

/** 下单参数（qty / notional / risk_pct 三选一） */
export interface PlaceOrderInput {
  side: ReplaySide;
  order_type: ReplayOrderType;
  qty?: number;
  notional?: number;       // 按名义价值（USDT）换算数量
  risk_pct?: number;       // 按权益风险百分比换算数量（需要止损）
  price?: number | null;
  reduce_only?: boolean;
  stop_loss?: number | null;
  take_profit?: number | null;
  tags?: string[];
  note?: string | null;
}

/** 推进参数 */
export interface StepInput {
  bars?: number;                                   // 推进根数，默认 1
  until_time?: number;                             // 推进到该时间（含），与 bars 同时给时先到先停
  stop_on?: 'none' | 'fill' | 'position_closed';  // 快进时遇到事件提前停
  intervals?: string[];                            // 需要同步返回的大周期（15m/1h/4h）
}

/** 当前账户快照 */
export interface ReplaySnapshot {
  session: ReplaySession;
  current_bar: ReplayBar;
  equity: number;
  unrealized_pnl: number;
  position: (ReplayPosition & { unrealized_pnl: number; unrealized_r: number | null }) | null;
  pending_orders: ReplayOrder[];
}

/** 推进结果 */
export interface StepResult {
  bars: ReplayBar[];                                // 新揭示的 5m K线
  interval_bars: Record<string, ReplayIntervalBar[]>; // 各大周期受影响的K线（最后一根可能未收盘）
  events: ReplayEvent[];
  end_of_data: boolean;
  snapshot: ReplaySnapshot;
}

/** 操作结果（下单/撤单/改单/平仓） */
export interface ActionResult {
  events: ReplayEvent[];
  snapshot: ReplaySnapshot;
}

/** 常驻内存的会话上下文 */
interface LiveSession {
  session: ReplaySession;
  state: ReplayEngineState;             // 账户状态（balance / 持仓 / 挂单），引擎直接在上面改
  bars: ReplayBar[];                    // 5m 缓存，升序：游标前一个 4h 桶起 → 已加载的未来K线
  end_of_data_at: number | null;        // 最近一次确认「没有更后面数据」的时间
  // 待落库的变更
  dirty_session: boolean;
  dirty_positions: Set<ReplayPosition>;
  dirty_orders: Set<ReplayOrder>;
  pending_fills: ReplayFillRecord[];
  last_access: number;
}

export class KlineReplayService {
  private static instance: KlineReplayService | null = null;

  private readonly repository = new KlineReplayRepository();
  private readonly loader = new ReplayKlineLoader();
  private readonly lives = new Map<number, LiveSession>();
  private readonly locks = new Map<number, Promise<unknown>>();
  private flush_timer: NodeJS.Timeout | null = null;
  private initialized = false;

  /** 单例 */
  static get_instance(): KlineReplayService {
    if (!this.instance) this.instance = new KlineReplayService();
    return this.instance;
  }

  /** 初始化表结构并启动定时落库 */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.repository.init_tables();
    this.flush_timer = setInterval(() => {
      this.flush_all(true).catch(err => logger.error('[KlineReplay] 定时落库失败', err));
    }, FLUSH_INTERVAL_MS);
    this.flush_timer.unref();
    this.initialized = true;
  }

  /** 进程退出前调用：停止定时器并落库全部内存变更 */
  async shutdown(): Promise<void> {
    if (this.flush_timer) {
      clearInterval(this.flush_timer);
      this.flush_timer = null;
    }
    await this.flush_all(false);
    logger.info('[KlineReplay] 内存状态已全部落库');
  }

  // ==================== 会话 ====================

  /** 创建会话：定位起始K线，游标停在该根（该根及之前可见） */
  async create_session(input: CreateSessionInput): Promise<ReplaySnapshot> {
    const symbol = String(input.symbol || '').toUpperCase();
    if (!symbol) throw new ReplayError('symbol 必填');
    if (!Number.isFinite(input.start_time)) throw new ReplayError('start_time 必填（毫秒时间戳）');

    const initial_balance = input.initial_balance ?? 10000;
    const leverage = input.leverage ?? 10;
    if (!(initial_balance > 0)) throw new ReplayError('initial_balance 必须大于 0');
    if (!(leverage >= 1 && leverage <= 125)) throw new ReplayError('leverage 范围 1~125');

    const bar = await this.loader.get_bar_at_or_before(symbol, input.start_time);
    if (!bar) throw new ReplayError(`${symbol} 在该时间附近（前 1 天内）没有 5m 数据`);

    const session: ReplaySession = {
      name: input.name?.trim() || `${symbol} ${this.format_beijing_time(bar.open_time)}`,
      symbol,
      start_time: bar.open_time,
      cursor_time: bar.open_time,
      last_price: bar.close,
      initial_balance,
      balance: initial_balance,
      leverage,
      taker_fee_rate: input.taker_fee_rate ?? 0.0005,
      maker_fee_rate: input.maker_fee_rate ?? 0.0002,
      slippage_rate: input.slippage_rate ?? 0,
      status: 'active',
      bars_stepped: 0,
      note: input.note ?? null,
    };
    session.id = await this.repository.create_session(session);
    logger.info(`[KlineReplay] 创建会话 #${session.id} ${symbol} @ ${bar.open_time}`);
    return this.build_snapshot(session, bar, null, []);
  }

  /** 会话列表 */
  async list_sessions(filter: { status?: ReplaySessionStatus; symbol?: string; limit?: number; offset?: number }): Promise<ReplaySession[]> {
    await this.flush_all(false);
    return this.repository.list_sessions({ ...filter, symbol: filter.symbol?.toUpperCase() });
  }

  /** 会话快照（直接取内存状态） */
  async get_snapshot(session_id: number): Promise<ReplaySnapshot> {
    return this.with_lock(session_id, async () => {
      const live = await this.get_live(session_id);
      return this.live_snapshot(live);
    });
  }

  /** 修改名称/备注 */
  async update_session_meta(session_id: number, patch: { name?: string; note?: string | null }): Promise<ReplaySession> {
    return this.with_lock(session_id, async () => {
      await this.require_session(session_id);
      await this.repository.update_session_meta(session_id, patch);
      const live = this.lives.get(session_id);
      if (live) {
        if (patch.name !== undefined) live.session.name = patch.name;
        if (patch.note !== undefined) live.session.note = patch.note;
        return live.session;
      }
      return this.require_session(session_id);
    });
  }

  /** 删除会话（内存里未落库的变更直接丢弃） */
  async delete_session(session_id: number): Promise<void> {
    await this.with_lock(session_id, async () => {
      this.lives.delete(session_id);
      const ok = await this.repository.delete_session(session_id);
      if (!ok) throw new ReplayError('会话不存在', 404);
    });
  }

  /** 结束会话：按当前价平掉持仓、撤掉挂单 */
  async finish_session(session_id: number): Promise<ActionResult> {
    return this.with_lock(session_id, async () => {
      const { live, engine, bar } = await this.open_engine(session_id);
      if (engine.state.position) engine.close_position(bar, null, 'session_end');
      for (const order of [...engine.state.orders]) engine.cancel_order(order, '会话结束');
      live.session.status = 'finished';
      live.session.finished_at = new Date();
      await this.commit(live, engine, true);
      const result = { events: engine.events, snapshot: this.live_snapshot(live) };
      this.lives.delete(session_id);
      return result;
    });
  }

  // ==================== 推进 ====================

  /** 推进 K 线 */
  async step(session_id: number, input: StepInput): Promise<StepResult> {
    return this.with_lock(session_id, async () => {
      for (const i of input.intervals ?? []) {
        if (!REPLAY_INTERVALS[i]) throw new ReplayError(`不支持的周期: ${i}`);
      }
      const intervals = (input.intervals ?? []).filter(i => i !== '5m');
      const max_bars = Math.min(Math.max(Math.floor(input.bars ?? (input.until_time ? MAX_STEP_BARS : 1)), 1), MAX_STEP_BARS);

      const { live, engine } = await this.open_engine(session_id);
      const session = live.session;
      const revealed: ReplayBar[] = [];
      let end_of_data = false;
      const prev_cursor = session.cursor_time;

      while (revealed.length < max_bars) {
        const next = await this.peek_next_bar(live);
        if (!next) { end_of_data = true; break; }
        if (input.until_time !== undefined && next.open_time > input.until_time) break;

        const gap = next.open_time - session.cursor_time;
        if (gap > REPLAY_BASE_INTERVAL_MS) {
          engine.events.push({
            type: 'gap',
            from_time: session.cursor_time,
            to_time: next.open_time,
            missing_bars: Math.round(gap / REPLAY_BASE_INTERVAL_MS) - 1,
          });
        }

        const fills_before = engine.fills.length;
        const closes_before = engine.events.filter(e => e.type === 'position_closed').length;
        engine.process_bar(next);
        session.cursor_time = next.open_time;
        session.last_price = next.close;
        session.bars_stepped += 1;
        revealed.push(next);

        if (input.stop_on === 'fill' && engine.fills.length > fills_before) break;
        if (input.stop_on === 'position_closed'
          && engine.events.filter(e => e.type === 'position_closed').length > closes_before) break;
      }

      // 告诉前端后面是否还有K线，便于禁用「下一步」
      if (!end_of_data) {
        end_of_data = (await this.peek_next_bar(live)) === null;
      }

      // 有成交或委托状态变化才立即落库，纯推进交给定时批量落库
      const has_trade_change = engine.fills.length > 0 || engine.touched_orders.size > 0;
      await this.commit(live, engine, has_trade_change);

      const interval_bars = this.build_interval_bars(live, prev_cursor, intervals);
      this.trim_cache(live);

      return {
        bars: revealed,
        interval_bars,
        events: engine.events,
        end_of_data,
        snapshot: this.live_snapshot(live),
      };
    });
  }

  /** 游标视角下某周期K线（初始化图表用） */
  async get_klines(session_id: number, interval: string, limit: number): Promise<ReplayIntervalBar[]> {
    if (!REPLAY_INTERVALS[interval]) throw new ReplayError(`不支持的周期: ${interval}`);
    const safe_limit = Math.min(Math.max(Math.floor(limit) || 300, 1), 1500);
    const session = await this.with_lock(session_id, async () => (await this.get_live(session_id)).session);
    return this.loader.get_interval_bars(session.symbol, interval, session.cursor_time, safe_limit);
  }

  // ==================== 交易 ====================

  /** 下单 */
  async place_order(session_id: number, input: PlaceOrderInput): Promise<ActionResult & { order: ReplayOrder }> {
    return this.with_lock(session_id, async () => {
      if (input.side !== 'buy' && input.side !== 'sell') throw new ReplayError('side 必须是 buy / sell');
      if (!['market', 'limit', 'stop'].includes(input.order_type)) throw new ReplayError('order_type 必须是 market / limit / stop');

      const { live, engine, bar } = await this.open_engine(session_id);
      const price = input.order_type === 'market' ? null : this.optional_number(input.price, 'price');
      const stop_loss = this.optional_number(input.stop_loss, 'stop_loss');
      const take_profit = this.optional_number(input.take_profit, 'take_profit');
      const ref_price = price ?? bar.close;
      const qty = this.resolve_qty(input, ref_price, stop_loss, engine.get_equity(bar.close));

      const order: ReplayOrder = {
        session_id,
        position_id: null,
        side: input.side,
        order_type: input.order_type,
        qty,
        price,
        reduce_only: Boolean(input.reduce_only),
        stop_loss,
        take_profit,
        status: 'pending',
        created_bar_time: bar.open_time,
        filled_bar_time: null,
        filled_price: null,
        fee: 0,
        reject_reason: null,
        tags: this.normalize_tags(input.tags),
        note: input.note ?? null,
      };
      engine.submit_order(order, bar);
      await this.commit(live, engine, true);
      return { order, events: engine.events, snapshot: this.live_snapshot(live) };
    });
  }

  /** 撤单 */
  async cancel_order(session_id: number, order_id: number): Promise<ActionResult> {
    return this.with_lock(session_id, async () => {
      const { live, engine } = await this.open_engine(session_id);
      const order = engine.state.orders.find(o => o.id === order_id);
      if (!order) throw new ReplayError('挂单不存在或已成交/撤销', 404);
      engine.cancel_order(order, '手动撤单');
      await this.commit(live, engine, true);
      return { events: engine.events, snapshot: this.live_snapshot(live) };
    });
  }

  /** 修改持仓止损/止盈（字段不传=不改，传 null=清除） */
  async update_protection(
    session_id: number,
    patch: { stop_loss?: number | null; take_profit?: number | null },
  ): Promise<ActionResult> {
    return this.with_lock(session_id, async () => {
      const { live, engine, bar } = await this.open_engine(session_id);
      const sl = patch.stop_loss === undefined ? undefined : this.optional_number(patch.stop_loss, 'stop_loss');
      const tp = patch.take_profit === undefined ? undefined : this.optional_number(patch.take_profit, 'take_profit');
      const error = engine.set_protection(sl, tp, bar);
      if (error) throw new ReplayError(error);
      await this.commit(live, engine, true);
      return { events: engine.events, snapshot: this.live_snapshot(live) };
    });
  }

  /** 市价平仓（qty 不传=全平） */
  async close_position(session_id: number, qty?: number | null): Promise<ActionResult> {
    return this.with_lock(session_id, async () => {
      const { live, engine, bar } = await this.open_engine(session_id);
      const close_qty = qty === undefined || qty === null ? null : this.optional_number(qty, 'qty');
      const error = engine.close_position(bar, close_qty, 'manual');
      if (error) throw new ReplayError(error);
      await this.commit(live, engine, true);
      return { events: engine.events, snapshot: this.live_snapshot(live) };
    });
  }

  /** 更新仓位复盘标签/笔记（任何时候都可以改） */
  async update_position_journal(
    session_id: number,
    position_id: number,
    patch: { tags?: string[]; note?: string | null },
  ): Promise<ReplayPosition> {
    return this.with_lock(session_id, async () => {
      // 先落库内存变更，避免之后落库用旧的标签/笔记覆盖
      const live = this.lives.get(session_id);
      if (live) await this.flush(live);

      const position = await this.repository.get_position(position_id);
      if (!position || position.session_id !== session_id) throw new ReplayError('仓位不存在', 404);
      const tags = patch.tags === undefined ? undefined : this.normalize_tags(patch.tags);
      await this.repository.update_position_journal(position_id, { tags, note: patch.note });

      const in_memory = live?.state.position;
      if (in_memory && in_memory.id === position_id) {
        if (tags !== undefined) in_memory.tags = tags;
        if (patch.note !== undefined) in_memory.note = patch.note;
      }
      return (await this.repository.get_position(position_id)) as ReplayPosition;
    });
  }

  // ==================== 查询 / 统计 ====================

  /** 会话委托 */
  async list_orders(session_id: number, status?: ReplayOrderStatus): Promise<ReplayOrder[]> {
    await this.flush_session(session_id);
    await this.require_session(session_id);
    return this.repository.list_orders(session_id, status);
  }

  /** 会话仓位回合 */
  async list_positions(session_id: number, status?: 'open' | 'closed'): Promise<ReplayPosition[]> {
    await this.flush_session(session_id);
    await this.require_session(session_id);
    return this.repository.list_positions({ session_ids: [session_id], status });
  }

  /** 会话成交 */
  async list_fills(session_id: number): Promise<ReplayFill[]> {
    await this.flush_session(session_id);
    await this.require_session(session_id);
    return this.repository.list_fills(session_id);
  }

  /** 单会话统计 */
  async get_session_stats(session_id: number): Promise<ReplayStatsReport> {
    await this.flush_session(session_id);
    const session = await this.require_session(session_id);
    const positions = await this.repository.list_positions({ session_ids: [session_id], status: 'closed' });
    return build_stats_report(positions, session.initial_balance);
  }

  /** 跨会话累计统计 */
  async get_overall_stats(query: ReplayPositionQuery): Promise<ReplayStatsReport> {
    await this.flush_all(false);
    const positions = await this.repository.list_positions({
      ...query,
      symbol: query.symbol?.toUpperCase(),
      status: 'closed',
      limit: 10000,
    });
    return build_stats_report(positions);
  }

  /** 5m 数据覆盖区间（按日表连续段合并，北京时间日期） */
  async get_data_coverage(): Promise<Array<{ start_date: string; end_date: string; days: number }>> {
    const dates = await this.loader.list_5m_dates();
    const ranges: Array<{ start_date: string; end_date: string; days: number }> = [];
    const to_ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
    for (const d of dates) {
      const last = ranges[ranges.length - 1];
      if (last && to_ms(d) - to_ms(last.end_date) === 24 * 60 * 60 * 1000) {
        last.end_date = d;
        last.days += 1;
      } else {
        ranges.push({ start_date: d, end_date: d, days: 1 });
      }
    }
    return ranges;
  }

  // ==================== 内部：内存会话 ====================

  /** 取常驻内存的会话；不在内存则从库加载（进程重启/闲置淘汰后） */
  private async get_live(session_id: number): Promise<LiveSession> {
    const cached = this.lives.get(session_id);
    if (cached) {
      cached.last_access = Date.now();
      return cached;
    }

    const session = await this.require_session(session_id);
    const [position, orders, history] = await Promise.all([
      this.repository.get_open_position(session_id),
      this.repository.get_pending_orders(session_id),
      this.loader.load_5m(session.symbol, bucket_start(session.cursor_time, CACHE_KEEP_BEFORE_MS), session.cursor_time),
    ]);
    const live: LiveSession = {
      session,
      state: { session_id, symbol: session.symbol, balance: session.balance, position, orders },
      bars: history,
      end_of_data_at: null,
      dirty_session: false,
      dirty_positions: new Set(),
      dirty_orders: new Set(),
      pending_fills: [],
      last_access: Date.now(),
    };
    this.lives.set(session_id, live);
    return live;
  }

  /** 取内存会话并构造撮合引擎（仅活跃会话） */
  private async open_engine(session_id: number): Promise<{ live: LiveSession; engine: ReplayMatchingEngine; bar: ReplayBar }> {
    const live = await this.get_live(session_id);
    if (live.session.status !== 'active') throw new ReplayError('会话已结束，不能继续操作', 409);
    const engine = new ReplayMatchingEngine(live.state, {
      leverage: live.session.leverage,
      taker_fee_rate: live.session.taker_fee_rate,
      maker_fee_rate: live.session.maker_fee_rate,
      slippage_rate: live.session.slippage_rate,
    });
    return { live, engine, bar: this.get_cursor_bar(live) };
  }

  /**
   * 把一次操作的引擎变更并入待落库队列
   * @param immediate true=立即落库；false=等定时批量落库
   */
  private async commit(live: LiveSession, engine: ReplayMatchingEngine, immediate: boolean): Promise<void> {
    live.session.balance = live.state.balance;
    live.dirty_session = true;
    engine.touched_positions.forEach(p => live.dirty_positions.add(p));
    engine.touched_orders.forEach(o => live.dirty_orders.add(o));
    live.pending_fills.push(...engine.fills);
    if (immediate) await this.flush(live);
  }

  /** 落库某会话的待写变更（调用方需持有该会话的锁） */
  private async flush(live: LiveSession): Promise<void> {
    if (!live.dirty_session && live.dirty_positions.size === 0 && live.dirty_orders.size === 0 && live.pending_fills.length === 0) {
      return;
    }
    const positions = [...live.dirty_positions];
    const orders = [...live.dirty_orders];
    const fills = live.pending_fills;
    live.dirty_session = false;
    live.dirty_positions = new Set();
    live.dirty_orders = new Set();
    live.pending_fills = [];

    try {
      await this.repository.persist_changes({ session: live.session, positions, orders, fills });
    } catch (error) {
      // 失败则放回队列，下次重试（事务已回滚，重试是幂等的：未拿到 id 的会重新插入）
      live.dirty_session = true;
      positions.forEach(p => live.dirty_positions.add(p));
      orders.forEach(o => live.dirty_orders.add(o));
      live.pending_fills = [...fills, ...live.pending_fills];
      throw error;
    }
  }

  /** 落库单个会话（读接口前调用） */
  private async flush_session(session_id: number): Promise<void> {
    if (!this.lives.has(session_id)) return;
    await this.with_lock(session_id, async () => {
      const live = this.lives.get(session_id);
      if (live) await this.flush(live);
    });
  }

  /**
   * 落库所有内存会话
   * @param evict_idle 顺带把闲置过久的会话移出内存
   */
  private async flush_all(evict_idle: boolean): Promise<void> {
    for (const session_id of [...this.lives.keys()]) {
      await this.with_lock(session_id, async () => {
        const live = this.lives.get(session_id);
        if (!live) return;
        try {
          await this.flush(live);
        } catch (error) {
          logger.error(`[KlineReplay] 会话 #${session_id} 落库失败，稍后重试`, error);
          return;
        }
        if (evict_idle && Date.now() - live.last_access > IDLE_EVICT_MS) {
          this.lives.delete(session_id);
        }
      });
    }
  }

  /** 取会话，不存在抛 404 */
  private async require_session(session_id: number): Promise<ReplaySession> {
    if (!Number.isInteger(session_id) || session_id <= 0) throw new ReplayError('会话 id 无效');
    const session = await this.repository.get_session(session_id);
    if (!session) throw new ReplayError('会话不存在', 404);
    return session;
  }

  /** 内存会话的快照 */
  private live_snapshot(live: LiveSession): ReplaySnapshot {
    return this.build_snapshot(live.session, this.get_cursor_bar(live), live.state.position, live.state.orders);
  }

  /** 构造快照（返回副本，避免外部拿到内存对象引用） */
  private build_snapshot(
    session: ReplaySession,
    bar: ReplayBar,
    position: ReplayPosition | null,
    orders: ReplayOrder[],
  ): ReplaySnapshot {
    const unrealized = calc_unrealized_pnl(position, bar.close);
    return {
      session: { ...session },
      current_bar: bar,
      equity: session.balance + unrealized,
      unrealized_pnl: unrealized,
      position: position ? {
        ...position,
        unrealized_pnl: unrealized,
        unrealized_r: position.risk_amount ? (unrealized + position.realized_pnl - position.fee_total) / position.risk_amount : null,
      } : null,
      pending_orders: orders.filter(o => o.status === 'pending').map(o => ({ ...o })),
    };
  }

  // ==================== 内部：K线缓存 ====================

  /** 游标所在K线 */
  private get_cursor_bar(live: LiveSession): ReplayBar {
    const bar = live.bars.find(b => b.open_time === live.session.cursor_time);
    if (!bar) throw new ReplayError('游标K线数据缺失（5m 数据可能已被清理）', 500);
    return bar;
  }

  /** 游标之后的下一根（不移动游标，缓存不够时向后加载） */
  private async peek_next_bar(live: LiveSession): Promise<ReplayBar | null> {
    const cursor = live.session.cursor_time;
    let next = live.bars.find(b => b.open_time > cursor);
    if (next) return next;
    if (live.end_of_data_at !== null && Date.now() - live.end_of_data_at < END_OF_DATA_TTL_MS) return null;

    const last_time = live.bars.length > 0 ? live.bars[live.bars.length - 1].open_time : cursor;
    const loaded = await this.loader.load_forward(live.session.symbol, Math.max(last_time, cursor));
    if (loaded.length === 0) {
      live.end_of_data_at = Date.now();
      return null;
    }
    live.end_of_data_at = null;
    live.bars.push(...loaded.filter(b => b.open_time > last_time));
    next = live.bars.find(b => b.open_time > cursor);
    return next ?? null;
  }

  /** 丢弃游标前一个 4h 桶之前的缓存K线 */
  private trim_cache(live: LiveSession): void {
    const keep_from = bucket_start(live.session.cursor_time, CACHE_KEEP_BEFORE_MS);
    const index = live.bars.findIndex(b => b.open_time >= keep_from);
    if (index > 0) live.bars.splice(0, index);
  }

  /**
   * 推进后各大周期受影响的K线（从旧游标所在桶到新游标所在桶）
   */
  private build_interval_bars(live: LiveSession, prev_cursor: number, intervals: string[]): Record<string, ReplayIntervalBar[]> {
    const result: Record<string, ReplayIntervalBar[]> = {};
    const cursor = live.session.cursor_time;
    for (const interval of intervals) {
      const ms = REPLAY_INTERVALS[interval];
      const from = bucket_start(prev_cursor + REPLAY_BASE_INTERVAL_MS, ms);
      const bars = live.bars.filter(b => b.open_time >= from && b.open_time <= cursor);
      result[interval] = aggregate_bars(bars, ms, cursor);
    }
    return result;
  }

  // ==================== 内部：工具 ====================

  /** 同一会话串行执行 */
  private async with_lock<T>(session_id: number, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(session_id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.locks.set(session_id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(session_id) === run) this.locks.delete(session_id);
    }
  }

  /** 数量换算：qty / notional / risk_pct 三选一 */
  private resolve_qty(input: PlaceOrderInput, ref_price: number, stop_loss: number | null, equity: number): number {
    const given = [input.qty, input.notional, input.risk_pct].filter(v => v !== undefined && v !== null);
    if (given.length !== 1) throw new ReplayError('qty / notional / risk_pct 必须且只能给一个');

    if (input.qty !== undefined && input.qty !== null) {
      return this.optional_number(input.qty, 'qty') as number;
    }
    if (input.notional !== undefined && input.notional !== null) {
      const notional = this.optional_number(input.notional, 'notional') as number;
      return notional / ref_price;
    }
    const risk_pct = this.optional_number(input.risk_pct, 'risk_pct') as number;
    if (stop_loss === null) throw new ReplayError('按风险百分比下单必须设置止损');
    const distance = Math.abs(ref_price - stop_loss);
    if (distance <= 0) throw new ReplayError('止损价不能等于委托价');
    return equity * risk_pct / 100 / distance;
  }

  /** 可选数字参数校验（null/undefined 返回 null） */
  private optional_number(value: unknown, field: string): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new ReplayError(`${field} 必须是大于 0 的数字`);
    return n;
  }

  /** 北京时间 YYYY-MM-DD HH:mm */
  private format_beijing_time(ts: number): string {
    return new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }

  /** 标签去空去重 */
  private normalize_tags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 20);
  }
}
