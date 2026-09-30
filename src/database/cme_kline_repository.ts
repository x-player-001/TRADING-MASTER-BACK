/**
 * CME 期货K线 数据库操作
 *
 * 独立于币安K线分表，一张表存全部周期：
 *   cme_klines - symbol（品种根代码，如 ES / GC）× interval（5m/15m/1h/4h）× open_time 唯一
 *
 * 数据来自 Databento 连续合约 1m 聚合，contract 记录该根K线所用的具体合约（如 ESZ6），用于标注换月。
 */

import { BaseRepository } from './base_repository';

/** CME K线行 */
export interface CmeKlineRow {
  symbol: string;
  interval: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  contract: string;
}

const UPSERT_BATCH_SIZE = 1000;

export class CmeKlineRepository extends BaseRepository {

  /** 初始化表结构（幂等） */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS cme_klines (
        id          BIGINT PRIMARY KEY AUTO_INCREMENT,
        symbol      VARCHAR(10)    NOT NULL COMMENT '品种根代码 ES/GC',
        \`interval\`  VARCHAR(4)     NOT NULL COMMENT '5m/15m/1h/4h',
        open_time   BIGINT         NOT NULL,
        close_time  BIGINT         NOT NULL,
        open        DECIMAL(20,6)  NOT NULL,
        high        DECIMAL(20,6)  NOT NULL,
        low         DECIMAL(20,6)  NOT NULL,
        close       DECIMAL(20,6)  NOT NULL,
        volume      BIGINT         NOT NULL,
        contract    VARCHAR(16)    NOT NULL COMMENT '具体合约，如 ESZ6（换月标注）',
        source      VARCHAR(16)    NOT NULL DEFAULT 'databento',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_symbol_interval_time (symbol, \`interval\`, open_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='CME期货K线（Databento 连续合约）'
    `, 'cme_klines');
  }

  /** 批量写入（已存在则覆盖，未收盘的最后一根下次会被更新） */
  async upsert_klines(rows: CmeKlineRow[]): Promise<number> {
    let affected = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
      const params = batch.flatMap(r => [
        r.symbol, r.interval, r.open_time, r.close_time, r.open, r.high, r.low, r.close, r.volume, r.contract,
      ]);
      affected += await this.update_and_get_affected_rows(`
        INSERT INTO cme_klines (symbol, \`interval\`, open_time, close_time, open, high, low, close, volume, contract)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        ON DUPLICATE KEY UPDATE close_time = VALUES(close_time), open = VALUES(open), high = VALUES(high),
          low = VALUES(low), close = VALUES(close), volume = VALUES(volume), contract = VALUES(contract)
      `, params);
    }
    return affected;
  }

  /** 某品种某周期最新一根的 open_time，无数据返回 null */
  async get_latest_open_time(symbol: string, interval: string): Promise<number | null> {
    const rows = await this.execute_query(
      'SELECT MAX(open_time) AS t FROM cme_klines WHERE symbol = ? AND `interval` = ?',
      [symbol, interval],
    );
    return rows[0]?.t !== null && rows[0]?.t !== undefined ? Number(rows[0].t) : null;
  }

  /** 查询区间K线（含两端，按时间升序） */
  async get_klines(symbol: string, interval: string, start_time: number, end_time: number): Promise<CmeKlineRow[]> {
    const rows = await this.execute_query(`
      SELECT symbol, \`interval\`, open_time, close_time, open, high, low, close, volume, contract
      FROM cme_klines
      WHERE symbol = ? AND \`interval\` = ? AND open_time BETWEEN ? AND ?
      ORDER BY open_time
    `, [symbol, interval, start_time, end_time]);
    return rows.map(r => ({
      symbol: r.symbol,
      interval: r.interval,
      open_time: Number(r.open_time),
      close_time: Number(r.close_time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      contract: r.contract,
    }));
  }

  /** 各品种各周期的数据概况 */
  async get_summary(): Promise<Array<{ symbol: string; interval: string; count: number; first_time: number; last_time: number }>> {
    const rows = await this.execute_query(`
      SELECT symbol, \`interval\`, COUNT(*) AS cnt, MIN(open_time) AS first_time, MAX(open_time) AS last_time
      FROM cme_klines GROUP BY symbol, \`interval\` ORDER BY symbol, \`interval\`
    `);
    return rows.map(r => ({
      symbol: r.symbol,
      interval: r.interval,
      count: Number(r.cnt),
      first_time: Number(r.first_time),
      last_time: Number(r.last_time),
    }));
  }
}
