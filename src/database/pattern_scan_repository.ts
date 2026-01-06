/**
 * 形态扫描相关数据库操作
 *
 * 包含:
 * 1. 扫描任务表 (pattern_scan_tasks)
 * 2. 扫描结果表 (pattern_scan_results)
 */

import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * 形态类型
 * 五种核心形态
 */
export type PatternType =
  | 'DOUBLE_BOTTOM'      // 双底
  | 'TRIPLE_BOTTOM'      // 三底
  | 'PULLBACK'           // 上涨回调
  | 'CONSOLIDATION'      // 横盘震荡
  | 'SURGE_W_BOTTOM';    // 上涨后W底

/**
 * 扫描任务状态
 */
export type ScanTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * 扫描任务
 */
export interface PatternScanTask {
  id: string;
  status: ScanTaskStatus;
  interval_type: string;        // 扫描的K线周期
  lookback_bars: number;        // 分析的K线数量
  total_symbols: number;
  scanned_symbols: number;
  found_patterns: number;
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
  created_at?: Date;
}

/**
 * 关键价位
 */
export interface KeyLevels {
  neckline?: number;           // 颈线
  support?: number;            // 支撑位
  resistance?: number;         // 阻力位
  target?: number;             // 目标价
  stop_loss?: number;          // 止损位
  entry?: number;              // 入场价
  swing_high?: number;         // 波段高点
  swing_low?: number;          // 波段低点
  mid?: number;                // 区间中线
  target_up?: number;          // 向上突破目标
  target_down?: number;        // 向下突破目标
  has_fake_breakdown?: boolean; // 是否有假突破
  bars_between?: number;       // 两底间隔K线数
  low1_price?: number;         // 第一个底价格
  low2_price?: number;         // 第二个底价格
  // 上涨后W底形态专用
  surge_start?: number;        // 起涨点价格
  surge_high?: number;         // 上涨高点价格
  surge_pct?: number;          // 上涨幅度 (%)
  distance_to_bottom_pct?: number;   // 当前价格距底部距离 (%)
  distance_to_neckline_pct?: number; // 当前价格距颈线距离 (%)
}

/**
 * 扫描结果
 */
export interface PatternScanResult {
  id?: number;
  task_id: string;
  symbol: string;
  pattern_type: PatternType;
  score: number;                // 形态评分 0-100
  description: string;
  key_levels: KeyLevels;
  kline_interval: string;
  detected_at: number;          // 检测时的K线时间
  created_at?: Date;
}

export class PatternScanRepository extends BaseRepository {

  /**
   * 初始化表结构
   */
  async init_tables(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      // 扫描任务表
      const create_tasks_table = `
        CREATE TABLE IF NOT EXISTS pattern_scan_tasks (
          id VARCHAR(36) PRIMARY KEY,
          status ENUM('pending', 'running', 'completed', 'failed') DEFAULT 'pending',
          interval_type VARCHAR(10) NOT NULL,
          lookback_bars INT NOT NULL,
          total_symbols INT DEFAULT 0,
          scanned_symbols INT DEFAULT 0,
          found_patterns INT DEFAULT 0,
          error_message TEXT,
          started_at TIMESTAMP NULL,
          completed_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          INDEX idx_status (status),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='形态扫描任务'
      `;

      // 扫描结果表
      const create_results_table = `
        CREATE TABLE IF NOT EXISTS pattern_scan_results (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          task_id VARCHAR(36) NOT NULL,
          symbol VARCHAR(20) NOT NULL,
          pattern_type ENUM('DOUBLE_BOTTOM', 'TRIPLE_BOTTOM', 'PULLBACK', 'CONSOLIDATION') NOT NULL,
          score INT NOT NULL,
          description TEXT,
          key_levels JSON,
          kline_interval VARCHAR(10) NOT NULL,
          detected_at BIGINT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          INDEX idx_task_id (task_id),
          INDEX idx_pattern_type (pattern_type),
          INDEX idx_score (score),
          INDEX idx_symbol (symbol),
          FOREIGN KEY (task_id) REFERENCES pattern_scan_tasks(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='形态扫描结果'
      `;

      try {
        await conn.execute(create_tasks_table);
        await conn.execute(create_results_table);

        // 迁移：更新 pattern_type ENUM 以支持新类型
        try {
          await conn.execute(`
            ALTER TABLE pattern_scan_results
            MODIFY COLUMN pattern_type ENUM('DOUBLE_BOTTOM', 'TRIPLE_BOTTOM', 'PULLBACK', 'CONSOLIDATION', 'SURGE_W_BOTTOM') NOT NULL
          `);
          logger.info('Pattern type ENUM updated to include SURGE_W_BOTTOM');
        } catch (alter_error: any) {
          // 忽略已经是正确类型的情况
          if (!alter_error.message?.includes('Duplicate')) {
            logger.debug('Pattern type ENUM migration skipped or already up to date');
          }
        }

        logger.info('Pattern scan tables initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize pattern scan tables', error);
        throw error;
      }
    });
  }

  // ==================== 扫描任务操作 ====================

  /**
   * 创建扫描任务
   */
  async create_task(interval_type: string, lookback_bars: number): Promise<string> {
    const task_id = uuidv4();

    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `INSERT INTO pattern_scan_tasks (id, status, interval_type, lookback_bars)
         VALUES (?, 'pending', ?, ?)`,
        [task_id, interval_type, lookback_bars]
      );
      return task_id;
    });
  }

  /**
   * 获取任务
   */
  async get_task(task_id: string): Promise<PatternScanTask | null> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT * FROM pattern_scan_tasks WHERE id = ?',
        [task_id]
      );
      return rows.length > 0 ? this.map_to_task(rows[0]) : null;
    });
  }

  /**
   * 更新任务状态为运行中
   */
  async start_task(task_id: string, total_symbols: number): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `UPDATE pattern_scan_tasks
         SET status = 'running', total_symbols = ?, started_at = NOW()
         WHERE id = ?`,
        [total_symbols, task_id]
      );
    });
  }

  /**
   * 更新扫描进度
   */
  async update_progress(task_id: string, scanned: number, found: number): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `UPDATE pattern_scan_tasks
         SET scanned_symbols = ?, found_patterns = ?
         WHERE id = ?`,
        [scanned, found, task_id]
      );
    });
  }

  /**
   * 完成任务
   */
  async complete_task(task_id: string, found_patterns: number): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `UPDATE pattern_scan_tasks
         SET status = 'completed', found_patterns = ?, completed_at = NOW()
         WHERE id = ?`,
        [found_patterns, task_id]
      );
    });
  }

  /**
   * 任务失败
   */
  async fail_task(task_id: string, error_message: string): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `UPDATE pattern_scan_tasks
         SET status = 'failed', error_message = ?, completed_at = NOW()
         WHERE id = ?`,
        [error_message, task_id]
      );
    });
  }

  /**
   * 获取任务列表
   */
  async get_tasks(options: {
    status?: ScanTaskStatus;
    limit?: number;
  } = {}): Promise<PatternScanTask[]> {
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM pattern_scan_tasks WHERE 1=1';
      const params: any[] = [];

      if (options.status) {
        sql += ' AND status = ?';
        params.push(options.status);
      }

      sql += ' ORDER BY created_at DESC';

      if (options.limit) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(row => this.map_to_task(row));
    });
  }

  // ==================== 扫描结果操作 ====================

  /**
   * 保存扫描结果
   */
  async save_result(result: Omit<PatternScanResult, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [res] = await conn.execute<ResultSetHeader>(
        `INSERT INTO pattern_scan_results
         (task_id, symbol, pattern_type, score, description, key_levels, kline_interval, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.task_id,
          result.symbol,
          result.pattern_type,
          result.score,
          result.description,
          JSON.stringify(result.key_levels),
          result.kline_interval,
          result.detected_at
        ]
      );
      return res.insertId;
    });
  }

  /**
   * 批量保存扫描结果
   */
  async save_results_batch(results: Omit<PatternScanResult, 'id' | 'created_at'>[]): Promise<void> {
    if (results.length === 0) return;

    return this.execute_with_connection(async (conn) => {
      const placeholders = results.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values: any[] = [];

      for (const r of results) {
        values.push(
          r.task_id,
          r.symbol,
          r.pattern_type,
          r.score,
          r.description,
          JSON.stringify(r.key_levels),
          r.kline_interval,
          r.detected_at
        );
      }

      await conn.execute(
        `INSERT INTO pattern_scan_results
         (task_id, symbol, pattern_type, score, description, key_levels, kline_interval, detected_at)
         VALUES ${placeholders}`,
        values
      );
    });
  }

  /**
   * 获取任务的扫描结果
   */
  async get_results(task_id: string, options: {
    pattern_type?: PatternType;
    min_score?: number;
    symbol?: string;
    limit?: number;
  } = {}): Promise<PatternScanResult[]> {
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM pattern_scan_results WHERE task_id = ?';
      const params: any[] = [task_id];

      if (options.pattern_type) {
        sql += ' AND pattern_type = ?';
        params.push(options.pattern_type);
      }
      if (options.min_score) {
        sql += ' AND score >= ?';
        params.push(options.min_score);
      }
      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }

      sql += ' ORDER BY score DESC';

      if (options.limit) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(row => this.map_to_result(row));
    });
  }

  /**
   * 获取最新一次成功扫描的结果
   */
  async get_latest_results(options: {
    pattern_type?: PatternType;
    min_score?: number;
    limit?: number;
  } = {}): Promise<PatternScanResult[]> {
    return this.execute_with_connection(async (conn) => {
      // 找到最新完成的任务
      const [tasks] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM pattern_scan_tasks
         WHERE status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`
      );

      if (tasks.length === 0) {
        return [];
      }

      return this.get_results(tasks[0].id, options);
    });
  }

  /**
   * 清理旧任务和结果
   */
  async cleanup_old_tasks(days_to_keep: number = 7): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `DELETE FROM pattern_scan_tasks
         WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [days_to_keep]
      );
      return result.affectedRows;
    });
  }

  /**
   * 删除所有扫描结果和任务
   */
  async delete_all(): Promise<{ deleted_results: number; deleted_tasks: number }> {
    return this.execute_with_connection(async (conn) => {
      // 先删除结果（外键约束）
      const [results_res] = await conn.execute<ResultSetHeader>(
        'DELETE FROM pattern_scan_results'
      );

      // 再删除任务
      const [tasks_res] = await conn.execute<ResultSetHeader>(
        'DELETE FROM pattern_scan_tasks'
      );

      return {
        deleted_results: results_res.affectedRows,
        deleted_tasks: tasks_res.affectedRows
      };
    });
  }

  // ==================== 映射方法 ====================

  private map_to_task(row: RowDataPacket): PatternScanTask {
    return {
      id: row.id,
      status: row.status,
      interval_type: row.interval_type,
      lookback_bars: row.lookback_bars,
      total_symbols: row.total_symbols,
      scanned_symbols: row.scanned_symbols,
      found_patterns: row.found_patterns,
      error_message: row.error_message || undefined,
      started_at: row.started_at || undefined,
      completed_at: row.completed_at || undefined,
      created_at: row.created_at
    };
  }

  private map_to_result(row: RowDataPacket): PatternScanResult {
    let key_levels: KeyLevels = {};
    try {
      key_levels = typeof row.key_levels === 'string'
        ? JSON.parse(row.key_levels)
        : row.key_levels || {};
    } catch {
      key_levels = {};
    }

    return {
      id: row.id,
      task_id: row.task_id,
      symbol: row.symbol,
      pattern_type: row.pattern_type,
      score: row.score,
      description: row.description,
      key_levels,
      kline_interval: row.kline_interval,
      detected_at: Number(row.detected_at),
      created_at: row.created_at
    };
  }
}
