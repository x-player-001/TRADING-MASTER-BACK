/**
 * K线回放 + 模拟交易 服务（存储层编排）
 *
 * 撮合在前端完成（replay_matching_engine.ts / replay_account.ts），后端只负责：
 *   - 会话增删改查
 *   - 下发K线：游标之后的 5m 批量块（前端本地逐根揭示）、任意时刻之前的大周期历史
 *   - 接收前端同步（进度 + 整份交易记录），用 revision 防止乱序覆盖
 *   - 基于已存储的回合计算统计
 */

import {
  KlineReplayRepository,
  ReplayPositionQuery,
  ReplaySessionProgress,
  ReplayTradeRecords,
} from '@/database/kline_replay_repository';
import { logger } from '@/utils/logger';
import { ReplayKlineLoader } from './replay_kline_loader';
import { build_stats_report, ReplayStatsReport } from './replay_stats';
import {
  ReplayBar,
  ReplayFill,
  ReplayIntervalBar,
  ReplayOrder,
  ReplayOrderStatus,
  ReplayPosition,
  ReplaySession,
  ReplaySessionStatus,
  REPLAY_INTERVALS,
} from './replay_types';

/** 单次下发 5m 的上限 */
const MAX_BARS_PER_REQUEST = 2000;
/** 单次同步的记录数上限（防误传） */
const MAX_SYNC_RECORDS = 20000;

/** 业务错误（带 HTTP 状态码） */
export class ReplayError extends Error {
  constructor(message: string, readonly status_code: number = 400, readonly extra?: Record<string, unknown>) {
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

/** 同步请求体 */
export interface SyncInput {
  revision: number;
  progress: ReplaySessionProgress;
  positions?: ReplayPosition[];
  orders?: ReplayOrder[];
  fills?: ReplayFill[];
}

/** 会话完整状态（前端恢复用） */
export interface ReplaySessionState {
  session: ReplaySession;
  cursor_bar: ReplayBar | null;
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  fills: ReplayFill[];
}

export class KlineReplayService {
  private static instance: KlineReplayService | null = null;

  private readonly repository = new KlineReplayRepository();
  private readonly loader = new ReplayKlineLoader();
  private initialized = false;

  /** 单例 */
  static get_instance(): KlineReplayService {
    if (!this.instance) this.instance = new KlineReplayService();
    return this.instance;
  }

  /** 初始化表结构 */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.repository.init_tables();
    this.initialized = true;
  }

  // ==================== 会话 ====================

  /** 创建会话：起点对齐到所在（或之前 1 天内最近）的 5m K线 */
  async create_session(input: CreateSessionInput): Promise<ReplaySessionState> {
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
      sync_revision: 0,
      note: input.note ?? null,
    };
    session.id = await this.repository.create_session(session);
    logger.info(`[KlineReplay] 创建会话 #${session.id} ${symbol} @ ${bar.open_time}`);
    return { session, cursor_bar: bar, positions: [], orders: [], fills: [] };
  }

  /** 会话列表 */
  async list_sessions(filter: { status?: ReplaySessionStatus; symbol?: string; limit?: number; offset?: number }): Promise<ReplaySession[]> {
    return this.repository.list_sessions({ ...filter, symbol: filter.symbol?.toUpperCase() });
  }

  /** 会话完整状态：会话 + 游标K线 + 全部仓位/委托/成交 */
  async get_state(session_id: number): Promise<ReplaySessionState> {
    const session = await this.require_session(session_id);
    const [cursor_bar, positions, orders, fills] = await Promise.all([
      this.loader.get_bar_at_or_before(session.symbol, session.cursor_time),
      this.repository.list_positions({ session_ids: [session_id], limit: 10000 }),
      this.repository.list_orders(session_id),
      this.repository.list_fills(session_id),
    ]);
    return { session, cursor_bar, positions, orders, fills };
  }

  /** 修改名称/备注 */
  async update_session_meta(session_id: number, patch: { name?: string; note?: string | null }): Promise<ReplaySession> {
    await this.require_session(session_id);
    await this.repository.update_session_meta(session_id, patch);
    return this.require_session(session_id);
  }

  /** 删除会话 */
  async delete_session(session_id: number): Promise<void> {
    const ok = await this.repository.delete_session(session_id);
    if (!ok) throw new ReplayError('会话不存在', 404);
  }

  // ==================== K线 ====================

  /**
   * 下发 after 之后的 5m（前端本地逐根揭示，跨越数据空洞）
   * @param after 默认从会话起点之后开始
   */
  async get_bars(session_id: number, after: number | undefined, limit: number): Promise<{ bars: ReplayBar[]; end_of_data: boolean }> {
    const session = await this.require_session(session_id);
    const safe_limit = Math.min(Math.max(Math.floor(limit) || 600, 1), MAX_BARS_PER_REQUEST);
    return this.loader.load_bars_after(session.symbol, after ?? session.start_time, safe_limit);
  }

  /**
   * 截止到 end_time 的某周期K线（初始化图表的历史部分；最后一根可能未收盘）
   * @param end_time 5m K线 open_time，默认会话起点
   */
  async get_klines(session_id: number, interval: string, end_time: number | undefined, limit: number): Promise<ReplayIntervalBar[]> {
    const session = await this.require_session(session_id);
    if (!REPLAY_INTERVALS[interval]) throw new ReplayError(`不支持的周期: ${interval}`);
    const safe_limit = Math.min(Math.max(Math.floor(limit) || 300, 1), 1500);
    return this.loader.get_interval_bars(session.symbol, interval, end_time ?? session.start_time, safe_limit);
  }

  // ==================== 同步 ====================

  /**
   * 前端同步：更新进度；带了 positions/orders/fills 就整份替换交易记录
   * revision 必须比上次大，否则返回 409（过期请求，不覆盖）
   */
  async sync(session_id: number, input: SyncInput): Promise<{ revision: number }> {
    const revision = Number(input?.revision);
    if (!Number.isInteger(revision) || revision <= 0) throw new ReplayError('revision 必须是正整数');
    const progress = this.validate_progress(input.progress);

    const has_trades = input.positions !== undefined || input.orders !== undefined || input.fills !== undefined;
    let trades: ReplayTradeRecords | null = null;
    if (has_trades) {
      trades = {
        positions: this.require_array(input.positions, 'positions'),
        orders: this.require_array(input.orders, 'orders'),
        fills: this.require_array(input.fills, 'fills'),
      };
      this.validate_trades(trades);
    }

    const result = await this.repository.sync_session(session_id, revision, progress, trades);
    if (!result.ok && result.reason === 'not_found') throw new ReplayError('会话不存在', 404);
    if (!result.ok && result.reason === 'stale') {
      throw new ReplayError('同步版本过期（已有更新的同步）', 409, { current_revision: result.current_revision });
    }
    return { revision };
  }

  // ==================== 统计 ====================

  /** 单会话统计 */
  async get_session_stats(session_id: number): Promise<ReplayStatsReport> {
    const session = await this.require_session(session_id);
    const positions = await this.repository.list_positions({ session_ids: [session_id], status: 'closed', limit: 10000 });
    return build_stats_report(positions, session.initial_balance);
  }

  /** 跨会话累计统计 */
  async get_overall_stats(query: ReplayPositionQuery): Promise<ReplayStatsReport> {
    const positions = await this.repository.list_positions({
      ...query,
      symbol: query.symbol?.toUpperCase(),
      status: 'closed',
      limit: 10000,
    });
    return build_stats_report(positions);
  }

  /** 会话委托（可按状态过滤） */
  async list_orders(session_id: number, status?: ReplayOrderStatus): Promise<ReplayOrder[]> {
    await this.require_session(session_id);
    return this.repository.list_orders(session_id, status);
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

  // ==================== 内部 ====================

  /** 取会话，不存在抛 404 */
  private async require_session(session_id: number): Promise<ReplaySession> {
    if (!Number.isInteger(session_id) || session_id <= 0) throw new ReplayError('会话 id 无效');
    const session = await this.repository.get_session(session_id);
    if (!session) throw new ReplayError('会话不存在', 404);
    return session;
  }

  /** 校验进度字段 */
  private validate_progress(p: any): ReplaySessionProgress {
    if (!p || typeof p !== 'object') throw new ReplayError('progress 必填');
    const progress: ReplaySessionProgress = {
      cursor_time: Number(p.cursor_time),
      last_price: Number(p.last_price),
      balance: Number(p.balance),
      bars_stepped: Number(p.bars_stepped ?? 0),
      status: p.status === 'finished' ? 'finished' : 'active',
    };
    for (const [k, v] of Object.entries(progress)) {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new ReplayError(`progress.${k} 必须是数字`);
    }
    return progress;
  }

  /** 校验整份交易记录的结构与关联 */
  private validate_trades(t: ReplayTradeRecords): void {
    const total = t.positions.length + t.orders.length + t.fills.length;
    if (total > MAX_SYNC_RECORDS) throw new ReplayError(`单次同步记录数超过上限 ${MAX_SYNC_RECORDS}`);

    const check_ids = (items: Array<{ client_id?: unknown }>, name: string): Set<string> => {
      const ids = new Set<string>();
      for (const item of items) {
        const id = item?.client_id;
        if (typeof id !== 'string' || !id || id.length > 64) throw new ReplayError(`${name} 的 client_id 必须是 1~64 位字符串`);
        if (ids.has(id)) throw new ReplayError(`${name} 的 client_id 重复: ${id}`);
        ids.add(id);
      }
      return ids;
    };
    const position_ids = check_ids(t.positions, 'positions');
    check_ids(t.orders, 'orders');
    check_ids(t.fills, 'fills');

    for (const f of t.fills) {
      if (!position_ids.has(f.position_client_id)) {
        throw new ReplayError(`成交 ${f.client_id} 关联的仓位 ${f.position_client_id} 不在同步数据中`);
      }
    }
    for (const p of t.positions) {
      if (!Array.isArray(p.tags)) p.tags = [];
    }
    for (const o of t.orders) {
      if (!Array.isArray(o.tags)) o.tags = [];
    }
  }

  /** 要求是数组 */
  private require_array<T>(value: T[] | undefined, field: string): T[] {
    if (!Array.isArray(value)) throw new ReplayError(`同步交易记录时 ${field} 必须是数组（positions/orders/fills 需同时提供）`);
    return value;
  }

  /** 北京时间 YYYY-MM-DD HH:mm */
  private format_beijing_time(ts: number): string {
    return new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}
