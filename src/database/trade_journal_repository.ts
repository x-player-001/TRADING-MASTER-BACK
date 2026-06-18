/**
 * 交易日志数据存储层
 * 包含三张表：trade_journal（主记录）、trade_analysis（评估记录）、trade_review（复盘总结）
 *
 * 状态流转：
 *   analyzing → open       （确认开仓）
 *   analyzing → dismissed  （放弃开仓）
 *   analyzing → failed     （AI 分析失败，前端可停止轮询并重试）
 *   open      → closed     （手动平仓）
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

// ==================== 类型定义 ====================

export type TradeDirection = 'LONG' | 'SHORT';
export type TradeStatus = 'analyzing' | 'open' | 'dismissed' | 'closed' | 'failed';

export interface TradeJournal {
  id?: number;
  symbol: string;
  direction: TradeDirection;
  entry_reason: string;
  planned_entry_price?: number;
  planned_stop_loss?: number;
  planned_take_profit?: number;
  actual_exit_price?: number;
  pnl_pct?: number;
  status: TradeStatus;
  // ---- 从交易所同步的真实成交数据（与 planned_* 并存，复盘时可对比计划 vs 真实）----
  actual_entry_price?: number;   // 真实入场均价（来自交易所持仓/成交）
  actual_qty?: number;           // 真实持仓数量
  leverage?: number;             // 杠杆倍数
  realized_pnl?: number;         // 真实已实现盈亏（USDT，平仓后由交易所提供，已扣手续费）
  synced_at?: Date;              // 最近一次从交易所同步的时间
  opened_at?: Date;
  closed_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

/** 再评估时对入场风险点的逐条复核 */
export interface RiskReviewItem {
  risk: string;
  status: 'materialized' | 'cleared' | 'pending';
  note: string;
}

export interface TradeAnalysis {
  id?: number;
  journal_id: number;
  analysis_type: 'entry' | 'reassess';  // 入场评估 or 持仓中再评估
  market_snapshot: object;
  claude_analysis: string;
  risk_points: string[];
  opportunities: string[];
  overall_assessment: string;
  confidence_score?: number;
  // ---- 入场评估的可执行清单字段（entry 类型才有，旧记录为 null）----
  action?: 'enter' | 'wait' | 'skip' | null;   // 明确动作
  entry_zone_low?: number | null;              // 入场区间下沿
  entry_zone_high?: number | null;             // 入场区间上沿
  invalidation_price?: number | null;          // 失效价（证伪价）
  target_1?: number | null;                    // 目标1
  target_2?: number | null;                    // 目标2
  rr_ratio?: number | null;                    // 盈亏比
  // ---- 再评估的入场风险点复核（reassess 类型才有）----
  risk_review?: RiskReviewItem[] | null;
  created_at?: Date;
}

export interface TradeReview {
  id?: number;
  journal_id: number;
  exit_reason: string;
  claude_review: string;
  what_went_well: string[];
  what_went_wrong: string[];
  lessons: string[];
  created_at?: Date;
}

// ==================== Repository ====================

export class TradeJournalRepository extends BaseRepository {

  /**
   * 初始化建表
   */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS trade_journal (
        id INT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL,
        direction ENUM('LONG','SHORT') NOT NULL,
        entry_reason TEXT NOT NULL,
        planned_entry_price DECIMAL(20,8) NULL,
        planned_stop_loss DECIMAL(20,8) NULL,
        planned_take_profit DECIMAL(20,8) NULL,
        actual_exit_price DECIMAL(20,8) NULL,
        pnl_pct DECIMAL(10,4) NULL,
        status ENUM('analyzing','open','dismissed','closed','failed') NOT NULL DEFAULT 'analyzing',
        actual_entry_price DECIMAL(20,8) NULL,
        actual_qty DECIMAL(30,8) NULL,
        leverage INT NULL,
        realized_pnl DECIMAL(20,8) NULL,
        synced_at TIMESTAMP NULL,
        opened_at TIMESTAMP NULL,
        closed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_symbol (symbol),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_journal');

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS trade_analysis (
        id INT PRIMARY KEY AUTO_INCREMENT,
        journal_id INT NOT NULL,
        analysis_type ENUM('entry','reassess') NOT NULL DEFAULT 'entry',
        market_snapshot JSON NOT NULL,
        claude_analysis TEXT NOT NULL,
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
        INDEX idx_journal_id (journal_id),
        FOREIGN KEY (journal_id) REFERENCES trade_journal(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_analysis');

    // 兼容旧表：补齐入场清单字段与风险复核字段（已存在则忽略）
    await this.ensure_analysis_columns();

    // 兼容旧表：补齐 trade_journal 的真实成交字段
    await this.ensure_journal_columns();

    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS trade_review (
        id INT PRIMARY KEY AUTO_INCREMENT,
        journal_id INT NOT NULL,
        exit_reason TEXT NOT NULL,
        claude_review TEXT NOT NULL,
        what_went_well JSON NOT NULL,
        what_went_wrong JSON NOT NULL,
        lessons JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_journal_id (journal_id),
        FOREIGN KEY (journal_id) REFERENCES trade_journal(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_review');
  }

  /**
   * 给已存在的表补齐新增列/枚举值（幂等）。
   * 先查 information_schema 确认列是否已存在，缺了才 ADD —— 避免「试错+吞异常」
   * 每次重启都刷一条 ER_DUP_FIELDNAME 错误日志，也兼容 MySQL 8.0（不支持 ADD COLUMN IF NOT EXISTS）。
   */
  private async ensure_analysis_columns(): Promise<void> {
    // 已存在的列集合
    const existing = new Set(
      (await this.execute_query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trade_analysis'`
      )).map((r: any) => r.COLUMN_NAME)
    );

    const columns: Record<string, string> = {
      action:             'VARCHAR(10) NULL',
      entry_zone_low:     'DECIMAL(20,8) NULL',
      entry_zone_high:    'DECIMAL(20,8) NULL',
      invalidation_price: 'DECIMAL(20,8) NULL',
      target_1:           'DECIMAL(20,8) NULL',
      target_2:           'DECIMAL(20,8) NULL',
      rr_ratio:           'DECIMAL(10,4) NULL',
      risk_review:        'JSON NULL',
    };

    for (const [name, def] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      try {
        await this.execute_query(`ALTER TABLE trade_analysis ADD COLUMN ${name} ${def}`);
      } catch (err: any) {
        logger.warn(`[TradeJournal] ensure_analysis_columns ${name}: ${err.message}`);
      }
    }

    // status 枚举补上 'failed'：只在尚未包含时 MODIFY，避免重复 DDL
    const status_col = await this.execute_query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trade_journal' AND COLUMN_NAME = 'status'`
    );
    const status_type: string = status_col[0]?.COLUMN_TYPE ?? '';
    if (!status_type.includes("'failed'")) {
      try {
        await this.execute_query(
          `ALTER TABLE trade_journal MODIFY COLUMN status ENUM('analyzing','open','dismissed','closed','failed') NOT NULL DEFAULT 'analyzing'`
        );
      } catch (err: any) {
        logger.warn(`[TradeJournal] ensure status enum: ${err.message}`);
      }
    }
  }

  /**
   * 给已存在的 trade_journal 表补齐真实成交字段（幂等）。
   * 同 ensure_analysis_columns：先查 information_schema，缺了才 ADD。
   */
  private async ensure_journal_columns(): Promise<void> {
    const existing = new Set(
      (await this.execute_query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trade_journal'`
      )).map((r: any) => r.COLUMN_NAME)
    );

    const columns: Record<string, string> = {
      actual_entry_price: 'DECIMAL(20,8) NULL',
      actual_qty:         'DECIMAL(30,8) NULL',
      leverage:           'INT NULL',
      realized_pnl:       'DECIMAL(20,8) NULL',
      synced_at:          'TIMESTAMP NULL',
    };

    for (const [name, def] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      try {
        await this.execute_query(`ALTER TABLE trade_journal ADD COLUMN ${name} ${def}`);
      } catch (err: any) {
        logger.warn(`[TradeJournal] ensure_journal_columns ${name}: ${err.message}`);
      }
    }
  }

  // ==================== trade_journal ====================

  /**
   * 创建交易记录，初始状态 analyzing
   */
  async create_journal(data: Omit<TradeJournal, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const sql = `
      INSERT INTO trade_journal
        (symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const id = await this.insert_and_get_id(sql, [
      data.symbol,
      data.direction,
      data.entry_reason,
      data.planned_entry_price ?? null,
      data.planned_stop_loss ?? null,
      data.planned_take_profit ?? null,
      'analyzing',
    ]);
    logger.info(`[TradeJournal] Created journal #${id} for ${data.symbol} ${data.direction}`);
    return id;
  }

  /**
   * 确认开仓：analyzing → open
   */
  async mark_open(id: number): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_journal SET status = 'open', opened_at = NOW() WHERE id = ? AND status = 'analyzing'`,
      [id]
    );
    logger.info(`[TradeJournal] Marked journal #${id} as open`);
  }

  /**
   * 放弃开仓：analyzing → dismissed
   */
  async mark_dismissed(id: number): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_journal SET status = 'dismissed' WHERE id = ? AND status = 'analyzing'`,
      [id]
    );
    logger.info(`[TradeJournal] Dismissed journal #${id}`);
  }

  /**
   * AI 分析失败：analyzing → failed（前端轮询到 failed 即可停止等待并提示重试）
   */
  async mark_failed(id: number): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_journal SET status = 'failed' WHERE id = ? AND status = 'analyzing'`,
      [id]
    );
    logger.warn(`[TradeJournal] Marked journal #${id} as failed`);
  }

  /**
   * 平仓：open → closed
   */
  async mark_closed(id: number, actual_exit_price: number, pnl_pct: number): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_journal SET actual_exit_price = ?, pnl_pct = ?, status = 'closed', closed_at = NOW() WHERE id = ? AND status = 'open'`,
      [actual_exit_price, pnl_pct, id]
    );
    logger.info(`[TradeJournal] Closed journal #${id}, pnl_pct=${pnl_pct.toFixed(2)}%`);
  }

  /**
   * 全局同步用：按币种+方向找一条仍待回填真实成交的 journal（analyzing 或 open）。
   * 优先 open，其次 analyzing；同币种同方向同一时间只一笔，所以取最新一条即可。
   */
  async find_open_or_analyzing_by_symbol_direction(
    symbol: string,
    direction: TradeDirection
  ): Promise<TradeJournal | null> {
    const rows = await this.execute_query(
      `SELECT * FROM trade_journal
       WHERE symbol = ? AND direction = ? AND status IN ('analyzing','open')
       ORDER BY FIELD(status,'open','analyzing'), created_at DESC
       LIMIT 1`,
      [symbol, direction]
    );
    return rows[0] ?? null;
  }

  /**
   * 全局同步用：取所有未结束（analyzing/open）的 journal，用于检测交易所侧已平仓的记录。
   */
  async find_all_active(): Promise<TradeJournal[]> {
    return this.execute_query(
      `SELECT * FROM trade_journal WHERE status IN ('analyzing','open') ORDER BY created_at ASC`
    );
  }

  /**
   * 同步用：未在系统内评估过的真实持仓，直接建一条 open 记录。
   */
  async create_synced_journal(data: {
    symbol: string;
    direction: TradeDirection;
    entry_reason: string;
    actual_entry_price: number;
    actual_qty: number;
    leverage?: number;
  }): Promise<number> {
    const sql = `
      INSERT INTO trade_journal
        (symbol, direction, entry_reason, planned_entry_price,
         actual_entry_price, actual_qty, leverage, status, opened_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NOW(), NOW())
    `;
    const id = await this.insert_and_get_id(sql, [
      data.symbol,
      data.direction,
      data.entry_reason,
      data.actual_entry_price,   // 无计划价时用真实入场价兜底，保证盈亏可算
      data.actual_entry_price,
      data.actual_qty,
      data.leverage ?? null,
    ]);
    logger.info(`[TradeJournal] Created synced journal #${id} for ${data.symbol} ${data.direction} (no prior analysis)`);
    return id;
  }

  /**
   * 同步用：把交易所真实持仓回填到现有 journal，并推进 analyzing → open。
   * 已是 open 的记录也会刷新真实数据（不重置 opened_at）。
   */
  async apply_real_position(id: number, data: {
    actual_entry_price: number;
    actual_qty: number;
    leverage?: number;
  }): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_journal
       SET actual_entry_price = ?, actual_qty = ?, leverage = ?,
           status = 'open',
           opened_at = COALESCE(opened_at, NOW()),
           synced_at = NOW()
       WHERE id = ? AND status IN ('analyzing','open')`,
      [data.actual_entry_price, data.actual_qty, data.leverage ?? null, id]
    );
    logger.info(`[TradeJournal] Applied real position to journal #${id}`);
  }

  /**
   * 同步用：把交易所真实平仓数据回填，open → closed。
   * realized_pnl 来自交易所（已扣手续费）；pnl_pct 仍按真实入出场价记录价格变动%。
   */
  async apply_real_close(id: number, data: {
    actual_exit_price: number;
    realized_pnl: number;
    pnl_pct: number;
  }): Promise<void> {
    await this.update_and_get_affected_rows(
      `UPDATE trade_journal
       SET actual_exit_price = ?, realized_pnl = ?, pnl_pct = ?,
           status = 'closed', closed_at = NOW(), synced_at = NOW()
       WHERE id = ? AND status = 'open'`,
      [data.actual_exit_price, data.realized_pnl, data.pnl_pct, id]
    );
    logger.info(`[TradeJournal] Applied real close to journal #${id}, realized_pnl=${data.realized_pnl}`);
  }

  /**
   * 查询单条记录
   */
  async find_by_id(id: number): Promise<TradeJournal | null> {
    const rows = await this.execute_query('SELECT * FROM trade_journal WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  /**
   * 查询列表，支持状态筛选和分页
   */
  async find_list(status?: TradeStatus, limit: number = 20, offset: number = 0): Promise<TradeJournal[]> {
    if (status) {
      return this.execute_query(
        `SELECT * FROM trade_journal WHERE status = ? ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
        [status]
      );
    }
    return this.execute_query(
      `SELECT * FROM trade_journal ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      []
    );
  }

  /**
   * 查询列表并附带每条记录的最新入场评估摘要（overall_assessment、confidence_score）
   */
  async find_list_with_analysis(status?: TradeStatus, limit: number = 20, offset: number = 0): Promise<any[]> {
    const where = status ? `WHERE j.status = ?` : '';
    const params: any[] = status ? [status] : [];
    const sql = `
      SELECT
        j.*,
        a.overall_assessment,
        a.confidence_score,
        a.analysis_type
      FROM trade_journal j
      LEFT JOIN trade_analysis a ON a.id = (
        SELECT id FROM trade_analysis
        WHERE journal_id = j.id AND analysis_type = 'entry'
        ORDER BY created_at DESC LIMIT 1
      )
      ${where}
      ORDER BY j.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;
    return this.execute_query(sql, params);
  }

  /**
   * 统计已平仓交易的盈亏摘要
   */
  async get_stats(): Promise<{ total: number; win: number; loss: number; win_rate: number }> {
    const rows = await this.execute_query(`
      SELECT
        COUNT(*) AS total,
        SUM(pnl_pct > 0) AS win,
        SUM(pnl_pct <= 0) AS loss
      FROM trade_journal
      WHERE status = 'closed'
    `);
    const r = rows[0];
    const total = Number(r.total);
    const win = Number(r.win);
    return {
      total,
      win,
      loss: Number(r.loss),
      win_rate: total > 0 ? Math.round((win / total) * 100) : 0,
    };
  }

  /**
   * 置信度校准：按 confidence 分桶统计已平仓交易的实际胜率/平均盈亏
   * 用入场评估的 confidence_score 关联其平仓结果，验证「高置信度是否真的更赚」
   */
  async get_confidence_calibration(): Promise<Array<{
    bucket: string; samples: number; win_rate: number | null; avg_pnl_pct: number | null;
  }>> {
    const sql = `
      SELECT
        CASE
          WHEN a.confidence_score >= 80 THEN '80+'
          WHEN a.confidence_score >= 60 THEN '60-79'
          WHEN a.confidence_score >= 40 THEN '40-59'
          ELSE '<40'
        END AS bucket,
        COUNT(*) AS samples,
        ROUND(SUM(j.pnl_pct > 0) / COUNT(*) * 100, 1) AS win_rate,
        ROUND(AVG(j.pnl_pct), 2) AS avg_pnl_pct
      FROM trade_journal j
      JOIN trade_analysis a ON a.id = (
        SELECT id FROM trade_analysis
        WHERE journal_id = j.id AND analysis_type = 'entry'
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE j.status = 'closed' AND a.confidence_score IS NOT NULL
      GROUP BY bucket
      ORDER BY MIN(a.confidence_score) DESC
    `;
    const rows = await this.execute_query(sql);
    return rows.map(r => ({
      bucket: r.bucket,
      samples: Number(r.samples),
      win_rate: r.win_rate != null ? Number(r.win_rate) : null,
      avg_pnl_pct: r.avg_pnl_pct != null ? Number(r.avg_pnl_pct) : null,
    }));
  }

  // ==================== trade_analysis ====================

  /**
   * 保存评估结果（入场评估或持仓中再评估）
   */
  async save_analysis(data: Omit<TradeAnalysis, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO trade_analysis
        (journal_id, analysis_type, market_snapshot, claude_analysis, risk_points, opportunities, overall_assessment, confidence_score,
         action, entry_zone_low, entry_zone_high, invalidation_price, target_1, target_2, rr_ratio, risk_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    return this.insert_and_get_id(sql, [
      data.journal_id,
      data.analysis_type,
      JSON.stringify(data.market_snapshot),
      data.claude_analysis,
      JSON.stringify(data.risk_points),
      JSON.stringify(data.opportunities),
      data.overall_assessment,
      data.confidence_score ?? null,
      data.action ?? null,
      data.entry_zone_low ?? null,
      data.entry_zone_high ?? null,
      data.invalidation_price ?? null,
      data.target_1 ?? null,
      data.target_2 ?? null,
      data.rr_ratio ?? null,
      data.risk_review ? JSON.stringify(data.risk_review) : null,
    ]);
  }

  /**
   * 查询某笔交易的所有评估记录（按时间升序，保留历史）
   */
  async find_analyses_by_journal(journal_id: number): Promise<TradeAnalysis[]> {
    const rows = await this.execute_query(
      'SELECT * FROM trade_analysis WHERE journal_id = ? ORDER BY created_at ASC',
      [journal_id]
    );
    return rows.map(r => ({
      ...r,
      market_snapshot: typeof r.market_snapshot === 'string' ? JSON.parse(r.market_snapshot) : r.market_snapshot,
      risk_points: typeof r.risk_points === 'string' ? JSON.parse(r.risk_points) : r.risk_points,
      opportunities: typeof r.opportunities === 'string' ? JSON.parse(r.opportunities) : r.opportunities,
      risk_review: r.risk_review == null ? null : (typeof r.risk_review === 'string' ? JSON.parse(r.risk_review) : r.risk_review),
    }));
  }

  // ==================== trade_review ====================

  /**
   * 保存平仓复盘
   */
  async save_review(data: Omit<TradeReview, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO trade_review
        (journal_id, exit_reason, claude_review, what_went_well, what_went_wrong, lessons)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const id = await this.insert_and_get_id(sql, [
      data.journal_id,
      data.exit_reason,
      data.claude_review,
      JSON.stringify(data.what_went_well),
      JSON.stringify(data.what_went_wrong),
      JSON.stringify(data.lessons),
    ]);
    logger.info(`[TradeJournal] Saved review for journal #${data.journal_id}`);
    return id;
  }

  /**
   * 取最近 N 条复盘的 lessons 和 what_went_wrong，用于聚合「历史错误清单」
   */
  async get_recent_lessons(limit: number = 20): Promise<Array<{ lessons: string[]; what_went_wrong: string[] }>> {
    const rows = await this.execute_query(
      `SELECT lessons, what_went_wrong FROM trade_review ORDER BY created_at DESC LIMIT ${Number(limit)}`,
      []
    );
    return rows.map(r => ({
      lessons: typeof r.lessons === 'string' ? JSON.parse(r.lessons) : (r.lessons ?? []),
      what_went_wrong: typeof r.what_went_wrong === 'string' ? JSON.parse(r.what_went_wrong) : (r.what_went_wrong ?? []),
    }));
  }

  /**
   * 查询某笔交易的复盘
   */
  async find_review_by_journal(journal_id: number): Promise<TradeReview | null> {
    const rows = await this.execute_query(
      'SELECT * FROM trade_review WHERE journal_id = ?',
      [journal_id]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      ...r,
      what_went_well: typeof r.what_went_well === 'string' ? JSON.parse(r.what_went_well) : r.what_went_well,
      what_went_wrong: typeof r.what_went_wrong === 'string' ? JSON.parse(r.what_went_wrong) : r.what_went_wrong,
      lessons: typeof r.lessons === 'string' ? JSON.parse(r.lessons) : r.lessons,
    };
  }
}
