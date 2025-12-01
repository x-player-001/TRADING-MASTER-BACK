/**
 * 信号处理记录 Repository
 * 负责存储和查询交易信号的处理结果
 */

import { DatabaseConfig } from '@/core/config/database';
import {
  SignalProcessingRecord,
  CreateSignalProcessingRecordInput,
  SignalProcessingResult,
  RejectionCategory
} from '@/types/signal_processing';
import { logger } from '@/utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

export class SignalProcessingRepository {
  private static instance: SignalProcessingRepository;

  private constructor() {}

  static get_instance(): SignalProcessingRepository {
    if (!SignalProcessingRepository.instance) {
      SignalProcessingRepository.instance = new SignalProcessingRepository();
    }
    return SignalProcessingRepository.instance;
  }

  /**
   * 创建信号处理记录
   */
  async create_record(input: CreateSignalProcessingRecordInput): Promise<number> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        INSERT INTO signal_processing_records (
          signal_id, anomaly_id, symbol, signal_direction, signal_score, signal_source,
          processing_result, rejection_reason, rejection_category,
          order_id, position_id, entry_price, quantity, position_value_usd,
          current_daily_loss, current_open_positions, available_balance,
          signal_received_at, error_message, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        input.signal_id || null,
        input.anomaly_id || null,
        input.symbol,
        input.signal_direction,
        input.signal_score || null,
        input.signal_source || 'OI_ANOMALY',
        input.processing_result,
        input.rejection_reason || null,
        input.rejection_category || null,
        input.order_id || null,
        input.position_id || null,
        input.entry_price || null,
        input.quantity || null,
        input.position_value_usd || null,
        input.current_daily_loss || null,
        input.current_open_positions || 0,
        input.available_balance || null,
        input.signal_received_at || new Date(),
        input.error_message || null,
        input.metadata ? JSON.stringify(input.metadata) : null
      ];

      const [result] = await conn.query<ResultSetHeader>(sql, values);

      logger.info(
        `[SignalProcessingRepository] Created record #${result.insertId}: ${input.symbol} ${input.signal_direction} - ${input.processing_result}`,
        input.rejection_reason ? { rejection_reason: input.rejection_reason } : {}
      );

      return result.insertId;
    } catch (error) {
      logger.error('[SignalProcessingRepository] Failed to create record:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 根据ID查询记录
   */
  async get_by_id(id: number): Promise<SignalProcessingRecord | null> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM signal_processing_records WHERE id = ?
      `;

      const [rows] = await conn.query<RowDataPacket[]>(sql, [id]);

      if (rows.length === 0) {
        return null;
      }

      return this.map_row_to_record(rows[0]);
    } catch (error) {
      logger.error('[SignalProcessingRepository] Failed to get record by id:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 查询指定时间范围内的记录
   */
  async get_records_by_time_range(
    start_time: Date,
    end_time: Date,
    filters?: {
      symbol?: string;
      processing_result?: SignalProcessingResult;
      rejection_category?: RejectionCategory;
    }
  ): Promise<SignalProcessingRecord[]> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      let sql = `
        SELECT * FROM signal_processing_records
        WHERE signal_received_at >= ? AND signal_received_at <= ?
      `;

      const values: any[] = [start_time, end_time];

      if (filters?.symbol) {
        sql += ' AND symbol = ?';
        values.push(filters.symbol);
      }

      if (filters?.processing_result) {
        sql += ' AND processing_result = ?';
        values.push(filters.processing_result);
      }

      if (filters?.rejection_category) {
        sql += ' AND rejection_category = ?';
        values.push(filters.rejection_category);
      }

      sql += ' ORDER BY signal_received_at DESC';

      const [rows] = await conn.query<RowDataPacket[]>(sql, values);

      return rows.map(row => this.map_row_to_record(row));
    } catch (error) {
      logger.error('[SignalProcessingRepository] Failed to get records by time range:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 统计信号处理结果
   */
  async get_processing_statistics(
    start_time: Date,
    end_time: Date
  ): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    rejection_breakdown: Record<string, number>;
  }> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      // 总数和接受/拒绝统计
      const count_sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN processing_result = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted,
          SUM(CASE WHEN processing_result = 'REJECTED' THEN 1 ELSE 0 END) as rejected
        FROM signal_processing_records
        WHERE signal_received_at >= ? AND signal_received_at <= ?
      `;

      const [count_rows] = await conn.query<RowDataPacket[]>(count_sql, [start_time, end_time]);

      // 拒绝原因分类统计
      const rejection_sql = `
        SELECT
          rejection_category,
          COUNT(*) as count
        FROM signal_processing_records
        WHERE signal_received_at >= ?
          AND signal_received_at <= ?
          AND processing_result = 'REJECTED'
          AND rejection_category IS NOT NULL
        GROUP BY rejection_category
      `;

      const [rejection_rows] = await conn.query<RowDataPacket[]>(rejection_sql, [start_time, end_time]);

      const rejection_breakdown: Record<string, number> = {};
      rejection_rows.forEach(row => {
        rejection_breakdown[row.rejection_category] = row.count;
      });

      return {
        total: count_rows[0].total || 0,
        accepted: count_rows[0].accepted || 0,
        rejected: count_rows[0].rejected || 0,
        rejection_breakdown
      };
    } catch (error) {
      logger.error('[SignalProcessingRepository] Failed to get statistics:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 查询最近N条记录
   */
  async get_recent_records(limit: number = 100): Promise<SignalProcessingRecord[]> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM signal_processing_records
        ORDER BY signal_received_at DESC
        LIMIT ?
      `;

      const [rows] = await conn.query<RowDataPacket[]>(sql, [limit]);

      return rows.map(row => this.map_row_to_record(row));
    } catch (error) {
      logger.error('[SignalProcessingRepository] Failed to get recent records:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 根据anomaly_id查询处理记录
   */
  async get_by_anomaly_id(anomaly_id: number): Promise<SignalProcessingRecord | null> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM signal_processing_records
        WHERE anomaly_id = ?
        ORDER BY processed_at DESC
        LIMIT 1
      `;

      const [rows] = await conn.query<RowDataPacket[]>(sql, [anomaly_id]);

      if (rows.length === 0) {
        return null;
      }

      return this.map_row_to_record(rows[0]);
    } catch (error) {
      logger.error('[SignalProcessingRepository] Failed to get record by anomaly_id:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 将数据库行映射为记录对象
   */
  private map_row_to_record(row: RowDataPacket): SignalProcessingRecord {
    return {
      id: row.id,
      signal_id: row.signal_id,
      anomaly_id: row.anomaly_id,
      symbol: row.symbol,
      signal_direction: row.signal_direction,
      signal_score: row.signal_score ? parseFloat(row.signal_score) : undefined,
      signal_source: row.signal_source,
      processing_result: row.processing_result,
      rejection_reason: row.rejection_reason,
      rejection_category: row.rejection_category,
      order_id: row.order_id,
      position_id: row.position_id,
      entry_price: row.entry_price ? parseFloat(row.entry_price) : undefined,
      quantity: row.quantity ? parseFloat(row.quantity) : undefined,
      position_value_usd: row.position_value_usd ? parseFloat(row.position_value_usd) : undefined,
      current_daily_loss: row.current_daily_loss ? parseFloat(row.current_daily_loss) : undefined,
      current_open_positions: row.current_open_positions,
      available_balance: row.available_balance ? parseFloat(row.available_balance) : undefined,
      signal_received_at: new Date(row.signal_received_at),
      processed_at: row.processed_at ? new Date(row.processed_at) : undefined,
      error_message: row.error_message,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }
}

// 导出单例
export const signal_processing_repository = SignalProcessingRepository.get_instance();
