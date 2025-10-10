import { BaseRepository } from '../base_repository';
import { BacktestResult } from '@/quantitative/types/backtest_types';
import { logger } from '@/utils/logger';

/**
 * 回测结果数据库操作类
 */
export class BacktestRepository extends BaseRepository {

  /**
   * 保存回测结果
   */
  async save(result: BacktestResult): Promise<number> {
    try {
      const insertId = await this.insert_and_get_id(
        `INSERT INTO quant_backtest_results
        (strategy_id, symbol, \`interval\`, start_time, end_time, initial_capital, final_capital,
         total_return, annual_return, sharpe_ratio, max_drawdown, win_rate, total_trades,
         avg_trade_duration, profit_factor, performance_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.strategy_id,
          result.symbol,
          result.interval,
          result.start_time,
          result.end_time,
          result.initial_capital,
          result.final_capital,
          result.total_return,
          result.annual_return,
          result.sharpe_ratio,
          result.max_drawdown,
          result.win_rate,
          result.total_trades,
          result.avg_trade_duration,
          result.profit_factor,
          JSON.stringify(result.performance_data)
        ]
      );
      return insertId;
    } catch (error) {
      logger.error('Failed to save backtest result', error);
      throw error;
    }
  }

  /**
   * 根据ID获取回测结果
   */
  async find_by_id(id: number): Promise<BacktestResult | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_backtest_results WHERE id = ?',
        [id]
      );
      const results = this.parse_json_fields(rows as any[]);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      logger.error(`Failed to find backtest result by id: ${id}`, error);
      throw error;
    }
  }

  /**
   * 获取策略的所有回测结果
   */
  async find_by_strategy(strategy_id: number, limit: number = 10): Promise<BacktestResult[]> {
    try {
      const rows = await this.execute_query(
        `SELECT * FROM quant_backtest_results
         WHERE strategy_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [strategy_id, limit]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find backtest results by strategy: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 获取所有回测结果
   */
  async find_all(limit: number = 50, offset: number = 0): Promise<BacktestResult[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_backtest_results ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find all backtest results', error);
      throw error;
    }
  }

  /**
   * 根据币种和周期获取回测结果
   */
  async find_by_symbol_interval(
    symbol: string,
    interval: string,
    limit: number = 10
  ): Promise<BacktestResult[]> {
    try {
      const rows = await this.execute_query(
        `SELECT * FROM quant_backtest_results
         WHERE symbol = ? AND \`interval\` = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [symbol, interval, limit]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find backtest results by symbol/interval: ${symbol}/${interval}`, error);
      throw error;
    }
  }

  /**
   * 获取最佳回测结果（按夏普比率排序）
   */
  async find_best_results(limit: number = 10): Promise<BacktestResult[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_backtest_results ORDER BY sharpe_ratio DESC LIMIT ?',
        [limit]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find best backtest results', error);
      throw error;
    }
  }

  /**
   * 根据多个ID获取回测结果（用于对比）
   */
  async find_by_ids(ids: number[]): Promise<BacktestResult[]> {
    try {
      if (ids.length === 0) {
        return [];
      }

      const placeholders = ids.map(() => '?').join(',');
      const rows = await this.execute_query(
        `SELECT * FROM quant_backtest_results WHERE id IN (${placeholders})`,
        ids
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find backtest results by ids', error);
      throw error;
    }
  }

  /**
   * 删除回测结果
   */
  async delete(id: number): Promise<void> {
    try {
      await this.delete_and_get_affected_rows('DELETE FROM quant_backtest_results WHERE id = ?', [id]);
    } catch (error) {
      logger.error(`Failed to delete backtest result: ${id}`, error);
      throw error;
    }
  }

  /**
   * 获取回测统计信息
   */
  async get_statistics(): Promise<{
    total_backtests: number;
    avg_return: number;
    avg_sharpe: number;
    avg_win_rate: number;
  }> {
    try {
      const rows = await this.execute_query(
        `SELECT
          COUNT(*) as total_backtests,
          AVG(total_return) as avg_return,
          AVG(sharpe_ratio) as avg_sharpe,
          AVG(win_rate) as avg_win_rate
         FROM quant_backtest_results`
      );
      const stats = (rows as any[])[0];
      return {
        total_backtests: stats.total_backtests || 0,
        avg_return: stats.avg_return || 0,
        avg_sharpe: stats.avg_sharpe || 0,
        avg_win_rate: stats.avg_win_rate || 0
      };
    } catch (error) {
      logger.error('Failed to get backtest statistics', error);
      throw error;
    }
  }

  /**
   * 解析JSON字段
   */
  private parse_json_fields(rows: any[]): BacktestResult[] {
    return rows.map(row => ({
      ...row,
      performance_data: typeof row.performance_data === 'string'
        ? JSON.parse(row.performance_data)
        : row.performance_data
    }));
  }
}
