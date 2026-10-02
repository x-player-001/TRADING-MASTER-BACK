/**
 * 策略回测结果 数据库操作（各策略通用）
 *
 * 表:
 *   strategy_backtest_runs   - 一次回测运行（策略、参数、数据区间、汇总统计）
 *   strategy_backtest_trades - 运行产出的交易（含未成交信号），带特征与画图标注
 */

import { BaseRepository } from './base_repository';
import { BacktestTrade, BacktestTradeStatus } from '@/services/strategy_backtest/backtest_types';
import { StatTrade } from '@/services/strategy_backtest/backtest_stats';

export type BacktestRunStatus = 'running' | 'done' | 'failed';

export interface BacktestRun {
  id: number;
  strategy_id: string;
  strategy_name: string;
  strategy_version: number;
  timeframe: string;
  params: Record<string, unknown>;
  data_from: number;
  data_to: number;
  status: BacktestRunStatus;
  symbols_total: number;
  trade_count: number;
  signal_count: number;
  summary: Record<string, unknown> | null;
  note: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface NewBacktestRun {
  strategy_id: string;
  strategy_name: string;
  strategy_version: number;
  timeframe: string;
  params: Record<string, unknown>;
  data_from: number;
  data_to: number;
  note?: string | null;
}

/** 交易列表筛选 */
export interface BacktestTradeFilter {
  status?: BacktestTradeStatus[];
  symbol?: string;
  exit_reason?: string[];
  result?: 'win' | 'loss';
  from?: number;                 // 按 signal_time
  to?: number;
  sort?: 'signal_time' | 'pnl' | 'r_multiple' | 'mfe_pct' | 'mae_pct';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export type StoredBacktestTrade = BacktestTrade & { id: number; run_id: number };

const TRADE_COLUMNS = [
  'run_id', 'strategy_id', 'symbol', 'timeframe', 'side', 'status', 'signal_time', 'entry_time', 'entry_price',
  'stop_price', 'target_price', 'exit_time', 'exit_price', 'exit_reason', 'pnl', 'pnl_pct', 'r_multiple',
  'mfe_pct', 'mae_pct', 'bars_held', 'features', 'annotations',
] as const;

/** 列表不返回标注（体积大），详情才返回 */
const LIST_COLUMNS = TRADE_COLUMNS.filter(c => c !== 'annotations').concat(['id'] as any).join(', ');
const SORT_COLUMNS = new Set(['signal_time', 'pnl', 'r_multiple', 'mfe_pct', 'mae_pct']);
const INSERT_CHUNK = 200;

export class StrategyBacktestRepository extends BaseRepository {

  /** 建表（幂等） */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS strategy_backtest_runs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        strategy_id      VARCHAR(40)  NOT NULL,
        strategy_name    VARCHAR(80)  NOT NULL,
        strategy_version INT          NOT NULL,
        timeframe        VARCHAR(8)   NOT NULL,
        params           JSON         NOT NULL,
        data_from        BIGINT       NOT NULL COMMENT '数据起始（毫秒）',
        data_to          BIGINT       NOT NULL COMMENT '数据结束（毫秒）',
        status           VARCHAR(16)  NOT NULL COMMENT 'running / done / failed',
        symbols_total    INT          NOT NULL DEFAULT 0,
        trade_count      INT          NOT NULL DEFAULT 0 COMMENT '已平仓交易数',
        signal_count     INT          NOT NULL DEFAULT 0 COMMENT '信号总数（含未成交）',
        summary          JSON         NULL,
        note             VARCHAR(255) NULL,
        error            TEXT         NULL,
        created_at       BIGINT       NOT NULL,
        finished_at      BIGINT       NULL,
        INDEX idx_strategy (strategy_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='策略回测运行'
    `, 'strategy_backtest_runs');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS strategy_backtest_trades (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_id        BIGINT       NOT NULL,
        strategy_id   VARCHAR(40)  NOT NULL,
        symbol        VARCHAR(30)  NOT NULL,
        timeframe     VARCHAR(8)   NOT NULL,
        side          VARCHAR(8)   NOT NULL,
        status        VARCHAR(16)  NOT NULL COMMENT 'closed / unfilled',
        signal_time   BIGINT       NOT NULL,
        entry_time    BIGINT       NULL,
        entry_price   DOUBLE       NULL,
        stop_price    DOUBLE       NULL,
        target_price  DOUBLE       NULL,
        exit_time     BIGINT       NULL,
        exit_price    DOUBLE       NULL,
        exit_reason   VARCHAR(24)  NULL,
        pnl           DOUBLE       NULL,
        pnl_pct       DOUBLE       NULL,
        r_multiple    DOUBLE       NULL,
        mfe_pct       DOUBLE       NULL,
        mae_pct       DOUBLE       NULL,
        bars_held     INT          NULL,
        features      JSON         NOT NULL,
        annotations   JSON         NOT NULL,
        INDEX idx_run_signal (run_id, signal_time),
        INDEX idx_run_symbol (run_id, symbol),
        INDEX idx_run_status (run_id, status, exit_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='策略回测交易'
    `, 'strategy_backtest_trades');
  }

  /** 新建运行记录（status=running），返回 id */
  async create_run(r: NewBacktestRun): Promise<number> {
    return this.insert_and_get_id(
      `INSERT INTO strategy_backtest_runs
       (strategy_id, strategy_name, strategy_version, timeframe, params, data_from, data_to, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      [r.strategy_id, r.strategy_name, r.strategy_version, r.timeframe, JSON.stringify(r.params), r.data_from, r.data_to, r.note ?? null, Date.now()]
    );
  }

  /** 结束运行（写入状态与汇总） */
  async finish_run(id: number, f: { status: BacktestRunStatus; symbols_total: number; trade_count: number; signal_count: number; summary: unknown; error?: string | null }): Promise<void> {
    await this.execute_query(
      `UPDATE strategy_backtest_runs SET status = ?, symbols_total = ?, trade_count = ?, signal_count = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?`,
      [f.status, f.symbols_total, f.trade_count, f.signal_count, f.summary === null ? null : JSON.stringify(f.summary), f.error ?? null, Date.now(), id]
    );
  }

  /** 批量写入交易 */
  async insert_trades(run_id: number, trades: BacktestTrade[]): Promise<void> {
    for (let s = 0; s < trades.length; s += INSERT_CHUNK) {
      const chunk = trades.slice(s, s + INSERT_CHUNK);
      const placeholders = chunk.map(() => `(${TRADE_COLUMNS.map(() => '?').join(', ')})`).join(', ');
      const params: unknown[] = [];
      for (const t of chunk) {
        for (const c of TRADE_COLUMNS) {
          if (c === 'run_id') params.push(run_id);
          else if (c === 'features' || c === 'annotations') params.push(JSON.stringify(t[c]));
          else params.push((t as any)[c] ?? null);
        }
      }
      await this.execute_query(`INSERT INTO strategy_backtest_trades (${TRADE_COLUMNS.join(', ')}) VALUES ${placeholders}`, params);
    }
  }

  /** 删除运行及其交易 */
  async delete_run(id: number): Promise<void> {
    await this.execute_query(`DELETE FROM strategy_backtest_trades WHERE run_id = ?`, [id]);
    await this.execute_query(`DELETE FROM strategy_backtest_runs WHERE id = ?`, [id]);
  }

  /** 运行列表（按创建时间倒序） */
  async list_runs(f: { strategy_id?: string; limit?: number; offset?: number }): Promise<{ total: number; rows: BacktestRun[] }> {
    const where = f.strategy_id ? 'WHERE strategy_id = ?' : '';
    const params = f.strategy_id ? [f.strategy_id] : [];
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
    const offset = Math.max(Number(f.offset) || 0, 0);
    const [cnt] = await this.execute_query(`SELECT COUNT(*) AS n FROM strategy_backtest_runs ${where}`, params);
    const rows = await this.execute_query(`SELECT * FROM strategy_backtest_runs ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    return { total: Number(cnt.n), rows: rows.map(r => this.to_run(r)) };
  }

  /** 单个运行 */
  async get_run(id: number): Promise<BacktestRun | null> {
    const rows = await this.execute_query(`SELECT * FROM strategy_backtest_runs WHERE id = ?`, [id]);
    return rows.length ? this.to_run(rows[0]) : null;
  }

  /** 交易列表（不含标注） */
  async list_trades(run_id: number, f: BacktestTradeFilter): Promise<{ total: number; rows: StoredBacktestTrade[] }> {
    const { where, params } = this.build_where(run_id, f);
    const sort = f.sort && SORT_COLUMNS.has(f.sort) ? f.sort : 'signal_time';
    const order = f.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
    const offset = Math.max(Number(f.offset) || 0, 0);
    const [cnt] = await this.execute_query(`SELECT COUNT(*) AS n FROM strategy_backtest_trades WHERE ${where}`, params);
    const rows = await this.execute_query(
      `SELECT ${LIST_COLUMNS} FROM strategy_backtest_trades WHERE ${where} ORDER BY ${sort} ${order}, id ${order} LIMIT ${limit} OFFSET ${offset}`, params
    );
    return { total: Number(cnt.n), rows: rows.map(r => this.to_trade(r)) };
  }

  /** 单笔交易（含标注） */
  async get_trade(id: number): Promise<StoredBacktestTrade | null> {
    const rows = await this.execute_query(`SELECT * FROM strategy_backtest_trades WHERE id = ?`, [id]);
    return rows.length ? this.to_trade(rows[0]) : null;
  }

  /** 同一筛选条件下按信号时间的前一笔 / 后一笔（逐个翻看用） */
  async get_neighbors(t: StoredBacktestTrade, f: BacktestTradeFilter): Promise<{ prev_id: number | null; next_id: number | null }> {
    const { where, params } = this.build_where(t.run_id, f);
    const [prev] = await this.execute_query(
      `SELECT id FROM strategy_backtest_trades WHERE ${where} AND (signal_time < ? OR (signal_time = ? AND id < ?)) ORDER BY signal_time DESC, id DESC LIMIT 1`,
      [...params, t.signal_time, t.signal_time, t.id]
    );
    const [next] = await this.execute_query(
      `SELECT id FROM strategy_backtest_trades WHERE ${where} AND (signal_time > ? OR (signal_time = ? AND id > ?)) ORDER BY signal_time ASC, id ASC LIMIT 1`,
      [...params, t.signal_time, t.signal_time, t.id]
    );
    return { prev_id: prev ? Number(prev.id) : null, next_id: next ? Number(next.id) : null };
  }

  /** 统计用的已平仓交易（只取必要列） */
  async get_stat_trades(run_id: number, f: { symbol?: string; from?: number; to?: number }): Promise<StatTrade[]> {
    const { where, params } = this.build_where(run_id, { ...f, status: ['closed'] });
    const rows = await this.execute_query(
      `SELECT symbol, exit_time, exit_reason, pnl, r_multiple FROM strategy_backtest_trades WHERE ${where} ORDER BY exit_time`, params
    );
    return rows.map(r => ({
      symbol: r.symbol, exit_time: Number(r.exit_time), exit_reason: r.exit_reason,
      pnl: Number(r.pnl), r_multiple: r.r_multiple === null ? null : Number(r.r_multiple),
    }));
  }

  /** 拼接筛选条件 */
  private build_where(run_id: number, f: BacktestTradeFilter): { where: string; params: unknown[] } {
    const where = ['run_id = ?'];
    const params: unknown[] = [run_id];
    if (f.status?.length) { where.push(`status IN (${f.status.map(() => '?').join(', ')})`); params.push(...f.status); }
    if (f.symbol) { where.push('symbol = ?'); params.push(f.symbol); }
    if (f.exit_reason?.length) { where.push(`exit_reason IN (${f.exit_reason.map(() => '?').join(', ')})`); params.push(...f.exit_reason); }
    if (f.result === 'win') where.push('pnl > 0');
    if (f.result === 'loss') where.push('pnl <= 0');
    if (f.from !== undefined) { where.push('signal_time >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('signal_time <= ?'); params.push(f.to); }
    return { where: where.join(' AND '), params };
  }

  /** DB 行 → 运行 */
  private to_run(r: any): BacktestRun {
    const json = (v: any) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
    return {
      id: Number(r.id), strategy_id: r.strategy_id, strategy_name: r.strategy_name, strategy_version: Number(r.strategy_version),
      timeframe: r.timeframe, params: json(r.params) ?? {}, data_from: Number(r.data_from), data_to: Number(r.data_to),
      status: r.status, symbols_total: Number(r.symbols_total), trade_count: Number(r.trade_count), signal_count: Number(r.signal_count),
      summary: json(r.summary), note: r.note, error: r.error, created_at: Number(r.created_at),
      finished_at: r.finished_at === null ? null : Number(r.finished_at),
    };
  }

  /** DB 行 → 交易 */
  private to_trade(r: any): StoredBacktestTrade {
    const num = (v: any) => (v === null || v === undefined ? null : Number(v));
    const json = (v: any) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
    return {
      id: Number(r.id), run_id: Number(r.run_id), strategy_id: r.strategy_id, symbol: r.symbol, timeframe: r.timeframe,
      side: r.side, status: r.status, signal_time: Number(r.signal_time), entry_time: num(r.entry_time), entry_price: num(r.entry_price),
      stop_price: num(r.stop_price), target_price: num(r.target_price), exit_time: num(r.exit_time), exit_price: num(r.exit_price),
      exit_reason: r.exit_reason, pnl: num(r.pnl), pnl_pct: num(r.pnl_pct), r_multiple: num(r.r_multiple),
      mfe_pct: num(r.mfe_pct), mae_pct: num(r.mae_pct), bars_held: num(r.bars_held),
      features: json(r.features) ?? {}, annotations: json(r.annotations) ?? [],
    };
  }
}
