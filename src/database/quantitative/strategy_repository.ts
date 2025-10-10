import { BaseRepository } from '../base_repository';
import { StrategyConfig, CreateStrategyRequest, UpdateStrategyRequest, StrategyPerformance } from '@/quantitative/types/strategy_types';
import { logger } from '@/utils/logger';

/**
 * 策略配置数据库操作类
 */
export class StrategyRepository extends BaseRepository {

  /**
   * 获取所有策略
   */
  async find_all(): Promise<StrategyConfig[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_strategies ORDER BY created_at DESC'
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find all strategies', error);
      throw error;
    }
  }

  /**
   * 根据ID获取策略
   */
  async find_by_id(id: number): Promise<StrategyConfig | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_strategies WHERE id = ?',
        [id]
      );
      const strategies = this.parse_json_fields(rows as any[]);
      return strategies.length > 0 ? strategies[0] : null;
    } catch (error) {
      logger.error(`Failed to find strategy by id: ${id}`, error);
      throw error;
    }
  }

  /**
   * 根据名称获取策略
   */
  async find_by_name(name: string): Promise<StrategyConfig | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_strategies WHERE name = ?',
        [name]
      );
      const strategies = this.parse_json_fields(rows as any[]);
      return strategies.length > 0 ? strategies[0] : null;
    } catch (error) {
      logger.error(`Failed to find strategy by name: ${name}`, error);
      throw error;
    }
  }

  /**
   * 根据类型获取策略
   */
  async find_by_type(type: string): Promise<StrategyConfig[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_strategies WHERE type = ? ORDER BY created_at DESC',
        [type]
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error(`Failed to find strategies by type: ${type}`, error);
      throw error;
    }
  }

  /**
   * 获取启用的策略
   */
  async find_enabled(): Promise<StrategyConfig[]> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_strategies WHERE enabled = 1 ORDER BY created_at DESC'
      );
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find enabled strategies', error);
      throw error;
    }
  }

  /**
   * 创建策略
   */
  async create(data: CreateStrategyRequest): Promise<number> {
    try {
      const insertId = await this.insert_and_get_id(
        `INSERT INTO quant_strategies (name, type, description, parameters, mode)
         VALUES (?, ?, ?, ?, ?)`,
        [
          data.name,
          data.type,
          data.description || null,
          JSON.stringify(data.parameters),
          data.mode || 'backtest'
        ]
      );
      return insertId;
    } catch (error) {
      logger.error('Failed to create strategy', error);
      throw error;
    }
  }

  /**
   * 更新策略
   */
  async update(id: number, data: UpdateStrategyRequest): Promise<void> {
    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) {
        fields.push('name = ?');
        values.push(data.name);
      }
      if (data.description !== undefined) {
        fields.push('description = ?');
        values.push(data.description);
      }
      if (data.parameters !== undefined) {
        fields.push('parameters = ?');
        values.push(JSON.stringify(data.parameters));
      }
      if (data.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(data.enabled ? 1 : 0);
      }
      if (data.mode !== undefined) {
        fields.push('mode = ?');
        values.push(data.mode);
      }

      if (fields.length === 0) {
        return;
      }

      values.push(id);

      await this.update_and_get_affected_rows(
        `UPDATE quant_strategies SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
    } catch (error) {
      logger.error(`Failed to update strategy: ${id}`, error);
      throw error;
    }
  }

  /**
   * 删除策略
   */
  async delete(id: number): Promise<void> {
    try {
      await this.delete_and_get_affected_rows('DELETE FROM quant_strategies WHERE id = ?', [id]);
    } catch (error) {
      logger.error(`Failed to delete strategy: ${id}`, error);
      throw error;
    }
  }

  /**
   * 切换策略启用状态
   */
  async toggle_enabled(id: number, enabled: boolean): Promise<void> {
    try {
      await this.update_and_get_affected_rows(
        'UPDATE quant_strategies SET enabled = ? WHERE id = ?',
        [enabled ? 1 : 0, id]
      );
    } catch (error) {
      logger.error(`Failed to toggle strategy enabled: ${id}`, error);
      throw error;
    }
  }

  /**
   * 获取策略性能统计
   */
  async get_performance(strategy_id: number): Promise<StrategyPerformance | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_strategy_performance WHERE strategy_id = ?',
        [strategy_id]
      );
      const performances = rows as StrategyPerformance[];
      return performances.length > 0 ? performances[0] : null;
    } catch (error) {
      logger.error(`Failed to get strategy performance: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 更新策略性能统计
   */
  async update_performance(strategy_id: number, data: Partial<StrategyPerformance>): Promise<void> {
    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (data.total_backtests !== undefined) {
        fields.push('total_backtests = ?');
        values.push(data.total_backtests);
      }
      if (data.total_trades !== undefined) {
        fields.push('total_trades = ?');
        values.push(data.total_trades);
      }
      if (data.win_trades !== undefined) {
        fields.push('win_trades = ?');
        values.push(data.win_trades);
      }
      if (data.loss_trades !== undefined) {
        fields.push('loss_trades = ?');
        values.push(data.loss_trades);
      }
      if (data.win_rate !== undefined) {
        fields.push('win_rate = ?');
        values.push(data.win_rate);
      }
      if (data.avg_return !== undefined) {
        fields.push('avg_return = ?');
        values.push(data.avg_return);
      }
      if (data.best_return !== undefined) {
        fields.push('best_return = ?');
        values.push(data.best_return);
      }
      if (data.worst_return !== undefined) {
        fields.push('worst_return = ?');
        values.push(data.worst_return);
      }
      if (data.avg_sharpe !== undefined) {
        fields.push('avg_sharpe = ?');
        values.push(data.avg_sharpe);
      }
      if (data.avg_max_drawdown !== undefined) {
        fields.push('avg_max_drawdown = ?');
        values.push(data.avg_max_drawdown);
      }
      if (data.last_backtest_at !== undefined) {
        fields.push('last_backtest_at = ?');
        values.push(data.last_backtest_at);
      }

      if (fields.length === 0) {
        return;
      }

      // 构建INSERT ... ON DUPLICATE KEY UPDATE语句
      const field_names = fields.map(f => f.split(' = ')[0]);

      await this.execute_query(
        `INSERT INTO quant_strategy_performance (strategy_id, ${field_names.join(', ')})
         VALUES (?, ${field_names.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${fields.join(', ')}`,
        [strategy_id, ...values, ...values] // INSERT values + UPDATE values
      );
    } catch (error) {
      logger.error(`Failed to update strategy performance: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 解析JSON字段
   */
  private parse_json_fields(rows: any[]): any[] {
    return rows.map(row => ({
      ...row,
      parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
      enabled: row.enabled === 1
    }));
  }
}
