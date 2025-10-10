import { RowDataPacket } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { RangeBox, BreakoutSignal, BreakoutStatus } from '@/types/structure';
import { logger } from '@/utils/logger';

/**
 * 结构性形态数据库操作
 */
export class StructureRepository extends BaseRepository {

  /**
   * 保存交易区间
   */
  async save_range(range: RangeBox): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        INSERT INTO structure_patterns (
          symbol, \`interval\`, structure_type, key_levels, pattern_data,
          breakout_status, confidence, strength,
          start_time, end_time, duration_bars
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const key_levels = {
        support: range.support,
        resistance: range.resistance,
        middle: range.middle
      };

      const pattern_data = {
        range_size: range.range_size,
        range_percent: range.range_percent,
        touch_count: range.touch_count,
        support_touches: range.support_touches,
        resistance_touches: range.resistance_touches,
        near_resistance: range.near_resistance,
        near_support: range.near_support,
        avg_volume: range.avg_volume,
        volume_trend: range.volume_trend
      };

      const values = [
        range.symbol,
        range.interval,
        range.type,
        JSON.stringify(key_levels),
        JSON.stringify(pattern_data),
        'forming',
        range.confidence,
        range.strength,
        range.start_time,
        range.end_time,
        range.duration_bars
      ];

      try {
        const [result] = await conn.execute(query, values) as any;
        logger.info(`Range saved: ${range.symbol}:${range.interval} [${range.support.toFixed(2)} - ${range.resistance.toFixed(2)}]`);
        return result.insertId;
      } catch (error) {
        logger.error('Failed to save range', error);
        throw error;
      }
    });
  }

  /**
   * 获取最新的交易区间
   */
  async get_latest_ranges(
    symbol?: string,
    interval?: string,
    limit: number = 10
  ): Promise<RangeBox[]> {
    return this.execute_with_connection(async (conn) => {
      let query = `
        SELECT * FROM structure_patterns
        WHERE structure_type = 'range'
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
        return rows.map((row: any) => this.map_to_range(row));
      } catch (error) {
        logger.error('Failed to get latest ranges', error);
        throw error;
      }
    });
  }

  /**
   * 获取正在形成中的区间 (未突破)
   */
  async get_forming_ranges(symbol: string, interval: string): Promise<RangeBox[]> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        SELECT * FROM structure_patterns
        WHERE symbol = ? AND \`interval\` = ?
          AND structure_type = 'range'
          AND breakout_status = 'forming'
        ORDER BY confidence DESC, created_at DESC
        LIMIT 5
      `;

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, [symbol, interval]);
        return rows.map((row: any) => this.map_to_range(row));
      } catch (error) {
        logger.error('Failed to get forming ranges', error);
        throw error;
      }
    });
  }

  /**
   * 更新区间突破状态
   */
  async update_range_breakout(
    range_id: number,
    breakout_status: BreakoutStatus,
    breakout_price: number,
    breakout_time: number
  ): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        UPDATE structure_patterns
        SET breakout_status = ?,
            breakout_price = ?,
            breakout_time = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;

      try {
        await conn.execute(query, [breakout_status, breakout_price, breakout_time, range_id]);
        logger.info(`Range breakout updated: ID ${range_id}, status: ${breakout_status}`);
      } catch (error) {
        logger.error('Failed to update range breakout', error);
        throw error;
      }
    });
  }

  /**
   * 保存突破信号
   */
  async save_breakout_signal(signal: BreakoutSignal): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        INSERT INTO breakout_signals (
          structure_id, symbol, \`interval\`, breakout_direction,
          breakout_price, previous_range_high, previous_range_low,
          breakout_strength, breakout_volume, avg_volume, volume_ratio,
          target_price, stop_loss, risk_reward_ratio, breakout_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        signal.structure_id || null,
        signal.symbol,
        signal.interval,
        signal.breakout_direction,
        signal.breakout_price,
        signal.previous_range_high,
        signal.previous_range_low,
        signal.breakout_strength,
        signal.breakout_volume,
        signal.avg_volume,
        signal.volume_ratio,
        signal.target_price,
        signal.stop_loss,
        signal.risk_reward_ratio,
        signal.breakout_time
      ];

      try {
        const [result] = await conn.execute(query, values) as any;
        logger.info(`Breakout signal saved: ${signal.symbol} ${signal.breakout_direction} @ ${signal.breakout_price}`);
        return result.insertId;
      } catch (error) {
        logger.error('Failed to save breakout signal', error);
        throw error;
      }
    });
  }

  /**
   * 获取最新突破信号
   */
  async get_latest_breakout_signals(
    symbol?: string,
    interval?: string,
    limit: number = 20
  ): Promise<BreakoutSignal[]> {
    return this.execute_with_connection(async (conn) => {
      let query = `SELECT * FROM breakout_signals WHERE 1=1`;
      const values: any[] = [];

      if (symbol) {
        query += ` AND symbol = ?`;
        values.push(symbol);
      }

      if (interval) {
        query += ` AND \`interval\` = ?`;
        values.push(interval);
      }

      query += ` ORDER BY breakout_time DESC LIMIT ?`;
      values.push(limit);

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, values);
        return rows.map((row: any) => this.map_to_breakout_signal(row));
      } catch (error) {
        logger.error('Failed to get breakout signals', error);
        throw error;
      }
    });
  }

  /**
   * 更新突破信号结果
   */
  async update_signal_result(
    signal_id: number,
    result: 'hit_target' | 'hit_stop' | 'failed',
    result_time: number,
    max_profit_percent?: number,
    max_loss_percent?: number
  ): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const query = `
        UPDATE breakout_signals
        SET result = ?,
            result_time = ?,
            max_profit_percent = ?,
            max_loss_percent = ?
        WHERE id = ?
      `;

      try {
        await conn.execute(query, [
          result,
          result_time,
          max_profit_percent || null,
          max_loss_percent || null,
          signal_id
        ]);
        logger.info(`Signal result updated: ID ${signal_id}, result: ${result}`);
      } catch (error) {
        logger.error('Failed to update signal result', error);
        throw error;
      }
    });
  }

  /**
   * 获取突破信号统计
   */
  async get_signal_statistics(
    symbol?: string,
    interval?: string,
    days: number = 30
  ): Promise<any> {
    return this.execute_with_connection(async (conn) => {
      let query = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN result = 'hit_target' THEN 1 ELSE 0 END) as hit_target,
          SUM(CASE WHEN result = 'hit_stop' THEN 1 ELSE 0 END) as hit_stop,
          SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) as pending,
          AVG(risk_reward_ratio) as avg_risk_reward,
          AVG(breakout_strength) as avg_strength,
          AVG(volume_ratio) as avg_volume_ratio
        FROM breakout_signals
        WHERE breakout_time > ?
      `;
      const values: any[] = [Date.now() - days * 24 * 60 * 60 * 1000];

      if (symbol) {
        query += ` AND symbol = ?`;
        values.push(symbol);
      }

      if (interval) {
        query += ` AND \`interval\` = ?`;
        values.push(interval);
      }

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(query, values);
        const stats = rows[0];

        const completed = stats.hit_target + stats.hit_stop + stats.failed;
        const win_rate = completed > 0 ? (stats.hit_target / completed) * 100 : 0;

        return {
          ...stats,
          win_rate: Number(win_rate.toFixed(2)),
          avg_risk_reward: Number(stats.avg_risk_reward || 0).toFixed(2),
          avg_strength: Number(stats.avg_strength || 0).toFixed(0),
          avg_volume_ratio: Number(stats.avg_volume_ratio || 0).toFixed(2)
        };
      } catch (error) {
        logger.error('Failed to get signal statistics', error);
        throw error;
      }
    });
  }

  /**
   * 映射数据库行到RangeBox对象
   */
  private map_to_range(row: RowDataPacket): RangeBox {
    const key_levels = typeof row.key_levels === 'string'
      ? JSON.parse(row.key_levels)
      : row.key_levels;

    const pattern_data = typeof row.pattern_data === 'string'
      ? JSON.parse(row.pattern_data)
      : row.pattern_data;

    return {
      id: row.id,
      symbol: row.symbol,
      interval: row.interval,
      type: row.structure_type,
      resistance: key_levels.resistance,
      support: key_levels.support,
      middle: key_levels.middle,
      range_size: pattern_data.range_size,
      range_percent: pattern_data.range_percent,
      touch_count: pattern_data.touch_count,
      support_touches: pattern_data.support_touches,
      resistance_touches: pattern_data.resistance_touches,
      duration_bars: row.duration_bars,
      near_resistance: pattern_data.near_resistance,
      near_support: pattern_data.near_support,
      breakout_direction: pattern_data.breakout_direction || null,
      confidence: parseFloat(row.confidence),
      strength: row.strength,
      start_time: row.start_time,
      end_time: row.end_time,
      avg_volume: pattern_data.avg_volume,
      volume_trend: pattern_data.volume_trend,
      pattern_data,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * 映射数据库行到BreakoutSignal对象
   */
  private map_to_breakout_signal(row: RowDataPacket): BreakoutSignal {
    return {
      id: row.id,
      structure_id: row.structure_id,
      symbol: row.symbol,
      interval: row.interval,
      breakout_direction: row.breakout_direction,
      breakout_price: parseFloat(row.breakout_price),
      previous_range_high: parseFloat(row.previous_range_high),
      previous_range_low: parseFloat(row.previous_range_low),
      breakout_strength: row.breakout_strength,
      breakout_volume: parseFloat(row.breakout_volume),
      avg_volume: parseFloat(row.avg_volume),
      volume_ratio: parseFloat(row.volume_ratio),
      target_price: parseFloat(row.target_price),
      stop_loss: parseFloat(row.stop_loss),
      risk_reward_ratio: parseFloat(row.risk_reward_ratio),
      result: row.result,
      result_time: row.result_time,
      max_profit_percent: row.max_profit_percent ? parseFloat(row.max_profit_percent) : undefined,
      max_loss_percent: row.max_loss_percent ? parseFloat(row.max_loss_percent) : undefined,
      breakout_time: row.breakout_time,
      created_at: row.created_at
    };
  }
}
