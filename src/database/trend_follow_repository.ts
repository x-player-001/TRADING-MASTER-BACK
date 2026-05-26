/**
 * 趋势跟随报警数据库操作
 *
 * 表:
 *   trend_follow_alerts  - 报警记录（Lv1/2/3）
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
  created_at?: Date;
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
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_tf_time_level (symbol, timeframe, kline_time, alert_level),
        INDEX idx_created_at  (created_at),
        INDEX idx_symbol      (symbol),
        INDEX idx_timeframe   (timeframe),
        INDEX idx_alert_level (alert_level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='趋势跟随报警记录'
    `;

    return this.execute_with_connection(async (conn) => {
      await conn.execute(sql);
      logger.info('[TrendFollowRepository] Table ready');
    });
  }

  /** 保存一条报警 */
  async save_alert(record: Omit<TrendFollowAlertRecord, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO trend_follow_alerts
         (symbol, timeframe, alert_level, kline_time, current_price,
          wave_start_price, wave_end_price, wave_amplitude_pct, wave_bar_count,
          pullback_ratio, fib_zone, volume_shrink, reversal_signal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        params.push(options.limit);
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
      created_at:           row.created_at,
    };
  }
}
