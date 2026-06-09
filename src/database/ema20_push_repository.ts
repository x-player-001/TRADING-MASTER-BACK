/**
 * EMA20 均线推动数据库操作
 *
 * 表:
 *   ema20_push_contexts - 推动上下文快照（每个 symbol+timeframe 一条）
 *   ema20_push_records  - 每次推动的详细记录
 */

import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

export interface EMA20PushContextRecord {
  id?: number;
  symbol: string;
  timeframe: string;
  push_count: number;
  start_price: number;
  current_price: number;
  amplitude_pct: number;
  ema20: number;
  last_push_time: number | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface EMA20PushDetailRecord {
  id?: number;
  symbol: string;
  timeframe: string;
  push_index: number;
  kline_time: number;
  low_price: number;
  close_price: number;
  peak_price: number;
  gain_pct: number;
  ema20: number;
  distance_pct: number;
  created_at?: Date;
}

export class EMA20PushRepository extends BaseRepository {

  async init_tables(): Promise<void> {
    const sql_ctx = `
      CREATE TABLE IF NOT EXISTS ema20_push_contexts (
        id               BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol           VARCHAR(20)   NOT NULL,
        timeframe        VARCHAR(5)    NOT NULL,
        push_count       INT           NOT NULL DEFAULT 0,
        start_price      DECIMAL(20,8) NOT NULL,
        current_price    DECIMAL(20,8) NOT NULL,
        amplitude_pct    DECIMAL(10,4) NOT NULL DEFAULT 0,
        ema20            DECIMAL(20,8) NOT NULL,
        last_push_time   BIGINT        NULL,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_tf (symbol, timeframe),
        INDEX idx_push_count (push_count DESC),
        INDEX idx_updated    (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='EMA20均线推动上下文'
    `;

    const sql_rec = `
      CREATE TABLE IF NOT EXISTS ema20_push_records (
        id           BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol       VARCHAR(20)   NOT NULL,
        timeframe    VARCHAR(5)    NOT NULL,
        push_index   INT           NOT NULL,
        kline_time   BIGINT        NOT NULL,
        low_price    DECIMAL(20,8) NOT NULL,
        close_price  DECIMAL(20,8) NOT NULL,
        peak_price   DECIMAL(20,8) NOT NULL DEFAULT 0,
        gain_pct     DECIMAL(10,4) NOT NULL DEFAULT 0,
        ema20        DECIMAL(20,8) NOT NULL,
        distance_pct DECIMAL(10,4) NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_tf_idx (symbol, timeframe, push_index),
        INDEX idx_symbol    (symbol),
        INDEX idx_kline_time (kline_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='EMA20均线推动记录'
    `;

    return this.execute_with_connection(async (conn) => {
      await conn.execute(sql_ctx);
      await conn.execute(sql_rec);
      logger.info('[EMA20PushRepository] Tables ready');
    });
  }

  /** 更新推动上下文（upsert） */
  async upsert_context(record: Omit<EMA20PushContextRecord, 'id' | 'updated_at'>): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `INSERT INTO ema20_push_contexts
         (symbol, timeframe, push_count, start_price, current_price, amplitude_pct, ema20, last_push_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           push_count    = VALUES(push_count),
           current_price = VALUES(current_price),
           amplitude_pct = VALUES(amplitude_pct),
           ema20         = VALUES(ema20),
           last_push_time = VALUES(last_push_time)`,
        [
          record.symbol, record.timeframe, record.push_count,
          record.start_price, record.current_price, record.amplitude_pct,
          record.ema20, record.last_push_time ?? null,
        ]
      );
    });
  }

  /** 插入一条推动记录 */
  async insert_push_record(record: Omit<EMA20PushDetailRecord, 'id' | 'created_at'>): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `INSERT IGNORE INTO ema20_push_records
         (symbol, timeframe, push_index, kline_time, low_price, close_price, peak_price, gain_pct, ema20, distance_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.symbol, record.timeframe, record.push_index,
          record.kline_time, record.low_price, record.close_price,
          record.peak_price, record.gain_pct,
          record.ema20, record.distance_pct,
        ]
      );
    });
  }

  /** 查询推动上下文列表 */
  async get_contexts(options: {
    symbol?: string;
    timeframe?: string;
    min_push_count?: number;
    limit?: number;
  } = {}): Promise<EMA20PushContextRecord[]> {
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM ema20_push_contexts WHERE 1=1';
      const params: any[] = [];

      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }
      if (options.timeframe) {
        sql += ' AND timeframe = ?';
        params.push(options.timeframe);
      }
      if (options.min_push_count !== undefined) {
        sql += ' AND push_count >= ?';
        params.push(Number(options.min_push_count));
      }

      sql += ' ORDER BY push_count DESC, updated_at DESC';

      if (options.limit) {
        sql += ` LIMIT ${Number(options.limit)}`;
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(r => this._map_context(r));
    });
  }

  /** 查询某币种某周期的推动详细记录 */
  async get_push_records(symbol: string, timeframe: string): Promise<EMA20PushDetailRecord[]> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT * FROM ema20_push_records WHERE symbol=? AND timeframe=? ORDER BY push_index ASC',
        [symbol.toUpperCase(), timeframe]
      );
      return rows.map(r => this._map_record(r));
    });
  }

  /** 重置某币种某周期的推动上下文和记录 */
  async reset(symbol: string, timeframe: string): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute('DELETE FROM ema20_push_contexts WHERE symbol=? AND timeframe=?', [symbol.toUpperCase(), timeframe]);
      await conn.execute('DELETE FROM ema20_push_records WHERE symbol=? AND timeframe=?', [symbol.toUpperCase(), timeframe]);
    });
  }

  private _map_context(row: RowDataPacket): EMA20PushContextRecord {
    return {
      id:             row.id,
      symbol:         row.symbol,
      timeframe:      row.timeframe,
      push_count:     row.push_count,
      start_price:    parseFloat(row.start_price),
      current_price:  parseFloat(row.current_price),
      amplitude_pct:  parseFloat(row.amplitude_pct),
      ema20:          parseFloat(row.ema20),
      last_push_time: row.last_push_time ? Number(row.last_push_time) : null,
      created_at:     row.created_at,
      updated_at:     row.updated_at,
    };
  }

  private _map_record(row: RowDataPacket): EMA20PushDetailRecord {
    return {
      id:           row.id,
      symbol:       row.symbol,
      timeframe:    row.timeframe,
      push_index:   row.push_index,
      kline_time:   Number(row.kline_time),
      low_price:    parseFloat(row.low_price),
      close_price:  parseFloat(row.close_price),
      peak_price:   parseFloat(row.peak_price),
      gain_pct:     parseFloat(row.gain_pct),
      ema20:        parseFloat(row.ema20),
      distance_pct: parseFloat(row.distance_pct),
      created_at:   row.created_at,
    };
  }
}
