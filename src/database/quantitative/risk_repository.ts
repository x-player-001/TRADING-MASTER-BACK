import { BaseRepository } from '../base_repository';
import { RiskConfig } from '@/quantitative/types/risk_types';
import { logger } from '@/utils/logger';

/**
 * 风控配置数据库操作类
 */
export class RiskRepository extends BaseRepository {

  /**
   * 获取策略的风控配置
   */
  async find_by_strategy(strategy_id: number): Promise<RiskConfig | null> {
    try {
      const rows = await this.execute_query(
        'SELECT * FROM quant_risk_config WHERE strategy_id = ?',
        [strategy_id]
      );
      const configs = this.parse_json_fields(rows as any[]);
      return configs.length > 0 ? configs[0] : null;
    } catch (error) {
      logger.error(`Failed to find risk config by strategy: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 创建风控配置
   */
  async create(config: RiskConfig): Promise<void> {
    try {
      await this.insert_and_get_id(
        `INSERT INTO quant_risk_config
        (strategy_id, max_positions, max_position_size_percent, max_total_risk_percent,
         stop_loss_percent, take_profit_percent, max_daily_loss_percent, blacklist_symbols)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          config.strategy_id,
          config.max_positions,
          config.max_position_size_percent,
          config.max_total_risk_percent,
          config.stop_loss_percent,
          config.take_profit_percent,
          config.max_daily_loss_percent,
          JSON.stringify(config.blacklist_symbols || [])
        ]
      );
    } catch (error) {
      logger.error('Failed to create risk config', error);
      throw error;
    }
  }

  /**
   * 更新风控配置
   */
  async update(strategy_id: number, data: Partial<RiskConfig>): Promise<void> {
    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (data.max_positions !== undefined) {
        fields.push('max_positions = ?');
        values.push(data.max_positions);
      }
      if (data.max_position_size_percent !== undefined) {
        fields.push('max_position_size_percent = ?');
        values.push(data.max_position_size_percent);
      }
      if (data.max_total_risk_percent !== undefined) {
        fields.push('max_total_risk_percent = ?');
        values.push(data.max_total_risk_percent);
      }
      if (data.stop_loss_percent !== undefined) {
        fields.push('stop_loss_percent = ?');
        values.push(data.stop_loss_percent);
      }
      if (data.take_profit_percent !== undefined) {
        fields.push('take_profit_percent = ?');
        values.push(data.take_profit_percent);
      }
      if (data.max_daily_loss_percent !== undefined) {
        fields.push('max_daily_loss_percent = ?');
        values.push(data.max_daily_loss_percent);
      }
      if (data.blacklist_symbols !== undefined) {
        fields.push('blacklist_symbols = ?');
        values.push(JSON.stringify(data.blacklist_symbols));
      }

      if (fields.length === 0) {
        return;
      }

      values.push(strategy_id);

      await this.update_and_get_affected_rows(
        `UPDATE quant_risk_config SET ${fields.join(', ')} WHERE strategy_id = ?`,
        values
      );
    } catch (error) {
      logger.error(`Failed to update risk config for strategy: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 删除风控配置
   */
  async delete(strategy_id: number): Promise<void> {
    try {
      await this.delete_and_get_affected_rows('DELETE FROM quant_risk_config WHERE strategy_id = ?', [strategy_id]);
    } catch (error) {
      logger.error(`Failed to delete risk config for strategy: ${strategy_id}`, error);
      throw error;
    }
  }

  /**
   * 获取所有风控配置
   */
  async find_all(): Promise<RiskConfig[]> {
    try {
      const rows = await this.execute_query('SELECT * FROM quant_risk_config');
      return this.parse_json_fields(rows as any[]);
    } catch (error) {
      logger.error('Failed to find all risk configs', error);
      throw error;
    }
  }

  /**
   * 添加黑名单币种
   */
  async add_to_blacklist(strategy_id: number, symbol: string): Promise<void> {
    try {
      const config = await this.find_by_strategy(strategy_id);
      if (!config) {
        throw new Error(`Risk config not found for strategy: ${strategy_id}`);
      }

      const blacklist = config.blacklist_symbols || [];
      if (!blacklist.includes(symbol)) {
        blacklist.push(symbol);
        await this.update(strategy_id, { blacklist_symbols: blacklist });
      }
    } catch (error) {
      logger.error(`Failed to add symbol to blacklist: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 从黑名单移除币种
   */
  async remove_from_blacklist(strategy_id: number, symbol: string): Promise<void> {
    try {
      const config = await this.find_by_strategy(strategy_id);
      if (!config) {
        throw new Error(`Risk config not found for strategy: ${strategy_id}`);
      }

      const blacklist = (config.blacklist_symbols || []).filter(s => s !== symbol);
      await this.update(strategy_id, { blacklist_symbols: blacklist });
    } catch (error) {
      logger.error(`Failed to remove symbol from blacklist: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 检查币种是否在黑名单中
   */
  async is_blacklisted(strategy_id: number, symbol: string): Promise<boolean> {
    try {
      const config = await this.find_by_strategy(strategy_id);
      if (!config) {
        return false;
      }

      return (config.blacklist_symbols || []).includes(symbol);
    } catch (error) {
      logger.error(`Failed to check if symbol is blacklisted: ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 解析JSON字段
   */
  private parse_json_fields(rows: any[]): RiskConfig[] {
    return rows.map(row => ({
      ...row,
      blacklist_symbols: row.blacklist_symbols && typeof row.blacklist_symbols === 'string'
        ? JSON.parse(row.blacklist_symbols)
        : (row.blacklist_symbols || [])
    }));
  }
}
