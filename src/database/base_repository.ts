import { Connection } from 'mysql2/promise';
import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';

/**
 * 基础数据库仓库类，提供通用的数据库操作方法
 *
 * 重要：每次数据库操作都从连接池获取新连接，用完后立即释放
 * 避免长时间持有连接导致超时问题
 */
export abstract class BaseRepository {
  /**
   * 执行SQL查询
   * @param sql - SQL语句
   * @param params - 查询参数
   */
  protected async execute_query(sql: string, params?: any[]): Promise<any[]> {
    return this.execute_with_connection(async (conn) => {
      try {
        const [rows] = await conn.execute(sql, params || []);
        return rows as any[];
      } catch (error) {
        logger.error(`SQL执行失败: ${sql}`, error);
        logger.error('参数:', params);
        throw error;
      }
    });
  }

  /**
   * 插入数据并返回插入ID
   * @param sql - 插入SQL语句
   * @param params - 插入参数
   */
  protected async insert_and_get_id(sql: string, params: any[]): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      try {
        const [result] = await conn.execute(sql, params || []);
        return (result as any).insertId;
      } catch (error) {
        logger.error(`插入数据失败: ${sql}`, error);
        logger.error('参数:', params);
        throw error;
      }
    });
  }

  /**
   * 更新数据并返回受影响的行数
   * @param sql - 更新SQL语句
   * @param params - 更新参数
   */
  protected async update_and_get_affected_rows(sql: string, params: any[]): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      try {
        const [result] = await conn.execute(sql, params || []);
        return (result as any).affectedRows;
      } catch (error) {
        logger.error(`更新数据失败: ${sql}`, error);
        logger.error('参数:', params);
        throw error;
      }
    });
  }

  /**
   * 删除数据并返回受影响的行数
   * @param sql - 删除SQL语句
   * @param params - 删除参数
   */
  protected async delete_and_get_affected_rows(sql: string, params: any[]): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      try {
        const [result] = await conn.execute(sql, params || []);
        return (result as any).affectedRows;
      } catch (error) {
        logger.error(`删除数据失败: ${sql}`, error);
        logger.error('参数:', params);
        throw error;
      }
    });
  }

  /**
   * 创建表（如果不存在）
   * @param create_sql - 建表SQL语句
   * @param table_name - 表名（用于日志）
   */
  protected async ensure_table_exists(create_sql: string, table_name: string): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      try {
        await conn.execute(create_sql);
        logger.info(`${table_name} table created or verified`);
      } catch (error) {
        logger.error(`创建表 ${table_name} 失败`, error);
        logger.error('SQL:', create_sql);
        throw error;
      }
    });
  }

  /**
   * 执行数据库操作并自动管理连接
   * @param operation - 数据库操作函数
   *
   * 关键设计：
   * 1. 每次从连接池获取新连接
   * 2. 用完后立即释放回连接池
   * 3. 避免长时间持有连接导致超时
   */
  protected async execute_with_connection<T>(operation: (conn: Connection) => Promise<T>): Promise<T> {
    const conn = await DatabaseConfig.get_mysql_connection();
    try {
      return await operation(conn);
    } catch (error) {
      logger.error('Database operation failed', error);
      throw error;
    } finally {
      // 关键：用完后立即释放连接回连接池
      conn.release();
    }
  }
}
