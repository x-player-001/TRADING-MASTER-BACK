/**
 * 成交量监控相关数据库操作
 *
 * 包含:
 * 1. 监控币种配置表 (volume_monitor_symbols)
 * 2. 放量报警记录表 (volume_alerts)
 */

import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

/**
 * 监控币种配置
 */
export interface VolumeMonitorSymbol {
  id?: number;
  symbol: string;
  enabled: boolean;
  volume_multiplier: number;    // 放量倍数阈值
  lookback_bars: number;        // 计算基准的K线数
  min_volume_usdt: number;      // 最小成交额
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 放量报警记录
 */
export interface VolumeAlert {
  id?: number;
  symbol: string;
  kline_time: number;
  current_volume: number;
  avg_volume: number;
  volume_ratio: number;         // 放量倍数
  price_change_pct: number;     // K线涨跌幅
  direction: 'UP' | 'DOWN';     // 放量方向
  current_price: number;
  is_important: boolean;        // 是否为重要信号 (≥10x)
  created_at?: Date;
}

/**
 * 形态报警记录（倒锤头穿越EMA120等）
 */
export interface PatternAlert {
  id?: number;
  symbol: string;
  kline_time: number;
  pattern_type: 'HAMMER_CROSS_EMA';  // 形态类型
  current_price: number;
  price_change_pct: number;
  ema120: number;                    // EMA120值
  lower_shadow_pct: number;          // 下影线百分比
  upper_shadow_pct: number;          // 上影线百分比
  is_final: boolean;                 // 是否为完结K线
  created_at?: Date;
}

export class VolumeMonitorRepository extends BaseRepository {

  /**
   * 初始化表结构
   */
  async init_tables(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      // 监控币种配置表
      const create_symbols_table = `
        CREATE TABLE IF NOT EXISTS volume_monitor_symbols (
          id INT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL UNIQUE,
          enabled TINYINT(1) DEFAULT 1,
          volume_multiplier DECIMAL(5,2) DEFAULT 2.5,
          lookback_bars INT DEFAULT 20,
          min_volume_usdt DECIMAL(20,2) DEFAULT 100000,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

          INDEX idx_enabled (enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='成交量监控币种配置'
      `;

      // 放量报警记录表
      const create_alerts_table = `
        CREATE TABLE IF NOT EXISTS volume_alerts (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL,
          kline_time BIGINT NOT NULL,
          current_volume DECIMAL(30,8) NOT NULL,
          avg_volume DECIMAL(30,8) NOT NULL,
          volume_ratio DECIMAL(10,2) NOT NULL,
          price_change_pct DECIMAL(10,4) NOT NULL,
          direction ENUM('UP', 'DOWN') NOT NULL,
          current_price DECIMAL(20,8) NOT NULL,
          is_important TINYINT(1) DEFAULT 0 COMMENT '是否为重要信号 (>=10x)',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          UNIQUE KEY uk_symbol_time (symbol, kline_time),
          INDEX idx_created_at (created_at),
          INDEX idx_volume_ratio (volume_ratio),
          INDEX idx_direction (direction),
          INDEX idx_is_important (is_important)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='放量报警记录'
      `;

      // 形态报警记录表
      const create_pattern_alerts_table = `
        CREATE TABLE IF NOT EXISTS pattern_alerts (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL,
          kline_time BIGINT NOT NULL,
          pattern_type VARCHAR(30) NOT NULL COMMENT '形态类型: HAMMER_CROSS_EMA',
          current_price DECIMAL(20,8) NOT NULL,
          price_change_pct DECIMAL(10,4) NOT NULL,
          ema120 DECIMAL(20,8) NOT NULL COMMENT 'EMA120值',
          lower_shadow_pct DECIMAL(10,4) NOT NULL COMMENT '下影线百分比',
          upper_shadow_pct DECIMAL(10,4) NOT NULL COMMENT '上影线百分比',
          is_final TINYINT(1) DEFAULT 0 COMMENT '是否为完结K线',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          UNIQUE KEY uk_symbol_time_type (symbol, kline_time, pattern_type),
          INDEX idx_created_at (created_at),
          INDEX idx_pattern_type (pattern_type),
          INDEX idx_is_final (is_final)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='形态报警记录'
      `;

      // 检查并添加 is_important 字段（兼容旧表）
      const add_is_important_column = `
        ALTER TABLE volume_alerts
        ADD COLUMN IF NOT EXISTS is_important TINYINT(1) DEFAULT 0
        COMMENT '是否为重要信号 (>=10x)'
      `;

      try {
        await conn.execute(create_symbols_table);
        await conn.execute(create_alerts_table);
        await conn.execute(create_pattern_alerts_table);

        // 尝试添加 is_important 字段（如果表已存在但没有此字段）
        try {
          await conn.execute(add_is_important_column);
        } catch {
          // 字段可能已存在，忽略错误
        }

        logger.info('Volume monitor tables initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize volume monitor tables', error);
        throw error;
      }
    });
  }

  // ==================== 监控币种配置操作 ====================

  /**
   * 获取所有监控币种
   */
  async get_all_symbols(): Promise<VolumeMonitorSymbol[]> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT * FROM volume_monitor_symbols ORDER BY symbol'
      );
      return rows.map(row => this.map_to_symbol(row));
    });
  }

  /**
   * 获取启用的监控币种
   */
  async get_enabled_symbols(): Promise<VolumeMonitorSymbol[]> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT * FROM volume_monitor_symbols WHERE enabled = 1 ORDER BY symbol'
      );
      return rows.map(row => this.map_to_symbol(row));
    });
  }

  /**
   * 获取单个币种配置
   */
  async get_symbol(symbol: string): Promise<VolumeMonitorSymbol | null> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT * FROM volume_monitor_symbols WHERE symbol = ?',
        [symbol.toUpperCase()]
      );
      return rows.length > 0 ? this.map_to_symbol(rows[0]) : null;
    });
  }

  /**
   * 添加监控币种
   */
  async add_symbol(config: Omit<VolumeMonitorSymbol, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO volume_monitor_symbols
         (symbol, enabled, volume_multiplier, lookback_bars, min_volume_usdt)
         VALUES (?, ?, ?, ?, ?)`,
        [
          config.symbol.toUpperCase(),
          config.enabled ? 1 : 0,
          config.volume_multiplier,
          config.lookback_bars,
          config.min_volume_usdt
        ]
      );
      return result.insertId;
    });
  }

  /**
   * 更新监控币种配置
   */
  async update_symbol(
    symbol: string,
    updates: Partial<Omit<VolumeMonitorSymbol, 'id' | 'symbol' | 'created_at' | 'updated_at'>>
  ): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled ? 1 : 0);
      }
      if (updates.volume_multiplier !== undefined) {
        fields.push('volume_multiplier = ?');
        values.push(updates.volume_multiplier);
      }
      if (updates.lookback_bars !== undefined) {
        fields.push('lookback_bars = ?');
        values.push(updates.lookback_bars);
      }
      if (updates.min_volume_usdt !== undefined) {
        fields.push('min_volume_usdt = ?');
        values.push(updates.min_volume_usdt);
      }

      if (fields.length === 0) {
        return false;
      }

      values.push(symbol.toUpperCase());

      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE volume_monitor_symbols SET ${fields.join(', ')} WHERE symbol = ?`,
        values
      );

      return result.affectedRows > 0;
    });
  }

  /**
   * 删除监控币种
   */
  async delete_symbol(symbol: string): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        'DELETE FROM volume_monitor_symbols WHERE symbol = ?',
        [symbol.toUpperCase()]
      );
      return result.affectedRows > 0;
    });
  }

  /**
   * 切换币种启用状态
   */
  async toggle_symbol(symbol: string): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        'UPDATE volume_monitor_symbols SET enabled = NOT enabled WHERE symbol = ?',
        [symbol.toUpperCase()]
      );
      return result.affectedRows > 0;
    });
  }

  /**
   * 批量添加币种
   */
  async add_symbols_batch(symbols: string[]): Promise<number> {
    if (symbols.length === 0) return 0;

    return this.execute_with_connection(async (conn) => {
      const placeholders = symbols.map(() => '(?, 1, 2.5, 20, 100000)').join(', ');
      const values = symbols.map(s => s.toUpperCase());

      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO volume_monitor_symbols
         (symbol, enabled, volume_multiplier, lookback_bars, min_volume_usdt)
         VALUES ${placeholders}`,
        values
      );

      return result.affectedRows;
    });
  }

  // ==================== 放量报警记录操作 ====================

  /**
   * 保存放量报警
   */
  async save_alert(alert: Omit<VolumeAlert, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO volume_alerts
         (symbol, kline_time, current_volume, avg_volume, volume_ratio,
          price_change_pct, direction, current_price, is_important)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alert.symbol,
          alert.kline_time,
          alert.current_volume,
          alert.avg_volume,
          alert.volume_ratio,
          alert.price_change_pct,
          alert.direction,
          alert.current_price,
          alert.is_important ? 1 : 0
        ]
      );
      return result.insertId;
    });
  }

  /**
   * 查询报警记录
   */
  async get_alerts(options: {
    symbol?: string;
    date?: string;  // 格式: YYYY-MM-DD
    start_time?: number;
    end_time?: number;
    min_ratio?: number;
    direction?: 'UP' | 'DOWN';
    limit?: number;
  } = {}): Promise<(VolumeAlert & { daily_alert_index?: number })[]> {
    return this.execute_with_connection(async (conn) => {
      // 如果传入了日期参数，计算该日期的开始和结束时间戳
      let date_start_time: number | undefined;
      let date_end_time: number | undefined;

      if (options.date) {
        const date = new Date(options.date + 'T00:00:00+08:00'); // 北京时间
        date_start_time = date.getTime();
        date_end_time = date_start_time + 24 * 60 * 60 * 1000 - 1;
      }

      let sql = 'SELECT * FROM volume_alerts WHERE 1=1';
      const params: any[] = [];

      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }

      // 优先使用 date 参数，否则使用 start_time/end_time
      if (date_start_time !== undefined) {
        sql += ' AND kline_time >= ?';
        params.push(date_start_time);
      } else if (options.start_time) {
        sql += ' AND kline_time >= ?';
        params.push(options.start_time);
      }

      if (date_end_time !== undefined) {
        sql += ' AND kline_time <= ?';
        params.push(date_end_time);
      } else if (options.end_time) {
        sql += ' AND kline_time <= ?';
        params.push(options.end_time);
      }

      if (options.min_ratio) {
        sql += ' AND volume_ratio >= ?';
        params.push(options.min_ratio);
      }
      if (options.direction) {
        sql += ' AND direction = ?';
        params.push(options.direction);
      }

      sql += ' ORDER BY kline_time ASC'; // 按时间升序，便于计算第几次报警

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      const alerts = rows.map(row => this.map_to_alert(row));

      // 计算每个币种当天的第几次报警
      const symbol_count_map = new Map<string, number>();
      const alerts_with_index = alerts.map(alert => {
        const count = (symbol_count_map.get(alert.symbol) || 0) + 1;
        symbol_count_map.set(alert.symbol, count);
        return {
          ...alert,
          daily_alert_index: count
        };
      });

      // 按时间倒序返回（最新的在前）
      alerts_with_index.reverse();

      // 应用 limit
      if (options.limit && alerts_with_index.length > options.limit) {
        return alerts_with_index.slice(0, options.limit);
      }

      return alerts_with_index;
    });
  }

  /**
   * 检查报警是否已存在
   */
  async alert_exists(symbol: string, kline_time: number): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) as cnt FROM volume_alerts WHERE symbol = ? AND kline_time = ?',
        [symbol.toUpperCase(), kline_time]
      );
      return rows[0].cnt > 0;
    });
  }

  /**
   * 清理旧报警记录
   */
  async cleanup_old_alerts(days_to_keep: number = 30): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const cutoff = Date.now() - days_to_keep * 24 * 60 * 60 * 1000;
      const [result] = await conn.execute<ResultSetHeader>(
        'DELETE FROM volume_alerts WHERE kline_time < ?',
        [cutoff]
      );
      return result.affectedRows;
    });
  }

  // ==================== 形态报警记录操作 ====================

  /**
   * 保存形态报警
   */
  async save_pattern_alert(alert: Omit<PatternAlert, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO pattern_alerts
         (symbol, kline_time, pattern_type, current_price, price_change_pct,
          ema120, lower_shadow_pct, upper_shadow_pct, is_final)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alert.symbol,
          alert.kline_time,
          alert.pattern_type,
          alert.current_price,
          alert.price_change_pct,
          alert.ema120,
          alert.lower_shadow_pct,
          alert.upper_shadow_pct,
          alert.is_final ? 1 : 0
        ]
      );
      return result.insertId;
    });
  }

  /**
   * 查询形态报警记录
   */
  async get_pattern_alerts(options: {
    symbol?: string;
    date?: string;  // 格式: YYYY-MM-DD
    start_time?: number;
    end_time?: number;
    pattern_type?: string;
    is_final?: boolean;
    limit?: number;
  } = {}): Promise<(PatternAlert & { daily_alert_index?: number })[]> {
    return this.execute_with_connection(async (conn) => {
      // 如果传入了日期参数，计算该日期的开始和结束时间戳
      let date_start_time: number | undefined;
      let date_end_time: number | undefined;

      if (options.date) {
        const date = new Date(options.date + 'T00:00:00+08:00'); // 北京时间
        date_start_time = date.getTime();
        date_end_time = date_start_time + 24 * 60 * 60 * 1000 - 1;
      }

      let sql = 'SELECT * FROM pattern_alerts WHERE 1=1';
      const params: any[] = [];

      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }

      // 优先使用 date 参数，否则使用 start_time/end_time
      if (date_start_time !== undefined) {
        sql += ' AND kline_time >= ?';
        params.push(date_start_time);
      } else if (options.start_time) {
        sql += ' AND kline_time >= ?';
        params.push(options.start_time);
      }

      if (date_end_time !== undefined) {
        sql += ' AND kline_time <= ?';
        params.push(date_end_time);
      } else if (options.end_time) {
        sql += ' AND kline_time <= ?';
        params.push(options.end_time);
      }

      if (options.pattern_type) {
        sql += ' AND pattern_type = ?';
        params.push(options.pattern_type);
      }

      if (options.is_final !== undefined) {
        sql += ' AND is_final = ?';
        params.push(options.is_final ? 1 : 0);
      }

      sql += ' ORDER BY kline_time ASC';

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      const alerts = rows.map(row => this.map_to_pattern_alert(row));

      // 计算每个币种当天的第几次报警
      const symbol_count_map = new Map<string, number>();
      const alerts_with_index = alerts.map(alert => {
        const count = (symbol_count_map.get(alert.symbol) || 0) + 1;
        symbol_count_map.set(alert.symbol, count);
        return {
          ...alert,
          daily_alert_index: count
        };
      });

      // 按时间倒序返回（最新的在前）
      alerts_with_index.reverse();

      // 应用 limit
      if (options.limit && alerts_with_index.length > options.limit) {
        return alerts_with_index.slice(0, options.limit);
      }

      return alerts_with_index;
    });
  }

  /**
   * 检查形态报警是否已存在
   */
  async pattern_alert_exists(symbol: string, kline_time: number, pattern_type: string): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) as cnt FROM pattern_alerts WHERE symbol = ? AND kline_time = ? AND pattern_type = ?',
        [symbol.toUpperCase(), kline_time, pattern_type]
      );
      return rows[0].cnt > 0;
    });
  }

  /**
   * 清理旧形态报警记录
   */
  async cleanup_old_pattern_alerts(days_to_keep: number = 30): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const cutoff = Date.now() - days_to_keep * 24 * 60 * 60 * 1000;
      const [result] = await conn.execute<ResultSetHeader>(
        'DELETE FROM pattern_alerts WHERE kline_time < ?',
        [cutoff]
      );
      return result.affectedRows;
    });
  }

  // ==================== 映射方法 ====================

  private map_to_symbol(row: RowDataPacket): VolumeMonitorSymbol {
    return {
      id: row.id,
      symbol: row.symbol,
      enabled: row.enabled === 1,
      volume_multiplier: parseFloat(row.volume_multiplier),
      lookback_bars: row.lookback_bars,
      min_volume_usdt: parseFloat(row.min_volume_usdt),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private map_to_alert(row: RowDataPacket): VolumeAlert {
    return {
      id: row.id,
      symbol: row.symbol,
      kline_time: Number(row.kline_time),
      current_volume: parseFloat(row.current_volume),
      avg_volume: parseFloat(row.avg_volume),
      volume_ratio: parseFloat(row.volume_ratio),
      price_change_pct: parseFloat(row.price_change_pct),
      direction: row.direction,
      current_price: parseFloat(row.current_price),
      is_important: row.is_important === 1,
      created_at: row.created_at
    };
  }

  private map_to_pattern_alert(row: RowDataPacket): PatternAlert {
    return {
      id: row.id,
      symbol: row.symbol,
      kline_time: Number(row.kline_time),
      pattern_type: row.pattern_type,
      current_price: parseFloat(row.current_price),
      price_change_pct: parseFloat(row.price_change_pct),
      ema120: parseFloat(row.ema120),
      lower_shadow_pct: parseFloat(row.lower_shadow_pct),
      upper_shadow_pct: parseFloat(row.upper_shadow_pct),
      is_final: row.is_final === 1,
      created_at: row.created_at
    };
  }
}
