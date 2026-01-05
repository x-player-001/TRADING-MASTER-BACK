/**
 * 订单簿报警相关数据库操作
 */

import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';
import {
  OrderBookAlert,
  OrderBookAlertType,
  AlertSeverity,
  OrderBookAlertQueryOptions,
  OrderBookMonitorStatistics
} from '@/types/orderbook_types';

export class OrderBookAlertRepository extends BaseRepository {

  /**
   * 初始化表结构
   */
  async init_tables(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const create_alerts_table = `
        CREATE TABLE IF NOT EXISTS orderbook_alerts (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL,
          alert_time BIGINT NOT NULL,
          alert_type ENUM('BIG_ORDER', 'IMBALANCE', 'WITHDRAWAL') NOT NULL,
          side ENUM('BID', 'ASK') NULL,

          -- 大单检测相关字段
          order_price DECIMAL(20,8) NULL,
          order_qty DECIMAL(30,8) NULL,
          order_value_usdt DECIMAL(30,8) NULL,
          avg_order_qty DECIMAL(30,8) NULL,
          order_ratio DECIMAL(10,2) NULL,

          -- 买卖失衡相关字段
          bid_total_qty DECIMAL(30,8) NULL,
          ask_total_qty DECIMAL(30,8) NULL,
          imbalance_ratio DECIMAL(10,4) NULL,

          -- 撤单检测相关字段
          prev_qty DECIMAL(30,8) NULL,
          curr_qty DECIMAL(30,8) NULL,
          withdrawn_qty DECIMAL(30,8) NULL,
          withdrawn_value_usdt DECIMAL(30,8) NULL,

          -- 通用字段
          current_price DECIMAL(20,8) NOT NULL,
          severity ENUM('LOW', 'MEDIUM', 'HIGH') DEFAULT 'LOW',
          is_important TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          UNIQUE KEY uk_symbol_time_type (symbol, alert_time, alert_type),
          INDEX idx_created_at (created_at),
          INDEX idx_alert_type (alert_type),
          INDEX idx_severity (severity),
          INDEX idx_is_important (is_important),
          INDEX idx_symbol (symbol),
          INDEX idx_side (side)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单簿报警记录'
      `;

      try {
        await conn.execute(create_alerts_table);
        logger.info('[OrderBookAlertRepository] Tables initialized successfully');
      } catch (error) {
        logger.error('[OrderBookAlertRepository] Failed to initialize tables', error);
        throw error;
      }
    });
  }

  /**
   * 保存报警记录
   */
  async save_alert(alert: Omit<OrderBookAlert, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO orderbook_alerts
         (symbol, alert_time, alert_type, side,
          order_price, order_qty, order_value_usdt, avg_order_qty, order_ratio,
          bid_total_qty, ask_total_qty, imbalance_ratio,
          prev_qty, curr_qty, withdrawn_qty, withdrawn_value_usdt,
          current_price, severity, is_important)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alert.symbol,
          alert.alert_time,
          alert.alert_type,
          alert.side || null,
          alert.order_price || null,
          alert.order_qty || null,
          alert.order_value_usdt || null,
          alert.avg_order_qty || null,
          alert.order_ratio || null,
          alert.bid_total_qty || null,
          alert.ask_total_qty || null,
          alert.imbalance_ratio || null,
          alert.prev_qty || null,
          alert.curr_qty || null,
          alert.withdrawn_qty || null,
          alert.withdrawn_value_usdt || null,
          alert.current_price,
          alert.severity,
          alert.is_important ? 1 : 0
        ]
      );
      return result.insertId;
    });
  }

  /**
   * 批量保存报警记录
   */
  async save_alerts_batch(alerts: Omit<OrderBookAlert, 'id' | 'created_at'>[]): Promise<number> {
    if (alerts.length === 0) return 0;

    return this.execute_with_connection(async (conn) => {
      let inserted = 0;

      for (const alert of alerts) {
        const [result] = await conn.execute<ResultSetHeader>(
          `INSERT IGNORE INTO orderbook_alerts
           (symbol, alert_time, alert_type, side,
            order_price, order_qty, order_value_usdt, avg_order_qty, order_ratio,
            bid_total_qty, ask_total_qty, imbalance_ratio,
            prev_qty, curr_qty, withdrawn_qty, withdrawn_value_usdt,
            current_price, severity, is_important)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            alert.symbol,
            alert.alert_time,
            alert.alert_type,
            alert.side || null,
            alert.order_price || null,
            alert.order_qty || null,
            alert.order_value_usdt || null,
            alert.avg_order_qty || null,
            alert.order_ratio || null,
            alert.bid_total_qty || null,
            alert.ask_total_qty || null,
            alert.imbalance_ratio || null,
            alert.prev_qty || null,
            alert.curr_qty || null,
            alert.withdrawn_qty || null,
            alert.withdrawn_value_usdt || null,
            alert.current_price,
            alert.severity,
            alert.is_important ? 1 : 0
          ]
        );

        if (result.insertId > 0) {
          inserted++;
        }
      }

      return inserted;
    });
  }

  /**
   * 查询报警记录
   */
  async get_alerts(options: OrderBookAlertQueryOptions = {}): Promise<(OrderBookAlert & { daily_alert_index?: number })[]> {
    return this.execute_with_connection(async (conn) => {
      // 日期转时间戳
      let date_start_time: number | undefined;
      let date_end_time: number | undefined;

      if (options.date) {
        const date = new Date(options.date + 'T00:00:00+08:00');
        date_start_time = date.getTime();
        date_end_time = date_start_time + 24 * 60 * 60 * 1000 - 1;
      }

      let sql = 'SELECT * FROM orderbook_alerts WHERE 1=1';
      const params: any[] = [];

      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }

      if (options.alert_type) {
        sql += ' AND alert_type = ?';
        params.push(options.alert_type);
      }

      if (options.side) {
        sql += ' AND side = ?';
        params.push(options.side);
      }

      if (options.severity) {
        sql += ' AND severity = ?';
        params.push(options.severity);
      }

      if (options.is_important !== undefined) {
        sql += ' AND is_important = ?';
        params.push(options.is_important ? 1 : 0);
      }

      // 时间范围
      if (date_start_time !== undefined) {
        sql += ' AND alert_time >= ?';
        params.push(date_start_time);
      } else if (options.start_time) {
        sql += ' AND alert_time >= ?';
        params.push(options.start_time);
      }

      if (date_end_time !== undefined) {
        sql += ' AND alert_time <= ?';
        params.push(date_end_time);
      } else if (options.end_time) {
        sql += ' AND alert_time <= ?';
        params.push(options.end_time);
      }

      sql += ' ORDER BY alert_time ASC';

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      const alerts = rows.map(row => this.map_to_alert(row));

      // 计算每个币种当天第几次报警
      const symbol_count_map = new Map<string, number>();
      const alerts_with_index = alerts.map(alert => {
        const count = (symbol_count_map.get(alert.symbol) || 0) + 1;
        symbol_count_map.set(alert.symbol, count);
        return {
          ...alert,
          daily_alert_index: count
        };
      });

      // 按时间倒序返回
      alerts_with_index.reverse();

      // 应用 limit
      if (options.limit && alerts_with_index.length > options.limit) {
        return alerts_with_index.slice(0, options.limit);
      }

      return alerts_with_index;
    });
  }

  /**
   * 获取最近N分钟的报警
   */
  async get_recent_alerts(minutes: number = 30, symbol?: string): Promise<OrderBookAlert[]> {
    const start_time = Date.now() - minutes * 60 * 1000;

    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM orderbook_alerts WHERE alert_time >= ?';
      const params: any[] = [start_time];

      if (symbol) {
        sql += ' AND symbol = ?';
        params.push(symbol.toUpperCase());
      }

      sql += ' ORDER BY alert_time DESC';

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(row => this.map_to_alert(row));
    });
  }

  /**
   * 获取统计数据
   */
  async get_statistics(date?: string): Promise<OrderBookMonitorStatistics> {
    return this.execute_with_connection(async (conn) => {
      let time_condition = '';
      const params: any[] = [];

      if (date) {
        const date_obj = new Date(date + 'T00:00:00+08:00');
        const start_time = date_obj.getTime();
        const end_time = start_time + 24 * 60 * 60 * 1000 - 1;
        time_condition = ' WHERE alert_time >= ? AND alert_time <= ?';
        params.push(start_time, end_time);
      }

      const [total_rows] = await conn.execute<RowDataPacket[]>(
        `SELECT COUNT(*) as total FROM orderbook_alerts${time_condition}`,
        params
      );

      const [type_rows] = await conn.execute<RowDataPacket[]>(
        `SELECT alert_type, COUNT(*) as count FROM orderbook_alerts${time_condition} GROUP BY alert_type`,
        params
      );

      const [important_rows] = await conn.execute<RowDataPacket[]>(
        `SELECT COUNT(*) as count FROM orderbook_alerts${time_condition ? time_condition + ' AND' : ' WHERE'} is_important = 1`,
        params
      );

      const [symbols_rows] = await conn.execute<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT symbol) as count FROM orderbook_alerts${time_condition}`,
        params
      );

      const type_map = new Map<string, number>();
      for (const row of type_rows) {
        type_map.set(row.alert_type, row.count);
      }

      return {
        total_alerts: total_rows[0].total,
        big_order_alerts: type_map.get('BIG_ORDER') || 0,
        imbalance_alerts: type_map.get('IMBALANCE') || 0,
        withdrawal_alerts: type_map.get('WITHDRAWAL') || 0,
        important_alerts: important_rows[0].count,
        symbols_with_alerts: symbols_rows[0].count
      };
    });
  }

  /**
   * 清理旧报警记录
   */
  async cleanup_old_alerts(days_to_keep: number = 30): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const cutoff = Date.now() - days_to_keep * 24 * 60 * 60 * 1000;
      const [result] = await conn.execute<ResultSetHeader>(
        'DELETE FROM orderbook_alerts WHERE alert_time < ?',
        [cutoff]
      );
      return result.affectedRows;
    });
  }

  /**
   * 检查报警是否已存在
   */
  async alert_exists(symbol: string, alert_time: number, alert_type: OrderBookAlertType): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) as cnt FROM orderbook_alerts WHERE symbol = ? AND alert_time = ? AND alert_type = ?',
        [symbol.toUpperCase(), alert_time, alert_type]
      );
      return rows[0].cnt > 0;
    });
  }

  /**
   * 映射数据库行到报警对象
   */
  private map_to_alert(row: RowDataPacket): OrderBookAlert {
    return {
      id: row.id,
      symbol: row.symbol,
      alert_time: Number(row.alert_time),
      alert_type: row.alert_type as OrderBookAlertType,
      side: row.side || undefined,
      order_price: row.order_price ? parseFloat(row.order_price) : undefined,
      order_qty: row.order_qty ? parseFloat(row.order_qty) : undefined,
      order_value_usdt: row.order_value_usdt ? parseFloat(row.order_value_usdt) : undefined,
      avg_order_qty: row.avg_order_qty ? parseFloat(row.avg_order_qty) : undefined,
      order_ratio: row.order_ratio ? parseFloat(row.order_ratio) : undefined,
      bid_total_qty: row.bid_total_qty ? parseFloat(row.bid_total_qty) : undefined,
      ask_total_qty: row.ask_total_qty ? parseFloat(row.ask_total_qty) : undefined,
      imbalance_ratio: row.imbalance_ratio ? parseFloat(row.imbalance_ratio) : undefined,
      prev_qty: row.prev_qty ? parseFloat(row.prev_qty) : undefined,
      curr_qty: row.curr_qty ? parseFloat(row.curr_qty) : undefined,
      withdrawn_qty: row.withdrawn_qty ? parseFloat(row.withdrawn_qty) : undefined,
      withdrawn_value_usdt: row.withdrawn_value_usdt ? parseFloat(row.withdrawn_value_usdt) : undefined,
      current_price: parseFloat(row.current_price),
      severity: row.severity as AlertSeverity,
      is_important: row.is_important === 1,
      created_at: row.created_at
    };
  }
}
