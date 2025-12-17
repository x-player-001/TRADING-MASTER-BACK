/**
 * 边界报警数据存储层
 *
 * 当价格触碰区间的上下边界时生成报警信号
 */

import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';

// 边界报警数据结构
export interface BoundaryAlertData {
  id?: number;
  symbol: string;
  alert_type: 'TOUCH_UPPER' | 'TOUCH_LOWER';  // 触碰上沿 / 触碰下沿
  alert_price: number;                         // 触碰时的价格
  upper_bound: number;                         // 区间上沿
  lower_bound: number;                         // 区间下沿
  extended_high: number;                       // 扩展上沿 (P95)
  extended_low: number;                        // 扩展下沿 (P5)
  zone_score: number;                          // 区间评分
  zone_start_time: Date;                       // 区间开始时间
  zone_end_time: Date;                         // 区间结束时间
  zone_kline_count: number;                    // 区间K线数量
  kline_open: number;                          // 触发K线开盘价
  kline_high: number;                          // 触发K线最高价
  kline_low: number;                           // 触发K线最低价
  kline_close: number;                         // 触发K线收盘价
  kline_volume: number;                        // 触发K线成交量
  alert_time: Date;                            // 报警时间
  created_at?: Date;
}

export class BoundaryAlertRepository {
  private table_name = 'boundary_alerts';
  private table_initialized = false;

  /**
   * 确保表存在
   */
  async ensure_table_exists(): Promise<void> {
    if (this.table_initialized) return;

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const create_sql = `
        CREATE TABLE IF NOT EXISTS ${this.table_name} (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          symbol VARCHAR(20) NOT NULL,
          alert_type ENUM('TOUCH_UPPER', 'TOUCH_LOWER') NOT NULL,
          alert_price DECIMAL(20,8) NOT NULL,
          upper_bound DECIMAL(20,8) NOT NULL,
          lower_bound DECIMAL(20,8) NOT NULL,
          extended_high DECIMAL(20,8) NOT NULL,
          extended_low DECIMAL(20,8) NOT NULL,
          zone_score INT NOT NULL,
          zone_start_time DATETIME NOT NULL,
          zone_end_time DATETIME NOT NULL,
          zone_kline_count INT NOT NULL,
          kline_open DECIMAL(20,8) NOT NULL,
          kline_high DECIMAL(20,8) NOT NULL,
          kline_low DECIMAL(20,8) NOT NULL,
          kline_close DECIMAL(20,8) NOT NULL,
          kline_volume DECIMAL(30,8) NOT NULL,
          alert_time DATETIME NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          INDEX idx_symbol (symbol),
          INDEX idx_alert_type (alert_type),
          INDEX idx_alert_time (alert_time),
          INDEX idx_symbol_time (symbol, alert_time)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='区间边界报警信号'
      `;

      await connection.execute(create_sql);
      this.table_initialized = true;
      logger.info('[BoundaryAlert] 表已初始化');
    } catch (error: any) {
      if (!error.message?.includes('already exists')) {
        throw error;
      }
      this.table_initialized = true;
    } finally {
      connection.release();
    }
  }

  /**
   * 保存边界报警
   */
  async save(alert: BoundaryAlertData): Promise<number> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        INSERT INTO ${this.table_name} (
          symbol, alert_type, alert_price,
          upper_bound, lower_bound, extended_high, extended_low,
          zone_score, zone_start_time, zone_end_time, zone_kline_count,
          kline_open, kline_high, kline_low, kline_close, kline_volume,
          alert_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await connection.execute(sql, [
        alert.symbol,
        alert.alert_type,
        alert.alert_price,
        alert.upper_bound,
        alert.lower_bound,
        alert.extended_high,
        alert.extended_low,
        alert.zone_score,
        alert.zone_start_time,
        alert.zone_end_time,
        alert.zone_kline_count,
        alert.kline_open,
        alert.kline_high,
        alert.kline_low,
        alert.kline_close,
        alert.kline_volume,
        alert.alert_time
      ]);

      return (result as any).insertId;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取最近的报警信号
   */
  async get_recent_alerts(limit: number = 50): Promise<BoundaryAlertData[]> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM ${this.table_name}
        ORDER BY alert_time DESC
        LIMIT ?
      `;

      const [rows] = await connection.execute(sql, [limit]);
      return rows as BoundaryAlertData[];
    } finally {
      connection.release();
    }
  }

  /**
   * 获取指定币种的最近报警
   */
  async get_alerts_by_symbol(symbol: string, limit: number = 20): Promise<BoundaryAlertData[]> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM ${this.table_name}
        WHERE symbol = ?
        ORDER BY alert_time DESC
        LIMIT ?
      `;

      const [rows] = await connection.execute(sql, [symbol, limit]);
      return rows as BoundaryAlertData[];
    } finally {
      connection.release();
    }
  }

  /**
   * 获取指定时间范围内的报警
   */
  async get_alerts_by_time_range(
    start_time: Date,
    end_time: Date,
    symbol?: string
  ): Promise<BoundaryAlertData[]> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      let sql = `
        SELECT * FROM ${this.table_name}
        WHERE alert_time >= ? AND alert_time <= ?
      `;
      const params: any[] = [start_time, end_time];

      if (symbol) {
        sql += ' AND symbol = ?';
        params.push(symbol);
      }

      sql += ' ORDER BY alert_time DESC';

      const [rows] = await connection.execute(sql, params);
      return rows as BoundaryAlertData[];
    } finally {
      connection.release();
    }
  }

  /**
   * 检查是否存在重复报警（同一币种、同一类型、指定时间内）
   */
  async has_recent_alert(
    symbol: string,
    alert_type: 'TOUCH_UPPER' | 'TOUCH_LOWER',
    cooldown_minutes: number = 30
  ): Promise<boolean> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT COUNT(*) as count FROM ${this.table_name}
        WHERE symbol = ? AND alert_type = ?
        AND alert_time >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
      `;

      const [rows] = await connection.execute(sql, [symbol, alert_type, cooldown_minutes]);
      return (rows as any)[0].count > 0;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取今日报警统计
   */
  async get_today_statistics(): Promise<{
    total_count: number;
    upper_count: number;
    lower_count: number;
    symbols_count: number;
  }> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT
          COUNT(*) as total_count,
          SUM(CASE WHEN alert_type = 'TOUCH_UPPER' THEN 1 ELSE 0 END) as upper_count,
          SUM(CASE WHEN alert_type = 'TOUCH_LOWER' THEN 1 ELSE 0 END) as lower_count,
          COUNT(DISTINCT symbol) as symbols_count
        FROM ${this.table_name}
        WHERE DATE(alert_time) = CURDATE()
      `;

      const [rows] = await connection.execute(sql);
      const result = (rows as any)[0];

      return {
        total_count: result.total_count || 0,
        upper_count: result.upper_count || 0,
        lower_count: result.lower_count || 0,
        symbols_count: result.symbols_count || 0
      };
    } finally {
      connection.release();
    }
  }

  /**
   * 清理旧数据
   */
  async cleanup_old_alerts(days_to_keep: number = 7): Promise<number> {
    await this.ensure_table_exists();

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        DELETE FROM ${this.table_name}
        WHERE alert_time < DATE_SUB(NOW(), INTERVAL ? DAY)
      `;

      const [result] = await connection.execute(sql, [days_to_keep]);
      return (result as any).affectedRows;
    } finally {
      connection.release();
    }
  }
}
