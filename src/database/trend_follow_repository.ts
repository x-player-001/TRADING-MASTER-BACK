/**
 * 趋势跟随报警数据库操作
 *
 * 表:
 *   trend_follow_alerts         - 报警记录（Lv1/2/3）
 *   trend_follow_watch_contexts - 观察区状态快照（每次进入观察区新增一条）
 */

import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

export interface TrendFollowAlertRecord {
  id?: number;
  symbol: string;
  timeframe: string;                        // 5m / 15m / 1h / 4h
  alert_level: number;                      // 1 / 2 / 3
  kline_time: number;                       // 报警 K 线时间戳(ms)
  current_price: number;
  wave_start_price: number;                 // 第一波起涨价
  wave_end_price: number;                   // 第一波高点
  wave_amplitude_pct: number;              // 第一波涨幅 %
  wave_bar_count: number;                   // 第一波根数
  pullback_ratio: number;                   // 回调比例 0~1
  fib_zone: string;                         // 斐波那契区间描述
  volume_shrink: boolean;                   // 是否缩量
  reversal_signal: boolean;                 // 是否出现止跌形态
  ema20_support: boolean;                   // 回调低点在 EMA20 ±5% 范围内
  ema20?: number | null;                    // EMA20 值
  created_at?: Date;
}

export interface TrendFollowWatchContextRecord {
  id?: number;
  symbol: string;
  timeframe: string;
  state: string;                        // WATCHING / ALERTED / ABANDONED
  wave_start_price: number;
  wave_end_price: number;
  wave_amplitude_pct: number;
  wave_bar_count: number;
  wave_avg_volume: number;
  wave_end_time: number;
  pullback_lowest_price: number;
  pullback_bar_count: number;
  pullback_avg_volume: number;
  current_price: number;
  quote_volume_24h?: number | null;   // 进入观察区时的24h成交额(USDT)
  last_alert_level?: number | null;
  watch_start_time: number;
  abandoned_reason?: string | null;
  remark?: string | null;
  is_deleted?: boolean;
  updated_at?: Date;
}

export class TrendFollowRepository extends BaseRepository {

  /** 初始化表结构 */
  async init_tables(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS trend_follow_alerts (
        id          BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol      VARCHAR(20)  NOT NULL,
        timeframe   VARCHAR(5)   NOT NULL COMMENT '5m/15m/1h/4h',
        alert_level TINYINT      NOT NULL COMMENT '1轻度 2黄金 3深度',
        kline_time  BIGINT       NOT NULL,
        current_price       DECIMAL(20,8) NOT NULL,
        wave_start_price    DECIMAL(20,8) NOT NULL,
        wave_end_price      DECIMAL(20,8) NOT NULL,
        wave_amplitude_pct  DECIMAL(10,4) NOT NULL COMMENT '第一波涨幅%',
        wave_bar_count      INT           NOT NULL,
        pullback_ratio      DECIMAL(10,4) NOT NULL COMMENT '回调比例0~1',
        fib_zone            VARCHAR(50)   NOT NULL,
        volume_shrink       TINYINT(1)    NOT NULL DEFAULT 0,
        reversal_signal     TINYINT(1)    NOT NULL DEFAULT 0,
        ema20_support       TINYINT(1)    NOT NULL DEFAULT 0,
        ema20               DECIMAL(20,8) NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_tf_time_level (symbol, timeframe, kline_time, alert_level),
        INDEX idx_created_at  (created_at),
        INDEX idx_symbol      (symbol),
        INDEX idx_timeframe   (timeframe),
        INDEX idx_alert_level (alert_level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='趋势跟随报警记录'
    `;

    const sql_watch = `
      CREATE TABLE IF NOT EXISTS trend_follow_watch_contexts (
        id               BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol           VARCHAR(20)   NOT NULL,
        timeframe        VARCHAR(5)    NOT NULL COMMENT '5m/15m/1h/4h',
        state            VARCHAR(20)   NOT NULL COMMENT 'WATCHING/ALERTED/ABANDONED',
        wave_start_price     DECIMAL(20,8) NOT NULL,
        wave_end_price       DECIMAL(20,8) NOT NULL,
        wave_amplitude_pct   DECIMAL(10,4) NOT NULL,
        wave_bar_count       INT           NOT NULL,
        wave_avg_volume      DECIMAL(30,8) NOT NULL,
        wave_end_time        BIGINT        NOT NULL,
        pullback_lowest_price DECIMAL(20,8) NOT NULL,
        pullback_bar_count   INT           NOT NULL,
        pullback_avg_volume  DECIMAL(30,8) NOT NULL,
        current_price        DECIMAL(20,8) NOT NULL DEFAULT 0,
        quote_volume_24h     DECIMAL(30,2) NULL     COMMENT '进入时24h成交额(USDT)',
        last_alert_level     TINYINT       NULL,
        watch_start_time     BIGINT        NOT NULL,
        abandoned_reason     VARCHAR(200)  NULL,
        remark               VARCHAR(500)  NULL     COMMENT '手动备注',
        is_deleted           TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1=手动删除',
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        INDEX idx_state     (state),
        INDEX idx_symbol    (symbol),
        INDEX idx_timeframe (timeframe),
        INDEX idx_updated   (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='趋势跟随观察区快照'
    `;

    return this.execute_with_connection(async (conn) => {
      await conn.execute(sql);
      await conn.execute(sql_watch);
      logger.info('[TrendFollowRepository] Tables ready');
    });
  }

  /** 新建一条观察区记录，返回自增 id */
  async insert_watch_context(record: Omit<TrendFollowWatchContextRecord, 'id' | 'updated_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO trend_follow_watch_contexts
         (symbol, timeframe, state,
          wave_start_price, wave_end_price, wave_amplitude_pct, wave_bar_count, wave_avg_volume, wave_end_time,
          pullback_lowest_price, pullback_bar_count, pullback_avg_volume,
          current_price, quote_volume_24h, last_alert_level, watch_start_time, abandoned_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.symbol,
          record.timeframe,
          record.state,
          record.wave_start_price,
          record.wave_end_price,
          record.wave_amplitude_pct,
          record.wave_bar_count,
          record.wave_avg_volume,
          record.wave_end_time,
          record.pullback_lowest_price,
          record.pullback_bar_count,
          record.pullback_avg_volume,
          record.current_price,
          record.quote_volume_24h ?? null,
          record.last_alert_level ?? null,
          record.watch_start_time,
          record.abandoned_reason ?? null,
        ]
      );
      return result.insertId;
    });
  }

  /** 按 id 更新观察区记录 */
  async update_watch_context(id: number, record: Omit<TrendFollowWatchContextRecord, 'id' | 'updated_at'>): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `UPDATE trend_follow_watch_contexts SET
           state                 = ?,
           wave_start_price      = ?,
           wave_end_price        = ?,
           wave_amplitude_pct    = ?,
           wave_bar_count        = ?,
           wave_avg_volume       = ?,
           wave_end_time         = ?,
           pullback_lowest_price = ?,
           pullback_bar_count    = ?,
           pullback_avg_volume   = ?,
           current_price         = ?,
           quote_volume_24h      = COALESCE(?, quote_volume_24h),
           last_alert_level      = ?,
           watch_start_time      = ?,
           abandoned_reason      = ?
         WHERE id = ?`,
        [
          record.state,
          record.wave_start_price,
          record.wave_end_price,
          record.wave_amplitude_pct,
          record.wave_bar_count,
          record.wave_avg_volume,
          record.wave_end_time,
          record.pullback_lowest_price,
          record.pullback_bar_count,
          record.pullback_avg_volume,
          record.current_price,
          record.quote_volume_24h ?? null,
          record.last_alert_level ?? null,
          record.watch_start_time,
          record.abandoned_reason ?? null,
          id,
        ]
      );
    });
  }

  /** 查询观察区快照列表 */
  async get_watch_contexts(options: {
    symbol?: string;
    timeframe?: string;
    state?: string;
    deleted?: boolean;   // true=只查已手动删除；默认只查未删除
    limit?: number;
  } = {}): Promise<TrendFollowWatchContextRecord[]> {
    return this.execute_with_connection(async (conn) => {
      const is_deleted_val = options.deleted ? 1 : 0;

      let sql = `SELECT * FROM trend_follow_watch_contexts WHERE is_deleted = ${is_deleted_val}`;
      const params: any[] = [];

      if (!options.deleted && !options.state) {
        // 默认不传 state 时只返回活跃状态
        sql += " AND state IN ('WATCHING', 'ALERTED')";
      }
      if (options.state) {
        sql += ' AND state = ?';
        params.push(options.state);
      }
      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }
      if (options.timeframe) {
        sql += ' AND timeframe = ?';
        params.push(options.timeframe);
      }

      const use_updated_at = options.deleted || options.state === 'BREAKTHROUGH';
      sql += use_updated_at ? ' ORDER BY updated_at DESC' : ' ORDER BY watch_start_time DESC';

      if (options.limit) {
        sql += ' LIMIT ?';
        params.push(Number(options.limit));
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(r => this._map_context(r));
    });
  }

  /** 更新观察区记录的备注 */
  async update_watch_context_remark(id: number, remark: string | null): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        'UPDATE trend_follow_watch_contexts SET remark = ? WHERE id = ? AND is_deleted = 0',
        [remark, id]
      );
      return result.affectedRows > 0;
    });
  }

  /** 按 id 软删除观察区记录（标记 is_deleted=1） */
  async soft_delete_watch_context(id: number): Promise<boolean> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        'UPDATE trend_follow_watch_contexts SET is_deleted = 1 WHERE id = ? AND is_deleted = 0',
        [id]
      );
      return result.affectedRows > 0;
    });
  }

  /** 保存一条报警 */
  async save_alert(record: Omit<TrendFollowAlertRecord, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO trend_follow_alerts
         (symbol, timeframe, alert_level, kline_time, current_price,
          wave_start_price, wave_end_price, wave_amplitude_pct, wave_bar_count,
          pullback_ratio, fib_zone, volume_shrink, reversal_signal, ema20_support, ema20)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.symbol,
          record.timeframe,
          record.alert_level,
          record.kline_time,
          record.current_price,
          record.wave_start_price,
          record.wave_end_price,
          record.wave_amplitude_pct,
          record.wave_bar_count,
          record.pullback_ratio,
          record.fib_zone,
          record.volume_shrink ? 1 : 0,
          record.reversal_signal ? 1 : 0,
          record.ema20_support ? 1 : 0,
          record.ema20 ?? null,
        ]
      );
      return result.insertId;
    });
  }

  /** 查询报警列表 */
  async get_alerts(options: {
    symbol?: string;
    timeframe?: string;
    alert_level?: number;
    date?: string;          // YYYY-MM-DD 北京时间
    start_time?: number;
    end_time?: number;
    limit?: number;
  } = {}): Promise<TrendFollowAlertRecord[]> {
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM trend_follow_alerts WHERE 1=1';
      const params: any[] = [];

      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }
      if (options.timeframe) {
        sql += ' AND timeframe = ?';
        params.push(options.timeframe);
      }
      if (options.alert_level !== undefined) {
        sql += ' AND alert_level = ?';
        params.push(options.alert_level);
      }

      // 日期范围（北京时间）
      if (options.date) {
        const day_start = new Date(options.date + 'T00:00:00+08:00').getTime();
        const day_end   = day_start + 24 * 60 * 60 * 1000 - 1;
        sql += ' AND kline_time >= ? AND kline_time <= ?';
        params.push(day_start, day_end);
      } else {
        if (options.start_time !== undefined) {
          sql += ' AND kline_time >= ?';
          params.push(options.start_time);
        }
        if (options.end_time !== undefined) {
          sql += ' AND kline_time <= ?';
          params.push(options.end_time);
        }
      }

      sql += ' ORDER BY kline_time DESC, alert_level DESC';

      if (options.limit) {
        sql += ' LIMIT ?';
        params.push(Number(options.limit));
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(r => this._map(r));
    });
  }

  /** 清理旧记录 */
  async cleanup(days_to_keep: number = 30): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const cutoff = Date.now() - days_to_keep * 24 * 60 * 60 * 1000;
      const [result] = await conn.execute<ResultSetHeader>(
        'DELETE FROM trend_follow_alerts WHERE kline_time < ?',
        [cutoff]
      );
      return result.affectedRows;
    });
  }

  private _map_context(row: RowDataPacket): TrendFollowWatchContextRecord {
    return {
      id:                    row.id,
      symbol:                row.symbol,
      timeframe:             row.timeframe,
      state:                 row.state,
      wave_start_price:      parseFloat(row.wave_start_price),
      wave_end_price:        parseFloat(row.wave_end_price),
      wave_amplitude_pct:    parseFloat(row.wave_amplitude_pct),
      wave_bar_count:        row.wave_bar_count,
      wave_avg_volume:       parseFloat(row.wave_avg_volume),
      wave_end_time:         Number(row.wave_end_time),
      pullback_lowest_price: parseFloat(row.pullback_lowest_price),
      pullback_bar_count:    row.pullback_bar_count,
      pullback_avg_volume:   parseFloat(row.pullback_avg_volume),
      current_price:         parseFloat(row.current_price),
      quote_volume_24h:      row.quote_volume_24h != null ? parseFloat(row.quote_volume_24h) : null,
      last_alert_level:      row.last_alert_level ?? null,
      watch_start_time:      Number(row.watch_start_time),
      abandoned_reason:      row.abandoned_reason ?? null,
      remark:                row.remark ?? null,
      is_deleted:            row.is_deleted === 1,
      updated_at:            row.updated_at,
    };
  }

  private _map(row: RowDataPacket): TrendFollowAlertRecord {
    return {
      id:                   row.id,
      symbol:               row.symbol,
      timeframe:            row.timeframe,
      alert_level:          row.alert_level,
      kline_time:           Number(row.kline_time),
      current_price:        parseFloat(row.current_price),
      wave_start_price:     parseFloat(row.wave_start_price),
      wave_end_price:       parseFloat(row.wave_end_price),
      wave_amplitude_pct:   parseFloat(row.wave_amplitude_pct),
      wave_bar_count:       row.wave_bar_count,
      pullback_ratio:       parseFloat(row.pullback_ratio),
      fib_zone:             row.fib_zone,
      volume_shrink:        row.volume_shrink === 1,
      reversal_signal:      row.reversal_signal === 1,
      ema20_support:        row.ema20_support === 1,
      ema20:                row.ema20 ? parseFloat(row.ema20) : null,
      created_at:           row.created_at,
    };
  }
}
