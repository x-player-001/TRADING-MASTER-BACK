/**
 * 错误日志数据库仓库
 * 用于持久化保存系统运行中的错误信息
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

/**
 * 错误类型枚举
 */
export enum ErrorType {
  API_ERROR = 'API_ERROR',           // API调用错误
  ORDER_ERROR = 'ORDER_ERROR',       // 订单相关错误
  POSITION_ERROR = 'POSITION_ERROR', // 持仓相关错误
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR', // WebSocket错误
  DATABASE_ERROR = 'DATABASE_ERROR', // 数据库错误
  SYSTEM_ERROR = 'SYSTEM_ERROR',     // 系统错误
  TRADING_ERROR = 'TRADING_ERROR',   // 交易逻辑错误
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'    // 未知错误
}

/**
 * 错误日志记录接口
 */
export interface ErrorLogRecord {
  id?: number;
  error_type: ErrorType | string;
  error_code?: string;
  error_message: string;
  symbol?: string;
  context?: Record<string, any>;
  stack_trace?: string;
  trading_mode?: 'LIVE' | 'PAPER';
  created_at?: Date;
}

/**
 * 错误日志仓库类
 */
export class ErrorLogRepository extends BaseRepository {
  private static instance: ErrorLogRepository;

  private constructor() {
    super();
  }

  /**
   * 获取单例实例
   */
  static getInstance(): ErrorLogRepository {
    if (!ErrorLogRepository.instance) {
      ErrorLogRepository.instance = new ErrorLogRepository();
    }
    return ErrorLogRepository.instance;
  }

  /**
   * 记录错误日志
   * @param record 错误记录
   */
  async log_error(record: ErrorLogRecord): Promise<number | null> {
    try {
      const sql = `
        INSERT INTO error_logs (
          error_type, error_code, error_message, symbol,
          context, stack_trace, trading_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        record.error_type,
        record.error_code || null,
        record.error_message,
        record.symbol || null,
        record.context ? JSON.stringify(record.context) : null,
        record.stack_trace || null,
        record.trading_mode || 'LIVE'
      ];

      const id = await this.insert_and_get_id(sql, params);
      return id;
    } catch (error) {
      // 记录错误日志失败时，只打印日志，不抛出异常，避免影响主流程
      logger.error('[ErrorLogRepository] Failed to log error:', error);
      return null;
    }
  }

  /**
   * 快捷方法：记录API错误
   */
  async log_api_error(
    error_message: string,
    error_code?: string,
    symbol?: string,
    context?: Record<string, any>
  ): Promise<number | null> {
    return this.log_error({
      error_type: ErrorType.API_ERROR,
      error_code,
      error_message,
      symbol,
      context
    });
  }

  /**
   * 快捷方法：记录订单错误
   */
  async log_order_error(
    error_message: string,
    symbol: string,
    context?: Record<string, any>,
    error_code?: string
  ): Promise<number | null> {
    return this.log_error({
      error_type: ErrorType.ORDER_ERROR,
      error_code,
      error_message,
      symbol,
      context
    });
  }

  /**
   * 快捷方法：记录交易错误
   */
  async log_trading_error(
    error_message: string,
    symbol?: string,
    context?: Record<string, any>,
    stack_trace?: string
  ): Promise<number | null> {
    return this.log_error({
      error_type: ErrorType.TRADING_ERROR,
      error_message,
      symbol,
      context,
      stack_trace
    });
  }

  /**
   * 查询最近的错误日志
   * @param limit 查询数量
   * @param error_type 错误类型过滤
   */
  async get_recent_errors(limit: number = 100, error_type?: ErrorType): Promise<ErrorLogRecord[]> {
    try {
      let sql = `
        SELECT * FROM error_logs
        ${error_type ? 'WHERE error_type = ?' : ''}
        ORDER BY created_at DESC
        LIMIT ?
      `;

      const params = error_type ? [error_type, limit] : [limit];
      const rows = await this.execute_query(sql, params);

      return rows.map(row => ({
        ...row,
        context: row.context ? JSON.parse(row.context) : null
      }));
    } catch (error) {
      logger.error('[ErrorLogRepository] Failed to get recent errors:', error);
      return [];
    }
  }

  /**
   * 查询指定币种的错误日志
   */
  async get_errors_by_symbol(symbol: string, limit: number = 50): Promise<ErrorLogRecord[]> {
    try {
      const sql = `
        SELECT * FROM error_logs
        WHERE symbol = ?
        ORDER BY created_at DESC
        LIMIT ?
      `;

      const rows = await this.execute_query(sql, [symbol, limit]);

      return rows.map(row => ({
        ...row,
        context: row.context ? JSON.parse(row.context) : null
      }));
    } catch (error) {
      logger.error('[ErrorLogRepository] Failed to get errors by symbol:', error);
      return [];
    }
  }

  /**
   * 获取错误统计
   */
  async get_error_stats(hours: number = 24): Promise<{
    total: number;
    by_type: Record<string, number>;
    by_symbol: Record<string, number>;
  }> {
    try {
      // 总数
      const total_sql = `
        SELECT COUNT(*) as total FROM error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      `;
      const [total_row] = await this.execute_query(total_sql, [hours]);

      // 按类型统计
      const type_sql = `
        SELECT error_type, COUNT(*) as count FROM error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY error_type
      `;
      const type_rows = await this.execute_query(type_sql, [hours]);

      // 按币种统计
      const symbol_sql = `
        SELECT symbol, COUNT(*) as count FROM error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
          AND symbol IS NOT NULL
        GROUP BY symbol
        ORDER BY count DESC
        LIMIT 20
      `;
      const symbol_rows = await this.execute_query(symbol_sql, [hours]);

      return {
        total: total_row?.total || 0,
        by_type: type_rows.reduce((acc: Record<string, number>, row: any) => {
          acc[row.error_type] = row.count;
          return acc;
        }, {}),
        by_symbol: symbol_rows.reduce((acc: Record<string, number>, row: any) => {
          if (row.symbol) acc[row.symbol] = row.count;
          return acc;
        }, {})
      };
    } catch (error) {
      logger.error('[ErrorLogRepository] Failed to get error stats:', error);
      return { total: 0, by_type: {}, by_symbol: {} };
    }
  }

  /**
   * 清理旧日志
   * @param days 保留天数
   */
  async cleanup_old_logs(days: number = 30): Promise<number> {
    try {
      const sql = `
        DELETE FROM error_logs
        WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
      `;
      return await this.delete_and_get_affected_rows(sql, [days]);
    } catch (error) {
      logger.error('[ErrorLogRepository] Failed to cleanup old logs:', error);
      return 0;
    }
  }
}

// 导出单例实例
export const errorLogRepository = ErrorLogRepository.getInstance();
