/**
 * 交易日志存储层（AI 复盘业务的主表）
 *
 * 以币安真实成交为主体：一条 trade_log = 一个完整开平回合。
 * AI 评估（trade_log_analysis）和复盘（trade_log_review）作为配角挂在 log 上，可有可无。
 *
 * 注意：与 trade_record_repository.ts（实盘交易引擎用，表 trade_records）是两套不同业务，
 *       本表命名为 trade_log 以示区分。
 *
 * 三张表：
 *   trade_log          主表：真实交易记录（回合）
 *   trade_log_analysis 评估记录（入场评估 / 持仓中再评估）→ 外键 log_id
 *   trade_log_review   平仓复盘 → 外键 log_id
 *
 * 状态：
 *   analyzing 仅评估、尚无真实成交（计划阶段）
 *   open      交易所有持仓（已开仓未平）
 *   closed    回合已平仓
 *   dismissed 放弃（仅评估未成交）
 *
 * 去重/联动：log 存回合的 first_trade_id + last_trade_id，
 *   同步时按 last_trade_id 精确去重（UNIQUE 约束兜底），杜绝重复入库。
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

export type TradeDirection = 'LONG' | 'SHORT';
export type TradeLogStatus = 'analyzing' | 'open' | 'closed' | 'dismissed';

export interface TradeLog {
  id?: number;
  symbol: string;
  direction: TradeDirection;
  status: TradeLogStatus;
  // ---- 计划（评估时填，可空）----
  entry_reason?: string;
  planned_entry_price?: number;
  planned_stop_loss?: number;
  planned_take_profit?: number;
  // ---- 真实成交（来自币安回合，可空）----
  entry_price?: number;        // 开仓加权均价
  exit_price?: number;         // 平仓加权均价
  qty?: number;                // 开仓总数量
  leverage?: number;
  realized_pnl?: number;       // 已实现盈亏净值（已扣手续费）
  pnl_pct?: number;            // 价格变动%（不含杠杆）
  // ---- 回合区间（联回 binance_trades + 去重）----
  first_trade_id?: number;
  last_trade_id?: number;
  opened_at?: Date;
  closed_at?: Date;
  synced_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

/** 再评估时对入场风险点的逐条复核 */
export interface RiskReviewItem {
  risk: string;
  status: 'materialized' | 'cleared' | 'pending';
  note: string;
}

export interface TradeLogAnalysis {
  id?: number;
  log_id: number;
  analysis_type: 'entry' | 'reassess';
  market_snapshot: object;
  ai_analysis: string;
  risk_points: string[];
  opportunities: string[];
  overall_assessment: string;
  confidence_score?: number;
  action?: 'enter' | 'wait' | 'skip' | null;
  entry_zone_low?: number | null;
  entry_zone_high?: number | null;
  invalidation_price?: number | null;
  target_1?: number | null;
  target_2?: number | null;
  rr_ratio?: number | null;
  risk_review?: RiskReviewItem[] | null;
  created_at?: Date;
}

export interface TradeLogReview {
  id?: number;
  log_id: number;
  exit_reason: string;
  ai_review: string;
  what_went_well: string[];
  what_went_wrong: string[];
  lessons: string[];
  created_at?: Date;
}

export class TradeLogRepository extends BaseRepository {

  // ==================== 建表 ====================

  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS trade_log (
        id INT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL,
        direction ENUM('LONG','SHORT') NOT NULL,
        status ENUM('analyzing','open','closed','dismissed') NOT NULL DEFAULT 'analyzing',
        entry_reason TEXT NULL,
        planned_entry_price DECIMAL(20,8) NULL,
        planned_stop_loss DECIMAL(20,8) NULL,
        planned_take_profit DECIMAL(20,8) NULL,
        entry_price DECIMAL(20,8) NULL,
        exit_price DECIMAL(20,8) NULL,
        qty DECIMAL(30,8) NULL,
        leverage INT NULL,
        realized_pnl DECIMAL(20,8) NULL,
        pnl_pct DECIMAL(10,4) NULL,
        first_trade_id BIGINT NULL,
        last_trade_id BIGINT NULL,
        opened_at TIMESTAMP NULL,
        closed_at TIMESTAMP NULL,
        synced_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_last_trade (last_trade_id),
        INDEX idx_symbol (symbol),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_log');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS trade_log_analysis (
        id INT PRIMARY KEY AUTO_INCREMENT,
        log_id INT NOT NULL,
        analysis_type ENUM('entry','reassess') NOT NULL DEFAULT 'entry',
        market_snapshot JSON NOT NULL,
        ai_analysis TEXT NOT NULL,
        risk_points JSON NOT NULL,
        opportunities JSON NOT NULL,
        overall_assessment TEXT NOT NULL,
        confidence_score INT NULL,
        action VARCHAR(10) NULL,
        entry_zone_low DECIMAL(20,8) NULL,
        entry_zone_high DECIMAL(20,8) NULL,
        invalidation_price DECIMAL(20,8) NULL,
        target_1 DECIMAL(20,8) NULL,
        target_2 DECIMAL(20,8) NULL,
        rr_ratio DECIMAL(10,4) NULL,
        risk_review JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_log_id (log_id),
        FOREIGN KEY (log_id) REFERENCES trade_log(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_log_analysis');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS trade_log_review (
        id INT PRIMARY KEY AUTO_INCREMENT,
        log_id INT NOT NULL,
        exit_reason TEXT NOT NULL,
        ai_review TEXT NOT NULL,
        what_went_well JSON NOT NULL,
        what_went_wrong JSON NOT NULL,
        lessons JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_log_id (log_id),
        FOREIGN KEY (log_id) REFERENCES trade_log(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_log_review');
  }

  // ==================== trade_log ====================

  /** 评估阶段创建记录（尚无真实成交），状态 analyzing */
  async create_analyzing(data: {
    symbol: string;
    direction: TradeDirection;
    entry_reason: string;
    planned_entry_price?: number;
    planned_stop_loss?: number;
    planned_take_profit?: number;
  }): Promise<number> {
    const sql = `
      INSERT INTO trade_log
        (symbol, direction, status, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit)
      VALUES (?, ?, 'analyzing', ?, ?, ?, ?)
    `;
    const id = await this.insert_and_get_id(sql, [
      data.symbol, data.direction, data.entry_reason,
      data.planned_entry_price ?? null, data.planned_stop_loss ?? null, data.planned_take_profit ?? null,
    ]);
    logger.info(`[TradeLog] Created analyzing log #${id} for ${data.symbol} ${data.direction}`);
    return id;
  }

  /**
   * 同步用：按币种+方向找一条仍可回填的记录（analyzing 或 open），优先 open。
   * 同币种同方向同一时间只一笔，取最新一条。
   */
  async find_open_or_analyzing(symbol: string, direction: TradeDirection): Promise<TradeLog | null> {
    const rows = await this.execute_query(
      `SELECT * FROM trade_log
       WHERE symbol = ? AND direction = ? AND status IN ('analyzing','open')
       ORDER BY FIELD(status,'open','analyzing'), created_at DESC
       LIMIT 1`,
      [symbol, direction]
    );
    return rows[0] ? this.map_log(rows[0]) : null;
  }

  /** 去重用：按回合末笔 trade_id 查是否已入库（last_trade_id 唯一） */
  async find_by_last_trade_id(last_trade_id: number): Promise<TradeLog | null> {
    const rows = await this.execute_query(
      `SELECT * FROM trade_log WHERE last_trade_id = ? LIMIT 1`, [last_trade_id]
    );
    return rows[0] ? this.map_log(rows[0]) : null;
  }

  /** 回填未闭合回合的真实持仓数据，analyzing → open（已 open 则刷新，不重置 opened_at） */
  async apply_open_round(id: number, data: {
    entry_price: number; qty: number; leverage?: number; first_trade_id: number; opened_at: Date;
  }): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_log
       SET entry_price = ?, qty = ?, leverage = ?, first_trade_id = ?,
           status = 'open', opened_at = COALESCE(opened_at, ?), synced_at = NOW()
       WHERE id = ? AND status IN ('analyzing','open')`,
      [data.entry_price, data.qty, data.leverage ?? null, data.first_trade_id, data.opened_at, id]
    );
    logger.info(`[TradeLog] Applied open round to log #${id}`);
  }

  /** 回填已闭合回合的真实平仓数据，→ closed */
  async apply_closed_round(id: number, data: {
    entry_price: number; exit_price: number; qty: number; leverage?: number;
    realized_pnl: number; pnl_pct: number; first_trade_id: number; last_trade_id: number;
    opened_at: Date; closed_at: Date;
  }): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_log
       SET entry_price = ?, exit_price = ?, qty = ?, leverage = ?,
           realized_pnl = ?, pnl_pct = ?, first_trade_id = ?, last_trade_id = ?,
           status = 'closed', opened_at = COALESCE(opened_at, ?), closed_at = ?, synced_at = NOW()
       WHERE id = ?`,
      [data.entry_price, data.exit_price, data.qty, data.leverage ?? null,
       data.realized_pnl, data.pnl_pct, data.first_trade_id, data.last_trade_id,
       data.opened_at, data.closed_at, id]
    );
    logger.info(`[TradeLog] Applied closed round to log #${id}`);
  }

  /** 同步用：未评估的完整回合（开了又平，从无记录）直接建 closed 记录 */
  async create_closed_round(data: {
    symbol: string; direction: TradeDirection; entry_reason: string;
    entry_price: number; exit_price: number; qty: number; leverage?: number;
    realized_pnl: number; pnl_pct: number; first_trade_id: number; last_trade_id: number;
    opened_at: Date; closed_at: Date;
  }): Promise<number> {
    const sql = `
      INSERT INTO trade_log
        (symbol, direction, status, entry_reason,
         entry_price, exit_price, qty, leverage, realized_pnl, pnl_pct,
         first_trade_id, last_trade_id, opened_at, closed_at, synced_at)
      VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    const id = await this.insert_and_get_id(sql, [
      data.symbol, data.direction, data.entry_reason,
      data.entry_price, data.exit_price, data.qty, data.leverage ?? null,
      data.realized_pnl, data.pnl_pct, data.first_trade_id, data.last_trade_id, data.opened_at, data.closed_at,
    ]);
    logger.info(`[TradeLog] Created closed log #${id} for ${data.symbol} ${data.direction} (synced round)`);
    return id;
  }

  /** 同步用：未评估的未闭合回合（当前持仓，从无记录）直接建 open 记录 */
  async create_open_round(data: {
    symbol: string; direction: TradeDirection; entry_reason: string;
    entry_price: number; qty: number; leverage?: number; first_trade_id: number; opened_at: Date;
  }): Promise<number> {
    const sql = `
      INSERT INTO trade_log
        (symbol, direction, status, entry_reason, entry_price, qty, leverage, first_trade_id, opened_at, synced_at)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, NOW())
    `;
    const id = await this.insert_and_get_id(sql, [
      data.symbol, data.direction, data.entry_reason,
      data.entry_price, data.qty, data.leverage ?? null, data.first_trade_id, data.opened_at,
    ]);
    logger.info(`[TradeLog] Created open log #${id} for ${data.symbol} ${data.direction} (synced round)`);
    return id;
  }

  /** 放弃评估：analyzing → dismissed */
  async mark_dismissed(id: number): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_log SET status = 'dismissed' WHERE id = ? AND status = 'analyzing'`, [id]
    );
  }

  async find_by_id(id: number): Promise<TradeLog | null> {
    const rows = await this.execute_query('SELECT * FROM trade_log WHERE id = ?', [id]);
    return rows[0] ? this.map_log(rows[0]) : null;
  }

  /** 所有未结束记录（analyzing/open），用于同步时检测平仓 */
  async find_all_active(): Promise<TradeLog[]> {
    const rows = await this.execute_query(
      `SELECT * FROM trade_log WHERE status IN ('analyzing','open') ORDER BY created_at ASC`
    );
    return rows.map(r => this.map_log(r));
  }

  /** 列表查询，附带最新入场评估摘要（有评估才有，无则为 null） */
  async find_list(status?: TradeLogStatus, limit = 20, offset = 0): Promise<any[]> {
    const where = status ? `WHERE r.status = ?` : '';
    const params: any[] = status ? [status] : [];
    const sql = `
      SELECT r.*, a.overall_assessment, a.confidence_score
      FROM trade_log r
      LEFT JOIN trade_log_analysis a ON a.id = (
        SELECT id FROM trade_log_analysis
        WHERE log_id = r.id AND analysis_type = 'entry'
        ORDER BY created_at DESC LIMIT 1
      )
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;
    const rows = await this.execute_query(sql, params);
    return rows.map(r => ({ ...this.map_log(r), overall_assessment: r.overall_assessment, confidence_score: r.confidence_score }));
  }

  /** 已平仓盈亏统计（基于真实 realized_pnl） */
  async get_stats(): Promise<{ total: number; win: number; loss: number; win_rate: number; total_pnl: number }> {
    const rows = await this.execute_query(`
      SELECT COUNT(*) AS total, SUM(realized_pnl > 0) AS win, SUM(realized_pnl <= 0) AS loss,
             COALESCE(SUM(realized_pnl), 0) AS total_pnl
      FROM trade_log WHERE status = 'closed'
    `);
    const r = rows[0];
    const total = Number(r.total);
    const win = Number(r.win);
    return {
      total, win, loss: Number(r.loss),
      win_rate: total > 0 ? Math.round((win / total) * 100) : 0,
      total_pnl: Number(r.total_pnl),
    };
  }

  /** 置信度校准：按 confidence 分桶统计已平仓的真实胜率/平均盈亏 */
  async get_confidence_calibration(): Promise<Array<{ bucket: string; samples: number; win_rate: number | null; avg_pnl: number | null }>> {
    const sql = `
      SELECT
        CASE WHEN a.confidence_score >= 80 THEN '80+'
             WHEN a.confidence_score >= 60 THEN '60-79'
             WHEN a.confidence_score >= 40 THEN '40-59'
             ELSE '<40' END AS bucket,
        COUNT(*) AS samples,
        ROUND(SUM(r.realized_pnl > 0) / COUNT(*) * 100, 1) AS win_rate,
        ROUND(AVG(r.realized_pnl), 4) AS avg_pnl
      FROM trade_log r
      JOIN trade_log_analysis a ON a.id = (
        SELECT id FROM trade_log_analysis
        WHERE log_id = r.id AND analysis_type = 'entry'
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE r.status = 'closed' AND a.confidence_score IS NOT NULL
      GROUP BY bucket
      ORDER BY MIN(a.confidence_score) DESC
    `;
    const rows = await this.execute_query(sql);
    return rows.map(r => ({
      bucket: r.bucket,
      samples: Number(r.samples),
      win_rate: r.win_rate != null ? Number(r.win_rate) : null,
      avg_pnl: r.avg_pnl != null ? Number(r.avg_pnl) : null,
    }));
  }

  // ==================== trade_log_analysis ====================

  async save_analysis(data: Omit<TradeLogAnalysis, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO trade_log_analysis
        (log_id, analysis_type, market_snapshot, ai_analysis, risk_points, opportunities, overall_assessment, confidence_score,
         action, entry_zone_low, entry_zone_high, invalidation_price, target_1, target_2, rr_ratio, risk_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    return this.insert_and_get_id(sql, [
      data.log_id, data.analysis_type, JSON.stringify(data.market_snapshot), data.ai_analysis,
      JSON.stringify(data.risk_points), JSON.stringify(data.opportunities), data.overall_assessment,
      data.confidence_score ?? null,
      data.action ?? null, data.entry_zone_low ?? null, data.entry_zone_high ?? null,
      data.invalidation_price ?? null, data.target_1 ?? null, data.target_2 ?? null, data.rr_ratio ?? null,
      data.risk_review ? JSON.stringify(data.risk_review) : null,
    ]);
  }

  async find_analyses_by_log(log_id: number): Promise<TradeLogAnalysis[]> {
    const rows = await this.execute_query(
      'SELECT * FROM trade_log_analysis WHERE log_id = ? ORDER BY created_at ASC', [log_id]
    );
    return rows.map(r => ({
      ...r,
      market_snapshot: typeof r.market_snapshot === 'string' ? JSON.parse(r.market_snapshot) : r.market_snapshot,
      risk_points: typeof r.risk_points === 'string' ? JSON.parse(r.risk_points) : r.risk_points,
      opportunities: typeof r.opportunities === 'string' ? JSON.parse(r.opportunities) : r.opportunities,
      risk_review: r.risk_review == null ? null : (typeof r.risk_review === 'string' ? JSON.parse(r.risk_review) : r.risk_review),
    }));
  }

  // ==================== trade_log_review ====================

  async save_review(data: Omit<TradeLogReview, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO trade_log_review (log_id, exit_reason, ai_review, what_went_well, what_went_wrong, lessons)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    return this.insert_and_get_id(sql, [
      data.log_id, data.exit_reason, data.ai_review,
      JSON.stringify(data.what_went_well), JSON.stringify(data.what_went_wrong), JSON.stringify(data.lessons),
    ]);
  }

  async find_review_by_log(log_id: number): Promise<TradeLogReview | null> {
    const rows = await this.execute_query('SELECT * FROM trade_log_review WHERE log_id = ?', [log_id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      ...r,
      what_went_well: typeof r.what_went_well === 'string' ? JSON.parse(r.what_went_well) : r.what_went_well,
      what_went_wrong: typeof r.what_went_wrong === 'string' ? JSON.parse(r.what_went_wrong) : r.what_went_wrong,
      lessons: typeof r.lessons === 'string' ? JSON.parse(r.lessons) : r.lessons,
    };
  }

  async has_review(log_id: number): Promise<boolean> {
    const rows = await this.execute_query('SELECT id FROM trade_log_review WHERE log_id = ? LIMIT 1', [log_id]);
    return rows.length > 0;
  }

  /** 取最近 N 条复盘的 lessons + what_went_wrong，聚合历史错误清单 */
  async get_recent_lessons(limit = 20): Promise<Array<{ lessons: string[]; what_went_wrong: string[] }>> {
    const rows = await this.execute_query(
      `SELECT lessons, what_went_wrong FROM trade_log_review ORDER BY created_at DESC LIMIT ${Number(limit)}`
    );
    return rows.map(r => ({
      lessons: typeof r.lessons === 'string' ? JSON.parse(r.lessons) : (r.lessons ?? []),
      what_went_wrong: typeof r.what_went_wrong === 'string' ? JSON.parse(r.what_went_wrong) : (r.what_went_wrong ?? []),
    }));
  }

  /** 行映射：DECIMAL/数值字段统一转 number */
  private map_log(r: any): TradeLog {
    const num = (v: any) => v == null ? undefined : Number(v);
    return {
      id: r.id, symbol: r.symbol, direction: r.direction, status: r.status,
      entry_reason: r.entry_reason ?? undefined,
      planned_entry_price: num(r.planned_entry_price),
      planned_stop_loss: num(r.planned_stop_loss),
      planned_take_profit: num(r.planned_take_profit),
      entry_price: num(r.entry_price), exit_price: num(r.exit_price), qty: num(r.qty),
      leverage: num(r.leverage), realized_pnl: num(r.realized_pnl), pnl_pct: num(r.pnl_pct),
      first_trade_id: num(r.first_trade_id), last_trade_id: num(r.last_trade_id),
      opened_at: r.opened_at, closed_at: r.closed_at, synced_at: r.synced_at,
      created_at: r.created_at, updated_at: r.updated_at,
    };
  }
}
