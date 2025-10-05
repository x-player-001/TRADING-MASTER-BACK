import { BaseRepository } from './base_repository';
import { SymbolConfig } from '@/types/common';
import { logger } from '@/utils/logger';

/**
 * 币种配置数据库操作仓库
 */
export class SymbolConfigRepository extends BaseRepository {

  /**
   * 创建币种配置表
   */
  async create_table(): Promise<void> {
    const create_sql = `
      CREATE TABLE IF NOT EXISTS symbol_configs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL UNIQUE,
        display_name VARCHAR(50) NOT NULL,
        base_asset VARCHAR(10) NOT NULL,
        quote_asset VARCHAR(10) NOT NULL,
        enabled TINYINT(1) DEFAULT 1,
        priority INT DEFAULT 50,
        category ENUM('major','alt','stable') DEFAULT 'alt',
        exchange VARCHAR(20) DEFAULT 'binance',
        min_price DECIMAL(20,8) DEFAULT 0,
        min_qty DECIMAL(20,8) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        INDEX idx_symbol (symbol),
        INDEX idx_enabled_priority (enabled, priority),
        INDEX idx_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await this.ensure_table_exists(create_sql, 'symbol_configs');
  }

  /**
   * 获取所有币种配置
   */
  async find_all(): Promise<SymbolConfig[]> {
    const sql = 'SELECT * FROM symbol_configs ORDER BY priority ASC, symbol ASC';
    return await this.execute_query(sql);
  }

  /**
   * 根据符号获取币种配置
   * @param symbol - 交易对符号
   */
  async find_by_symbol(symbol: string): Promise<SymbolConfig | null> {
    const sql = 'SELECT * FROM symbol_configs WHERE symbol = ?';
    const results = await this.execute_query(sql, [symbol]);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * 获取已启用的币种配置
   */
  async find_enabled(): Promise<SymbolConfig[]> {
    const sql = 'SELECT * FROM symbol_configs WHERE enabled = 1 ORDER BY priority ASC, symbol ASC';
    return await this.execute_query(sql);
  }

  /**
   * 按分类获取币种配置
   * @param category - 币种分类
   */
  async find_by_category(category: 'major' | 'alt' | 'stable'): Promise<SymbolConfig[]> {
    const sql = 'SELECT * FROM symbol_configs WHERE category = ? ORDER BY priority ASC, symbol ASC';
    return await this.execute_query(sql, [category]);
  }

  /**
   * 插入新的币种配置
   * @param symbol_data - 币种配置数据
   */
  async insert(symbol_data: Omit<SymbolConfig, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const sql = `
      INSERT INTO symbol_configs
      (symbol, display_name, base_asset, quote_asset, enabled, priority, category, exchange, min_price, min_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      symbol_data.symbol,
      symbol_data.display_name,
      symbol_data.base_asset,
      symbol_data.quote_asset,
      symbol_data.enabled,
      symbol_data.priority,
      symbol_data.category,
      symbol_data.exchange,
      symbol_data.min_price,
      symbol_data.min_qty
    ];

    return await this.insert_and_get_id(sql, params);
  }

  /**
   * 更新币种配置
   * @param symbol - 交易对符号
   * @param updates - 要更新的字段
   */
  async update(symbol: string, updates: Partial<SymbolConfig>): Promise<boolean> {
    const set_clauses: string[] = [];
    const params: any[] = [];

    // 构建SET子句
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'id' && key !== 'created_at' && key !== 'updated_at' && value !== undefined) {
        set_clauses.push(`${key} = ?`);
        params.push(value);
      }
    });

    if (set_clauses.length === 0) {
      return false;
    }

    params.push(symbol);
    const sql = `UPDATE symbol_configs SET ${set_clauses.join(', ')} WHERE symbol = ?`;

    const affected_rows = await this.update_and_get_affected_rows(sql, params);
    return affected_rows > 0;
  }

  /**
   * 删除币种配置
   * @param symbol - 交易对符号
   */
  async delete(symbol: string): Promise<boolean> {
    const sql = 'DELETE FROM symbol_configs WHERE symbol = ?';
    const affected_rows = await this.delete_and_get_affected_rows(sql, [symbol]);
    return affected_rows > 0;
  }

  /**
   * 切换币种启用状态
   * @param symbol - 交易对符号
   * @param enabled - 是否启用
   */
  async toggle_enabled(symbol: string, enabled: boolean): Promise<boolean> {
    return await this.update(symbol, { enabled });
  }

  /**
   * 批量插入币种配置
   * @param symbols - 币种配置数组
   */
  async batch_insert(symbols: Omit<SymbolConfig, 'id' | 'created_at' | 'updated_at'>[]): Promise<void> {
    await this.execute_transaction(async () => {
      for (const symbol_data of symbols) {
        await this.insert(symbol_data);
      }
    });

    logger.info(`批量插入 ${symbols.length} 个币种配置`);
  }

  /**
   * 获取币种总数
   */
  async count(): Promise<number> {
    const sql = 'SELECT COUNT(*) as count FROM symbol_configs';
    const results = await this.execute_query(sql);
    return results[0].count;
  }

  /**
   * 检查币种是否存在
   * @param symbol - 交易对符号
   */
  async exists(symbol: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM symbol_configs WHERE symbol = ? LIMIT 1';
    const results = await this.execute_query(sql, [symbol]);
    return results.length > 0;
  }
}