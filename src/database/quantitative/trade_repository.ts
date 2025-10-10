import { BaseRepository } from '../base_repository';
import { Trade, TradeStatistics } from '@/quantitative/types/trading_types';
import { logger } from '@/utils/logger';

/**
 * 交易记录数据库操作类
 */
export class TradeRepository extends BaseRepository {

  /**
   * 保存交易记录
   */
  async save(trade: Trade): Promise<number> {
    try {
      const insertId = await this.insert_and_get_id(
        `INSERT INTO quant_trades
        (strategy_id, backtest_id, symbol, \`interval\`, side, entry_price, exit_price, quantity,
         entry_time, exit_time, holding_duration, pnl, pnl_percent, commission, exit_reason, trade_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          trade.strategy_id,
          trade.backtest_id || null,
          trade.symbol,
          trade.interval,
          trade.side,
          trade.entry_price,
          trade.exit_price,
          trade.quantity,
          trade.entry_time,
          trade.exit_time,
          trade.holding_duration,
          trade.pnl,
          trade.pnl_percent,
          trade.commission || 0,
          trade.exit_reason,
          trade.trade_data ? JSON.stringify(trade.trade_data) : null
        ]
      );
      return insertId;
    } catch (error) {
      logger.error('Failed to save trade', error);
      throw error;
    }
  }

  /**
   * 批量保存交易记录
   */
  async save_batch(trades: Trade[]): Promise<void> {
    if (trades.length === 0) return;

    try {
      // 使用单独插入避免批量插入语法问题
      for (const trade of trades) {
        await this.save(trade);
      }
    } catch (error) {
      logger.error('Failed to save trades batch', error);
      throw error;
    }
  }

  /**
   * 根据ID获取交易记录
   */
  async find_by_id(id: number): Promise<Trade | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_trades WHERE id = ?',
        [id]
      );
      const trades = this.parse_json_fields(rows as any[]);
      return trades.length > 0 ? trades[0] : null;
    } catch (error) {
      logger.error(`Failed to find trade by id: ${id}`, error);
      throw error;
    }
  }

  /**
   * 获取回测的所有交易记录
   */
  async find_by_backtest(backtest_id: number): Promise<Trade[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_trades WHERE backtest_id = ? ORDER BY entry_time ASC',
        [backtest_id]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find trades by backtest: ${backtest_id}`, error);
      throw error;
    }
  }

  /**
   * 获取策略的所有交易记录
   */
  async find_by_strategy(strategy_id: number, limit: number = 100): Promise<Trade[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_trades WHERE strategy_id = ? ORDER BY entry_time DESC LIMIT ?',
        [strategy_id, limit]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find trades by strategy: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 获取币种的交易记录
   */
  async find_by_symbol(symbol: string, limit: number = 100): Promise<Trade[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_trades WHERE symbol = ? ORDER BY entry_time DESC LIMIT ?',
        [symbol, limit]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find trades by symbol: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 获取交易统计信息
   */
  async get_statistics(strategy_id?: number, backtest_id?: number): Promise<TradeStatistics> {
    try {
      let query = 'SELECT * FROM quant_trades WHERE 1=1';
      const params: any[] = [];

      if (strategy_id) {
        query += ' AND strategy_id = ?';
        params.push(strategy_id);
      }

      if (backtest_id) {
        query += ' AND backtest_id = ?';
        params.push(backtest_id);
      }

      const rows = await this.execute_query(query, params);
      const trades = rows as Trade[];

      if (trades.length === 0) {
        return {
          total_trades: 0,
          win_trades: 0,
          loss_trades: 0,
          win_rate: 0,
          total_pnl: 0,
          avg_pnl: 0,
          avg_win: 0,
          avg_loss: 0,
          max_win: 0,
          max_loss: 0,
          profit_factor: 0,
          avg_holding_duration: 0,
          max_consecutive_wins: 0,
          max_consecutive_losses: 0
        };
      }

      const win_trades = trades.filter(t => t.pnl > 0);
      const loss_trades = trades.filter(t => t.pnl <= 0);

      const total_wins = win_trades.reduce((sum, t) => sum + t.pnl, 0);
      const total_losses = Math.abs(loss_trades.reduce((sum, t) => sum + t.pnl, 0));

      // 计算最大连续盈亏
      let current_wins = 0;
      let current_losses = 0;
      let max_consecutive_wins = 0;
      let max_consecutive_losses = 0;

      trades.forEach(trade => {
        if (trade.pnl > 0) {
          current_wins++;
          current_losses = 0;
          max_consecutive_wins = Math.max(max_consecutive_wins, current_wins);
        } else {
          current_losses++;
          current_wins = 0;
          max_consecutive_losses = Math.max(max_consecutive_losses, current_losses);
        }
      });

      return {
        total_trades: trades.length,
        win_trades: win_trades.length,
        loss_trades: loss_trades.length,
        win_rate: (win_trades.length / trades.length) * 100,
        total_pnl: trades.reduce((sum, t) => sum + t.pnl, 0),
        avg_pnl: trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length,
        avg_win: win_trades.length > 0 ? total_wins / win_trades.length : 0,
        avg_loss: loss_trades.length > 0 ? total_losses / loss_trades.length : 0,
        max_win: win_trades.length > 0 ? Math.max(...win_trades.map(t => t.pnl)) : 0,
        max_loss: loss_trades.length > 0 ? Math.min(...loss_trades.map(t => t.pnl)) : 0,
        profit_factor: total_losses > 0 ? total_wins / total_losses : total_wins > 0 ? 999 : 0,
        avg_holding_duration: trades.reduce((sum, t) => sum + t.holding_duration, 0) / trades.length,
        max_consecutive_wins,
        max_consecutive_losses
      };
    } catch (error) {
      logger.error('Failed to get trade statistics', error);
      throw error;
    }
  }

  /**
   * 删除交易记录
   */
  async delete(id: number): Promise<void> {
    try {
      await this.delete_and_get_affected_rows('DELETE FROM quant_trades WHERE id = ?', [id]);
    } catch (error) {
      logger.error(`Failed to delete trade: ${id}`, error);
      throw error;
    }
  }

  /**
   * 删除回测的所有交易记录
   */
  async delete_by_backtest(backtest_id: number): Promise<void> {
    try {
      await this.delete_and_get_affected_rows('DELETE FROM quant_trades WHERE backtest_id = ?', [backtest_id]);
    } catch (error) {
      logger.error(`Failed to delete trades by backtest: ${backtest_id}`, error);
      throw error;
    }
  }

  /**
   * 解析JSON字段
   */
  private parse_json_fields(rows: any[]): Trade[] {
    return rows.map(row => ({
      ...row,
      trade_data: row.trade_data && typeof row.trade_data === 'string'
        ? JSON.parse(row.trade_data)
        : row.trade_data
    }));
  }
}
