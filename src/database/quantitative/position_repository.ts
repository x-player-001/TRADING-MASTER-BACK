import { BaseRepository } from '../base_repository';
import { Position, PositionStatus } from '@/quantitative/types/trading_types';
import { logger } from '@/utils/logger';

/**
 * 持仓数据库操作类
 */
export class PositionRepository extends BaseRepository {

  /**
   * 创建持仓
   */
  async create(position: Position): Promise<number> {
    try {
      const insertId = await this.insert_and_get_id(
        `INSERT INTO quant_positions
        (strategy_id, symbol, \`interval\`, side, entry_price, quantity, current_price,
         stop_loss, take_profit, entry_time, entry_indicators, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          position.strategy_id,
          position.symbol,
          position.interval,
          position.side,
          position.entry_price,
          position.quantity,
          position.current_price || position.entry_price,
          position.stop_loss || null,
          position.take_profit || null,
          position.entry_time,
          position.entry_indicators ? JSON.stringify(position.entry_indicators) : null,
          position.status || PositionStatus.OPEN
        ]
      );
      return insertId;
    } catch (error) {
      logger.error('Failed to create position', error);
      throw error;
    }
  }

  /**
   * 根据ID获取持仓
   */
  async find_by_id(id: number): Promise<Position | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_positions WHERE id = ?',
        [id]
      );
      const positions = this.parse_json_fields(rows as any[]);
      return positions.length > 0 ? positions[0] : null;
    } catch (error) {
      logger.error(`Failed to find position by id: ${id}`, error);
      throw error;
    }
  }

  /**
   * 获取所有开仓持仓
   */
  async find_open_positions(strategy_id?: number): Promise<Position[]> {
    try {
      let query = 'SELECT * FROM quant_positions WHERE status = ?';
      const params: any[] = [PositionStatus.OPEN];

      if (strategy_id) {
        query += ' AND strategy_id = ?';
        params.push(strategy_id);
      }

      query += ' ORDER BY entry_time DESC';

      const rows = await this.execute_query(query, params);
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find open positions', error);
      throw error;
    }
  }

  /**
   * 获取策略的持仓
   */
  async find_by_strategy(strategy_id: number, status?: PositionStatus): Promise<Position[]> {
    try {
      let query = 'SELECT * FROM quant_positions WHERE strategy_id = ?';
      const params: any[] = [strategy_id];

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      query += ' ORDER BY entry_time DESC';

      const rows = await this.execute_query(query, params);
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find positions by strategy: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 获取币种的持仓
   */
  async find_by_symbol(symbol: string, status?: PositionStatus): Promise<Position[]> {
    try {
      let query = 'SELECT * FROM quant_positions WHERE symbol = ?';
      const params: any[] = [symbol];

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      query += ' ORDER BY entry_time DESC';

      const rows = await this.execute_query(query, params);
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find positions by symbol: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 更新持仓
   */
  async update(id: number, data: Partial<Position>): Promise<void> {
    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (data.current_price !== undefined) {
        fields.push('current_price = ?');
        values.push(data.current_price);
      }
      if (data.stop_loss !== undefined) {
        fields.push('stop_loss = ?');
        values.push(data.stop_loss);
      }
      if (data.take_profit !== undefined) {
        fields.push('take_profit = ?');
        values.push(data.take_profit);
      }
      if (data.unrealized_pnl !== undefined) {
        fields.push('unrealized_pnl = ?');
        values.push(data.unrealized_pnl);
      }
      if (data.unrealized_pnl_percent !== undefined) {
        fields.push('unrealized_pnl_percent = ?');
        values.push(data.unrealized_pnl_percent);
      }
      if (data.status !== undefined) {
        fields.push('status = ?');
        values.push(data.status);
      }
      if (data.close_time !== undefined) {
        fields.push('close_time = ?');
        values.push(data.close_time);
      }

      if (fields.length === 0) {
        return;
      }

      values.push(id);

      await this.update_and_get_affected_rows(
        `UPDATE quant_positions SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
    } catch (error) {
      logger.error(`Failed to update position: ${id}`, error);
      throw error;
    }
  }

  /**
   * 平仓
   */
  async close(id: number, close_time: number): Promise<void> {
    try {
      await this.update_and_get_affected_rows(
        'UPDATE quant_positions SET status = ?, close_time = ? WHERE id = ?',
        [PositionStatus.CLOSED, close_time, id]
      );
    } catch (error) {
      logger.error(`Failed to close position: ${id}`, error);
      throw error;
    }
  }

  /**
   * 更新止损止盈
   */
  async update_stop_loss_take_profit(id: number, stop_loss: number, take_profit: number): Promise<void> {
    try {
      await this.update_and_get_affected_rows(
        'UPDATE quant_positions SET stop_loss = ?, take_profit = ? WHERE id = ?',
        [stop_loss, take_profit, id]
      );
    } catch (error) {
      logger.error(`Failed to update stop loss/take profit for position: ${id}`, error);
      throw error;
    }
  }

  /**
   * 删除持仓
   */
  async delete(id: number): Promise<void> {
    try {
      await this.delete_and_get_affected_rows('DELETE FROM quant_positions WHERE id = ?', [id]);
    } catch (error) {
      logger.error(`Failed to delete position: ${id}`, error);
      throw error;
    }
  }

  /**
   * 获取持仓统计
   */
  async get_statistics(strategy_id?: number): Promise<{
    total_positions: number;
    open_positions: number;
    closed_positions: number;
    total_unrealized_pnl: number;
  }> {
    try {
      let query = 'SELECT status, COUNT(*) as count, SUM(unrealized_pnl) as total_pnl FROM quant_positions';
      const params: any[] = [];

      if (strategy_id) {
        query += ' WHERE strategy_id = ?';
        params.push(strategy_id);
      }

      query += ' GROUP BY status';

      const rows = await this.execute_query(query, params);
      const stats = rows as any[];

      let open_count = 0;
      let closed_count = 0;
      let total_unrealized_pnl = 0;

      stats.forEach(stat => {
        if (stat.status === PositionStatus.OPEN) {
          open_count = stat.count;
          total_unrealized_pnl = stat.total_pnl || 0;
        } else if (stat.status === PositionStatus.CLOSED) {
          closed_count = stat.count;
        }
      });

      return {
        total_positions: open_count + closed_count,
        open_positions: open_count,
        closed_positions: closed_count,
        total_unrealized_pnl
      };
    } catch (error) {
      logger.error('Failed to get position statistics', error);
      throw error;
    }
  }

  /**
   * 解析JSON字段
   */
  private parse_json_fields(rows: any[]): Position[] {
    return rows.map(row => ({
      ...row,
      entry_indicators: row.entry_indicators && typeof row.entry_indicators === 'string'
        ? JSON.parse(row.entry_indicators)
        : row.entry_indicators
    }));
  }
}
