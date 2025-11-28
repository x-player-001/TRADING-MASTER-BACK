/**
 * 交易记录数据库存储
 * 存储所有开仓、平仓记录，支持历史查询和统计分析
 */

import { BaseRepository } from './base_repository';
import { logger } from '@/utils/logger';
import { PositionSide, TradingMode } from '@/types/trading_types';

/**
 * 交易记录数据库实体
 */
export interface TradeRecordEntity {
  id?: number;

  // 基础信息
  symbol: string;
  side: 'LONG' | 'SHORT';
  trading_mode: 'PAPER' | 'TESTNET' | 'LIVE';

  // 开仓信息
  entry_price: number;
  quantity: number;
  leverage: number;
  margin: number;                    // 保证金
  position_value: number;            // 仓位价值 = quantity * entry_price

  // 止损止盈配置
  stop_loss_price?: number;
  take_profit_price?: number;

  // 平仓信息
  exit_price?: number;
  realized_pnl?: number;
  realized_pnl_percent?: number;     // 基于保证金的收益率
  close_reason?: string;             // STOP_LOSS, TAKE_PROFIT, LIQUIDATION, MANUAL, RISK_LIMIT, TIMEOUT, SYNC_CLOSED

  // 手续费信息
  entry_commission?: number;         // 开仓手续费
  exit_commission?: number;          // 平仓手续费
  total_commission?: number;         // 总手续费
  commission_asset?: string;         // 手续费币种（通常是USDT）
  net_pnl?: number;                  // 净盈亏 = realized_pnl - total_commission

  // 币安订单信息
  entry_order_id?: string;           // 开仓订单ID
  exit_order_id?: string;            // 平仓订单ID
  tp_order_ids?: string;             // 止盈订单ID列表（JSON）

  // 信号关联
  signal_id?: number;
  signal_score?: number;
  anomaly_id?: number;               // 关联的OI异动记录ID

  // 状态
  status: 'OPEN' | 'CLOSED' | 'PARTIALLY_CLOSED';

  // 时间戳
  opened_at: Date;
  closed_at?: Date;
  created_at?: Date;
  updated_at?: Date;

  // 分批止盈记录（JSON）
  take_profit_executions?: string;
}

/**
 * 交易记录 Repository
 */
export class TradeRecordRepository extends BaseRepository {
  private static instance: TradeRecordRepository;
  private table_initialized = false;

  private constructor() {
    super();
  }

  static get_instance(): TradeRecordRepository {
    if (!TradeRecordRepository.instance) {
      TradeRecordRepository.instance = new TradeRecordRepository();
    }
    return TradeRecordRepository.instance;
  }

  /**
   * 确保表存在
   */
  async ensure_table(): Promise<void> {
    if (this.table_initialized) return;

    const create_sql = `
      CREATE TABLE IF NOT EXISTS trade_records (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,

        -- 基础信息
        symbol VARCHAR(20) NOT NULL,
        side ENUM('LONG', 'SHORT') NOT NULL,
        trading_mode ENUM('PAPER', 'TESTNET', 'LIVE') NOT NULL DEFAULT 'LIVE',

        -- 开仓信息
        entry_price DECIMAL(20, 8) NOT NULL,
        quantity DECIMAL(20, 8) NOT NULL,
        leverage INT NOT NULL DEFAULT 1,
        margin DECIMAL(20, 8) NOT NULL,
        position_value DECIMAL(20, 8) NOT NULL,

        -- 止损止盈配置
        stop_loss_price DECIMAL(20, 8),
        take_profit_price DECIMAL(20, 8),

        -- 平仓信息
        exit_price DECIMAL(20, 8),
        realized_pnl DECIMAL(20, 8),
        realized_pnl_percent DECIMAL(10, 4),
        close_reason VARCHAR(50),

        -- 手续费信息
        entry_commission DECIMAL(20, 8),
        exit_commission DECIMAL(20, 8),
        total_commission DECIMAL(20, 8),
        commission_asset VARCHAR(10),
        net_pnl DECIMAL(20, 8),

        -- 币安订单信息
        entry_order_id VARCHAR(50),
        exit_order_id VARCHAR(50),
        tp_order_ids TEXT,

        -- 信号关联
        signal_id BIGINT,
        signal_score DECIMAL(5, 2),
        anomaly_id BIGINT,

        -- 状态
        status ENUM('OPEN', 'CLOSED', 'PARTIALLY_CLOSED') NOT NULL DEFAULT 'OPEN',

        -- 时间戳
        opened_at DATETIME NOT NULL,
        closed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        -- 分批止盈记录
        take_profit_executions TEXT,

        -- 索引
        INDEX idx_symbol (symbol),
        INDEX idx_status (status),
        INDEX idx_trading_mode (trading_mode),
        INDEX idx_opened_at (opened_at),
        INDEX idx_closed_at (closed_at),
        INDEX idx_symbol_status (symbol, status),
        INDEX idx_mode_status (trading_mode, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;

    await this.ensure_table_exists(create_sql, 'trade_records');
    this.table_initialized = true;
    logger.info('[TradeRecordRepository] Table trade_records initialized');
  }

  /**
   * 创建开仓记录
   */
  async create_trade(record: Omit<TradeRecordEntity, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    await this.ensure_table();

    const sql = `
      INSERT INTO trade_records (
        symbol, side, trading_mode,
        entry_price, quantity, leverage, margin, position_value,
        stop_loss_price, take_profit_price,
        entry_order_id, tp_order_ids,
        signal_id, signal_score, anomaly_id,
        status, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      record.symbol,
      record.side,
      record.trading_mode,
      record.entry_price,
      record.quantity,
      record.leverage,
      record.margin,
      record.position_value,
      record.stop_loss_price || null,
      record.take_profit_price || null,
      record.entry_order_id || null,
      record.tp_order_ids || null,
      record.signal_id || null,
      record.signal_score || null,
      record.anomaly_id || null,
      record.status,
      record.opened_at
    ];

    const id = await this.insert_and_get_id(sql, params);
    logger.info(`[TradeRecordRepository] Created trade record id=${id} ${record.symbol} ${record.side}`);
    return id;
  }

  /**
   * 更新平仓信息
   */
  async close_trade(
    id: number,
    exit_price: number,
    realized_pnl: number,
    realized_pnl_percent: number,
    close_reason: string,
    exit_order_id?: string,
    take_profit_executions?: string
  ): Promise<boolean> {
    await this.ensure_table();

    const sql = `
      UPDATE trade_records SET
        exit_price = ?,
        realized_pnl = ?,
        realized_pnl_percent = ?,
        close_reason = ?,
        exit_order_id = ?,
        take_profit_executions = ?,
        status = 'CLOSED',
        closed_at = NOW()
      WHERE id = ?
    `;

    const affected = await this.update_and_get_affected_rows(sql, [
      exit_price,
      realized_pnl,
      realized_pnl_percent,
      close_reason,
      exit_order_id || null,
      take_profit_executions || null,
      id
    ]);

    if (affected > 0) {
      logger.info(`[TradeRecordRepository] Closed trade id=${id} pnl=${realized_pnl.toFixed(4)} reason=${close_reason}`);
    }
    return affected > 0;
  }

  /**
   * 更新开仓手续费信息（开仓后查询币安成交记录获取）
   */
  async update_entry_commission(
    id: number,
    entry_commission: number,
    commission_asset: string,
    actual_entry_price?: number,
    actual_quantity?: number
  ): Promise<boolean> {
    await this.ensure_table();

    let sql = `
      UPDATE trade_records SET
        entry_commission = ?,
        commission_asset = ?,
        total_commission = COALESCE(exit_commission, 0) + ?
    `;
    const params: any[] = [entry_commission, commission_asset, entry_commission];

    // 如果提供了实际成交价格和数量，同时更新
    if (actual_entry_price !== undefined) {
      sql += `, entry_price = ?`;
      params.push(actual_entry_price);
    }
    if (actual_quantity !== undefined) {
      sql += `, quantity = ?`;
      params.push(actual_quantity);
    }

    sql += ` WHERE id = ?`;
    params.push(id);

    const affected = await this.update_and_get_affected_rows(sql, params);
    if (affected > 0) {
      logger.info(`[TradeRecordRepository] Updated entry commission for id=${id}: ${entry_commission} ${commission_asset}`);
    }
    return affected > 0;
  }

  /**
   * 更新平仓手续费和净盈亏
   */
  async update_exit_commission(
    id: number,
    exit_commission: number,
    realized_pnl_from_binance?: number
  ): Promise<boolean> {
    await this.ensure_table();

    // 先获取当前记录的开仓手续费
    const record = await this.get_by_id(id);
    if (!record) {
      return false;
    }

    const entry_commission = record.entry_commission || 0;
    const total_commission = entry_commission + exit_commission;
    const realized_pnl = realized_pnl_from_binance ?? record.realized_pnl ?? 0;
    const net_pnl = realized_pnl - total_commission;

    const sql = `
      UPDATE trade_records SET
        exit_commission = ?,
        total_commission = ?,
        net_pnl = ?
        ${realized_pnl_from_binance !== undefined ? ', realized_pnl = ?' : ''}
      WHERE id = ?
    `;

    const params: any[] = [exit_commission, total_commission, net_pnl];
    if (realized_pnl_from_binance !== undefined) {
      params.push(realized_pnl_from_binance);
    }
    params.push(id);

    const affected = await this.update_and_get_affected_rows(sql, params);
    if (affected > 0) {
      logger.info(`[TradeRecordRepository] Updated exit commission for id=${id}: ${exit_commission}, total=${total_commission}, net_pnl=${net_pnl}`);
    }
    return affected > 0;
  }

  /**
   * 根据symbol和状态查找开仓记录
   */
  async find_open_trade_by_symbol(symbol: string, side: 'LONG' | 'SHORT', trading_mode: string): Promise<TradeRecordEntity | null> {
    await this.ensure_table();

    const sql = `
      SELECT * FROM trade_records
      WHERE symbol = ? AND side = ? AND trading_mode = ? AND status = 'OPEN'
      ORDER BY opened_at DESC
      LIMIT 1
    `;

    const rows = await this.execute_query(sql, [symbol, side, trading_mode]);
    return rows.length > 0 ? this.map_row_to_entity(rows[0]) : null;
  }

  /**
   * 获取所有开仓记录
   */
  async get_open_trades(trading_mode?: string): Promise<TradeRecordEntity[]> {
    await this.ensure_table();

    let sql = `SELECT * FROM trade_records WHERE status = 'OPEN'`;
    const params: any[] = [];

    if (trading_mode) {
      sql += ` AND trading_mode = ?`;
      params.push(trading_mode);
    }

    sql += ` ORDER BY opened_at DESC`;

    const rows = await this.execute_query(sql, params);
    return rows.map(row => this.map_row_to_entity(row));
  }

  /**
   * 获取历史交易记录
   */
  async get_trade_history(options: {
    trading_mode?: string;
    symbol?: string;
    start_date?: Date;
    end_date?: Date;
    limit?: number;
    offset?: number;
  } = {}): Promise<TradeRecordEntity[]> {
    await this.ensure_table();

    let sql = `SELECT * FROM trade_records WHERE status = 'CLOSED'`;
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
      sql += ` AND closed_at >= ?`;
      params.push(options.start_date);
    }

    if (options.end_date) {
      sql += ` AND closed_at <= ?`;
      params.push(options.end_date);
    }

    sql += ` ORDER BY closed_at DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);

      if (options.offset) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }
    }

    const rows = await this.execute_query(sql, params);
    return rows.map(row => this.map_row_to_entity(row));
  }

  /**
   * 获取交易统计
   */
  async get_statistics(trading_mode: string, start_date?: Date, end_date?: Date): Promise<{
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    win_rate: number;
    total_pnl: number;
    avg_pnl: number;
    max_win: number;
    max_loss: number;
    avg_holding_time_minutes: number;
    total_commission: number;
    net_pnl: number;
  }> {
    await this.ensure_table();

    let sql = `
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
        SUM(realized_pnl) as total_pnl,
        AVG(realized_pnl) as avg_pnl,
        MAX(realized_pnl) as max_win,
        MIN(realized_pnl) as max_loss,
        AVG(TIMESTAMPDIFF(MINUTE, opened_at, closed_at)) as avg_holding_time_minutes,
        SUM(COALESCE(total_commission, 0)) as total_commission,
        SUM(COALESCE(net_pnl, realized_pnl)) as net_pnl
      FROM trade_records
      WHERE status = 'CLOSED' AND trading_mode = ?
    `;
    const params: any[] = [trading_mode];

    if (start_date) {
      sql += ` AND opened_at >= ?`;
      params.push(start_date);
    }

    if (end_date) {
      sql += ` AND opened_at <= ?`;
      params.push(end_date);
    }

    const rows = await this.execute_query(sql, params);
    const row = rows[0];

    const total = parseInt(row.total_trades) || 0;
    const winning = parseInt(row.winning_trades) || 0;

    return {
      total_trades: total,
      winning_trades: winning,
      losing_trades: parseInt(row.losing_trades) || 0,
      win_rate: total > 0 ? winning / total : 0,
      total_pnl: parseFloat(row.total_pnl) || 0,
      avg_pnl: parseFloat(row.avg_pnl) || 0,
      max_win: parseFloat(row.max_win) || 0,
      max_loss: parseFloat(row.max_loss) || 0,
      avg_holding_time_minutes: parseFloat(row.avg_holding_time_minutes) || 0,
      total_commission: parseFloat(row.total_commission) || 0,
      net_pnl: parseFloat(row.net_pnl) || 0
    };
  }

  /**
   * 获取交易统计（按平仓时间过滤）
   * 用于统计系统启动后平仓的交易
   */
  async get_statistics_by_close_time(trading_mode: string, start_date?: Date, end_date?: Date): Promise<{
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    win_rate: number;
    total_pnl: number;
    avg_pnl: number;
    max_win: number;
    max_loss: number;
    avg_holding_time_minutes: number;
    total_commission: number;
    net_pnl: number;
  }> {
    await this.ensure_table();

    let sql = `
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
        SUM(realized_pnl) as total_pnl,
        AVG(realized_pnl) as avg_pnl,
        MAX(realized_pnl) as max_win,
        MIN(realized_pnl) as max_loss,
        AVG(TIMESTAMPDIFF(MINUTE, opened_at, closed_at)) as avg_holding_time_minutes,
        SUM(COALESCE(total_commission, 0)) as total_commission,
        SUM(COALESCE(net_pnl, realized_pnl)) as net_pnl
      FROM trade_records
      WHERE status = 'CLOSED' AND trading_mode = ?
    `;
    const params: any[] = [trading_mode];

    if (start_date) {
      sql += ` AND closed_at >= ?`;
      params.push(start_date);
    }

    if (end_date) {
      sql += ` AND closed_at <= ?`;
      params.push(end_date);
    }

    const rows = await this.execute_query(sql, params);
    const row = rows[0];

    const total = parseInt(row.total_trades) || 0;
    const winning = parseInt(row.winning_trades) || 0;

    return {
      total_trades: total,
      winning_trades: winning,
      losing_trades: parseInt(row.losing_trades) || 0,
      win_rate: total > 0 ? winning / total : 0,
      total_pnl: parseFloat(row.total_pnl) || 0,
      avg_pnl: parseFloat(row.avg_pnl) || 0,
      max_win: parseFloat(row.max_win) || 0,
      max_loss: parseFloat(row.max_loss) || 0,
      avg_holding_time_minutes: parseFloat(row.avg_holding_time_minutes) || 0,
      total_commission: parseFloat(row.total_commission) || 0,
      net_pnl: parseFloat(row.net_pnl) || 0
    };
  }

  /**
   * 根据ID获取交易记录
   */
  async get_by_id(id: number): Promise<TradeRecordEntity | null> {
    await this.ensure_table();

    const sql = `SELECT * FROM trade_records WHERE id = ?`;
    const rows = await this.execute_query(sql, [id]);
    return rows.length > 0 ? this.map_row_to_entity(rows[0]) : null;
  }

  /**
   * 根据开仓订单ID查找记录（用于去重）
   */
  async find_by_entry_order_id(entry_order_id: string, trading_mode: string): Promise<TradeRecordEntity | null> {
    await this.ensure_table();

    const sql = `
      SELECT * FROM trade_records
      WHERE entry_order_id = ? AND trading_mode = ?
      LIMIT 1
    `;

    const rows = await this.execute_query(sql, [entry_order_id, trading_mode]);
    return rows.length > 0 ? this.map_row_to_entity(rows[0]) : null;
  }

  /**
   * 创建已平仓的交易记录（用于回填历史交易）
   */
  async create_closed_trade(record: Omit<TradeRecordEntity, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    await this.ensure_table();

    const sql = `
      INSERT INTO trade_records (
        symbol, side, trading_mode,
        entry_price, quantity, leverage, margin, position_value,
        stop_loss_price, take_profit_price,
        exit_price, realized_pnl, realized_pnl_percent, close_reason,
        entry_commission, exit_commission, total_commission, commission_asset, net_pnl,
        entry_order_id, exit_order_id, tp_order_ids,
        signal_id, signal_score, anomaly_id,
        status, opened_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      record.symbol,
      record.side,
      record.trading_mode,
      record.entry_price,
      record.quantity,
      record.leverage,
      record.margin,
      record.position_value,
      record.stop_loss_price || null,
      record.take_profit_price || null,
      record.exit_price || null,
      record.realized_pnl || null,
      record.realized_pnl_percent || null,
      record.close_reason || null,
      record.entry_commission || null,
      record.exit_commission || null,
      record.total_commission || null,
      record.commission_asset || null,
      record.net_pnl || null,
      record.entry_order_id || null,
      record.exit_order_id || null,
      record.tp_order_ids || null,
      record.signal_id || null,
      record.signal_score || null,
      record.anomaly_id || null,
      record.status,
      record.opened_at,
      record.closed_at || null
    ];

    const id = await this.insert_and_get_id(sql, params);
    logger.info(`[TradeRecordRepository] Created closed trade record id=${id} ${record.symbol} ${record.side} pnl=${record.realized_pnl}`);
    return id;
  }

  /**
   * 更新止盈订单ID
   */
  async update_tp_order_ids(id: number, tp_order_ids: string[]): Promise<boolean> {
    await this.ensure_table();

    const sql = `UPDATE trade_records SET tp_order_ids = ? WHERE id = ?`;
    const affected = await this.update_and_get_affected_rows(sql, [JSON.stringify(tp_order_ids), id]);
    return affected > 0;
  }

  /**
   * 将数据库行映射为实体
   */
  private map_row_to_entity(row: any): TradeRecordEntity {
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      trading_mode: row.trading_mode,
      entry_price: parseFloat(row.entry_price),
      quantity: parseFloat(row.quantity),
      leverage: row.leverage,
      margin: parseFloat(row.margin),
      position_value: parseFloat(row.position_value),
      stop_loss_price: row.stop_loss_price ? parseFloat(row.stop_loss_price) : undefined,
      take_profit_price: row.take_profit_price ? parseFloat(row.take_profit_price) : undefined,
      exit_price: row.exit_price ? parseFloat(row.exit_price) : undefined,
      realized_pnl: row.realized_pnl ? parseFloat(row.realized_pnl) : undefined,
      realized_pnl_percent: row.realized_pnl_percent ? parseFloat(row.realized_pnl_percent) : undefined,
      close_reason: row.close_reason || undefined,
      // 手续费信息
      entry_commission: row.entry_commission ? parseFloat(row.entry_commission) : undefined,
      exit_commission: row.exit_commission ? parseFloat(row.exit_commission) : undefined,
      total_commission: row.total_commission ? parseFloat(row.total_commission) : undefined,
      commission_asset: row.commission_asset || undefined,
      net_pnl: row.net_pnl ? parseFloat(row.net_pnl) : undefined,
      // 订单信息
      entry_order_id: row.entry_order_id || undefined,
      exit_order_id: row.exit_order_id || undefined,
      tp_order_ids: row.tp_order_ids || undefined,
      signal_id: row.signal_id || undefined,
      signal_score: row.signal_score ? parseFloat(row.signal_score) : undefined,
      anomaly_id: row.anomaly_id || undefined,
      status: row.status,
      opened_at: new Date(row.opened_at),
      closed_at: row.closed_at ? new Date(row.closed_at) : undefined,
      created_at: row.created_at ? new Date(row.created_at) : undefined,
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      take_profit_executions: row.take_profit_executions || undefined
    };
  }
}
