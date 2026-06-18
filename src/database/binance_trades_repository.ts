/**
 * 币安成交流水存储层（事实源）
 *
 * 直接镜像币安 userTrades 的原始成交记录，trade_id 全局唯一，INSERT IGNORE 去重。
 * 交易记录（trade_record）的回合计算完全基于本表，不每次都打币安 API。
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

// 一条币安原始成交
export interface BinanceTrade {
  trade_id: number;          // 成交ID（币安 id，全局唯一）
  order_id: number;          // 订单ID
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  quote_qty: number;         // 成交额
  realized_pnl: number;      // 已实现盈亏（不含手续费）
  commission: number;        // 手续费
  commission_asset: string;  // 手续费币种
  position_side: string;     // LONG/SHORT/BOTH
  is_buyer: boolean;
  is_maker: boolean;
  trade_time: number;        // 成交时间(ms)
  created_at?: Date;
}

export class BinanceTradesRepository extends BaseRepository {

  /**
   * 初始化建表
   */
  async init_tables(): Promise<void> {
    await this.ensure_table_exists(`
      CREATE TABLE IF NOT EXISTS binance_trades (
        trade_id BIGINT PRIMARY KEY,
        order_id BIGINT NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        side ENUM('BUY','SELL') NOT NULL,
        price DECIMAL(20,8) NOT NULL,
        qty DECIMAL(30,8) NOT NULL,
        quote_qty DECIMAL(30,8) NOT NULL,
        realized_pnl DECIMAL(20,8) NOT NULL DEFAULT 0,
        commission DECIMAL(20,8) NOT NULL DEFAULT 0,
        commission_asset VARCHAR(10) NULL,
        position_side VARCHAR(10) NULL,
        is_buyer TINYINT(1) NOT NULL DEFAULT 0,
        is_maker TINYINT(1) NOT NULL DEFAULT 0,
        trade_time BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_symbol_time (symbol, trade_time),
        INDEX idx_order_id (order_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `, 'binance_trades');
  }

  /**
   * 批量去重写入成交（INSERT IGNORE，靠 trade_id 主键去重）。
   * 返回实际新插入的条数。
   */
  async upsert_trades(trades: BinanceTrade[]): Promise<number> {
    if (trades.length === 0) return 0;

    const placeholders = trades.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params: any[] = [];
    for (const t of trades) {
      params.push(
        t.trade_id, t.order_id, t.symbol, t.side, t.price, t.qty, t.quote_qty,
        t.realized_pnl, t.commission, t.commission_asset ?? null, t.position_side ?? null,
        t.is_buyer ? 1 : 0, t.is_maker ? 1 : 0, t.trade_time
      );
    }

    const sql = `
      INSERT IGNORE INTO binance_trades
        (trade_id, order_id, symbol, side, price, qty, quote_qty,
         realized_pnl, commission, commission_asset, position_side,
         is_buyer, is_maker, trade_time)
      VALUES ${placeholders}
    `;
    const affected = await this.update_and_get_affected_rows(sql, params);
    logger.info(`[BinanceTrades] upsert ${trades.length} trades, ${affected} new inserted`);
    return affected;
  }

  /**
   * 按币种读取成交流水（升序，供切回合用）。
   */
  async find_by_symbol(symbol: string, since_ms?: number): Promise<BinanceTrade[]> {
    const rows = since_ms != null
      ? await this.execute_query(
          `SELECT * FROM binance_trades WHERE symbol = ? AND trade_time >= ? ORDER BY trade_time ASC, trade_id ASC`,
          [symbol, since_ms]
        )
      : await this.execute_query(
          `SELECT * FROM binance_trades WHERE symbol = ? ORDER BY trade_time ASC, trade_id ASC`,
          [symbol]
        );
    return rows.map(this.map_row);
  }

  /**
   * 取库里已有成交涉及的所有币种（去重）。
   */
  async find_distinct_symbols(since_ms?: number): Promise<string[]> {
    const rows = since_ms != null
      ? await this.execute_query(`SELECT DISTINCT symbol FROM binance_trades WHERE trade_time >= ?`, [since_ms])
      : await this.execute_query(`SELECT DISTINCT symbol FROM binance_trades`);
    return rows.map((r: any) => r.symbol);
  }

  /**
   * 取某币种最新一笔成交时间，用于增量拉取的起点。
   */
  async get_last_trade_time(symbol: string): Promise<number | null> {
    const rows = await this.execute_query(
      `SELECT MAX(trade_time) AS t FROM binance_trades WHERE symbol = ?`,
      [symbol]
    );
    const t = rows[0]?.t;
    return t != null ? Number(t) : null;
  }

  /** 行映射：DECIMAL 字段 mysql2 默认返回字符串，统一转 number */
  private map_row(r: any): BinanceTrade {
    return {
      trade_id: Number(r.trade_id),
      order_id: Number(r.order_id),
      symbol: r.symbol,
      side: r.side,
      price: Number(r.price),
      qty: Number(r.qty),
      quote_qty: Number(r.quote_qty),
      realized_pnl: Number(r.realized_pnl),
      commission: Number(r.commission),
      commission_asset: r.commission_asset,
      position_side: r.position_side,
      is_buyer: !!r.is_buyer,
      is_maker: !!r.is_maker,
      trade_time: Number(r.trade_time),
      created_at: r.created_at,
    };
  }
}
