import { BaseRepository } from './base_repository';
import { KlineData } from '@/types/common';
import { logger } from '@/utils/logger';
import { ResultSetHeader, RowDataPacket } from 'mysql2';

/**
 * 分表K线数据记录接口
 */
export interface KlineMultiTableRecord extends RowDataPacket {
  id?: number;
  symbol: string;
  open_time: Date;
  close_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
  created_at?: Date;
}

/**
 * K线数据分表仓库 - 支持按时间周期分表
 */
export class KlineMultiTableRepository extends BaseRepository {

  // 表名映射
  private readonly TABLE_MAP: Record<string, string> = {
    '1m': 'kline_1m',
    '5m': 'kline_5m',
    '15m': 'kline_15m',
    '1h': 'kline_1h'
  };

  // 支持的时间周期
  private readonly SUPPORTED_INTERVALS = ['1m', '5m', '15m', '1h'];

  /**
   * 获取表名
   */
  private get_table_name(interval: string): string {
    const table_name = this.TABLE_MAP[interval];
    if (!table_name) {
      throw new Error(`Unsupported interval: ${interval}. Supported intervals: ${this.SUPPORTED_INTERVALS.join(', ')}`);
    }
    return table_name;
  }

  /**
   * 创建所有K线分表
   */
  async create_tables(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      for (const interval of this.SUPPORTED_INTERVALS) {
        const table_name = this.get_table_name(interval);
        const comment = this.get_table_comment(interval);

        const sql = `
          CREATE TABLE IF NOT EXISTS ${table_name} (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            symbol VARCHAR(20) NOT NULL COMMENT '交易对符号',
            open_time TIMESTAMP(3) NOT NULL COMMENT 'K线开始时间',
            close_time TIMESTAMP(3) NOT NULL COMMENT 'K线结束时间',
            open DECIMAL(20,8) NOT NULL COMMENT '开盘价',
            high DECIMAL(20,8) NOT NULL COMMENT '最高价',
            low DECIMAL(20,8) NOT NULL COMMENT '最低价',
            close DECIMAL(20,8) NOT NULL COMMENT '收盘价',
            volume DECIMAL(30,8) NOT NULL COMMENT '成交量',
            trade_count INT NOT NULL COMMENT '成交笔数',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            UNIQUE KEY uk_symbol_time (symbol, open_time),
            INDEX idx_symbol_time_desc (symbol, open_time DESC),
            INDEX idx_time_desc (open_time DESC),
            INDEX idx_symbol (symbol)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='${comment}'
        `;

        await conn.execute(sql);
        logger.info(`Created K-line table: ${table_name}`);
      }
    });
  }

  /**
   * 获取表注释
   */
  private get_table_comment(interval: string): string {
    const comment_map: Record<string, string> = {
      '1m': '1分钟K线数据表',
      '5m': '5分钟K线数据表',
      '15m': '15分钟K线数据表',
      '1h': '1小时K线数据表'
    };
    return comment_map[interval] || `${interval}K线数据表`;
  }

  /**
   * 批量插入K线数据
   */
  async batch_insert(kline_data_list: KlineData[]): Promise<number> {
    if (kline_data_list.length === 0) {
      return 0;
    }

    // 按interval分组
    const grouped_data = this.group_by_interval(kline_data_list);
    let total_inserted = 0;

    for (const [interval, data] of Object.entries(grouped_data)) {
      try {
        const inserted_count = await this.insert_to_table(interval, data);
        total_inserted += inserted_count;
      } catch (error) {
        logger.error(`Failed to insert data for interval ${interval}:`, error);
      }
    }

    return total_inserted;
  }

  /**
   * 按interval分组数据
   */
  private group_by_interval(kline_data_list: KlineData[]): Record<string, KlineData[]> {
    const grouped: Record<string, KlineData[]> = {};

    for (const kline of kline_data_list) {
      const interval = kline.interval;
      if (this.SUPPORTED_INTERVALS.includes(interval)) {
        if (!grouped[interval]) {
          grouped[interval] = [];
        }
        grouped[interval].push(kline);
      } else {
        logger.warn(`Skipping unsupported interval: ${interval}`);
      }
    }

    return grouped;
  }

  /**
   * 插入数据到指定表
   */
  private async insert_to_table(interval: string, data: KlineData[]): Promise<number> {
    if (data.length === 0) {
      return 0;
    }

    return this.execute_with_connection(async (conn) => {
      const table_name = this.get_table_name(interval);

      // 构建批量插入SQL
      const sql = `
        INSERT IGNORE INTO ${table_name}
        (symbol, open_time, close_time, open, high, low, close, volume, trade_count)
        VALUES ${data.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
      `;

      // 构建参数数组
      const values: any[] = [];
      for (const kline of data) {
        values.push(
          kline.symbol.toUpperCase(),
          new Date(kline.open_time),
          new Date(kline.close_time),
          kline.open,
          kline.high,
          kline.low,
          kline.close,
          kline.volume,
          kline.trade_count
        );
      }

      const [result] = await conn.execute<ResultSetHeader>(sql, values);
      return result.affectedRows;
    });
  }

  /**
   * 按时间范围查询K线数据
   */
  async find_by_time_range(
    symbol: string,
    interval: string,
    start_time?: number,
    end_time?: number,
    limit: number = 300
  ): Promise<KlineData[]> {
    return this.execute_with_connection(async (conn) => {
      const table_name = this.get_table_name(interval);

      let sql = `
        SELECT symbol, open_time, close_time, open, high, low, close, volume, trade_count
        FROM ${table_name}
        WHERE symbol = ?
      `;

      const params: any[] = [symbol.toUpperCase()];

      if (start_time) {
        sql += ' AND open_time >= ?';
        params.push(new Date(start_time));
      }

      if (end_time) {
        sql += ' AND open_time <= ?';
        params.push(new Date(end_time));
      }

      // 如果指定了时间范围，返回范围内所有数据；否则使用LIMIT
      if (start_time && end_time) {
        sql += ' ORDER BY open_time DESC';
      } else {
        sql += ' ORDER BY open_time DESC LIMIT ?';
        params.push(Math.floor(Number(limit)) || 300);
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      const records = rows as KlineMultiTableRecord[];

      return records.map(record => this.convert_to_kline_data(record, interval));
    });
  }

  /**
   * 获取最新K线数据
   */
  async find_latest(symbol: string, interval: string, limit: number = 100): Promise<KlineData[]> {
    return this.execute_with_connection(async (conn) => {
      const table_name = this.get_table_name(interval);

      const sql = `
        SELECT symbol, open_time, close_time, open, high, low, close, volume, trade_count
        FROM ${table_name}
        WHERE symbol = ?
        ORDER BY open_time DESC
        LIMIT ?
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [
        symbol.toUpperCase(),
        Math.floor(Number(limit)) || 100
      ]);

      const records = rows as KlineMultiTableRecord[];

      return records.map(record => this.convert_to_kline_data(record, interval));
    });
  }

  /**
   * 获取数据统计信息
   */
  async get_statistics(): Promise<Record<string, any>> {
    return this.execute_with_connection(async (conn) => {
      const stats: Record<string, any> = {};

      for (const interval of this.SUPPORTED_INTERVALS) {
        const table_name = this.get_table_name(interval);

        const sql = `
          SELECT
            COUNT(*) as total_count,
            COUNT(DISTINCT symbol) as unique_symbols,
            MIN(open_time) as earliest_time,
            MAX(open_time) as latest_time
          FROM ${table_name}
        `;

        const [rows] = await conn.execute<RowDataPacket[]>(sql);
        stats[interval] = rows[0];
      }

      return stats;
    });
  }

  /**
   * 获取指定币种的数据统计
   */
  async get_symbol_statistics(symbol: string): Promise<Record<string, any>> {
    return this.execute_with_connection(async (conn) => {
      const stats: Record<string, any> = {};

      for (const interval of this.SUPPORTED_INTERVALS) {
        const table_name = this.get_table_name(interval);

        const sql = `
          SELECT
            COUNT(*) as count,
            MIN(open_time) as earliest_time,
            MAX(open_time) as latest_time
          FROM ${table_name}
          WHERE symbol = ?
        `;

        const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol.toUpperCase()]);
        stats[interval] = rows[0];
      }

      return stats;
    });
  }

  /**
   * 获取指定币种和周期的最早K线时间戳
   * @param symbol 币种符号
   * @param interval 时间周期
   * @returns 最早K线的open_time时间戳(毫秒)，如果没有数据返回null
   */
  async get_earliest_kline_time(symbol: string, interval: string): Promise<number | null> {
    return this.execute_with_connection(async (conn) => {
      const table_name = this.get_table_name(interval);

      const sql = `
        SELECT MIN(open_time) as earliest_time
        FROM ${table_name}
        WHERE symbol = ?
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol.toUpperCase()]);
      const earliest = rows[0]?.earliest_time;

      // 如果是Date对象，转换为时间戳；如果已经是数字，直接返回
      if (earliest instanceof Date) {
        return earliest.getTime();
      } else if (typeof earliest === 'number') {
        return earliest;
      }

      return null;
    });
  }

  /**
   * 获取指定币种和周期的总记录数
   * @param symbol 币种符号
   * @param interval 时间周期
   * @returns 总记录数
   */
  async get_total_count(symbol: string, interval: string): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const table_name = this.get_table_name(interval);

      const sql = `
        SELECT COUNT(*) as total_count
        FROM ${table_name}
        WHERE symbol = ?
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol.toUpperCase()]);
      return rows[0]?.total_count || 0;
    });
  }

  /**
   * 检查数据完整性
   */
  async check_data_integrity(symbol: string, interval: string, days: number = 1): Promise<{
    expected_count: number;
    actual_count: number;
    missing_count: number;
    completeness_rate: number;
  }> {
    return this.execute_with_connection(async (conn) => {
      const table_name = this.get_table_name(interval);
      const end_time = new Date();
      const start_time = new Date(end_time.getTime() - days * 24 * 60 * 60 * 1000);

      // 计算期望的K线数量
      const interval_ms = this.get_interval_milliseconds(interval);
      const expected_count = Math.floor((end_time.getTime() - start_time.getTime()) / interval_ms);

      // 查询实际数量
      const sql = `
        SELECT COUNT(*) as count
        FROM ${table_name}
        WHERE symbol = ? AND open_time >= ? AND open_time <= ?
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [
        symbol.toUpperCase(),
        start_time,
        end_time
      ]);

      const actual_count = rows[0].count;
      const missing_count = Math.max(0, expected_count - actual_count);
      const completeness_rate = expected_count > 0 ? (actual_count / expected_count) * 100 : 0;

      return {
        expected_count,
        actual_count,
        missing_count,
        completeness_rate
      };
    });
  }

  /**
   * 清理旧数据
   */
  async cleanup_old_data(days_to_keep: number = 30): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const cutoff_date = new Date();
      cutoff_date.setDate(cutoff_date.getDate() - days_to_keep);

      let total_deleted = 0;

      for (const interval of this.SUPPORTED_INTERVALS) {
        const table_name = this.get_table_name(interval);

        const sql = `DELETE FROM ${table_name} WHERE open_time < ?`;
        const [result] = await conn.execute<ResultSetHeader>(sql, [cutoff_date]);

        if (result.affectedRows > 0) {
          logger.info(`Cleaned up ${result.affectedRows} old records from ${table_name}`);
          total_deleted += result.affectedRows;
        }
      }

      return total_deleted;
    });
  }

  /**
   * 将数据库记录转换为KlineData格式
   */
  private convert_to_kline_data(record: KlineMultiTableRecord, interval: string): KlineData {
    return {
      symbol: record.symbol,
      interval: interval,
      open_time: record.open_time.getTime(),
      close_time: record.close_time.getTime(),
      open: Number(record.open),
      high: Number(record.high),
      low: Number(record.low),
      close: Number(record.close),
      volume: Number(record.volume),
      trade_count: Number(record.trade_count),
      is_final: true
    };
  }

  /**
   * 获取时间间隔的毫秒数
   */
  private get_interval_milliseconds(interval: string): number {
    const interval_map: Record<string, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000
    };

    return interval_map[interval] || 60 * 1000;
  }

  /**
   * 获取支持的时间周期列表
   */
  get_supported_intervals(): string[] {
    return [...this.SUPPORTED_INTERVALS];
  }
}