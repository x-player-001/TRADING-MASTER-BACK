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
  pullback_lowest_price?: number | null;    // 回调最低影线价（事后评估 low 口径止损用，旧记录为 null）
  fib_zone: string;                         // 斐波那契区间描述
  volume_shrink: boolean;                   // 是否缩量
  reversal_signal: boolean;                 // 是否出现止跌形态
  ema20_support: boolean;                   // 回调低点在 EMA20 ±5% 范围内
  ema20?: number | null;                    // EMA20 值
  created_at?: Date;
}

/**
 * 报警事后评估结果（每条报警一对一）
 * 以「报警收盘价入场」为假想入场，分别用两种止损口径模拟：
 *   - low  口径：止损 = 回调最低点（pullback_lowest_price）
 *   - wave 口径：止损 = 第一波起涨价（wave_start_price）
 * 止盈统一为第一波高点（wave_end_price）。
 * 触及判断：一根K线内同时穿越止损止盈时，保守地算「止损先到」。
 */
export interface TrendFollowAlertOutcomeRecord {
  id?: number;
  alert_id: number;
  symbol: string;
  timeframe: string;
  alert_level: number;
  // 事后标签所需的信号特征冗余存储（便于统计 group by，省去 JOIN）
  volume_shrink: boolean;
  reversal_signal: boolean;
  ema20_support: boolean;
  // 价格基准
  entry_price: number;           // 报警收盘价（假想入场）
  target_price: number;          // 第一波高点（止盈）
  stop_low_price: number;        // low 口径止损：回调最低点
  stop_wave_price: number;       // wave 口径止损：第一波起涨价
  // 评估窗口
  eval_bars: number;             // 实际评估了多少根 K 线
  // MFE/MAE（相对入场价，%）
  mfe_pct: number;               // 最大有利偏移（最高价相对入场的最大涨幅，正数）
  mae_pct: number;               // 最大不利偏移（最低价相对入场的最大跌幅，负数）
  // low 口径结果
  outcome_low: string;           // win / loss / open
  rr_low: number | null;         // R 倍数（盈利距离 / 止损距离）
  bars_to_exit_low: number | null;
  // wave 口径结果
  outcome_wave: string;          // win / loss / open
  rr_wave: number | null;
  bars_to_exit_wave: number | null;
  evaluated_at?: Date;
}

/**
 * 多周期扳机入场确认事件（大周期到位 + 5m 结构确认）
 * outcome 为 NULL 表示尚未事后评估；评估口径：
 *   入场 = confirm_price，止损 = trigger_stop，止盈 = target_price，逐根 5m 模拟
 */
export interface TrendFollowEntryTriggerRecord {
  id?: number;
  symbol: string;
  parent_timeframe: string;        // 1h / 4h
  parent_alert_level: number;
  kline_time: number;              // 5m 确认K线 open_time
  confirm_price: number;
  trigger_stop: number;
  target_price: number;
  rr_ratio: number;
  // 事后评估结果（评估器回填）
  eval_bars?: number | null;
  mfe_pct?: number | null;
  mae_pct?: number | null;
  outcome?: string | null;         // win / loss / open / NULL未评估
  bars_to_exit?: number | null;
  evaluated_at?: Date | null;
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
        pullback_lowest_price DECIMAL(20,8) NULL COMMENT '回调最低影线价',
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

    const sql_outcome = `
      CREATE TABLE IF NOT EXISTS trend_follow_alert_outcomes (
        id              BIGINT PRIMARY KEY AUTO_INCREMENT,
        alert_id        BIGINT       NOT NULL,
        symbol          VARCHAR(20)  NOT NULL,
        timeframe       VARCHAR(5)   NOT NULL,
        alert_level     TINYINT      NOT NULL,
        volume_shrink   TINYINT(1)   NOT NULL DEFAULT 0,
        reversal_signal TINYINT(1)   NOT NULL DEFAULT 0,
        ema20_support   TINYINT(1)   NOT NULL DEFAULT 0,
        entry_price     DECIMAL(20,8) NOT NULL,
        target_price    DECIMAL(20,8) NOT NULL,
        stop_low_price  DECIMAL(20,8) NOT NULL,
        stop_wave_price DECIMAL(20,8) NOT NULL,
        eval_bars       INT          NOT NULL,
        mfe_pct         DECIMAL(10,4) NOT NULL,
        mae_pct         DECIMAL(10,4) NOT NULL,
        outcome_low     VARCHAR(8)   NOT NULL COMMENT 'win/loss/open',
        rr_low          DECIMAL(10,4) NULL,
        bars_to_exit_low  INT        NULL,
        outcome_wave    VARCHAR(8)   NOT NULL,
        rr_wave         DECIMAL(10,4) NULL,
        bars_to_exit_wave INT        NULL,
        evaluated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_alert (alert_id),
        INDEX idx_symbol      (symbol),
        INDEX idx_timeframe   (timeframe),
        INDEX idx_alert_level (alert_level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='趋势跟随报警事后评估结果'
    `;

    const sql_triggers = `
      CREATE TABLE IF NOT EXISTS trend_follow_entry_triggers (
        id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol             VARCHAR(20)  NOT NULL,
        parent_timeframe   VARCHAR(5)   NOT NULL COMMENT '触发扳机的大周期 1h/4h',
        parent_alert_level TINYINT      NOT NULL,
        kline_time         BIGINT       NOT NULL COMMENT '5m确认K线 open_time',
        confirm_price      DECIMAL(20,8) NOT NULL COMMENT '5m确认收盘价（假想入场）',
        trigger_stop       DECIMAL(20,8) NOT NULL COMMENT '5m摆动低点（止损）',
        target_price       DECIMAL(20,8) NOT NULL COMMENT '大周期第一波高点（止盈）',
        rr_ratio           DECIMAL(10,4) NOT NULL,
        eval_bars          INT           NULL COMMENT '事后评估根数（5m）',
        mfe_pct            DECIMAL(10,4) NULL,
        mae_pct            DECIMAL(10,4) NULL,
        outcome            VARCHAR(8)    NULL COMMENT 'win/loss/open，NULL=未评估',
        bars_to_exit       INT           NULL,
        evaluated_at       TIMESTAMP     NULL,
        created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_time (symbol, kline_time),
        INDEX idx_parent (parent_timeframe, parent_alert_level),
        INDEX idx_outcome (outcome)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='多周期扳机入场确认事件（含事后评估）'
    `;

    return this.execute_with_connection(async (conn) => {
      await conn.execute(sql);
      await conn.execute(sql_watch);
      await conn.execute(sql_outcome);
      await conn.execute(sql_triggers);
      // 兼容旧表：补齐回调最低影线价列
      // 注意：不用 IF NOT EXISTS（MySQL 8.0 不支持该语法，仅 MariaDB 支持），靠捕获 Duplicate column 实现幂等
      try {
        await conn.execute(
          `ALTER TABLE trend_follow_alerts ADD COLUMN pullback_lowest_price DECIMAL(20,8) NULL COMMENT '回调最低影线价'`
        );
      } catch (err: any) {
        if (!/Duplicate column/i.test(err.message ?? '')) {
          logger.warn(`[TrendFollowRepository] add pullback_lowest_price: ${err.message}`);
        }
      }
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
        sql += ` LIMIT ${Number(options.limit)}`;
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
          pullback_ratio, pullback_lowest_price, fib_zone, volume_shrink, reversal_signal, ema20_support, ema20)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          record.pullback_lowest_price ?? null,
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
        params.push(Number(options.alert_level));
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
          params.push(Number(options.start_time));
        }
        if (options.end_time !== undefined) {
          sql += ' AND kline_time <= ?';
          params.push(Number(options.end_time));
        }
      }

      sql += ' ORDER BY kline_time DESC, alert_level DESC';

      if (options.limit) {
        sql += ` LIMIT ${Number(options.limit)}`;
      }

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(r => this._map(r));
    });
  }

  // ==================== 事后评估结果 ====================

  /**
   * 查询待评估的报警：报警 K 线时间已过去足够久（now - kline_time >= ready_after_ms），
   * 且「尚未评估」或「上次评估仍是 open 且评估根数未达封顶」。
   * open 结果必须随时间推进重复评估，否则早评估的报警会永远停在 open，统计产生幸存者偏差。
   */
  async get_alerts_pending_outcome(ready_after_ms: number, limit: number = 200, cap_bars: number = 120): Promise<TrendFollowAlertRecord[]> {
    return this.execute_with_connection(async (conn) => {
      const cutoff = Date.now() - ready_after_ms;
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT a.* FROM trend_follow_alerts a
         LEFT JOIN trend_follow_alert_outcomes o ON o.alert_id = a.id
         WHERE a.kline_time <= ?
           AND (
             o.id IS NULL
             OR ((o.outcome_low = 'open' OR o.outcome_wave = 'open') AND o.eval_bars < ?)
           )
         ORDER BY a.kline_time ASC
         LIMIT ${Number(limit)}`,
        [cutoff, Number(cap_bars)]
      );
      return rows.map(r => this._map(r));
    });
  }

  /** 写入（或覆盖）一条报警评估结果 */
  async upsert_alert_outcome(record: Omit<TrendFollowAlertOutcomeRecord, 'id' | 'evaluated_at'>): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `INSERT INTO trend_follow_alert_outcomes
         (alert_id, symbol, timeframe, alert_level, volume_shrink, reversal_signal, ema20_support,
          entry_price, target_price, stop_low_price, stop_wave_price, eval_bars,
          mfe_pct, mae_pct,
          outcome_low, rr_low, bars_to_exit_low,
          outcome_wave, rr_wave, bars_to_exit_wave)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           eval_bars = VALUES(eval_bars),
           mfe_pct = VALUES(mfe_pct), mae_pct = VALUES(mae_pct),
           outcome_low = VALUES(outcome_low), rr_low = VALUES(rr_low), bars_to_exit_low = VALUES(bars_to_exit_low),
           outcome_wave = VALUES(outcome_wave), rr_wave = VALUES(rr_wave), bars_to_exit_wave = VALUES(bars_to_exit_wave),
           evaluated_at = CURRENT_TIMESTAMP`,
        [
          record.alert_id, record.symbol, record.timeframe, record.alert_level,
          record.volume_shrink ? 1 : 0, record.reversal_signal ? 1 : 0, record.ema20_support ? 1 : 0,
          record.entry_price, record.target_price, record.stop_low_price, record.stop_wave_price, record.eval_bars,
          record.mfe_pct, record.mae_pct,
          record.outcome_low, record.rr_low ?? null, record.bars_to_exit_low ?? null,
          record.outcome_wave, record.rr_wave ?? null, record.bars_to_exit_wave ?? null,
        ]
      );
    });
  }

  /**
   * 事后标签统计：按 等级 × 周期 × 信号组合 汇总胜率/盈亏比/MFE/MAE
   * stop 参数选择止损口径：'low'（回调低点）或 'wave'（起涨价）
   */
  async get_outcome_stats(options: {
    stop?: 'low' | 'wave';
    timeframe?: string;
    alert_level?: number;
    group_by_signals?: boolean;   // true 时把 volume_shrink/reversal/ema20 也纳入分组
  } = {}): Promise<any[]> {
    return this.execute_with_connection(async (conn) => {
      const stop = options.stop === 'wave' ? 'wave' : 'low';
      const outcome_col = `outcome_${stop}`;
      const rr_col = `rr_${stop}`;

      const group_cols = ['alert_level', 'timeframe'];
      if (options.group_by_signals) {
        group_cols.push('volume_shrink', 'reversal_signal', 'ema20_support');
      }

      const where: string[] = ['1=1'];
      const params: any[] = [];
      if (options.timeframe) { where.push('timeframe = ?'); params.push(options.timeframe); }
      if (options.alert_level !== undefined) { where.push('alert_level = ?'); params.push(Number(options.alert_level)); }

      const sql = `
        SELECT
          ${group_cols.join(', ')},
          COUNT(*) AS samples,
          SUM(${outcome_col} = 'win')  AS wins,
          SUM(${outcome_col} = 'loss') AS losses,
          SUM(${outcome_col} = 'open') AS opens,
          ROUND(SUM(${outcome_col} = 'win') / NULLIF(SUM(${outcome_col} IN ('win','loss')), 0) * 100, 1) AS win_rate,
          ROUND(AVG(${rr_col}), 2)        AS avg_rr,
          ROUND(AVG(mfe_pct), 2)          AS avg_mfe_pct,
          ROUND(AVG(mae_pct), 2)          AS avg_mae_pct,
          ROUND(AVG(mfe_pct) / NULLIF(-AVG(mae_pct), 0), 2) AS mfe_mae_ratio
        FROM trend_follow_alert_outcomes
        WHERE ${where.join(' AND ')}
        GROUP BY ${group_cols.join(', ')}
        ORDER BY alert_level, timeframe
      `;
      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(r => ({
        alert_level: r.alert_level,
        timeframe: r.timeframe,
        ...(options.group_by_signals ? {
          volume_shrink: r.volume_shrink === 1,
          reversal_signal: r.reversal_signal === 1,
          ema20_support: r.ema20_support === 1,
        } : {}),
        samples: Number(r.samples),
        wins: Number(r.wins),
        losses: Number(r.losses),
        opens: Number(r.opens),
        win_rate: r.win_rate != null ? Number(r.win_rate) : null,
        // avg_rr：均值，对浅回调（stop 贴近 entry）敏感，仅作参考；优先看 mfe_mae_ratio
        avg_rr: r.avg_rr != null ? Number(r.avg_rr) : null,
        avg_mfe_pct: r.avg_mfe_pct != null ? Number(r.avg_mfe_pct) : null,
        avg_mae_pct: r.avg_mae_pct != null ? Number(r.avg_mae_pct) : null,
        // mfe_mae_ratio：平均最大浮盈 / 平均最大浮亏，衡量信号潜力的稳健指标（不受 RR 爆炸影响）
        mfe_mae_ratio: r.mfe_mae_ratio != null ? Number(r.mfe_mae_ratio) : null,
      }));
    });
  }

  // ==================== 扳机入场确认事件 ====================

  /** 保存一条扳机确认事件（同 symbol 同确认K线幂等） */
  async insert_entry_trigger(record: Omit<TrendFollowEntryTriggerRecord, 'id' | 'created_at' | 'eval_bars' | 'mfe_pct' | 'mae_pct' | 'outcome' | 'bars_to_exit' | 'evaluated_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO trend_follow_entry_triggers
         (symbol, parent_timeframe, parent_alert_level, kline_time,
          confirm_price, trigger_stop, target_price, rr_ratio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.symbol,
          record.parent_timeframe,
          record.parent_alert_level,
          record.kline_time,
          record.confirm_price,
          record.trigger_stop,
          record.target_price,
          record.rr_ratio,
        ]
      );
      return result.insertId;
    });
  }

  /** 查询待评估的扳机事件：未评估，或仍为 open 且评估根数未达封顶 */
  async get_triggers_pending_outcome(ready_after_ms: number, limit: number = 200, cap_bars: number = 240): Promise<TrendFollowEntryTriggerRecord[]> {
    return this.execute_with_connection(async (conn) => {
      const cutoff = Date.now() - ready_after_ms;
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT * FROM trend_follow_entry_triggers
         WHERE kline_time <= ?
           AND (outcome IS NULL OR (outcome = 'open' AND eval_bars < ?))
         ORDER BY kline_time ASC
         LIMIT ${Number(limit)}`,
        [cutoff, Number(cap_bars)]
      );
      return rows.map(r => this._map_trigger(r));
    });
  }

  /** 回填一条扳机事件的评估结果 */
  async update_trigger_outcome(id: number, result: {
    eval_bars: number;
    mfe_pct: number;
    mae_pct: number;
    outcome: string;
    bars_to_exit: number | null;
  }): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.execute(
        `UPDATE trend_follow_entry_triggers
         SET eval_bars = ?, mfe_pct = ?, mae_pct = ?, outcome = ?, bars_to_exit = ?, evaluated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [result.eval_bars, result.mfe_pct, result.mae_pct, result.outcome, result.bars_to_exit ?? null, id]
      );
    });
  }

  /**
   * 扳机事后统计：按 父周期 × 父等级 汇总，便于和裸报警的 outcome-stats 对比
   * 「5m确认入场 vs 报警收盘直接入场」哪种打法更优
   */
  async get_trigger_outcome_stats(): Promise<any[]> {
    return this.execute_with_connection(async (conn) => {
      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT
           parent_timeframe, parent_alert_level,
           COUNT(*) AS samples,
           SUM(outcome = 'win')  AS wins,
           SUM(outcome = 'loss') AS losses,
           SUM(outcome = 'open') AS opens,
           SUM(outcome IS NULL)  AS unevaluated,
           ROUND(SUM(outcome = 'win') / NULLIF(SUM(outcome IN ('win','loss')), 0) * 100, 1) AS win_rate,
           ROUND(AVG(rr_ratio), 2) AS avg_rr,
           ROUND(AVG(mfe_pct), 2)  AS avg_mfe_pct,
           ROUND(AVG(mae_pct), 2)  AS avg_mae_pct
         FROM trend_follow_entry_triggers
         GROUP BY parent_timeframe, parent_alert_level
         ORDER BY parent_timeframe, parent_alert_level`
      );
      return rows.map(r => ({
        parent_timeframe: r.parent_timeframe,
        parent_alert_level: r.parent_alert_level,
        samples: Number(r.samples),
        wins: Number(r.wins),
        losses: Number(r.losses),
        opens: Number(r.opens),
        unevaluated: Number(r.unevaluated),
        win_rate: r.win_rate != null ? Number(r.win_rate) : null,
        avg_rr: r.avg_rr != null ? Number(r.avg_rr) : null,
        avg_mfe_pct: r.avg_mfe_pct != null ? Number(r.avg_mfe_pct) : null,
        avg_mae_pct: r.avg_mae_pct != null ? Number(r.avg_mae_pct) : null,
      }));
    });
  }

  /** 查询扳机事件列表（按确认时间倒序，含评估器回填的事后结果） */
  async get_triggers(options: {
    symbol?: string;
    parent_timeframe?: string;
    outcome?: string;        // win / loss / open / unevaluated（未评估）
    start_time?: number;     // kline_time 起始(ms)
    limit?: number;
  } = {}): Promise<TrendFollowEntryTriggerRecord[]> {
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM trend_follow_entry_triggers WHERE 1=1';
      const params: any[] = [];

      if (options.symbol) {
        sql += ' AND symbol = ?';
        params.push(options.symbol.toUpperCase());
      }
      if (options.parent_timeframe) {
        sql += ' AND parent_timeframe = ?';
        params.push(options.parent_timeframe);
      }
      if (options.outcome === 'unevaluated') {
        sql += ' AND outcome IS NULL';
      } else if (options.outcome) {
        sql += ' AND outcome = ?';
        params.push(options.outcome);
      }
      if (options.start_time !== undefined) {
        sql += ' AND kline_time >= ?';
        params.push(Number(options.start_time));
      }

      sql += ` ORDER BY kline_time DESC LIMIT ${Number(options.limit ?? 50)}`;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
      return rows.map(r => this._map_trigger(r));
    });
  }

  private _map_trigger(row: RowDataPacket): TrendFollowEntryTriggerRecord {
    return {
      id:                 row.id,
      symbol:             row.symbol,
      parent_timeframe:   row.parent_timeframe,
      parent_alert_level: row.parent_alert_level,
      kline_time:         Number(row.kline_time),
      confirm_price:      parseFloat(row.confirm_price),
      trigger_stop:       parseFloat(row.trigger_stop),
      target_price:       parseFloat(row.target_price),
      rr_ratio:           parseFloat(row.rr_ratio),
      eval_bars:          row.eval_bars ?? null,
      mfe_pct:            row.mfe_pct != null ? parseFloat(row.mfe_pct) : null,
      mae_pct:            row.mae_pct != null ? parseFloat(row.mae_pct) : null,
      outcome:            row.outcome ?? null,
      bars_to_exit:       row.bars_to_exit ?? null,
      evaluated_at:       row.evaluated_at ?? null,
      created_at:         row.created_at,
    };
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
      pullback_lowest_price: row.pullback_lowest_price != null ? parseFloat(row.pullback_lowest_price) : null,
      fib_zone:             row.fib_zone,
      volume_shrink:        row.volume_shrink === 1,
      reversal_signal:      row.reversal_signal === 1,
      ema20_support:        row.ema20_support === 1,
      ema20:                row.ema20 ? parseFloat(row.ema20) : null,
      created_at:           row.created_at,
    };
  }
}
