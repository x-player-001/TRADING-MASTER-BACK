/**
 * 交易日志数据存储层
 * 包含三张表：trade_journal（主记录）、trade_analysis（评估记录）、trade_review（复盘总结）
 *
 * 状态流转：
 *   analyzing → open       （确认开仓）
 *   analyzing → dismissed  （放弃开仓）
 *   open      → closed     （手动平仓）
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

// ==================== 类型定义 ====================

export type TradeDirection = 'LONG' | 'SHORT';
export type TradeStatus = 'analyzing' | 'open' | 'dismissed' | 'closed';

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
  opened_at?: Date;
  closed_at?: Date;
  created_at?: Date;
  updated_at?: Date;
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
        status ENUM('analyzing','open','dismissed','closed') NOT NULL DEFAULT 'analyzing',
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_journal_id (journal_id),
        FOREIGN KEY (journal_id) REFERENCES trade_journal(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'trade_analysis');

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

  // ==================== trade_analysis ====================

  /**
   * 保存评估结果（入场评估或持仓中再评估）
   */
  async save_analysis(data: Omit<TradeAnalysis, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO trade_analysis
        (journal_id, analysis_type, market_snapshot, claude_analysis, risk_points, opportunities, overall_assessment, confidence_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
