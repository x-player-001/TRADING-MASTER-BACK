/**
 * 订单记录数据库存储
 * 按订单粒度存储，每个订单一条记录
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';

/**
 * 订单类型
 */
export type OrderType = 'OPEN' | 'CLOSE';

/**
 * 订单记录数据库实体
 */
export interface OrderRecordEntity {
  id?: number;

  // 订单标识
  order_id: string;                           // 币安订单ID（唯一）

  // 基础信息
  symbol: string;
  side: 'BUY' | 'SELL';                       // 订单方向
  position_side: 'LONG' | 'SHORT';            // 持仓方向
  order_type: OrderType;                      // 订单类型：开仓/平仓
  trading_mode: 'PAPER' | 'TESTNET' | 'LIVE';

  // 成交信息
  price: number;                              // 成交均价
  quantity: number;                           // 成交数量
  quote_quantity?: number;                    // 成交金额 (price * quantity)
  leverage?: number;                          // 杠杆倍数

  // 盈亏（仅平仓订单有值）
  realized_pnl?: number;                      // 已实现盈亏

  // 手续费
  commission?: number;                        // 手续费
  commission_asset?: string;                  // 手续费币种

  // 关联信息
  position_id?: string;                       // 持仓周期ID（用于关联同一次开平仓）
  related_order_id?: string;                  // 关联订单ID（平仓订单关联开仓订单）
  close_reason?: string;                      // 平仓原因（仅平仓订单）

  // 信号关联
  signal_id?: number;
  anomaly_id?: number;

  // 时间戳
  order_time: Date;                           // 订单时间
  created_at?: Date;
  updated_at?: Date;
}

/**
 * 订单记录 Repository
 */
export class OrderRecordRepository extends BaseRepository {
  private static instance: OrderRecordRepository;
  private table_initialized = false;

  private constructor() {
    super();
  }

  static get_instance(): OrderRecordRepository {
    if (!OrderRecordRepository.instance) {
      OrderRecordRepository.instance = new OrderRecordRepository();
    }
    return OrderRecordRepository.instance;
  }

  /**
   * 确保表存在
   */
  async ensure_table(): Promise<void> {
    if (this.table_initialized) return;

    const create_sql = `
      CREATE TABLE IF NOT EXISTS order_records (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,

        -- 订单标识
        order_id VARCHAR(50) NOT NULL,

        -- 基础信息
        symbol VARCHAR(20) NOT NULL,
        side ENUM('BUY', 'SELL') NOT NULL,
        position_side ENUM('LONG', 'SHORT') NOT NULL,
        order_type ENUM('OPEN', 'CLOSE') NOT NULL,
        trading_mode ENUM('PAPER', 'TESTNET', 'LIVE') NOT NULL DEFAULT 'LIVE',

        -- 成交信息
        price DECIMAL(20, 8) NOT NULL,
        quantity DECIMAL(20, 8) NOT NULL,
        quote_quantity DECIMAL(20, 8),
        leverage INT DEFAULT 1,

        -- 盈亏（仅平仓订单有值）
        realized_pnl DECIMAL(20, 8),

        -- 手续费
        commission DECIMAL(20, 8),
        commission_asset VARCHAR(10),

        -- 关联信息
        position_id VARCHAR(50),
        related_order_id VARCHAR(50),
        close_reason VARCHAR(50),

        -- 信号关联
        signal_id BIGINT,
        anomaly_id BIGINT,

        -- 时间戳
        order_time DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        -- 唯一约束
        UNIQUE KEY uk_order_id_mode (order_id, trading_mode),

        -- 索引
        INDEX idx_symbol (symbol),
        INDEX idx_order_type (order_type),
        INDEX idx_position_side (position_side),
        INDEX idx_trading_mode (trading_mode),
        INDEX idx_order_time (order_time),
        INDEX idx_position_id (position_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;

    await this.ensure_table_exists(create_sql, 'order_records');
    this.table_initialized = true;
    logger.info('[OrderRecordRepository] Table order_records initialized');
  }

  /**
   * 创建订单记录
   */
  async create_order(record: Omit<OrderRecordEntity, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    await this.ensure_table();

    // 检查是否已存在（避免重复插入）
    const existing = await this.find_by_order_id(record.order_id, record.trading_mode);
    if (existing && existing.id) {
      logger.info(`[OrderRecordRepository] Order ${record.order_id} already exists, skipping insert`);
      return existing.id;
    }

    const quote_quantity = record.quote_quantity ?? record.price * record.quantity;

    const sql = `
      INSERT INTO order_records (
        order_id, symbol, side, position_side, order_type, trading_mode,
        price, quantity, quote_quantity, leverage,
        realized_pnl, commission, commission_asset,
        position_id, related_order_id, close_reason,
        signal_id, anomaly_id, order_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      record.order_id,
      record.symbol,
      record.side,
      record.position_side,
      record.order_type,
      record.trading_mode,
      record.price,
      record.quantity,
      quote_quantity,
      record.leverage || 1,
      record.realized_pnl || null,
      record.commission || null,
      record.commission_asset || null,
      record.position_id || null,
      record.related_order_id || null,
      record.close_reason || null,
      record.signal_id || null,
      record.anomaly_id || null,
      record.order_time
    ];

    const id = await this.insert_and_get_id(sql, params);
    logger.info(`[OrderRecordRepository] Created order record id=${id} order_id=${record.order_id} ${record.symbol} ${record.order_type}`);
    return id;
  }

  /**
   * 根据订单ID查找记录（用于去重）
   */
  async find_by_order_id(order_id: string, trading_mode: string): Promise<OrderRecordEntity | null> {
    await this.ensure_table();

    const sql = `
      SELECT * FROM order_records
      WHERE order_id = ? AND trading_mode = ?
      LIMIT 1
    `;

    const rows = await this.execute_query(sql, [order_id, trading_mode]);
    return rows.length > 0 ? this.map_row_to_entity(rows[0]) : null;
  }

  /**
   * 批量检查订单是否存在
   */
  async find_existing_order_ids(order_ids: string[], trading_mode: string): Promise<Set<string>> {
    await this.ensure_table();

    if (order_ids.length === 0) return new Set();

    const placeholders = order_ids.map(() => '?').join(',');
    const sql = `
      SELECT order_id FROM order_records
      WHERE order_id IN (${placeholders}) AND trading_mode = ?
    `;

    const rows = await this.execute_query(sql, [...order_ids, trading_mode]);
    return new Set(rows.map((row: any) => row.order_id));
  }

  /**
   * 更新手续费信息
   */
  async update_commission(
    order_id: string,
    trading_mode: string,
    commission: number,
    commission_asset: string
  ): Promise<boolean> {
    await this.ensure_table();

    const sql = `
      UPDATE order_records SET
        commission = ?,
        commission_asset = ?
      WHERE order_id = ? AND trading_mode = ?
    `;

    const affected = await this.update_and_get_affected_rows(sql, [
      commission,
      commission_asset,
      order_id,
      trading_mode
    ]);

    if (affected > 0) {
      logger.info(`[OrderRecordRepository] Updated commission for order_id=${order_id}: ${commission} ${commission_asset}`);
    }
    return affected > 0;
  }

  /**
   * 更新订单的position_id
   */
  async update_position_id(
    order_id: string,
    trading_mode: string,
    position_id: string
  ): Promise<boolean> {
    await this.ensure_table();

    const sql = `
      UPDATE order_records SET
        position_id = ?
      WHERE order_id = ? AND trading_mode = ?
    `;

    const affected = await this.update_and_get_affected_rows(sql, [
      position_id,
      order_id,
      trading_mode
    ]);

    return affected > 0;
  }

  /**
   * 获取所有开仓订单（未完全平仓的）
   */
  async get_open_orders(trading_mode?: string, symbol?: string): Promise<OrderRecordEntity[]> {
    await this.ensure_table();

    let sql = `
      SELECT o.* FROM order_records o
      WHERE o.order_type = 'OPEN'
    `;
    const params: any[] = [];

    if (trading_mode) {
      sql += ` AND o.trading_mode = ?`;
      params.push(trading_mode);
    }

    if (symbol) {
      sql += ` AND o.symbol = ?`;
      params.push(symbol);
    }

    sql += ` ORDER BY o.order_time DESC`;

    const rows = await this.execute_query(sql, params);
    return rows.map((row: any) => this.map_row_to_entity(row));
  }

  /**
   * 获取平仓订单历史
   */
  async get_close_orders(options: {
    trading_mode?: string;
    symbol?: string;
    start_date?: Date;
    end_date?: Date;
    limit?: number;
    offset?: number;
  } = {}): Promise<OrderRecordEntity[]> {
    await this.ensure_table();

    let sql = `SELECT * FROM order_records WHERE order_type = 'CLOSE'`;
    const params: any[] = [];

    if (options.trading_mode) {
      sql += ` AND trading_mode = ?`;
      params.push(options.trading_mode);
    }

    if (options.symbol) {
      sql += ` AND symbol = ?`;
      params.push(options.symbol);
    }

    if (options.start_date) {
      sql += ` AND order_time >= ?`;
      params.push(options.start_date);
    }

    if (options.end_date) {
      sql += ` AND order_time <= ?`;
      params.push(options.end_date);
    }

    sql += ` ORDER BY order_time DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);

      if (options.offset) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }
    }

    const rows = await this.execute_query(sql, params);
    return rows.map((row: any) => this.map_row_to_entity(row));
  }

  /**
   * 获取交易统计（基于完整交易周期，按position_id分组）
   * 一个position_id代表一笔完整交易（开仓+可能多次分批平仓）
   */
  async get_statistics(trading_mode: string, start_date?: Date, end_date?: Date): Promise<{
    total_orders: number;
    open_orders: number;
    close_orders: number;
    total_trades: number;      // 完整交易笔数（按position_id）
    winning_trades: number;    // 盈利交易笔数
    losing_trades: number;     // 亏损交易笔数
    winning_orders: number;    // 保留：盈利平仓订单数
    losing_orders: number;     // 保留：亏损平仓订单数
    win_rate: number;
    total_pnl: number;
    total_commission: number;
    net_pnl: number;
    avg_pnl: number;
    max_win: number;
    max_loss: number;
  }> {
    await this.ensure_table();

    // 基础订单统计
    let base_sql = `
      SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN order_type = 'OPEN' THEN 1 ELSE 0 END) as open_orders,
        SUM(CASE WHEN order_type = 'CLOSE' THEN 1 ELSE 0 END) as close_orders,
        SUM(CASE WHEN order_type = 'CLOSE' AND realized_pnl > 0 THEN 1 ELSE 0 END) as winning_orders,
        SUM(CASE WHEN order_type = 'CLOSE' AND realized_pnl < 0 THEN 1 ELSE 0 END) as losing_orders,
        SUM(CASE WHEN order_type = 'CLOSE' THEN COALESCE(realized_pnl, 0) ELSE 0 END) as total_pnl,
        SUM(COALESCE(commission, 0)) as total_commission,
        AVG(CASE WHEN order_type = 'CLOSE' THEN realized_pnl ELSE NULL END) as avg_pnl,
        MAX(CASE WHEN order_type = 'CLOSE' THEN realized_pnl ELSE NULL END) as max_win,
        MIN(CASE WHEN order_type = 'CLOSE' THEN realized_pnl ELSE NULL END) as max_loss
      FROM order_records
      WHERE trading_mode = ?
    `;
    const params: any[] = [trading_mode];

    if (start_date) {
      base_sql += ` AND order_time >= ?`;
      params.push(start_date);
    }

    if (end_date) {
      base_sql += ` AND order_time <= ?`;
      params.push(end_date);
    }

    const rows = await this.execute_query(base_sql, params);
    const row = rows[0];

    // 按position_id分组统计完整交易
    // 有position_id的按position_id分组，没有的每笔平仓算一笔交易
    let trade_sql = `
      SELECT
        COALESCE(position_id, CONCAT('orphan_', id)) as group_id,
        SUM(COALESCE(realized_pnl, 0)) as trade_pnl
      FROM order_records
      WHERE trading_mode = ?
        AND order_type = 'CLOSE'
    `;
    const trade_params: any[] = [trading_mode];

    if (start_date) {
      trade_sql += ` AND order_time >= ?`;
      trade_params.push(start_date);
    }

    if (end_date) {
      trade_sql += ` AND order_time <= ?`;
      trade_params.push(end_date);
    }

    trade_sql += ` GROUP BY group_id`;

    const trade_rows = await this.execute_query(trade_sql, trade_params);

    // 统计完整交易的胜负
    let total_trades = 0;
    let winning_trades = 0;
    let losing_trades = 0;

    for (const tr of trade_rows) {
      total_trades++;
      const pnl = parseFloat(tr.trade_pnl) || 0;
      if (pnl > 0) {
        winning_trades++;
      } else if (pnl < 0) {
        losing_trades++;
      }
      // pnl = 0 不计入胜负
    }

    const total_pnl = parseFloat(row.total_pnl) || 0;
    const total_commission = parseFloat(row.total_commission) || 0;

    return {
      total_orders: parseInt(row.total_orders) || 0,
      open_orders: parseInt(row.open_orders) || 0,
      close_orders: parseInt(row.close_orders) || 0,
      total_trades,
      winning_trades,
      losing_trades,
      winning_orders: parseInt(row.winning_orders) || 0,
      losing_orders: parseInt(row.losing_orders) || 0,
      win_rate: total_trades > 0 ? winning_trades / total_trades : 0,
      total_pnl,
      total_commission,
      net_pnl: total_pnl - total_commission,
      avg_pnl: parseFloat(row.avg_pnl) || 0,
      max_win: parseFloat(row.max_win) || 0,
      max_loss: parseFloat(row.max_loss) || 0
    };
  }

  /**
   * 根据ID获取订单记录
   */
  async get_by_id(id: number): Promise<OrderRecordEntity | null> {
    await this.ensure_table();

    const sql = `SELECT * FROM order_records WHERE id = ?`;
    const rows = await this.execute_query(sql, [id]);
    return rows.length > 0 ? this.map_row_to_entity(rows[0]) : null;
  }

  /**
   * 根据position_id获取所有相关订单
   */
  async get_by_position_id(position_id: string): Promise<OrderRecordEntity[]> {
    await this.ensure_table();

    const sql = `
      SELECT * FROM order_records
      WHERE position_id = ?
      ORDER BY order_time ASC
    `;

    const rows = await this.execute_query(sql, [position_id]);
    return rows.map((row: any) => this.map_row_to_entity(row));
  }

  /**
   * 获取指定币种的所有订单
   */
  async get_by_symbol(symbol: string, trading_mode: string, limit?: number): Promise<OrderRecordEntity[]> {
    await this.ensure_table();

    let sql = `
      SELECT * FROM order_records
      WHERE symbol = ? AND trading_mode = ?
      ORDER BY order_time DESC
    `;
    const params: any[] = [symbol, trading_mode];

    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.execute_query(sql, params);
    return rows.map((row: any) => this.map_row_to_entity(row));
  }

  /**
   * 删除订单记录（仅用于测试）
   */
  async delete_by_id(id: number): Promise<boolean> {
    await this.ensure_table();

    const sql = `DELETE FROM order_records WHERE id = ?`;
    const affected = await this.update_and_get_affected_rows(sql, [id]);
    return affected > 0;
  }

  /**
   * 清空所有记录（仅用于测试）
   */
  async clear_all(trading_mode?: string): Promise<number> {
    await this.ensure_table();

    let sql = `DELETE FROM order_records`;
    const params: any[] = [];

    if (trading_mode) {
      sql += ` WHERE trading_mode = ?`;
      params.push(trading_mode);
    }

    const affected = await this.update_and_get_affected_rows(sql, params);
    logger.warn(`[OrderRecordRepository] Cleared ${affected} order records`);
    return affected;
  }

  /**
   * 将数据库行映射为实体
   */
  private map_row_to_entity(row: any): OrderRecordEntity {
    return {
      id: row.id,
      order_id: row.order_id,
      symbol: row.symbol,
      side: row.side,
      position_side: row.position_side,
      order_type: row.order_type,
      trading_mode: row.trading_mode,
      price: parseFloat(row.price),
      quantity: parseFloat(row.quantity),
      quote_quantity: row.quote_quantity ? parseFloat(row.quote_quantity) : undefined,
      leverage: row.leverage || 1,
      realized_pnl: row.realized_pnl ? parseFloat(row.realized_pnl) : undefined,
      commission: row.commission ? parseFloat(row.commission) : undefined,
      commission_asset: row.commission_asset || undefined,
      position_id: row.position_id || undefined,
      related_order_id: row.related_order_id || undefined,
      close_reason: row.close_reason || undefined,
      signal_id: row.signal_id || undefined,
      anomaly_id: row.anomaly_id || undefined,
      order_time: new Date(row.order_time),
      created_at: row.created_at ? new Date(row.created_at) : undefined,
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined
    };
  }
}
