import { BaseRepository } from './base_repository';
import { TopSymbolConfig } from '@/types/common';
import { logger } from '@/utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

/**
 * TOP币种配置数据访问层
 */
export class TopSymbolsRepository extends BaseRepository {

  /**
   * 创建表结构
   */
  async create_table(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS top_symbols_config (
        id INT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL UNIQUE COMMENT '交易对符号',
        display_name VARCHAR(50) NOT NULL COMMENT '显示名称',
        rank_order INT NOT NULL COMMENT '排序权重 1-10',
        enabled BOOLEAN DEFAULT true COMMENT '是否启用订阅',
        subscription_intervals JSON COMMENT '订阅的时间周期',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        INDEX idx_rank_enabled (rank_order, enabled),
        INDEX idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TOP币种配置表'
    `;

    return this.execute_with_connection(async (conn) => {
      await conn.execute(sql);
      logger.info('TopSymbolsConfig table created successfully');
    });
  }

  /**
   * 获取所有TOP币种配置
   */
  async get_all_symbols(): Promise<TopSymbolConfig[]> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        SELECT id, symbol, display_name, rank_order, enabled,
               subscription_intervals, created_at, updated_at
        FROM top_symbols_config
        ORDER BY rank_order ASC
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql);

      return rows.map(row => ({
        ...row,
        subscription_intervals: JSON.parse(row.subscription_intervals || '[]'),
        enabled: Boolean(row.enabled)
      })) as TopSymbolConfig[];
    });
  }

  /**
   * 获取启用的TOP币种配置
   */
  async get_enabled_symbols(): Promise<TopSymbolConfig[]> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        SELECT id, symbol, display_name, rank_order, enabled,
               subscription_intervals, created_at, updated_at
        FROM top_symbols_config
        WHERE enabled = true
        ORDER BY rank_order ASC
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql);

      return rows.map(row => ({
        ...row,
        subscription_intervals: JSON.parse(row.subscription_intervals || '[]'),
        enabled: Boolean(row.enabled)
      })) as TopSymbolConfig[];
    });
  }

  /**
   * 根据符号获取配置
   */
  async get_symbol_by_name(symbol: string): Promise<TopSymbolConfig | null> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        SELECT id, symbol, display_name, rank_order, enabled,
               subscription_intervals, created_at, updated_at
        FROM top_symbols_config
        WHERE symbol = ?
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol]);

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        ...row,
        subscription_intervals: JSON.parse(row.subscription_intervals || '[]'),
        enabled: Boolean(row.enabled)
      } as TopSymbolConfig;
    });
  }

  /**
   * 创建币种配置
   */
  async create_symbol(config: Omit<TopSymbolConfig, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        INSERT INTO top_symbols_config (symbol, display_name, rank_order, enabled, subscription_intervals)
        VALUES (?, ?, ?, ?, ?)
      `;

      const [result] = await conn.execute<ResultSetHeader>(sql, [
        config.symbol,
        config.display_name,
        config.rank_order,
        config.enabled,
        JSON.stringify(config.subscription_intervals)
      ]);

      logger.info(`Created TOP symbol config: ${config.symbol}`);
      return result.insertId;
    });
  }

  /**
   * 更新币种配置
   */
  async update_symbol(symbol: string, updates: Partial<TopSymbolConfig>): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const set_clauses: string[] = [];
      const values: any[] = [];

      if (updates.display_name !== undefined) {
        set_clauses.push('display_name = ?');
        values.push(updates.display_name);
      }

      if (updates.rank_order !== undefined) {
        set_clauses.push('rank_order = ?');
        values.push(updates.rank_order);
      }

      if (updates.enabled !== undefined) {
        set_clauses.push('enabled = ?');
        values.push(updates.enabled);
      }

      if (updates.subscription_intervals !== undefined) {
        set_clauses.push('subscription_intervals = ?');
        values.push(JSON.stringify(updates.subscription_intervals));
      }

      if (set_clauses.length === 0) {
        return;
      }

      set_clauses.push('updated_at = CURRENT_TIMESTAMP');

      const sql = `
        UPDATE top_symbols_config
        SET ${set_clauses.join(', ')}
        WHERE symbol = ?
      `;

      values.push(symbol);

      await conn.execute(sql, values);
      logger.info(`Updated TOP symbol config: ${symbol}`);
    });
  }

  /**
   * 删除币种配置
   */
  async delete_symbol(symbol: string): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const sql = `DELETE FROM top_symbols_config WHERE symbol = ?`;

      await conn.execute(sql, [symbol]);
      logger.info(`Deleted TOP symbol config: ${symbol}`);
    });
  }

  /**
   * 批量更新排序
   */
  async batch_update_order(updates: Array<{ symbol: string; rank_order: number }>): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      await conn.beginTransaction();

      try {
        for (const update of updates) {
          const sql = `
            UPDATE top_symbols_config
            SET rank_order = ?, updated_at = CURRENT_TIMESTAMP
            WHERE symbol = ?
          `;

          await conn.execute(sql, [update.rank_order, update.symbol]);
        }

        await conn.commit();
        logger.info(`Batch updated ${updates.length} symbol orders`);
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    });
  }

  /**
   * 初始化默认数据
   */
  async initialize_default_data(): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      // 检查是否已有数据
      const [existing] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) as count FROM top_symbols_config'
      );

      if (existing[0].count > 0) {
        logger.info('TOP symbols config already initialized');
        return;
      }

      // 插入默认数据
      const default_symbols = [
        { symbol: 'BTCUSDT', display_name: 'Bitcoin', rank: 1, intervals: ['1m','5m','15m','1h'] },
        { symbol: 'ETHUSDT', display_name: 'Ethereum', rank: 2, intervals: ['1m','5m','15m','1h'] },
        { symbol: 'BNBUSDT', display_name: 'BNB', rank: 3, intervals: ['1m','5m','15m','1h'] },
        { symbol: 'XRPUSDT', display_name: 'XRP', rank: 4, intervals: ['5m','15m','1h'] },
        { symbol: 'SOLUSDT', display_name: 'Solana', rank: 5, intervals: ['5m','15m','1h'] },
        { symbol: 'ADAUSDT', display_name: 'Cardano', rank: 6, intervals: ['5m','15m','1h'] },
        { symbol: 'DOGEUSDT', display_name: 'Dogecoin', rank: 7, intervals: ['15m','1h'] },
        { symbol: 'DOTUSDT', display_name: 'Polkadot', rank: 8, intervals: ['15m','1h'] },
        { symbol: 'MATICUSDT', display_name: 'Polygon', rank: 9, intervals: ['15m','1h'] },
        { symbol: 'AVAXUSDT', display_name: 'Avalanche', rank: 10, intervals: ['15m','1h'] }
      ];

      const sql = `
        INSERT INTO top_symbols_config (symbol, display_name, rank_order, subscription_intervals)
        VALUES (?, ?, ?, ?)
      `;

      for (const config of default_symbols) {
        await conn.execute(sql, [
          config.symbol,
          config.display_name,
          config.rank,
          JSON.stringify(config.intervals)
        ]);
      }

      logger.info('Initialized TOP symbols default data');
    });
  }
}