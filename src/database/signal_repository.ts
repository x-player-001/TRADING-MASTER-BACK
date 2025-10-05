import { RowDataPacket } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { TradingSignal, PatternDetection } from '@/types/signal';
import { logger } from '@/utils/logger';

/**
 * 交易信号数据库操作
 */
export class SignalRepository extends BaseRepository {
  /**
   * 保存交易信号
   */
  async save_signal(signal: TradingSignal): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        INSERT INTO trading_signals (
          symbol, \`interval\`, signal_type, strength, price,
          indicators, description, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        signal.symbol,
        signal.interval,
        signal.signal_type,
        signal.strength,
        signal.price,
        JSON.stringify(signal.indicators),
        signal.description,
        signal.timestamp
      ];

      try {
        const [result] = await conn.execute(query, values) as any;
        logger.info(`Signal saved: ${signal.symbol} ${signal.signal_type} @ ${signal.price}`);
        return result.insertId;
      } catch (error) {
        logger.error('Failed to save signal', error);
        throw error;
      }
    });
  }

  /**
   * 获取最新信号
   */
  async get_latest_signals(symbol?: string, interval?: string, limit: number = 10): Promise<TradingSignal[]> {
    return this.execute_with_connection(async (conn) => {
      let query = `
        SELECT * FROM trading_signals
        WHERE 1=1
      `;
      const values: any[] = [];

      if (symbol) {
        query += ` AND symbol = ?`;
        values.push(symbol);
      }

      if (interval) {
        query += ` AND \`interval\` = ?`;
        values.push(interval);
      }

      query += ` ORDER BY created_at DESC LIMIT ?`;
      values.push(limit);

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, values);
        return rows.map((row: any) => this.map_to_signal(row));
      } catch (error) {
        logger.error('Failed to get latest signals', error);
        throw error;
      }
    });
  }

  /**
   * 按时间范围查询信号
   */
  async get_signals_by_time_range(
    symbol: string,
    interval: string,
    start_time: number,
    end_time: number
  ): Promise<TradingSignal[]> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        SELECT * FROM trading_signals
        WHERE symbol = ? AND \`interval\` = ?
          AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC
      `;

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, [symbol, interval, start_time, end_time]);
        return rows.map((row: any) => this.map_to_signal(row));
      } catch (error) {
        logger.error('Failed to get signals by time range', error);
        throw error;
      }
    });
  }

  /**
   * 获取多个币种的最新信号
   */
  async get_signals_overview(symbols: string[], interval: string): Promise<TradingSignal[]> {
    if (symbols.length === 0) return [];

    return this.execute_with_connection(async (conn) => {
      const placeholders = symbols.map(() => '?').join(',');
      const query = `
        SELECT t1.* FROM trading_signals t1
        INNER JOIN (
          SELECT symbol, MAX(created_at) as max_time
          FROM trading_signals
          WHERE symbol IN (${placeholders}) AND \`interval\` = ?
          GROUP BY symbol
        ) t2 ON t1.symbol = t2.symbol AND t1.created_at = t2.max_time
        ORDER BY t1.created_at DESC
      `;

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, [...symbols, interval]);
        return rows.map((row: any) => this.map_to_signal(row));
      } catch (error) {
        logger.error('Failed to get signals overview', error);
        throw error;
      }
    });
  }

  /**
   * 保存形态识别记录
   */
  async save_pattern(pattern: PatternDetection): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        INSERT INTO pattern_detections (
          symbol, \`interval\`, pattern_type, confidence, description, detected_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `;

      const values = [
        pattern.symbol,
        pattern.interval,
        pattern.pattern_type,
        pattern.confidence,
        pattern.description,
        pattern.detected_at
      ];

      try {
        const [result] = await conn.execute(query, values) as any;
        return result.insertId;
      } catch (error) {
        logger.error('Failed to save pattern', error);
        throw error;
      }
    });
  }

  /**
   * 获取最近的形态识别
   */
  async get_recent_patterns(symbol: string, interval: string, limit: number = 10): Promise<PatternDetection[]> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        SELECT * FROM pattern_detections
        WHERE symbol = ? AND \`interval\` = ?
        ORDER BY detected_at DESC
        LIMIT ?
      `;

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, [symbol, interval, limit]);
        return rows.map((row: any) => this.map_to_pattern(row));
      } catch (error) {
        logger.error('Failed to get recent patterns', error);
        throw error;
      }
    });
  }

  /**
   * 映射数据库行到TradingSignal对象
   */
  private map_to_signal(row: RowDataPacket): TradingSignal {
    return {
      id: row.id,
      symbol: row.symbol,
      interval: row.interval,
      signal_type: row.signal_type,
      strength: row.strength,
      price: parseFloat(row.price),
      indicators: typeof row.indicators === 'string' ? JSON.parse(row.indicators) : row.indicators,
      description: row.description,
      timestamp: row.timestamp,
      created_at: row.created_at
    };
  }

  /**
   * 映射数据库行到PatternDetection对象
   */
  private map_to_pattern(row: RowDataPacket): PatternDetection {
    return {
      id: row.id,
      symbol: row.symbol,
      interval: row.interval,
      pattern_type: row.pattern_type,
      confidence: parseFloat(row.confidence),
      description: row.description,
      detected_at: row.detected_at,
      created_at: row.created_at
    };
  }
}
