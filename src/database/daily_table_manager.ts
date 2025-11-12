/**
 * 日期分表管理器
 * 负责OI快照数据的日期分表管理：自动创建、查询路由、旧表清理
 */

import { DatabaseConfig } from '../core/config/database';
import { format } from 'date-fns';
import { logger } from '../utils/logger';

export class DailyTableManager {
  private static instance: DailyTableManager;
  private table_prefix = 'open_interest_snapshots';
  private retention_days = 20; // 数据保留20天

  private constructor() {}

  public static get_instance(): DailyTableManager {
    if (!DailyTableManager.instance) {
      DailyTableManager.instance = new DailyTableManager();
    }
    return DailyTableManager.instance;
  }

  /**
   * 获取指定日期的表名
   * @param date Date对象或日期字符串(YYYY-MM-DD)
   * @returns 表名，例如：open_interest_snapshots_20251111
   */
  public get_table_name(date: Date | string): string {
    const date_obj = typeof date === 'string' ? new Date(date) : date;
    const date_str = format(date_obj, 'yyyyMMdd');
    return `${this.table_prefix}_${date_str}`;
  }

  /**
   * 检查表是否存在
   */
  private async table_exists(table_name: string): Promise<boolean> {
    const conn = await DatabaseConfig.get_mysql_connection();
    try {
      const [rows] = await conn.query(
        `SELECT COUNT(*) as count
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?`,
        [table_name]
      );
      return (rows as any)[0].count > 0;
    } finally {
      conn.release();
    }
  }

  /**
   * 创建日期表
   * @param date 日期
   */
  public async create_table_if_not_exists(date: Date | string): Promise<void> {
    const table_name = this.get_table_name(date);

    // 检查表是否已存在
    if (await this.table_exists(table_name)) {
      logger.debug(`[DailyTableManager] 表已存在: ${table_name}`);
      return;
    }

    const conn = await DatabaseConfig.get_mysql_connection();
    const create_sql = `
      CREATE TABLE ${table_name} (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL,
        open_interest DECIMAL(30,8) NOT NULL,
        timestamp_ms BIGINT NOT NULL,
        snapshot_time TIMESTAMP NOT NULL,
        data_source VARCHAR(20) DEFAULT 'binance',

        mark_price DECIMAL(20,8) NULL COMMENT '标记价格',
        funding_rate DECIMAL(10,8) NULL COMMENT '资金费率',
        next_funding_time BIGINT NULL COMMENT '下次资金费时间',

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_timestamp (symbol, timestamp_ms),
        INDEX idx_snapshot_time (snapshot_time),
        INDEX idx_symbol (symbol),
        INDEX idx_snapshot_symbol (snapshot_time, symbol, timestamp_ms, open_interest)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='OI snapshots - ${format(new Date(date), 'yyyy-MM-dd')}';
    `;

    try {
      await conn.query(create_sql);
      logger.info(`[DailyTableManager] 成功创建日期表: ${table_name}`);
    } catch (error: any) {
      // 如果是表已存在错误（并发创建），忽略
      if (error.code === 'ER_TABLE_EXISTS_ERROR') {
        logger.debug(`[DailyTableManager] 表已存在(并发创建): ${table_name}`);
        return;
      }
      logger.error(`[DailyTableManager] 创建表失败: ${table_name}`, error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 删除指定日期的表
   */
  public async drop_table(date: Date | string): Promise<void> {
    const table_name = this.get_table_name(date);

    if (!(await this.table_exists(table_name))) {
      logger.debug(`[DailyTableManager] 表不存在，跳过删除: ${table_name}`);
      return;
    }

    const conn = await DatabaseConfig.get_mysql_connection();
    try {
      await conn.query(`DROP TABLE ${table_name}`);
      logger.info(`[DailyTableManager] 成功删除旧表: ${table_name}`);
    } catch (error) {
      logger.error(`[DailyTableManager] 删除表失败: ${table_name}`, error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 清理20天前的旧表
   * @returns 删除的表数量
   */
  public async cleanup_old_tables(): Promise<number> {
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      // 查找所有日期分表
      const [tables] = await conn.query(
        `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME LIKE '${this.table_prefix}_%'`
      );

      const cutoff_date = new Date();
      cutoff_date.setDate(cutoff_date.getDate() - this.retention_days);
      const cutoff_date_str = format(cutoff_date, 'yyyyMMdd');

      let deleted_count = 0;

      for (const row of tables as any[]) {
        const table_name = row.TABLE_NAME;
        // 提取日期部分：open_interest_snapshots_20251111 -> 20251111
        const date_str = table_name.replace(`${this.table_prefix}_`, '');

        // 验证日期格式（8位数字）
        if (!/^\d{8}$/.test(date_str)) {
          continue;
        }

        // 如果表的日期早于截止日期，删除
        if (date_str < cutoff_date_str) {
          try {
            await conn.query(`DROP TABLE ${table_name}`);
            logger.info(`[DailyTableManager] 清理旧表: ${table_name} (${date_str} < ${cutoff_date_str})`);
            deleted_count++;
          } catch (error) {
            logger.error(`[DailyTableManager] 清理旧表失败: ${table_name}`, error);
          }
        }
      }

      logger.info(`[DailyTableManager] 旧表清理完成，共删除 ${deleted_count} 个表`);
      return deleted_count;
    } finally {
      conn.release();
    }
  }

  /**
   * 获取指定日期范围内需要查询的所有表名
   * @param start_date 开始日期
   * @param end_date 结束日期
   * @returns 表名数组
   */
  public async get_tables_in_range(start_date: Date | string, end_date: Date | string): Promise<string[]> {
    const start = new Date(start_date);
    const end = new Date(end_date);

    const tables: string[] = [];
    const current = new Date(start);

    // 遍历日期范围
    while (current <= end) {
      const table_name = this.get_table_name(current);
      if (await this.table_exists(table_name)) {
        tables.push(table_name);
      }
      current.setDate(current.getDate() + 1);
    }

    return tables;
  }

  /**
   * 初始化：创建今天和未来1天的表（提前创建避免临界时刻创建）
   */
  public async initialize(): Promise<void> {
    logger.info('[DailyTableManager] 开始初始化日期分表...');

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 创建今天和明天的表
    await this.create_table_if_not_exists(today);
    await this.create_table_if_not_exists(tomorrow);

    logger.info('[DailyTableManager] 日期分表初始化完成');
  }

  /**
   * 启动定时清理任务（每天凌晨1点执行）
   */
  public start_cleanup_scheduler(): void {
    // 计算到下一个凌晨1点的延迟时间
    const now = new Date();
    const next_run = new Date(now);
    next_run.setHours(1, 0, 0, 0);

    if (next_run <= now) {
      next_run.setDate(next_run.getDate() + 1);
    }

    const delay = next_run.getTime() - now.getTime();

    logger.info(`[DailyTableManager] 定时清理任务已启动，首次执行时间: ${next_run.toLocaleString()}`);

    // 首次延迟执行
    setTimeout(() => {
      this.run_cleanup_task();

      // 之后每24小时执行一次
      setInterval(() => {
        this.run_cleanup_task();
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  /**
   * 执行清理任务
   */
  private async run_cleanup_task(): Promise<void> {
    try {
      logger.info('[DailyTableManager] 开始执行定时清理任务...');

      // 清理旧表
      const deleted_count = await this.cleanup_old_tables();

      // 创建明天的表（提前准备）
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      await this.create_table_if_not_exists(tomorrow);

      logger.info(`[DailyTableManager] 定时清理任务完成，删除了 ${deleted_count} 个旧表`);
    } catch (error) {
      logger.error('[DailyTableManager] 定时清理任务执行失败', error);
    }
  }

  /**
   * 获取数据保留天数配置
   */
  public get_retention_days(): number {
    return this.retention_days;
  }

  /**
   * 设置数据保留天数
   */
  public set_retention_days(days: number): void {
    if (days < 1) {
      throw new Error('数据保留天数必须大于0');
    }
    this.retention_days = days;
    logger.info(`[DailyTableManager] 数据保留天数已更新为: ${days} 天`);
  }
}

// 导出单例实例
export const daily_table_manager = DailyTableManager.get_instance();
