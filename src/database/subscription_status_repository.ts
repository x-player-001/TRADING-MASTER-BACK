import { BaseRepository } from './base_repository';
import { SubscriptionStatus, StreamType } from '@/types/common';
import { logger } from '@/utils/logger';

/**
 * 订阅状态数据库操作仓库
 */
export class SubscriptionStatusRepository extends BaseRepository {

  /**
   * 创建订阅状态表
   */
  async create_table(): Promise<void> {
    const create_sql = `
      CREATE TABLE IF NOT EXISTS subscription_status (
        id INT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL,
        stream_type ENUM('ticker','kline','depth','trade') NOT NULL,
        status ENUM('active','inactive','error') DEFAULT 'inactive',
        last_update TIMESTAMP NULL,
        error_count INT DEFAULT 0,
        error_message TEXT NULL,
        reconnect_attempts INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_stream (symbol, stream_type),
        INDEX idx_status (status),
        INDEX idx_last_update (last_update)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await this.ensure_table_exists(create_sql, 'subscription_status');
  }

  /**
   * 插入或更新订阅状态
   * @param symbol - 交易对符号
   * @param stream_type - 数据流类型
   * @param status - 订阅状态
   * @param error_message - 错误信息（可选）
   */
  async upsert(
    symbol: string,
    stream_type: StreamType,
    status: 'active' | 'inactive' | 'error',
    error_message?: string
  ): Promise<void> {
    const sql = `
      INSERT INTO subscription_status (symbol, stream_type, status, last_update, error_message)
      VALUES (?, ?, ?, NOW(), ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        last_update = NOW(),
        error_message = VALUES(error_message),
        error_count = IF(VALUES(status) = 'active', 0, error_count)
    `;

    await this.execute_query(sql, [symbol, stream_type, status, error_message || null]);
  }

  /**
   * 更新订阅状态
   * @param symbol - 交易对符号
   * @param stream_type - 数据流类型
   * @param status - 订阅状态
   * @param error_message - 错误信息（可选）
   */
  async update_status(
    symbol: string,
    stream_type: StreamType,
    status: 'active' | 'inactive' | 'error',
    error_message?: string
  ): Promise<boolean> {
    const sql = `
      UPDATE subscription_status
      SET status = ?, last_update = NOW(), error_message = ?, updated_at = NOW()
      WHERE symbol = ? AND stream_type = ?
    `;

    const affected_rows = await this.update_and_get_affected_rows(
      sql,
      [status, error_message || null, symbol, stream_type]
    );

    return affected_rows > 0;
  }

  /**
   * 获取所有订阅状态
   */
  async find_all(): Promise<SubscriptionStatus[]> {
    const sql = `
      SELECT * FROM subscription_status
      ORDER BY symbol ASC, stream_type ASC
    `;

    return await this.execute_query(sql);
  }

  /**
   * 根据符号获取订阅状态
   * @param symbol - 交易对符号
   */
  async find_by_symbol(symbol: string): Promise<SubscriptionStatus[]> {
    const sql = `
      SELECT * FROM subscription_status
      WHERE symbol = ?
      ORDER BY stream_type ASC
    `;

    return await this.execute_query(sql, [symbol]);
  }

  /**
   * 获取指定状态的订阅
   * @param status - 订阅状态
   */
  async find_by_status(status: 'active' | 'inactive' | 'error'): Promise<SubscriptionStatus[]> {
    const sql = `
      SELECT * FROM subscription_status
      WHERE status = ?
      ORDER BY symbol ASC, stream_type ASC
    `;

    return await this.execute_query(sql, [status]);
  }

  /**
   * 将所有活跃状态设为非活跃
   */
  async deactivate_all(): Promise<number> {
    const sql = `
      UPDATE subscription_status
      SET status = 'inactive', updated_at = NOW()
      WHERE status = 'active'
    `;

    return await this.update_and_get_affected_rows(sql, []);
  }

  /**
   * 增加错误计数
   * @param symbol - 交易对符号
   * @param stream_type - 数据流类型
   * @param error_message - 错误信息
   */
  async increment_error_count(symbol: string, stream_type: StreamType, error_message: string): Promise<void> {
    const sql = `
      UPDATE subscription_status
      SET error_count = error_count + 1,
          status = 'error',
          error_message = ?,
          updated_at = NOW()
      WHERE symbol = ? AND stream_type = ?
    `;

    await this.execute_query(sql, [error_message, symbol, stream_type]);
  }

  /**
   * 批量增加所有活跃订阅的错误计数
   * @param error_message - 错误信息
   */
  async increment_all_active_error_count(error_message: string): Promise<number> {
    const sql = `
      UPDATE subscription_status
      SET error_count = error_count + 1,
          status = 'error',
          error_message = ?,
          updated_at = NOW()
      WHERE status = 'active'
    `;

    return await this.update_and_get_affected_rows(sql, [error_message]);
  }

  /**
   * 重置错误计数
   * @param symbol - 交易对符号
   * @param stream_type - 数据流类型
   */
  async reset_error_count(symbol: string, stream_type: StreamType): Promise<void> {
    const sql = `
      UPDATE subscription_status
      SET error_count = 0, error_message = NULL, updated_at = NOW()
      WHERE symbol = ? AND stream_type = ?
    `;

    await this.execute_query(sql, [symbol, stream_type]);
  }

  /**
   * 删除指定符号的所有订阅状态
   * @param symbol - 交易对符号
   */
  async delete_by_symbol(symbol: string): Promise<number> {
    const sql = 'DELETE FROM subscription_status WHERE symbol = ?';
    return await this.delete_and_get_affected_rows(sql, [symbol]);
  }

  /**
   * 检查过期的订阅（超过指定时间没有更新）
   * @param minutes - 超时分钟数
   */
  async find_stale_subscriptions(minutes: number = 2): Promise<SubscriptionStatus[]> {
    const sql = `
      SELECT * FROM subscription_status
      WHERE status = 'active'
        AND last_update IS NOT NULL
        AND last_update < DATE_SUB(NOW(), INTERVAL ? MINUTE)
      ORDER BY last_update ASC
    `;

    return await this.execute_query(sql, [minutes]);
  }

  /**
   * 将过期的订阅标记为错误状态
   * @param minutes - 超时分钟数
   */
  async mark_stale_as_error(minutes: number = 2): Promise<number> {
    const sql = `
      UPDATE subscription_status
      SET status = 'error', error_message = 'No data received for ${minutes} minutes'
      WHERE status = 'active'
        AND last_update IS NOT NULL
        AND last_update < DATE_SUB(NOW(), INTERVAL ? MINUTE)
    `;

    return await this.update_and_get_affected_rows(sql, [minutes]);
  }

  /**
   * 获取订阅状态统计
   */
  async get_statistics(): Promise<any> {
    const sql = `
      SELECT
        status,
        COUNT(*) as count,
        AVG(error_count) as avg_error_count
      FROM subscription_status
      GROUP BY status
    `;

    const stats = await this.execute_query(sql);

    // 转换为对象格式
    const result: any = { active: 0, inactive: 0, error: 0 };
    stats.forEach(stat => {
      result[stat.status] = {
        count: stat.count,
        avg_error_count: parseFloat(stat.avg_error_count || 0)
      };
    });

    return result;
  }
}