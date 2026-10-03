/**
 * 模拟盘 数据库操作
 *
 * 表:
 *   paper_trades - 模拟交易全生命周期（挂单 → 持仓 → 平仓 / 撤单 / 失效 / 跳过）
 *   paper_runtime_status - paper 进程心跳（单行，供前端展示运行情况）
 *                  唯一键 (strategy_id, symbol, setup_time)：同一根反转K线只下一次单，写入幂等
 */

import { BaseRepository } from './base_repository';
import { PaperTrade, PaperTradeStatus } from '@/services/paper_trading/paper_types';

/** 列表查询条件 */
export interface PaperTradeFilter {
  status?: PaperTradeStatus[];
  strategy_id?: string;
  symbol?: string;
  from?: number;          // 按 signal_time 过滤
  to?: number;
  limit?: number;
  offset?: number;
}

/** paper 进程运行状态（心跳） */
export interface PaperRuntimeStatus {
  started_at: number;         // 进程启动时间
  heartbeat_at: number;       // 最近一次心跳
  last_bar_time: number;      // 已处理的最新 5m open_time（全市场最大值）
  ws_connected: boolean;
  symbols: number;            // 跟踪币种数
  bars_processed: number;     // 本次启动以来处理的 5m 根数（含预热）
  gap_filled: number;         // 本次启动以来 REST 补齐的根数
  pending: number;            // 当前挂单数
  open_positions: number;     // 当前持仓数
}

/** 可变字段（upsert 时更新；features 含第三推持仓中更新的 breakout） */
const MUTABLE_COLUMNS = [
  'status', 'take_profit', 'max_hold_until', 'fill_time', 'fill_price', 'qty', 'notional',
  'exit_time', 'exit_price', 'exit_reason', 'gross_pnl', 'fees', 'pnl', 'r_multiple',
  'mfe_r', 'mae_r', 'cancel_reason', 'last_bar_time', 'features',
] as const;

const ALL_COLUMNS = [
  'strategy_id', 'symbol', 'timeframe', 'side', 'status',
  'trigger_time', 'setup_time', 'signal_time', 'entry_trigger', 'base_stop', 'stop_price', 'take_profit',
  'expire_at', 'max_hold_until', 'fill_time', 'fill_price', 'qty', 'notional', 'risk_usdt',
  'exit_time', 'exit_price', 'exit_reason', 'gross_pnl', 'fees', 'pnl', 'r_multiple', 'mfe_r', 'mae_r',
  'cancel_reason', 'last_bar_time', 'features',
] as const;

export class PaperTradingRepository extends BaseRepository {

  /** 建表（幂等） */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        strategy_id     VARCHAR(40)  NOT NULL,
        symbol          VARCHAR(30)  NOT NULL,
        timeframe       VARCHAR(8)   NOT NULL,
        side            VARCHAR(8)   NOT NULL COMMENT 'short / long',
        status          VARCHAR(16)  NOT NULL COMMENT 'pending/open/closed/cancelled/expired/skipped',
        trigger_time    BIGINT       NOT NULL COMMENT '背离触发K线 open_time',
        setup_time      BIGINT       NOT NULL COMMENT '反转K线 open_time',
        signal_time     BIGINT       NOT NULL COMMENT '挂单生效时刻（反转K线收盘）',
        entry_trigger   DOUBLE       NOT NULL COMMENT '条件单触发价',
        base_stop       DOUBLE       NOT NULL COMMENT '背离极值（成交前触及即撤单）',
        stop_price      DOUBLE       NOT NULL COMMENT '成交后止损价',
        take_profit     DOUBLE       NULL,
        expire_at       BIGINT       NOT NULL,
        max_hold_until  BIGINT       NULL,
        fill_time       BIGINT       NULL,
        fill_price      DOUBLE       NULL,
        qty             DOUBLE       NULL,
        notional        DOUBLE       NULL,
        risk_usdt       DOUBLE       NOT NULL,
        exit_time       BIGINT       NULL,
        exit_price      DOUBLE       NULL,
        exit_reason     VARCHAR(16)  NULL COMMENT 'stop / take_profit / time',
        gross_pnl       DOUBLE       NULL,
        fees            DOUBLE       NULL,
        pnl             DOUBLE       NULL,
        r_multiple      DOUBLE       NULL,
        mfe_r           DOUBLE       NULL,
        mae_r           DOUBLE       NULL,
        cancel_reason   VARCHAR(40)  NULL,
        last_bar_time   BIGINT       NOT NULL COMMENT '已撮合到的最后一根 5m open_time',
        features        JSON         NOT NULL COMMENT '信号特征',
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_strategy_symbol_setup (strategy_id, symbol, setup_time),
        INDEX idx_status (status),
        INDEX idx_symbol (symbol),
        INDEX idx_signal_time (signal_time),
        INDEX idx_exit_time (exit_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模拟盘交易'
    `, 'paper_trades');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS paper_runtime_status (
        id              TINYINT      PRIMARY KEY,
        started_at      BIGINT       NOT NULL,
        heartbeat_at    BIGINT       NOT NULL,
        last_bar_time   BIGINT       NOT NULL,
        ws_connected    TINYINT      NOT NULL,
        symbols         INT          NOT NULL,
        bars_processed  BIGINT       NOT NULL,
        gap_filled      BIGINT       NOT NULL,
        pending         INT          NOT NULL,
        open_positions  INT          NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模拟盘进程心跳（单行）'
    `, 'paper_runtime_status');
  }

  /** 写入进程心跳（单行覆盖） */
  async save_runtime_status(s: PaperRuntimeStatus): Promise<void> {
    await this.execute_query(
      `REPLACE INTO paper_runtime_status
       (id, started_at, heartbeat_at, last_bar_time, ws_connected, symbols, bars_processed, gap_filled, pending, open_positions)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.started_at, s.heartbeat_at, s.last_bar_time, s.ws_connected ? 1 : 0, s.symbols, s.bars_processed, s.gap_filled, s.pending, s.open_positions]
    );
  }

  /** 读取进程心跳（从未运行过返回 null） */
  async get_runtime_status(): Promise<PaperRuntimeStatus | null> {
    const rows = await this.execute_query(`SELECT * FROM paper_runtime_status WHERE id = 1`);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      started_at: Number(r.started_at), heartbeat_at: Number(r.heartbeat_at), last_bar_time: Number(r.last_bar_time),
      ws_connected: Number(r.ws_connected) === 1, symbols: Number(r.symbols), bars_processed: Number(r.bars_processed),
      gap_filled: Number(r.gap_filled), pending: Number(r.pending), open_positions: Number(r.open_positions),
    };
  }

  /** 新增或更新一笔交易（按唯一键幂等），返回 id */
  async upsert_trade(t: PaperTrade): Promise<number> {
    const values = ALL_COLUMNS.map(c => c === 'features' ? JSON.stringify(t.features) : (t as any)[c] ?? null);
    const sql = `
      INSERT INTO paper_trades (${ALL_COLUMNS.join(', ')})
      VALUES (${ALL_COLUMNS.map(() => '?').join(', ')})
      ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), ${MUTABLE_COLUMNS.map(c => `${c} = VALUES(${c})`).join(', ')}
    `;
    const id = await this.insert_and_get_id(sql, values);
    t.id = id;
    return id;
  }

  /** 进行中的交易（pending / open） */
  async get_active_trades(): Promise<PaperTrade[]> {
    const rows = await this.execute_query(
      `SELECT * FROM paper_trades WHERE status IN ('pending', 'open') ORDER BY signal_time`
    );
    return rows.map(r => this.to_trade(r));
  }

  /** 列表查询（按 signal_time 倒序） */
  async list_trades(f: PaperTradeFilter): Promise<{ total: number; rows: PaperTrade[] }> {
    const where: string[] = [];
    const params: any[] = [];
    if (f.status && f.status.length) { where.push(`status IN (${f.status.map(() => '?').join(', ')})`); params.push(...f.status); }
    if (f.strategy_id) { where.push('strategy_id = ?'); params.push(f.strategy_id); }
    if (f.symbol) { where.push('symbol = ?'); params.push(f.symbol); }
    if (f.from !== undefined) { where.push('signal_time >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('signal_time <= ?'); params.push(f.to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
    const offset = Math.max(Number(f.offset) || 0, 0);
    const [cnt] = await this.execute_query(`SELECT COUNT(*) AS n FROM paper_trades ${w}`, params);
    const rows = await this.execute_query(
      `SELECT * FROM paper_trades ${w} ORDER BY signal_time DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params
    );
    return { total: Number(cnt.n), rows: rows.map(r => this.to_trade(r)) };
  }

  /** 单笔交易 */
  async get_trade(id: number): Promise<PaperTrade | null> {
    const rows = await this.execute_query(`SELECT * FROM paper_trades WHERE id = ?`, [id]);
    return rows.length ? this.to_trade(rows[0]) : null;
  }

  /** 按唯一键查询（实盘与模拟盘对拍用） */
  async get_trade_by_key(strategy_id: string, symbol: string, setup_time: number): Promise<PaperTrade | null> {
    const rows = await this.execute_query(
      `SELECT * FROM paper_trades WHERE strategy_id = ? AND symbol = ? AND setup_time = ?`, [strategy_id, symbol, setup_time],
    );
    return rows.length ? this.to_trade(rows[0]) : null;
  }

  /** 已平仓交易（按平仓时间升序，用于统计与资金曲线） */
  async get_closed_trades(f: { strategy_id?: string; from?: number; to?: number }): Promise<PaperTrade[]> {
    const where = [`status = 'closed'`];
    const params: any[] = [];
    if (f.strategy_id) { where.push('strategy_id = ?'); params.push(f.strategy_id); }
    if (f.from !== undefined) { where.push('exit_time >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('exit_time <= ?'); params.push(f.to); }
    const rows = await this.execute_query(
      `SELECT * FROM paper_trades WHERE ${where.join(' AND ')} ORDER BY exit_time, id`, params
    );
    return rows.map(r => this.to_trade(r));
  }

  /** 各策略各状态计数 */
  async count_by_status(): Promise<{ strategy_id: string; status: string; n: number }[]> {
    const rows = await this.execute_query(
      `SELECT strategy_id, status, COUNT(*) AS n FROM paper_trades GROUP BY strategy_id, status`
    );
    return rows.map(r => ({ strategy_id: r.strategy_id, status: r.status, n: Number(r.n) }));
  }

  /** DB 行转交易对象（BIGINT/DOUBLE 转 number，JSON 解析） */
  private to_trade(r: any): PaperTrade {
    const num = (v: any) => (v === null || v === undefined ? null : Number(v));
    return {
      id: Number(r.id),
      strategy_id: r.strategy_id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      side: r.side,
      status: r.status,
      trigger_time: Number(r.trigger_time),
      setup_time: Number(r.setup_time),
      signal_time: Number(r.signal_time),
      entry_trigger: Number(r.entry_trigger),
      base_stop: Number(r.base_stop),
      stop_price: Number(r.stop_price),
      take_profit: num(r.take_profit),
      expire_at: Number(r.expire_at),
      max_hold_until: num(r.max_hold_until),
      fill_time: num(r.fill_time),
      fill_price: num(r.fill_price),
      qty: num(r.qty),
      notional: num(r.notional),
      risk_usdt: Number(r.risk_usdt),
      exit_time: num(r.exit_time),
      exit_price: num(r.exit_price),
      exit_reason: r.exit_reason,
      gross_pnl: num(r.gross_pnl),
      fees: num(r.fees),
      pnl: num(r.pnl),
      r_multiple: num(r.r_multiple),
      mfe_r: num(r.mfe_r),
      mae_r: num(r.mae_r),
      cancel_reason: r.cancel_reason,
      last_bar_time: Number(r.last_bar_time),
      features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features,
    };
  }
}
