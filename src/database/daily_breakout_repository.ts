/**
 * 日线趋势线突破 数据库操作（独立于趋势跟随）
 *
 * 表:
 *   kline_1d_agg               - 日线K线（币安直拉，结构同 kline_1h_agg / kline_4h_agg）
 *   daily_trendline_breakouts  - 日线下降趋势线 / 盘整上沿突破事件
 */

import { BaseRepository } from './base_repository';
import { DailyBar, TrendlineBreakout } from '@/analysis/trendline_breakout_detector';

const DAY_MS = 86_400_000;
const H4_MS = 4 * 3_600_000;

/** 日线K线入库结构 */
export interface DailyKlineRow extends DailyBar {
  symbol: string;
  close_time: number;
}

/** 突破事件记录 */
export interface DailyBreakoutRecord {
  id?: number;
  symbol: string;
  line_type: string;
  price_scale: string;
  touch_count: number;
  touches: { time: number; price: number }[];
  line_start_time: number;
  line_start_price: number;
  line_start_value: number;
  line_end_time: number;
  line_end_price: number;
  slope_pct_per_day: number;
  span_days: number;
  depth_pct: number;
  fit_error_pct: number;
  breakout_time: number;
  breakout_close: number;
  breakout_line_value: number;
  breakout_pct: number;
  breakout_volume_ratio: number;
  status: string;
  retest_time: number | null;
  retest_low: number | null;
  retest_distance_pct: number | null;
  fail_time: number | null;
  max_gain_pct: number;
  last_time: number;
  last_close: number;
  last_line_value: number;
  last_distance_pct: number;
  created_at?: Date;
  updated_at?: Date;
}

export class DailyBreakoutRepository extends BaseRepository {

  /** 建表（幂等） */
  async init_tables(): Promise<void> {
    await this.execute_query(`
      CREATE TABLE IF NOT EXISTS kline_1d_agg (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        \`interval\` VARCHAR(10) NOT NULL,
        open_time BIGINT NOT NULL,
        close_time BIGINT NOT NULL,
        open DECIMAL(20,8) NOT NULL,
        high DECIMAL(20,8) NOT NULL,
        low DECIMAL(20,8) NOT NULL,
        close DECIMAL(20,8) NOT NULL,
        volume DECIMAL(30,8) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_time (symbol, open_time),
        INDEX idx_open_time (open_time),
        INDEX idx_symbol (symbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日线K线'
    `);

    await this.execute_query(`
      CREATE TABLE IF NOT EXISTS daily_trendline_breakouts (
        id                    BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol                VARCHAR(20)   NOT NULL,
        line_type             VARCHAR(12)   NOT NULL COMMENT 'descending / horizontal',
        price_scale           VARCHAR(8)    NOT NULL COMMENT 'log / linear',
        touch_count           INT           NOT NULL,
        touches               JSON          NOT NULL COMMENT '[{time, price}]',
        line_start_time       BIGINT        NOT NULL,
        line_start_price      DECIMAL(20,8) NOT NULL,
        line_start_value      DECIMAL(20,8) NOT NULL DEFAULT 0 COMMENT '首触点时刻的精确线值（画线用）',
        line_end_time         BIGINT        NOT NULL,
        line_end_price        DECIMAL(20,8) NOT NULL,
        slope_pct_per_day     DECIMAL(10,4) NOT NULL,
        span_days             INT           NOT NULL,
        depth_pct             DECIMAL(10,4) NOT NULL,
        fit_error_pct         DECIMAL(10,4) NOT NULL,
        breakout_time         BIGINT        NOT NULL,
        breakout_close        DECIMAL(20,8) NOT NULL,
        breakout_line_value   DECIMAL(20,8) NOT NULL,
        breakout_pct          DECIMAL(10,4) NOT NULL,
        breakout_volume_ratio DECIMAL(10,4) NOT NULL,
        status                VARCHAR(10)   NOT NULL COMMENT 'breakout / retest / failed',
        retest_time           BIGINT        NULL,
        retest_low            DECIMAL(20,8) NULL,
        retest_distance_pct   DECIMAL(10,4) NULL,
        fail_time             BIGINT        NULL,
        max_gain_pct          DECIMAL(10,4) NOT NULL,
        last_time             BIGINT        NOT NULL,
        last_close            DECIMAL(20,8) NOT NULL,
        last_line_value       DECIMAL(20,8) NOT NULL,
        last_distance_pct     DECIMAL(10,4) NOT NULL,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_breakout (symbol, breakout_time),
        INDEX idx_status (status),
        INDEX idx_breakout_time (breakout_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日线趋势线/盘整上沿突破事件'
    `);

    // 早期建表缺 line_start_value，补列（幂等）
    const cols = await this.execute_query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_trendline_breakouts' AND COLUMN_NAME = 'line_start_value'
    `);
    if (cols.length === 0) {
      await this.execute_query(`
        ALTER TABLE daily_trendline_breakouts
        ADD COLUMN line_start_value DECIMAL(20,8) NOT NULL DEFAULT 0 COMMENT '首触点时刻的精确线值（画线用）' AFTER line_start_price
      `);
    }
  }

  /** 批量写入日线（已存在则覆盖 OHLCV） */
  async upsert_daily_klines(rows: DailyKlineRow[]): Promise<number> {
    let affected = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const params: any[] = [];
      for (const r of batch) {
        params.push(r.symbol, '1d', r.open_time, r.close_time, r.open, r.high, r.low, r.close, r.volume);
      }
      affected += await this.update_and_get_affected_rows(`
        INSERT INTO kline_1d_agg (symbol, \`interval\`, open_time, close_time, open, high, low, close, volume)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        ON DUPLICATE KEY UPDATE open = VALUES(open), high = VALUES(high), low = VALUES(low),
          close = VALUES(close), volume = VALUES(volume), close_time = VALUES(close_time)
      `, params);
    }
    return affected;
  }

  /** 某币种最新一根日线的 open_time（无数据返回 null） */
  async get_latest_daily_time(symbol: string): Promise<number | null> {
    const rows = await this.execute_query(
      'SELECT MAX(open_time) AS t FROM kline_1d_agg WHERE symbol = ?', [symbol]
    );
    return rows[0]?.t != null ? Number(rows[0].t) : null;
  }

  /** 日线表中的所有币种 */
  async get_daily_symbols(): Promise<string[]> {
    const rows = await this.execute_query('SELECT DISTINCT symbol FROM kline_1d_agg ORDER BY symbol');
    return rows.map(r => r.symbol);
  }

  /** 读取已收盘日线（升序） */
  async get_daily_klines(symbol: string, since_time: number): Promise<DailyBar[]> {
    const rows = await this.execute_query(`
      SELECT open_time, open, high, low, close, volume FROM kline_1d_agg
      WHERE symbol = ? AND open_time >= ? AND close_time < ?
      ORDER BY open_time
    `, [symbol, since_time, Date.now()]);
    return rows.map(to_bar);
  }

  /**
   * 兜底：由 kline_4h_agg 按 UTC 自然日聚合日线（仅保留 6 根齐全的日子）
   * 用于日线表尚未回填时（例如本机验证）
   */
  async get_daily_klines_from_4h(symbol: string, since_time: number): Promise<DailyBar[]> {
    const rows = await this.execute_query(`
      SELECT open_time, open, high, low, close, volume FROM kline_4h_agg
      WHERE symbol = ? AND open_time >= ?
      ORDER BY open_time
    `, [symbol, since_time]);

    const days = new Map<number, DailyBar[]>();
    for (const r of rows) {
      const bar = to_bar(r);
      const day = Math.floor(bar.open_time / DAY_MS) * DAY_MS;
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(bar);
    }

    const result: DailyBar[] = [];
    for (const [day, bars] of days) {
      if (bars.length !== DAY_MS / H4_MS) continue;
      result.push({
        open_time: day,
        open: bars[0].open,
        high: Math.max(...bars.map(b => b.high)),
        low: Math.min(...bars.map(b => b.low)),
        close: bars[bars.length - 1].close,
        volume: bars.reduce((s, b) => s + b.volume, 0),
      });
    }
    return result.sort((p, q) => p.open_time - q.open_time);
  }

  /** 4h 聚合表中的所有币种（兜底数据源用） */
  async get_4h_symbols(): Promise<string[]> {
    const rows = await this.execute_query('SELECT DISTINCT symbol FROM kline_4h_agg ORDER BY symbol');
    return rows.map(r => r.symbol);
  }

  /** 写入/更新突破事件（同一 symbol + 突破日唯一，重复扫描时刷新状态） */
  async upsert_breakout(symbol: string, b: TrendlineBreakout): Promise<void> {
    const first = b.touches[0];
    const last = b.touches[b.touches.length - 1];
    await this.execute_query(`
      INSERT INTO daily_trendline_breakouts (
        symbol, line_type, price_scale, touch_count, touches,
        line_start_time, line_start_price, line_start_value, line_end_time, line_end_price,
        slope_pct_per_day, span_days, depth_pct, fit_error_pct,
        breakout_time, breakout_close, breakout_line_value, breakout_pct, breakout_volume_ratio,
        status, retest_time, retest_low, retest_distance_pct, fail_time, max_gain_pct,
        last_time, last_close, last_line_value, last_distance_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        line_type = VALUES(line_type), price_scale = VALUES(price_scale),
        touch_count = VALUES(touch_count), touches = VALUES(touches),
        line_start_time = VALUES(line_start_time), line_start_price = VALUES(line_start_price),
        line_start_value = VALUES(line_start_value),
        line_end_time = VALUES(line_end_time), line_end_price = VALUES(line_end_price),
        slope_pct_per_day = VALUES(slope_pct_per_day), span_days = VALUES(span_days),
        depth_pct = VALUES(depth_pct), fit_error_pct = VALUES(fit_error_pct),
        breakout_close = VALUES(breakout_close), breakout_line_value = VALUES(breakout_line_value),
        breakout_pct = VALUES(breakout_pct), breakout_volume_ratio = VALUES(breakout_volume_ratio),
        status = VALUES(status), retest_time = VALUES(retest_time), retest_low = VALUES(retest_low),
        retest_distance_pct = VALUES(retest_distance_pct), fail_time = VALUES(fail_time),
        max_gain_pct = VALUES(max_gain_pct), last_time = VALUES(last_time),
        last_close = VALUES(last_close), last_line_value = VALUES(last_line_value),
        last_distance_pct = VALUES(last_distance_pct)
    `, [
      symbol, b.line_type, b.price_scale, b.touch_count, JSON.stringify(b.touches),
      first.time, first.price, b.line_value_at(first.time), last.time, last.price,
      round(b.slope_pct_per_day), Math.round(b.span_days), round(b.depth_pct), round(b.fit_error_pct),
      b.breakout_time, b.breakout_close, b.breakout_line_value, round(b.breakout_pct), round(b.breakout_volume_ratio),
      b.status, b.retest_time, b.retest_low, b.retest_distance_pct === null ? null : round(b.retest_distance_pct),
      b.fail_time, round(b.max_gain_pct),
      b.last_time, b.last_close, b.last_line_value, round(b.last_distance_pct),
    ]);
  }

  /** 删除某币种指定时间后的突破事件（重扫前清理，避免已不成立的旧事件残留） */
  async delete_breakouts_since(symbol: string, since_time: number): Promise<number> {
    return this.delete_and_get_affected_rows(
      'DELETE FROM daily_trendline_breakouts WHERE symbol = ? AND breakout_time >= ?', [symbol, since_time]
    );
  }

  /** 按 id 查询单条突破事件 */
  async get_breakout(id: number): Promise<DailyBreakoutRecord | null> {
    const rows = await this.execute_query('SELECT * FROM daily_trendline_breakouts WHERE id = ?', [id]);
    return rows.length ? to_breakout_record(rows[0]) : null;
  }

  /** 按条件查询突破事件 */
  async list_breakouts(filter: DailyBreakoutFilter = {}): Promise<DailyBreakoutRecord[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.symbol) { where.push('symbol = ?'); params.push(filter.symbol.toUpperCase()); }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    if (filter.line_type) { where.push('line_type = ?'); params.push(filter.line_type); }
    if (filter.since_time) { where.push('breakout_time >= ?'); params.push(filter.since_time); }
    if (filter.min_volume_ratio != null) { where.push('breakout_volume_ratio >= ?'); params.push(filter.min_volume_ratio); }
    if (filter.min_breakout_pct != null) { where.push('breakout_pct >= ?'); params.push(filter.min_breakout_pct); }
    if (filter.min_touches != null) { where.push('touch_count >= ?'); params.push(filter.min_touches); }
    if (filter.min_span_days != null) { where.push('span_days >= ?'); params.push(filter.min_span_days); }
    if (filter.max_distance_pct != null) { where.push('last_distance_pct <= ?'); params.push(filter.max_distance_pct); }

    const order = {
      breakout_time: 'breakout_time DESC',
      distance: 'last_distance_pct ASC',
      volume_ratio: 'breakout_volume_ratio DESC',
      touches: 'touch_count DESC, span_days DESC',
    }[filter.sort ?? 'breakout_time'];
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 200), 1000));

    const rows = await this.execute_query(`
      SELECT * FROM daily_trendline_breakouts
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${order} LIMIT ${limit}
    `, params);
    return rows.map(to_breakout_record);
  }
}

/** 突破事件查询条件 */
export interface DailyBreakoutFilter {
  symbol?: string;
  statuses?: string[];
  line_type?: string;
  since_time?: number;
  min_volume_ratio?: number;
  min_breakout_pct?: number;
  min_touches?: number;
  min_span_days?: number;
  max_distance_pct?: number;
  sort?: 'breakout_time' | 'distance' | 'volume_ratio' | 'touches';
  limit?: number;
}

/** DB 行转突破事件（DECIMAL/BIGINT 转 number，JSON 解析） */
function to_breakout_record(r: any): DailyBreakoutRecord {
  const num = (v: any) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r.id),
    symbol: r.symbol,
    line_type: r.line_type,
    price_scale: r.price_scale,
    touch_count: Number(r.touch_count),
    touches: typeof r.touches === 'string' ? JSON.parse(r.touches) : r.touches,
    line_start_time: Number(r.line_start_time),
    line_start_price: Number(r.line_start_price),
    line_start_value: Number(r.line_start_value),
    line_end_time: Number(r.line_end_time),
    line_end_price: Number(r.line_end_price),
    slope_pct_per_day: Number(r.slope_pct_per_day),
    span_days: Number(r.span_days),
    depth_pct: Number(r.depth_pct),
    fit_error_pct: Number(r.fit_error_pct),
    breakout_time: Number(r.breakout_time),
    breakout_close: Number(r.breakout_close),
    breakout_line_value: Number(r.breakout_line_value),
    breakout_pct: Number(r.breakout_pct),
    breakout_volume_ratio: Number(r.breakout_volume_ratio),
    status: r.status,
    retest_time: num(r.retest_time),
    retest_low: num(r.retest_low),
    retest_distance_pct: num(r.retest_distance_pct),
    fail_time: num(r.fail_time),
    max_gain_pct: Number(r.max_gain_pct),
    last_time: Number(r.last_time),
    last_close: Number(r.last_close),
    last_line_value: Number(r.last_line_value),
    last_distance_pct: Number(r.last_distance_pct),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** DB 行转日线 */
function to_bar(r: any): DailyBar {
  return {
    open_time: Number(r.open_time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  };
}

/** DECIMAL(10,4) 入库前截断，避免超范围 */
function round(v: number): number {
  return Math.round(Math.max(-999999, Math.min(999999, v)) * 10000) / 10000;
}
