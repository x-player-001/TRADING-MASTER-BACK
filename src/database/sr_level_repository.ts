import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

/**
 * 支撑阻力位类型
 */
export type SRLevelType = 'SUPPORT' | 'RESISTANCE';

/**
 * 报警类型
 */
export type SRAlertType = 'APPROACHING' | 'TOUCHED' | 'BREAKOUT' | 'BOUNCE' | 'SQUEEZE' | 'BULLISH_STREAK' | 'PULLBACK_READY';

/**
 * 支撑阻力位
 */
export interface SRLevel {
  id?: number;
  symbol: string;
  interval: string;
  level_type: SRLevelType;
  price: number;
  strength: number;           // 强度评分 (0-100)
  touch_count: number;        // 触碰次数
  first_touch_time: number;   // 首次触碰时间
  last_touch_time: number;    // 最近触碰时间
  is_active: boolean;         // 是否仍有效
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 支撑阻力位报警信号
 */
export interface SRAlert {
  id?: number;
  symbol: string;
  interval: string;
  alert_type: SRAlertType;
  level_type: SRLevelType;
  level_price: number;        // 支撑阻力位价格
  current_price: number;      // 触发时当前价格
  distance_pct: number;       // 距离百分比
  level_strength: number;     // 该位置的强度
  kline_time: number;         // K线时间
  description: string;
  signal_score?: number;      // 信号评分 (0-100)，用于回调企稳信号
  // 爆发预测评分
  breakout_score?: number;              // 综合评分 (0-100)
  volatility_score?: number;            // 波动收敛度评分
  volume_score?: number;                // 成交量萎缩评分
  ma_convergence_score?: number;        // 均线收敛度评分
  pattern_score?: number;               // 形态特征评分
  predicted_direction?: 'UP' | 'DOWN' | 'UNKNOWN';  // 预测方向
  created_at?: Date;
}

/**
 * 支撑阻力位数据库操作
 */
export class SRLevelRepository extends BaseRepository {

  /**
   * 初始化表结构
   */
  async init_tables(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      // 支撑阻力位表
      const create_levels_table = `
        CREATE TABLE IF NOT EXISTS sr_levels (
          id INT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL,
          \`interval\` VARCHAR(10) NOT NULL,
          level_type ENUM('SUPPORT', 'RESISTANCE') NOT NULL,
          price DECIMAL(20, 8) NOT NULL,
          strength INT NOT NULL DEFAULT 50,
          touch_count INT NOT NULL DEFAULT 1,
          first_touch_time BIGINT NOT NULL,
          last_touch_time BIGINT NOT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

          INDEX idx_symbol_interval (symbol, \`interval\`),
          INDEX idx_active (is_active),
          INDEX idx_price (price),
          INDEX idx_strength (strength)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `;

      // 支撑阻力位报警表
      const create_alerts_table = `
        CREATE TABLE IF NOT EXISTS sr_alerts (
          id INT PRIMARY KEY AUTO_INCREMENT,
          symbol VARCHAR(20) NOT NULL,
          \`interval\` VARCHAR(10) NOT NULL,
          alert_type ENUM('APPROACHING', 'TOUCHED', 'BREAKOUT', 'BOUNCE', 'SQUEEZE', 'BULLISH_STREAK', 'PULLBACK_READY') NOT NULL,
          level_type ENUM('SUPPORT', 'RESISTANCE') NOT NULL,
          level_price DECIMAL(20, 8) NOT NULL,
          current_price DECIMAL(20, 8) NOT NULL,
          distance_pct DECIMAL(10, 4) NOT NULL,
          level_strength INT NOT NULL,
          kline_time BIGINT NOT NULL,
          description TEXT,
          signal_score INT DEFAULT NULL,
          breakout_score DECIMAL(5, 2) DEFAULT NULL,
          volatility_score DECIMAL(5, 2) DEFAULT NULL,
          volume_score DECIMAL(5, 2) DEFAULT NULL,
          ma_convergence_score DECIMAL(5, 2) DEFAULT NULL,
          pattern_score DECIMAL(5, 2) DEFAULT NULL,
          predicted_direction ENUM('UP', 'DOWN', 'UNKNOWN') DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          INDEX idx_symbol_interval (symbol, \`interval\`),
          INDEX idx_alert_type (alert_type),
          INDEX idx_kline_time (kline_time),
          INDEX idx_created_at (created_at),
          INDEX idx_breakout_score (breakout_score),
          INDEX idx_signal_score (signal_score)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `;

      try {
        await conn.execute(create_levels_table);
        await conn.execute(create_alerts_table);
        logger.info('SR tables initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize SR tables', error);
        throw error;
      }
    });
  }

  // ==================== 支撑阻力位操作 ====================

  /**
   * 保存或更新支撑阻力位
   */
  async upsert_level(level: SRLevel): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      // 先查找是否存在相近的价位
      const tolerance = level.price * 0.002; // 0.2% 容差
      const find_query = `
        SELECT id, touch_count, first_touch_time
        FROM sr_levels
        WHERE symbol = ? AND \`interval\` = ? AND level_type = ?
          AND price BETWEEN ? AND ?
          AND is_active = 1
        LIMIT 1
      `;

      const [existing] = await conn.execute<RowDataPacket[]>(find_query, [
        level.symbol,
        level.interval,
        level.level_type,
        level.price - tolerance,
        level.price + tolerance
      ]);

      if (existing.length > 0) {
        // 更新现有价位
        const update_query = `
          UPDATE sr_levels SET
            price = (price * touch_count + ?) / (touch_count + 1),
            touch_count = touch_count + 1,
            last_touch_time = ?,
            strength = LEAST(100, strength + 5),
            updated_at = NOW()
          WHERE id = ?
        `;

        await conn.execute(update_query, [
          level.price,
          level.last_touch_time,
          existing[0].id
        ]);

        return existing[0].id;
      } else {
        // 插入新价位
        const insert_query = `
          INSERT INTO sr_levels (
            symbol, \`interval\`, level_type, price, strength,
            touch_count, first_touch_time, last_touch_time, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await conn.execute<ResultSetHeader>(insert_query, [
          level.symbol,
          level.interval,
          level.level_type,
          level.price,
          level.strength,
          level.touch_count,
          level.first_touch_time,
          level.last_touch_time,
          level.is_active ? 1 : 0
        ]);

        return result.insertId;
      }
    });
  }

  /**
   * 批量保存支撑阻力位
   */
  async save_levels_batch(levels: SRLevel[]): Promise<void> {
    for (const level of levels) {
      await this.upsert_level(level);
    }
  }

  /**
   * 获取活跃的支撑阻力位
   */
  async get_active_levels(symbol: string, interval: string): Promise<SRLevel[]> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        SELECT * FROM sr_levels
        WHERE symbol = ? AND \`interval\` = ? AND is_active = 1
        ORDER BY price ASC
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(query, [symbol, interval]);
      return rows.map(row => this.map_to_level(row));
    });
  }

  /**
   * 获取指定价格范围内的支撑阻力位
   */
  async get_levels_in_range(
    symbol: string,
    interval: string,
    min_price: number,
    max_price: number
  ): Promise<SRLevel[]> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        SELECT * FROM sr_levels
        WHERE symbol = ? AND \`interval\` = ? AND is_active = 1
          AND price BETWEEN ? AND ?
        ORDER BY strength DESC
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(query, [
        symbol, interval, min_price, max_price
      ]);
      return rows.map(row => this.map_to_level(row));
    });
  }

  /**
   * 标记支撑阻力位失效（被有效突破）
   */
  async deactivate_level(id: number): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        'UPDATE sr_levels SET is_active = 0, updated_at = NOW() WHERE id = ?',
        [id]
      );
    });
  }

  /**
   * 清理指定币种的所有支撑阻力位
   */
  async clear_levels(symbol: string, interval: string): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        'DELETE FROM sr_levels WHERE symbol = ? AND `interval` = ?',
        [symbol, interval]
      );
    });
  }

  // ==================== 报警操作 ====================

  /**
   * 保存报警信号
   */
  async save_alert(alert: SRAlert): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        INSERT INTO sr_alerts (
          symbol, \`interval\`, alert_type, level_type, level_price,
          current_price, distance_pct, level_strength, kline_time, description,
          signal_score, breakout_score, volatility_score, volume_score, ma_convergence_score,
          pattern_score, predicted_direction
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await conn.execute<ResultSetHeader>(query, [
        alert.symbol,
        alert.interval,
        alert.alert_type,
        alert.level_type,
        alert.level_price,
        alert.current_price,
        alert.distance_pct,
        alert.level_strength,
        alert.kline_time,
        alert.description,
        alert.signal_score ?? null,
        alert.breakout_score ?? null,
        alert.volatility_score ?? null,
        alert.volume_score ?? null,
        alert.ma_convergence_score ?? null,
        alert.pattern_score ?? null,
        alert.predicted_direction ?? null
      ]);

      return result.insertId;
    });
  }

  /**
   * 检查是否已存在相同的报警（防重复）
   */
  async alert_exists(
    symbol: string,
    interval: string,
    alert_type: SRAlertType,
    level_price: number,
    kline_time: number
  ): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const tolerance = level_price * 0.001; // 0.1% 容差
      const query = `
        SELECT COUNT(*) as cnt FROM sr_alerts
        WHERE symbol = ? AND \`interval\` = ? AND alert_type = ?
          AND level_price BETWEEN ? AND ?
          AND kline_time = ?
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(query, [
        symbol, interval, alert_type,
        level_price - tolerance, level_price + tolerance,
        kline_time
      ]);

      return rows[0].cnt > 0;
    });
  }

  /**
   * 获取最近的报警
   */
  async get_recent_alerts(
    symbol?: string,
    interval?: string,
    limit: number = 50,
    symbol_like?: string,
    keyword?: string
  ): Promise<SRAlert[]> {
    return this.execute_with_connection(async (conn) => {
      let query = 'SELECT * FROM sr_alerts WHERE 1=1';
      const params: any[] = [];

      if (symbol) {
        query += ' AND symbol = ?';
        params.push(symbol);
      }
      // 模糊匹配 symbol
      if (symbol_like) {
        query += ' AND symbol LIKE ?';
        params.push(`%${symbol_like.toUpperCase()}%`);
      }
      if (interval) {
        query += ' AND `interval` = ?';
        params.push(interval);
      }
      // 模糊匹配 description
      if (keyword) {
        query += ' AND description LIKE ?';
        params.push(`%${keyword}%`);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const [rows] = await conn.execute<RowDataPacket[]>(query, params);
      return rows.map(row => this.map_to_alert(row));
    });
  }

  /**
   * 清空报警表
   */
  async truncate_alerts(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute('TRUNCATE TABLE sr_alerts');
      logger.info('SR alerts table truncated');
    });
  }

  // ==================== 映射方法 ====================

  private map_to_level(row: RowDataPacket): SRLevel {
    return {
      id: row.id,
      symbol: row.symbol,
      interval: row.interval,
      level_type: row.level_type,
      price: parseFloat(row.price),
      strength: row.strength,
      touch_count: row.touch_count,
      first_touch_time: Number(row.first_touch_time),
      last_touch_time: Number(row.last_touch_time),
      is_active: row.is_active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private map_to_alert(row: RowDataPacket): SRAlert {
    return {
      id: row.id,
      symbol: row.symbol,
      interval: row.interval,
      alert_type: row.alert_type,
      level_type: row.level_type,
      level_price: parseFloat(row.level_price),
      current_price: parseFloat(row.current_price),
      distance_pct: parseFloat(row.distance_pct),
      level_strength: row.level_strength,
      kline_time: Number(row.kline_time),
      description: row.description,
      breakout_score: row.breakout_score ? parseFloat(row.breakout_score) : undefined,
      volatility_score: row.volatility_score ? parseFloat(row.volatility_score) : undefined,
      volume_score: row.volume_score ? parseFloat(row.volume_score) : undefined,
      ma_convergence_score: row.ma_convergence_score ? parseFloat(row.ma_convergence_score) : undefined,
      pattern_score: row.pattern_score ? parseFloat(row.pattern_score) : undefined,
      predicted_direction: row.predicted_direction || undefined,
      created_at: row.created_at
    };
  }
}
