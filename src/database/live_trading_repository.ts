/**
 * 实盘交易 数据库操作
 *
 * 表:
 *   live_trades         - 实盘交易全生命周期；唯一键 (strategy_id, symbol, setup_time) 与 paper_trades 相同，可直接对拍
 *   live_events         - 审计日志：每次下单 / 撤单 / 成交 / 异常（排查用）
 *   live_control        - 控制开关（单行）：running / paused（停开新仓）/ flatten（撤单 + 全部平仓后转 paused）
 *   live_runtime_status - live 进程心跳（单行）
 */

import { BaseRepository } from './base_repository';
import { LiveControlMode, LiveTrade, LiveTradeStatus } from '@/services/live_trading/live_types';
import { LiveTradeStore } from '@/services/live_trading/live_executor';

/** live 进程运行状态 */
export interface LiveRuntimeStatus {
  started_at: number;
  heartbeat_at: number;
  mode: string;                 // live / shadow
  control: string;              // running / paused / flatten
  market_ws: boolean;
  user_ws: boolean;
  last_bar_time: number;
  balance: number | null;       // 钱包余额
  available: number | null;     // 可用余额
  active_trades: number;
  error_trades: number;
}

const COLUMNS = [
  'strategy_id', 'symbol', 'timeframe', 'side', 'status',
  'trigger_time', 'setup_time', 'signal_time',
  'entry_trigger', 'entry_limit', 'base_stop', 'stop_price', 'take_profit',
  'planned_qty', 'leverage', 'risk_usdt', 'expire_at', 'max_hold_until',
  'entry_mode', 'entry_order_id', 'filled_qty', 'fill_price', 'fill_time',
  'sl_seq', 'tp_seq', 'exit_seq',
  'exit_time', 'exit_price', 'exit_reason', 'gross_pnl', 'fees', 'funding', 'pnl', 'r_multiple', 'mfe_r', 'mae_r',
  'cancel_reason', 'error_msg', 'last_bar_time', 'features',
] as const;

/** 创建后不再变化的列 */
const IMMUTABLE = new Set(['strategy_id', 'symbol', 'timeframe', 'side', 'trigger_time', 'setup_time', 'signal_time', 'features']);

export class LiveTradingRepository extends BaseRepository implements LiveTradeStore {

  /** 建表（幂等） */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS live_trades (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        strategy_id     VARCHAR(40)  NOT NULL,
        symbol          VARCHAR(30)  NOT NULL,
        timeframe       VARCHAR(8)   NOT NULL,
        side            VARCHAR(8)   NOT NULL,
        status          VARCHAR(16)  NOT NULL COMMENT 'placing/pending/entering/open/closing/closed/cancelled/skipped/shadow/error',
        trigger_time    BIGINT       NOT NULL,
        setup_time      BIGINT       NOT NULL COMMENT '反转K线 open_time（与 paper_trades 同键）',
        signal_time     BIGINT       NOT NULL,
        entry_trigger   DOUBLE       NOT NULL,
        entry_limit     DOUBLE       NOT NULL COMMENT 'IOC 限价（最差可接受成交价）',
        base_stop       DOUBLE       NOT NULL,
        stop_price      DOUBLE       NOT NULL,
        take_profit     DOUBLE       NULL,
        planned_qty     DOUBLE       NOT NULL,
        leverage        INT          NOT NULL,
        risk_usdt       DOUBLE       NOT NULL,
        expire_at       BIGINT       NOT NULL,
        max_hold_until  BIGINT       NULL,
        entry_mode      VARCHAR(8)   NULL COMMENT 'algo / ioc',
        entry_order_id  BIGINT       NULL,
        filled_qty      DOUBLE       NULL,
        fill_price      DOUBLE       NULL,
        fill_time       BIGINT       NULL,
        sl_seq          INT          NOT NULL DEFAULT 0,
        tp_seq          INT          NOT NULL DEFAULT 0,
        exit_seq        INT          NOT NULL DEFAULT 0,
        exit_time       BIGINT       NULL,
        exit_price      DOUBLE       NULL,
        exit_reason     VARCHAR(16)  NULL,
        gross_pnl       DOUBLE       NULL,
        fees            DOUBLE       NULL,
        funding         DOUBLE       NULL,
        pnl             DOUBLE       NULL,
        r_multiple      DOUBLE       NULL,
        mfe_r           DOUBLE       NULL,
        mae_r           DOUBLE       NULL,
        cancel_reason   VARCHAR(60)  NULL,
        error_msg       VARCHAR(255) NULL,
        last_bar_time   BIGINT       NOT NULL,
        features        JSON         NOT NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_strategy_symbol_setup (strategy_id, symbol, setup_time),
        INDEX idx_status (status),
        INDEX idx_symbol (symbol),
        INDEX idx_exit_time (exit_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实盘交易'
    `, 'live_trades');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS live_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        trade_id    BIGINT       NULL,
        symbol      VARCHAR(30)  NOT NULL,
        kind        VARCHAR(40)  NOT NULL,
        payload     JSON         NULL,
        created_at  TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
        INDEX idx_trade (trade_id),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实盘审计日志'
    `, 'live_events');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS live_control (
        id          TINYINT      PRIMARY KEY,
        mode        VARCHAR(16)  NOT NULL COMMENT 'running / paused / flatten',
        note        VARCHAR(255) NULL,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实盘控制开关（单行）'
    `, 'live_control');
    await this.execute_query(`INSERT IGNORE INTO live_control (id, mode, note) VALUES (1, 'running', 'init')`);

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS live_runtime_status (
        id            TINYINT      PRIMARY KEY,
        started_at    BIGINT       NOT NULL,
        heartbeat_at  BIGINT       NOT NULL,
        mode          VARCHAR(8)   NOT NULL,
        control       VARCHAR(16)  NOT NULL,
        market_ws     TINYINT      NOT NULL,
        user_ws       TINYINT      NOT NULL,
        last_bar_time BIGINT       NOT NULL,
        balance       DOUBLE       NULL,
        available     DOUBLE       NULL,
        active_trades INT          NOT NULL,
        error_trades  INT          NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实盘进程心跳（单行）'
    `, 'live_runtime_status');
  }

  // ==================== 交易 ====================

  /** 新增交易；唯一键冲突返回 null */
  async insert_trade(t: LiveTrade): Promise<number | null> {
    const values = COLUMNS.map(c => this.col_value(t, c));
    try {
      return await this.insert_and_get_id(
        `INSERT INTO live_trades (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`, values,
      );
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') return null;
      throw err;
    }
  }

  /** 按 id 更新全部可变列 */
  async update_trade(t: LiveTrade): Promise<void> {
    if (t.id === undefined) throw new Error('update_trade 缺少 id');
    const cols = COLUMNS.filter(c => !IMMUTABLE.has(c));
    await this.execute_query(
      `UPDATE live_trades SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map(c => this.col_value(t, c)), t.id],
    );
  }

  /** 审计日志 */
  async log_event(trade_id: number | null, symbol: string, kind: string, payload: unknown): Promise<void> {
    await this.execute_query(
      `INSERT INTO live_events (trade_id, symbol, kind, payload) VALUES (?, ?, ?, ?)`,
      [trade_id, symbol, kind, payload === undefined ? null : JSON.stringify(payload)],
    );
  }

  /** 某时刻以来平仓交易的净盈亏之和 */
  async realized_pnl_since(ts: number): Promise<number> {
    const [r] = await this.execute_query(
      `SELECT COALESCE(SUM(pnl), 0) AS s FROM live_trades WHERE status = 'closed' AND exit_time >= ?`, [ts],
    );
    return Number(r.s);
  }

  /** 进行中 + 待人工处理的交易（启动恢复） */
  async get_recoverable_trades(): Promise<LiveTrade[]> {
    const rows = await this.execute_query(
      `SELECT * FROM live_trades WHERE status IN ('placing','pending','entering','open','closing','error') ORDER BY id`,
    );
    return rows.map(r => this.to_trade(r));
  }

  /** 列表（按 id 倒序） */
  async list_trades(f: { status?: LiveTradeStatus[]; limit?: number; offset?: number }): Promise<{ total: number; rows: LiveTrade[] }> {
    const where: string[] = [], params: any[] = [];
    if (f.status?.length) { where.push(`status IN (${f.status.map(() => '?').join(', ')})`); params.push(...f.status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
    const offset = Math.max(Number(f.offset) || 0, 0);
    const [cnt] = await this.execute_query(`SELECT COUNT(*) AS n FROM live_trades ${w}`, params);
    const rows = await this.execute_query(`SELECT * FROM live_trades ${w} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    return { total: Number(cnt.n), rows: rows.map(r => this.to_trade(r)) };
  }

  /** 人工处理完 error 交易后标记结束（status → closed 或 cancelled） */
  async resolve_error_trade(id: number, status: 'closed' | 'cancelled', note: string): Promise<number> {
    return this.update_and_get_affected_rows(
      `UPDATE live_trades SET status = ?, error_msg = CONCAT(COALESCE(error_msg, ''), ' | resolved: ', ?) WHERE id = ? AND status = 'error'`,
      [status, note, id],
    );
  }

  // ==================== 控制 / 心跳 ====================

  async get_control(): Promise<LiveControlMode> {
    const rows = await this.execute_query(`SELECT mode FROM live_control WHERE id = 1`);
    const m = rows[0]?.mode;
    return m === 'running' || m === 'paused' || m === 'flatten' ? m : 'paused';
  }

  async set_control(mode: LiveControlMode, note: string): Promise<void> {
    await this.execute_query(
      `INSERT INTO live_control (id, mode, note) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE mode = VALUES(mode), note = VALUES(note)`,
      [mode, note],
    );
  }

  async save_runtime_status(s: LiveRuntimeStatus): Promise<void> {
    await this.execute_query(
      `REPLACE INTO live_runtime_status
       (id, started_at, heartbeat_at, mode, control, market_ws, user_ws, last_bar_time, balance, available, active_trades, error_trades)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.started_at, s.heartbeat_at, s.mode, s.control, s.market_ws ? 1 : 0, s.user_ws ? 1 : 0, s.last_bar_time,
        s.balance, s.available, s.active_trades, s.error_trades],
    );
  }

  async get_runtime_status(): Promise<LiveRuntimeStatus | null> {
    const rows = await this.execute_query(`SELECT * FROM live_runtime_status WHERE id = 1`);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      started_at: Number(r.started_at), heartbeat_at: Number(r.heartbeat_at), mode: r.mode, control: r.control,
      market_ws: Number(r.market_ws) === 1, user_ws: Number(r.user_ws) === 1, last_bar_time: Number(r.last_bar_time),
      balance: r.balance === null ? null : Number(r.balance), available: r.available === null ? null : Number(r.available),
      active_trades: Number(r.active_trades), error_trades: Number(r.error_trades),
    };
  }

  // ==================== 转换 ====================

  private col_value(t: LiveTrade, c: typeof COLUMNS[number]): any {
    if (c === 'features') return JSON.stringify(t.features);
    if (c === 'error_msg') return t.error_msg ? t.error_msg.slice(0, 255) : null;
    if (c === 'cancel_reason') return t.cancel_reason ? t.cancel_reason.slice(0, 60) : null;
    const v = (t as any)[c];
    return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v;
  }

  private to_trade(r: any): LiveTrade {
    const num = (v: any) => (v === null || v === undefined ? null : Number(v));
    return {
      id: Number(r.id),
      strategy_id: r.strategy_id, symbol: r.symbol, timeframe: r.timeframe, side: r.side, status: r.status,
      trigger_time: Number(r.trigger_time), setup_time: Number(r.setup_time), signal_time: Number(r.signal_time),
      entry_trigger: Number(r.entry_trigger), entry_limit: Number(r.entry_limit), base_stop: Number(r.base_stop),
      stop_price: Number(r.stop_price), take_profit: num(r.take_profit),
      planned_qty: Number(r.planned_qty), leverage: Number(r.leverage), risk_usdt: Number(r.risk_usdt),
      expire_at: Number(r.expire_at), max_hold_until: num(r.max_hold_until),
      entry_mode: r.entry_mode ?? null, entry_order_id: num(r.entry_order_id),
      filled_qty: num(r.filled_qty), fill_price: num(r.fill_price), fill_time: num(r.fill_time),
      sl_seq: Number(r.sl_seq), tp_seq: Number(r.tp_seq), exit_seq: Number(r.exit_seq),
      exit_time: num(r.exit_time), exit_price: num(r.exit_price), exit_reason: r.exit_reason ?? null,
      gross_pnl: num(r.gross_pnl), fees: num(r.fees), funding: num(r.funding), pnl: num(r.pnl),
      r_multiple: num(r.r_multiple), mfe_r: num(r.mfe_r), mae_r: num(r.mae_r),
      cancel_reason: r.cancel_reason ?? null, error_msg: r.error_msg ?? null,
      last_bar_time: Number(r.last_bar_time),
      features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features,
    };
  }
}
