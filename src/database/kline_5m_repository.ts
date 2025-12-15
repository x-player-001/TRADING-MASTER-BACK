/**
 * 5分钟K线数据存储层（按日分表）
 *
 * 表名格式: kline_5m_YYYYMMDD
 * 每天约 14.4万条数据（500币种 × 288条）
 */

import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';

// K线数据结构
export interface Kline5mData {
  id?: number;
  symbol: string;
  open_time: number;      // 开盘时间戳(ms)
  close_time: number;     // 收盘时间戳(ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  created_at?: Date;
}

export class Kline5mRepository {
  // 写入缓冲区
  private write_buffer: Kline5mData[] = [];
  private readonly BUFFER_SIZE = 500;  // 每500条批量写入
  private flush_timer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 30000;  // 30秒强制刷新

  constructor() {
    // 启动定时刷新
    this.start_flush_timer();
  }

  /**
   * 获取日期对应的表名
   */
  private get_table_name(date?: Date): string {
    const d = date || new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `kline_5m_${year}${month}${day}`;
  }

  /**
   * 确保表存在（自动创建）
   */
  async ensure_table_exists(table_name: string): Promise<void> {
    const connection = await DatabaseConfig.get_mysql_connection();

    const create_sql = `
      CREATE TABLE IF NOT EXISTS ${table_name} (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        open_time BIGINT NOT NULL,
        close_time BIGINT NOT NULL,
        open DECIMAL(20,8) NOT NULL,
        high DECIMAL(20,8) NOT NULL,
        low DECIMAL(20,8) NOT NULL,
        close DECIMAL(20,8) NOT NULL,
        volume DECIMAL(30,8) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_time (symbol, open_time),
        INDEX idx_open_time (open_time),
        INDEX idx_symbol (symbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='5分钟K线数据'
    `;

    try {
      await connection.execute(create_sql);
    } catch (error: any) {
      // 表已存在则忽略
      if (!error.message?.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * 添加K线到写入缓冲区（异步批量写入）
   */
  async add_kline(kline: Kline5mData): Promise<void> {
    this.write_buffer.push(kline);

    // 缓冲区满则刷新
    if (this.write_buffer.length >= this.BUFFER_SIZE) {
      await this.flush();
    }
  }

  /**
   * 批量添加K线
   */
  async add_klines(klines: Kline5mData[]): Promise<void> {
    this.write_buffer.push(...klines);

    if (this.write_buffer.length >= this.BUFFER_SIZE) {
      await this.flush();
    }
  }

  /**
   * 刷新缓冲区，写入数据库
   */
  async flush(): Promise<void> {
    if (this.write_buffer.length === 0) return;

    const klines_to_write = [...this.write_buffer];
    this.write_buffer = [];

    // 按日期分组
    const by_date = new Map<string, Kline5mData[]>();
    for (const kline of klines_to_write) {
      const date = new Date(kline.open_time);
      const table_name = this.get_table_name(date);

      if (!by_date.has(table_name)) {
        by_date.set(table_name, []);
      }
      by_date.get(table_name)!.push(kline);
    }

    // 按表批量写入
    for (const [table_name, klines] of by_date) {
      try {
        await this.batch_insert(table_name, klines);
      } catch (error) {
        logger.error(`[Kline5m] Failed to batch insert to ${table_name}:`, error);
        // 写入失败的数据放回缓冲区
        this.write_buffer.push(...klines);
      }
    }
  }

  /**
   * 批量插入（使用 INSERT IGNORE 去重）
   */
  private async batch_insert(table_name: string, klines: Kline5mData[]): Promise<void> {
    if (klines.length === 0) return;

    const connection = await DatabaseConfig.get_mysql_connection();

    // 确保表存在
    await this.ensure_table_exists(table_name);

    // 构建批量插入 SQL
    const placeholders = klines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values: any[] = [];

    for (const k of klines) {
      values.push(k.symbol, k.open_time, k.close_time, k.open, k.high, k.low, k.close, k.volume);
    }

    const sql = `
      INSERT IGNORE INTO ${table_name}
      (symbol, open_time, close_time, open, high, low, close, volume)
      VALUES ${placeholders}
    `;

    try {
      const [result] = await connection.execute(sql, values);
      const affected = (result as any).affectedRows;
      if (affected > 0) {
        logger.debug(`[Kline5m] Inserted ${affected} rows to ${table_name}`);
      }
    } catch (error) {
      logger.error(`[Kline5m] Batch insert failed:`, error);
      throw error;
    }
  }

  /**
   * 启动定时刷新
   */
  private start_flush_timer(): void {
    this.flush_timer = setInterval(async () => {
      try {
        await this.flush();
      } catch (error) {
        logger.error('[Kline5m] Flush timer error:', error);
      }
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * 停止定时刷新
   */
  stop_flush_timer(): void {
    if (this.flush_timer) {
      clearInterval(this.flush_timer);
      this.flush_timer = null;
    }
  }

  /**
   * 查询某币种最近N根K线
   */
  async get_recent_klines(symbol: string, limit: number = 50): Promise<Kline5mData[]> {
    const connection = await DatabaseConfig.get_mysql_connection();
    const today = this.get_table_name();
    const yesterday = this.get_table_name(new Date(Date.now() - 24 * 60 * 60 * 1000));

    // 先查今天的表
    try {
      const sql = `
        SELECT * FROM ${today}
        WHERE symbol = ?
        ORDER BY open_time DESC
        LIMIT ?
      `;
      const [rows] = await connection.execute(sql, [symbol, limit]);
      const result = rows as Kline5mData[];

      // 如果不够，再查昨天的表
      if (result.length < limit) {
        try {
          const remaining = limit - result.length;
          const sql2 = `
            SELECT * FROM ${yesterday}
            WHERE symbol = ?
            ORDER BY open_time DESC
            LIMIT ?
          `;
          const [rows2] = await connection.execute(sql2, [symbol, remaining]);
          result.push(...(rows2 as Kline5mData[]));
        } catch {
          // 昨天的表可能不存在
        }
      }

      // 按时间升序排列
      return result.sort((a, b) => a.open_time - b.open_time);
    } catch (error: any) {
      // 表不存在
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return [];
      }
      throw error;
    }
  }

  /**
   * 查询指定时间范围的K线
   */
  async get_klines_by_time_range(
    symbol: string,
    start_time: number,
    end_time: number
  ): Promise<Kline5mData[]> {
    const connection = await DatabaseConfig.get_mysql_connection();

    // 计算涉及的日期
    const start_date = new Date(start_time);
    const end_date = new Date(end_time);
    const tables: string[] = [];

    let current = new Date(start_date);
    while (current <= end_date) {
      tables.push(this.get_table_name(current));
      current.setDate(current.getDate() + 1);
    }

    const results: Kline5mData[] = [];

    for (const table of tables) {
      try {
        const sql = `
          SELECT * FROM ${table}
          WHERE symbol = ? AND open_time >= ? AND open_time <= ?
          ORDER BY open_time
        `;
        const [rows] = await connection.execute(sql, [symbol, start_time, end_time]);
        results.push(...(rows as Kline5mData[]));
      } catch (error: any) {
        // 表不存在则跳过
        if (error.code !== 'ER_NO_SUCH_TABLE') {
          throw error;
        }
      }
    }

    return results.sort((a, b) => a.open_time - b.open_time);
  }

  /**
   * 删除指定日期之前的旧表
   */
  async cleanup_old_tables(days_to_keep: number = 7): Promise<number> {
    const connection = await DatabaseConfig.get_mysql_connection();

    // 获取所有 kline_5m_ 开头的表
    const [tables] = await connection.execute(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'kline_5m_%'
    `);

    const cutoff_date = new Date();
    cutoff_date.setDate(cutoff_date.getDate() - days_to_keep);
    const cutoff_str = this.get_table_name(cutoff_date).replace('kline_5m_', '');

    let dropped = 0;
    for (const row of tables as any[]) {
      const table_name = row.TABLE_NAME;
      const date_str = table_name.replace('kline_5m_', '');

      if (date_str < cutoff_str) {
        try {
          await connection.execute(`DROP TABLE IF EXISTS ${table_name}`);
          logger.info(`[Kline5m] Dropped old table: ${table_name}`);
          dropped++;
        } catch (error) {
          logger.error(`[Kline5m] Failed to drop table ${table_name}:`, error);
        }
      }
    }

    return dropped;
  }

  /**
   * 获取统计信息
   */
  async get_statistics(): Promise<{
    today_count: number;
    today_symbols: number;
    buffer_size: number;
  }> {
    const connection = await DatabaseConfig.get_mysql_connection();
    const today = this.get_table_name();

    try {
      const [rows] = await connection.execute(`
        SELECT COUNT(*) as count, COUNT(DISTINCT symbol) as symbols
        FROM ${today}
      `);
      const result = (rows as any[])[0];

      return {
        today_count: result.count || 0,
        today_symbols: result.symbols || 0,
        buffer_size: this.write_buffer.length
      };
    } catch (error: any) {
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return {
          today_count: 0,
          today_symbols: 0,
          buffer_size: this.write_buffer.length
        };
      }
      throw error;
    }
  }
}
