/**
 * K线回放模拟交易 数据库操作
 *
 * 撮合在前端完成，后端只存储。前端每次同步整份提交本会话的仓位/委托/成交，
 * 本层在一个事务里整份替换，并用 client_id 把关联换算成数据库 id。
 *
 * 表:
 *   replay_sessions   - 回放会话（品种、游标、资金、费率、同步版本号）
 *   replay_orders     - 委托（市价/限价/条件单，含拒单与撤单记录）
 *   replay_positions  - 仓位回合（开仓 → 平仓，含盈亏/R/MFE/MAE/标签/笔记）
 *   replay_fills      - 成交明细（前端图表打点用）
 */

import { PoolConnection } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';
import {
  ReplayFill,
  ReplayOrder,
  ReplayOrderStatus,
  ReplayPosition,
  ReplaySession,
  ReplaySessionStatus,
} from '@/services/kline_replay/replay_types';

/** 会话进度（前端同步） */
export interface ReplaySessionProgress {
  cursor_time: number;
  last_price: number;
  balance: number;
  bars_stepped: number;
  status: ReplaySessionStatus;
}

/** 整份交易记录 */
export interface ReplayTradeRecords {
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  fills: ReplayFill[];
}

/** 同步结果 */
export type ReplaySyncResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'stale'; current_revision: number };

/** 已平仓回合查询条件（统计用） */
export interface ReplayPositionQuery {
  session_ids?: number[];
  symbol?: string;
  direction?: string;
  tag?: string;
  start_time?: number;     // 按平仓K线时间过滤
  end_time?: number;
  status?: 'open' | 'closed';
  limit?: number;
}

/** DECIMAL 字段转 number（保留 null） */
function num_or_null(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** 标签 JSON 解析 */
function parse_tags(v: unknown): string[] {
  if (!v) return [];
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export class KlineReplayRepository extends BaseRepository {

  /** 初始化表结构（幂等；旧表自动补列） */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS replay_sessions (
        id               BIGINT PRIMARY KEY AUTO_INCREMENT,
        name             VARCHAR(100)  NOT NULL,
        symbol           VARCHAR(20)   NOT NULL,
        start_time       BIGINT        NOT NULL COMMENT '起始K线open_time',
        cursor_time      BIGINT        NOT NULL COMMENT '当前游标5m K线open_time',
        last_price       DECIMAL(24,10) NOT NULL COMMENT '游标K线收盘价',
        initial_balance  DECIMAL(24,8) NOT NULL,
        balance          DECIMAL(24,8) NOT NULL COMMENT '已实现资金',
        leverage         INT           NOT NULL DEFAULT 10,
        taker_fee_rate   DECIMAL(10,6) NOT NULL DEFAULT 0.000500,
        maker_fee_rate   DECIMAL(10,6) NOT NULL DEFAULT 0.000200,
        slippage_rate    DECIMAL(10,6) NOT NULL DEFAULT 0.000000,
        status           VARCHAR(12)   NOT NULL DEFAULT 'active' COMMENT 'active/finished',
        bars_stepped     INT           NOT NULL DEFAULT 0,
        sync_revision    INT           NOT NULL DEFAULT 0 COMMENT '最近一次同步的版本号',
        note             TEXT          NULL,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        finished_at      TIMESTAMP NULL,
        INDEX idx_status (status),
        INDEX idx_symbol (symbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='K线回放会话'
    `, 'replay_sessions');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS replay_orders (
        id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
        session_id         BIGINT        NOT NULL,
        client_id          VARCHAR(64)   NOT NULL DEFAULT '',
        position_id        BIGINT        NULL,
        position_client_id VARCHAR(64)   NULL,
        side               VARCHAR(4)    NOT NULL COMMENT 'buy/sell',
        order_type         VARCHAR(8)    NOT NULL COMMENT 'market/limit/stop',
        qty                DECIMAL(30,10) NOT NULL,
        price              DECIMAL(24,10) NULL COMMENT '限价/触发价',
        reduce_only        TINYINT(1)    NOT NULL DEFAULT 0,
        stop_loss          DECIMAL(24,10) NULL,
        take_profit        DECIMAL(24,10) NULL,
        status             VARCHAR(10)   NOT NULL COMMENT 'pending/filled/cancelled/rejected',
        created_bar_time   BIGINT        NOT NULL,
        filled_bar_time    BIGINT        NULL,
        filled_price       DECIMAL(24,10) NULL,
        fee                DECIMAL(24,8) NOT NULL DEFAULT 0,
        reject_reason      VARCHAR(255)  NULL,
        tags               VARCHAR(500)  NULL COMMENT 'JSON数组',
        note               TEXT          NULL,
        created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_session_status (session_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='K线回放委托'
    `, 'replay_orders');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS replay_positions (
        id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
        session_id          BIGINT        NOT NULL,
        client_id           VARCHAR(64)   NOT NULL DEFAULT '',
        symbol              VARCHAR(20)   NOT NULL,
        direction           VARCHAR(5)    NOT NULL COMMENT 'long/short',
        status              VARCHAR(6)    NOT NULL COMMENT 'open/closed',
        qty                 DECIMAL(30,10) NOT NULL,
        max_qty             DECIMAL(30,10) NOT NULL,
        avg_entry_price     DECIMAL(24,10) NOT NULL,
        exit_qty            DECIMAL(30,10) NOT NULL DEFAULT 0,
        avg_exit_price      DECIMAL(24,10) NULL,
        stop_loss           DECIMAL(24,10) NULL,
        take_profit         DECIMAL(24,10) NULL,
        initial_stop_loss   DECIMAL(24,10) NULL COMMENT '首次止损，定义1R',
        risk_amount         DECIMAL(24,8)  NULL COMMENT '计划风险USDT',
        realized_pnl        DECIMAL(24,8)  NOT NULL DEFAULT 0 COMMENT '毛盈亏',
        fee_total           DECIMAL(24,8)  NOT NULL DEFAULT 0,
        net_pnl             DECIMAL(24,8)  NOT NULL DEFAULT 0,
        r_multiple          DECIMAL(12,4)  NULL,
        max_favorable_price DECIMAL(24,10) NOT NULL,
        max_adverse_price   DECIMAL(24,10) NOT NULL,
        mfe_pct             DECIMAL(12,4)  NOT NULL DEFAULT 0,
        mae_pct             DECIMAL(12,4)  NOT NULL DEFAULT 0,
        open_bar_time       BIGINT        NOT NULL,
        close_bar_time      BIGINT        NULL,
        bars_held           INT           NULL,
        exit_reason         VARCHAR(16)   NULL COMMENT 'take_profit/stop_loss/manual/order/reverse/session_end',
        tags                VARCHAR(500)  NULL COMMENT 'JSON数组',
        note                TEXT          NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_session_status (session_id, status),
        INDEX idx_close_time (close_bar_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='K线回放仓位回合'
    `, 'replay_positions');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS replay_fills (
        id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
        session_id         BIGINT        NOT NULL,
        client_id          VARCHAR(64)   NOT NULL DEFAULT '',
        position_id        BIGINT        NOT NULL,
        position_client_id VARCHAR(64)   NULL,
        order_id           BIGINT        NULL,
        order_client_id    VARCHAR(64)   NULL,
        side               VARCHAR(4)    NOT NULL,
        qty                DECIMAL(30,10) NOT NULL,
        price              DECIMAL(24,10) NOT NULL,
        fee                DECIMAL(24,8) NOT NULL,
        liquidity          VARCHAR(5)    NOT NULL COMMENT 'maker/taker',
        trigger_type       VARCHAR(12)   NOT NULL COMMENT 'market/limit/stop/stop_loss/take_profit/manual/session_end',
        action             VARCHAR(6)    NOT NULL COMMENT 'open/add/reduce/close',
        realized_pnl       DECIMAL(24,8) NOT NULL DEFAULT 0,
        bar_time           BIGINT        NOT NULL,
        created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_session (session_id, bar_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='K线回放成交明细'
    `, 'replay_fills');

    // 早期版本（服务端撮合）建的表缺少以下列，补上
    await this.ensure_column('replay_sessions', 'sync_revision', `INT NOT NULL DEFAULT 0 COMMENT '最近一次同步的版本号' AFTER bars_stepped`);
    await this.ensure_column('replay_orders', 'client_id', `VARCHAR(64) NOT NULL DEFAULT '' AFTER session_id`);
    await this.ensure_column('replay_orders', 'position_client_id', `VARCHAR(64) NULL AFTER position_id`);
    await this.ensure_column('replay_positions', 'client_id', `VARCHAR(64) NOT NULL DEFAULT '' AFTER session_id`);
    await this.ensure_column('replay_fills', 'client_id', `VARCHAR(64) NOT NULL DEFAULT '' AFTER session_id`);
    await this.ensure_column('replay_fills', 'position_client_id', `VARCHAR(64) NULL AFTER position_id`);
    await this.ensure_column('replay_fills', 'order_client_id', `VARCHAR(64) NULL AFTER order_id`);
  }

  /** 列不存在时补列 */
  private async ensure_column(table: string, column: string, definition: string): Promise<void> {
    const rows = await this.execute_query(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (rows.length > 0) return;
    await this.execute_query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`[KlineReplayRepository] ${table} 补列 ${column}`);
  }

  // ==================== 会话 ====================

  /** 新建会话，返回 id */
  async create_session(s: ReplaySession): Promise<number> {
    return this.insert_and_get_id(`
      INSERT INTO replay_sessions
        (name, symbol, start_time, cursor_time, last_price, initial_balance, balance, leverage,
         taker_fee_rate, maker_fee_rate, slippage_rate, status, bars_stepped, sync_revision, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      s.name, s.symbol, s.start_time, s.cursor_time, s.last_price, s.initial_balance, s.balance, s.leverage,
      s.taker_fee_rate, s.maker_fee_rate, s.slippage_rate, s.status, s.bars_stepped, s.sync_revision, s.note,
    ]);
  }

  /** 查询单个会话 */
  async get_session(id: number): Promise<ReplaySession | null> {
    const rows = await this.execute_query('SELECT * FROM replay_sessions WHERE id = ?', [id]);
    return rows.length > 0 ? this.map_session(rows[0]) : null;
  }

  /** 会话列表 */
  async list_sessions(filter: { status?: ReplaySessionStatus; symbol?: string; limit?: number; offset?: number }): Promise<ReplaySession[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.symbol) { where.push('symbol = ?'); params.push(filter.symbol); }
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 500);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    const rows = await this.execute_query(`
      SELECT * FROM replay_sessions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    return rows.map(r => this.map_session(r));
  }

  /** 修改会话名称/备注 */
  async update_session_meta(id: number, patch: { name?: string; note?: string | null }): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.note !== undefined) { sets.push('note = ?'); params.push(patch.note); }
    if (sets.length === 0) return;
    params.push(id);
    await this.update_and_get_affected_rows(`UPDATE replay_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /** 删除会话及其全部委托/仓位/成交 */
  async delete_session(id: number): Promise<boolean> {
    return this.with_transaction(async conn => {
      await this.delete_trades(conn, id);
      const [result] = await conn.execute('DELETE FROM replay_sessions WHERE id = ?', [id]);
      return (result as any).affectedRows > 0;
    });
  }

  // ==================== 同步 ====================

  /**
   * 同步：更新进度，并（可选）整份替换交易记录
   * revision 必须大于库里的 sync_revision，否则视为过期请求拒绝
   * @param trades 不传则只更新进度
   */
  async sync_session(
    session_id: number,
    revision: number,
    progress: ReplaySessionProgress,
    trades: ReplayTradeRecords | null,
  ): Promise<ReplaySyncResult> {
    return this.with_transaction(async conn => {
      const [rows] = await conn.execute(
        'SELECT sync_revision, status FROM replay_sessions WHERE id = ? FOR UPDATE',
        [session_id],
      );
      const current = (rows as any[])[0];
      if (!current) return { ok: false, reason: 'not_found' };
      if (revision <= Number(current.sync_revision)) {
        return { ok: false, reason: 'stale', current_revision: Number(current.sync_revision) };
      }

      const finishing = progress.status === 'finished' && current.status !== 'finished';
      await conn.execute(`
        UPDATE replay_sessions
        SET cursor_time = ?, last_price = ?, balance = ?, bars_stepped = ?, status = ?, sync_revision = ?
            ${finishing ? ', finished_at = CURRENT_TIMESTAMP' : ''}
        WHERE id = ?
      `, [progress.cursor_time, progress.last_price, progress.balance, progress.bars_stepped, progress.status, revision, session_id]);

      if (trades) {
        await this.delete_trades(conn, session_id);
        await this.insert_trades(conn, session_id, trades);
      }
      return { ok: true, revision };
    });
  }

  /** 删除某会话的全部交易记录 */
  private async delete_trades(conn: PoolConnection, session_id: number): Promise<void> {
    await conn.execute('DELETE FROM replay_fills WHERE session_id = ?', [session_id]);
    await conn.execute('DELETE FROM replay_orders WHERE session_id = ?', [session_id]);
    await conn.execute('DELETE FROM replay_positions WHERE session_id = ?', [session_id]);
  }

  /** 插入整份交易记录：仓位 → 委托 → 成交，client_id 换算成数据库 id */
  private async insert_trades(conn: PoolConnection, session_id: number, trades: ReplayTradeRecords): Promise<void> {
    const position_ids = new Map<string, number>();
    for (const p of trades.positions) {
      const [result] = await conn.execute(`
        INSERT INTO replay_positions
          (session_id, client_id, symbol, direction, status, qty, max_qty, avg_entry_price, exit_qty, avg_exit_price,
           stop_loss, take_profit, initial_stop_loss, risk_amount, realized_pnl, fee_total, net_pnl, r_multiple,
           max_favorable_price, max_adverse_price, mfe_pct, mae_pct, open_bar_time, close_bar_time, bars_held,
           exit_reason, tags, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session_id, p.client_id, p.symbol, p.direction, p.status, p.qty, p.max_qty, p.avg_entry_price, p.exit_qty,
        p.avg_exit_price, p.stop_loss, p.take_profit, p.initial_stop_loss, p.risk_amount, p.realized_pnl,
        p.fee_total, p.net_pnl, p.r_multiple, p.max_favorable_price, p.max_adverse_price, p.mfe_pct, p.mae_pct,
        p.open_bar_time, p.close_bar_time, p.bars_held, p.exit_reason, JSON.stringify(p.tags), p.note,
      ]);
      position_ids.set(p.client_id, (result as any).insertId);
    }

    const order_ids = new Map<string, number>();
    for (const o of trades.orders) {
      const [result] = await conn.execute(`
        INSERT INTO replay_orders
          (session_id, client_id, position_id, position_client_id, side, order_type, qty, price, reduce_only,
           stop_loss, take_profit, status, created_bar_time, filled_bar_time, filled_price, fee, reject_reason, tags, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session_id, o.client_id, o.position_client_id ? position_ids.get(o.position_client_id) ?? null : null,
        o.position_client_id, o.side, o.order_type, o.qty, o.price, o.reduce_only ? 1 : 0, o.stop_loss,
        o.take_profit, o.status, o.created_bar_time, o.filled_bar_time, o.filled_price, o.fee, o.reject_reason,
        JSON.stringify(o.tags), o.note,
      ]);
      order_ids.set(o.client_id, (result as any).insertId);
    }

    for (const f of trades.fills) {
      const position_id = position_ids.get(f.position_client_id);
      if (position_id === undefined) {
        throw new Error(`成交 ${f.client_id} 关联的仓位 ${f.position_client_id} 不在同步数据中`);
      }
      await conn.execute(`
        INSERT INTO replay_fills
          (session_id, client_id, position_id, position_client_id, order_id, order_client_id, side, qty, price, fee,
           liquidity, trigger_type, action, realized_pnl, bar_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session_id, f.client_id, position_id, f.position_client_id,
        f.order_client_id ? order_ids.get(f.order_client_id) ?? null : null, f.order_client_id,
        f.side, f.qty, f.price, f.fee, f.liquidity, f.trigger_type, f.action, f.realized_pnl, f.bar_time,
      ]);
    }
  }

  // ==================== 查询 ====================

  /** 查询仓位回合 */
  async list_positions(q: ReplayPositionQuery): Promise<ReplayPosition[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (q.session_ids && q.session_ids.length > 0) {
      where.push(`session_id IN (${q.session_ids.map(() => '?').join(',')})`);
      params.push(...q.session_ids);
    }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.symbol) { where.push('symbol = ?'); params.push(q.symbol); }
    if (q.direction) { where.push('direction = ?'); params.push(q.direction); }
    if (q.tag) { where.push('JSON_CONTAINS(tags, JSON_QUOTE(?))'); params.push(q.tag); }
    if (q.start_time !== undefined) { where.push('close_bar_time >= ?'); params.push(q.start_time); }
    if (q.end_time !== undefined) { where.push('close_bar_time <= ?'); params.push(q.end_time); }
    const limit = Math.min(Math.max(Number(q.limit) || 1000, 1), 10000);
    const rows = await this.execute_query(`
      SELECT * FROM replay_positions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY open_bar_time, id
      LIMIT ${limit}
    `, params);
    return rows.map(r => this.map_position(r));
  }

  /** 会话委托列表 */
  async list_orders(session_id: number, status?: ReplayOrderStatus): Promise<ReplayOrder[]> {
    const rows = await this.execute_query(
      `SELECT * FROM replay_orders WHERE session_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id`,
      status ? [session_id, status] : [session_id],
    );
    return rows.map(r => this.map_order(r));
  }

  /** 会话成交列表 */
  async list_fills(session_id: number): Promise<ReplayFill[]> {
    const rows = await this.execute_query(
      'SELECT * FROM replay_fills WHERE session_id = ? ORDER BY bar_time, id',
      [session_id],
    );
    return rows.map(r => this.map_fill(r));
  }

  // ==================== 内部 ====================

  /** 事务包装 */
  private async with_transaction<T>(operation: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await DatabaseConfig.get_mysql_connection();
    try {
      await conn.beginTransaction();
      const result = await operation(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      logger.error('[KlineReplayRepository] 事务失败，已回滚', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  private map_session(r: any): ReplaySession {
    return {
      id: Number(r.id),
      name: r.name,
      symbol: r.symbol,
      start_time: Number(r.start_time),
      cursor_time: Number(r.cursor_time),
      last_price: Number(r.last_price),
      initial_balance: Number(r.initial_balance),
      balance: Number(r.balance),
      leverage: Number(r.leverage),
      taker_fee_rate: Number(r.taker_fee_rate),
      maker_fee_rate: Number(r.maker_fee_rate),
      slippage_rate: Number(r.slippage_rate),
      status: r.status,
      bars_stepped: Number(r.bars_stepped),
      sync_revision: Number(r.sync_revision),
      note: r.note ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      finished_at: r.finished_at ?? null,
    };
  }

  private map_order(r: any): ReplayOrder {
    return {
      id: Number(r.id),
      client_id: r.client_id,
      session_id: Number(r.session_id),
      position_id: num_or_null(r.position_id),
      position_client_id: r.position_client_id ?? null,
      side: r.side,
      order_type: r.order_type,
      qty: Number(r.qty),
      price: num_or_null(r.price),
      reduce_only: Boolean(r.reduce_only),
      stop_loss: num_or_null(r.stop_loss),
      take_profit: num_or_null(r.take_profit),
      status: r.status,
      created_bar_time: Number(r.created_bar_time),
      filled_bar_time: num_or_null(r.filled_bar_time),
      filled_price: num_or_null(r.filled_price),
      fee: Number(r.fee),
      reject_reason: r.reject_reason ?? null,
      tags: parse_tags(r.tags),
      note: r.note ?? null,
    };
  }

  private map_position(r: any): ReplayPosition {
    return {
      id: Number(r.id),
      client_id: r.client_id,
      session_id: Number(r.session_id),
      symbol: r.symbol,
      direction: r.direction,
      status: r.status,
      qty: Number(r.qty),
      max_qty: Number(r.max_qty),
      avg_entry_price: Number(r.avg_entry_price),
      exit_qty: Number(r.exit_qty),
      avg_exit_price: num_or_null(r.avg_exit_price),
      stop_loss: num_or_null(r.stop_loss),
      take_profit: num_or_null(r.take_profit),
      initial_stop_loss: num_or_null(r.initial_stop_loss),
      risk_amount: num_or_null(r.risk_amount),
      realized_pnl: Number(r.realized_pnl),
      fee_total: Number(r.fee_total),
      net_pnl: Number(r.net_pnl),
      r_multiple: num_or_null(r.r_multiple),
      max_favorable_price: Number(r.max_favorable_price),
      max_adverse_price: Number(r.max_adverse_price),
      mfe_pct: Number(r.mfe_pct),
      mae_pct: Number(r.mae_pct),
      open_bar_time: Number(r.open_bar_time),
      close_bar_time: num_or_null(r.close_bar_time),
      bars_held: num_or_null(r.bars_held),
      exit_reason: r.exit_reason ?? null,
      tags: parse_tags(r.tags),
      note: r.note ?? null,
    };
  }

  private map_fill(r: any): ReplayFill {
    return {
      id: Number(r.id),
      client_id: r.client_id,
      session_id: Number(r.session_id),
      position_id: Number(r.position_id),
      position_client_id: r.position_client_id,
      order_id: num_or_null(r.order_id),
      order_client_id: r.order_client_id ?? null,
      side: r.side,
      qty: Number(r.qty),
      price: Number(r.price),
      fee: Number(r.fee),
      liquidity: r.liquidity,
      trigger_type: r.trigger_type,
      action: r.action,
      realized_pnl: Number(r.realized_pnl),
      bar_time: Number(r.bar_time),
    };
  }
}
