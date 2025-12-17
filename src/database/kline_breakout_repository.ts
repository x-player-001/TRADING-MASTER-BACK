/**
 * K线突破信号数据存储层
 */

import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';

// K线突破信号类型
export interface KlineBreakoutSignal {
  id?: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  breakout_price: number;
  upper_bound: number;
  lower_bound: number;
  breakout_pct: number;
  volume: number;
  volume_ratio: number;
  kline_open?: number;
  kline_high?: number;
  kline_low?: number;
  kline_close?: number;
  zone_start_time?: Date;      // 密集区开始时间
  zone_end_time?: Date;        // 密集区结束时间
  zone_kline_count?: number;   // 密集区K线数量
  center_price?: number;       // 密集区中心价格
  zone_score?: number;         // 区间得分 (0-100)
  atr?: number;                // ATR值
  signal_time: Date;
  created_at?: Date;
}

export class KlineBreakoutRepository {
  /**
   * 保存突破信号
   */
  async save_signal(signal: Omit<KlineBreakoutSignal, 'id' | 'created_at'>): Promise<number> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        INSERT INTO kline_breakout_signals (
          symbol, direction, breakout_price, upper_bound, lower_bound,
          breakout_pct, volume, volume_ratio,
          kline_open, kline_high, kline_low, kline_close,
          zone_start_time, zone_end_time, zone_kline_count, center_price, zone_score, atr,
          signal_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await connection.execute(sql, [
        signal.symbol,
        signal.direction,
        signal.breakout_price,
        signal.upper_bound,
        signal.lower_bound,
        signal.breakout_pct,
        signal.volume,
        signal.volume_ratio,
        signal.kline_open ?? null,
        signal.kline_high ?? null,
        signal.kline_low ?? null,
        signal.kline_close ?? null,
        signal.zone_start_time ?? null,
        signal.zone_end_time ?? null,
        signal.zone_kline_count ?? null,
        signal.center_price ?? null,
        signal.zone_score ?? null,
        signal.atr ?? null,
        signal.signal_time
      ]);

      const insert_id = (result as any).insertId;
      logger.info(`[KlineBreakout] Saved signal: ${signal.symbol} ${signal.direction} breakout ${signal.breakout_pct.toFixed(2)}%`);
      return insert_id;
    } catch (error) {
      logger.error('[KlineBreakout] Failed to save signal:', error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取最近的突破信号
   */
  async get_recent_signals(limit: number = 50): Promise<KlineBreakoutSignal[]> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM kline_breakout_signals
        ORDER BY signal_time DESC
        LIMIT ?
      `;

      const [rows] = await connection.execute(sql, [limit]);
      return rows as KlineBreakoutSignal[];
    } catch (error) {
      logger.error('[KlineBreakout] Failed to get recent signals:', error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取指定币种的最近突破信号
   */
  async get_signals_by_symbol(symbol: string, limit: number = 20): Promise<KlineBreakoutSignal[]> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM kline_breakout_signals
        WHERE symbol = ?
        ORDER BY signal_time DESC
        LIMIT ?
      `;

      const [rows] = await connection.execute(sql, [symbol, limit]);
      return rows as KlineBreakoutSignal[];
    } catch (error) {
      logger.error(`[KlineBreakout] Failed to get signals for ${symbol}:`, error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 按方向获取突破信号
   */
  async get_signals_by_direction(direction: 'UP' | 'DOWN', limit: number = 50): Promise<KlineBreakoutSignal[]> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM kline_breakout_signals
        WHERE direction = ?
        ORDER BY signal_time DESC
        LIMIT ?
      `;

      const [rows] = await connection.execute(sql, [direction, limit]);
      return rows as KlineBreakoutSignal[];
    } catch (error) {
      logger.error(`[KlineBreakout] Failed to get signals by direction:`, error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 按时间范围获取突破信号
   */
  async get_signals_by_time_range(
    start_time: Date,
    end_time: Date,
    limit: number = 100
  ): Promise<KlineBreakoutSignal[]> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const sql = `
        SELECT * FROM kline_breakout_signals
        WHERE signal_time >= ? AND signal_time <= ?
        ORDER BY signal_time DESC
        LIMIT ?
      `;

      const [rows] = await connection.execute(sql, [start_time, end_time, limit]);
      return rows as KlineBreakoutSignal[];
    } catch (error) {
      logger.error('[KlineBreakout] Failed to get signals by time range:', error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 检查是否有近期重复信号（避免短时间内重复发信号）
   * @deprecated 使用 has_recent_signal_near_price 代替
   */
  async has_recent_signal(symbol: string, direction: 'UP' | 'DOWN', minutes: number = 30): Promise<boolean> {
    return this.has_recent_signal_near_price(symbol, direction, 0, minutes, 100);
  }

  /**
   * 检查是否有近期价格相近的重复信号
   * @param symbol 交易对
   * @param direction 方向
   * @param price 当前突破价格
   * @param minutes 冷却时间（分钟）
   * @param price_tolerance_pct 价格容差百分比（例如 1.0 表示 ±1%）
   */
  async has_recent_signal_near_price(
    symbol: string,
    direction: 'UP' | 'DOWN',
    price: number,
    minutes: number = 30,
    price_tolerance_pct: number = 1.0
  ): Promise<boolean> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      // 计算价格范围
      const price_min = price * (1 - price_tolerance_pct / 100);
      const price_max = price * (1 + price_tolerance_pct / 100);

      // 查询近期信号（如果 price > 0，还要检查价格范围）
      let sql: string;
      let params: any[];

      if (price > 0) {
        sql = `
          SELECT COUNT(*) as count, MAX(signal_time) as last_time, MAX(breakout_price) as last_price
          FROM kline_breakout_signals
          WHERE symbol = ? AND direction = ?
            AND signal_time > DATE_SUB(NOW(), INTERVAL ? MINUTE)
            AND breakout_price BETWEEN ? AND ?
        `;
        params = [symbol, direction, minutes, price_min, price_max];
      } else {
        sql = `
          SELECT COUNT(*) as count, MAX(signal_time) as last_time, MAX(breakout_price) as last_price
          FROM kline_breakout_signals
          WHERE symbol = ? AND direction = ?
            AND signal_time > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        `;
        params = [symbol, direction, minutes];
      }

      const [rows] = await connection.execute(sql, params);
      const result = (rows as any)[0];
      const count = result.count;

      if (count > 0) {
        logger.info(`[KlineBreakout] Cooldown ACTIVE: ${symbol} ${direction} @ ${price.toFixed(6)} | Last: ${result.last_price?.toFixed(6)} at ${result.last_time} | ${count} signal(s) in ${minutes} min`);
      } else if (price > 0) {
        logger.debug(`[KlineBreakout] Cooldown PASSED: ${symbol} ${direction} @ ${price.toFixed(6)} | No signals in price range [${price_min.toFixed(6)}, ${price_max.toFixed(6)}]`);
      }

      return count > 0;
    } catch (error) {
      logger.error(`[KlineBreakout] Failed to check recent signal:`, error);
      // 出错时返回 true，宁可漏发也不要重复发
      return true;
    } finally {
      connection.release();
    }
  }

  /**
   * 获取统计信息
   */
  async get_statistics(hours: number = 24): Promise<{
    total_signals: number;
    up_signals: number;
    down_signals: number;
    avg_breakout_pct: number;
    avg_volume_ratio: number;
    top_symbols: { symbol: string; count: number }[];
  }> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      // 总数统计
      const count_sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN direction = 'UP' THEN 1 ELSE 0 END) as up_count,
          SUM(CASE WHEN direction = 'DOWN' THEN 1 ELSE 0 END) as down_count,
          AVG(breakout_pct) as avg_breakout_pct,
          AVG(volume_ratio) as avg_volume_ratio
        FROM kline_breakout_signals
        WHERE signal_time > DATE_SUB(NOW(), INTERVAL ? HOUR)
      `;
      const [count_rows] = await connection.execute(count_sql, [hours]);
      const counts = (count_rows as any)[0];

      // 热门币种
      const top_sql = `
        SELECT symbol, COUNT(*) as count
        FROM kline_breakout_signals
        WHERE signal_time > DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY symbol
        ORDER BY count DESC
        LIMIT 10
      `;
      const [top_rows] = await connection.execute(top_sql, [hours]);

      return {
        total_signals: counts.total || 0,
        up_signals: counts.up_count || 0,
        down_signals: counts.down_count || 0,
        avg_breakout_pct: parseFloat(counts.avg_breakout_pct) || 0,
        avg_volume_ratio: parseFloat(counts.avg_volume_ratio) || 0,
        top_symbols: top_rows as { symbol: string; count: number }[]
      };
    } catch (error) {
      logger.error('[KlineBreakout] Failed to get statistics:', error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 清空所有信号数据
   */
  async truncate(): Promise<void> {
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      await connection.execute('TRUNCATE TABLE kline_breakout_signals');
      logger.info('[KlineBreakout] Table truncated');
    } catch (error) {
      logger.error('[KlineBreakout] Failed to truncate table:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
}
