import { BaseRepository } from './base_repository';
import { HistoricalDataCache } from '@/types/common';
import { logger } from '@/utils/logger';

/**
 * 历史数据缓存数据库操作仓库
 */
export class HistoricalDataCacheRepository extends BaseRepository {

  /**
   * 创建历史数据缓存表
   */
  async create_table(): Promise<void> {
    const create_sql = `
      CREATE TABLE IF NOT EXISTS historical_data_cache (
        id INT PRIMARY KEY AUTO_INCREMENT,
        symbol VARCHAR(20) NOT NULL,
        time_interval ENUM('1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1mo') NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        data_count INT NOT NULL,
        cache_key VARCHAR(200) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        fetch_duration INT DEFAULT 0,
        data_source VARCHAR(50) DEFAULT 'binance_api',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_interval_time (symbol, time_interval, start_time),
        INDEX idx_expires_at (expires_at),
        INDEX idx_cache_key (cache_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await this.ensure_table_exists(create_sql, 'historical_data_cache');
  }

  /**
   * 插入缓存记录（兼容旧字段名 interval）
   */
  async insert(cache_data: Omit<HistoricalDataCache, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO historical_data_cache
      (symbol, time_interval, start_time, end_time, data_count, cache_key, expires_at, fetch_duration, data_source)
      VALUES (?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?, ?, ?, ?)
    `;

    const timeInterval = (cache_data as any).time_interval ?? (cache_data as any).interval;

    const params = [
      cache_data.symbol,
      timeInterval,
      cache_data.start_time.getTime() / 1000,
      cache_data.end_time.getTime() / 1000,
      cache_data.data_count,
      cache_data.cache_key,
      cache_data.expires_at,
      cache_data.fetch_duration,
      cache_data.data_source
    ];

    return await this.insert_and_get_id(sql, params);
  }

  /**
   * 插入或更新缓存记录（兼容旧字段名 interval）
   */
  async upsert(cache_data: Omit<HistoricalDataCache, 'id' | 'created_at'>): Promise<void> {
    const sql = `
      INSERT INTO historical_data_cache
      (symbol, time_interval, start_time, end_time, data_count, cache_key, expires_at, fetch_duration, data_source)
      VALUES (?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        data_count = VALUES(data_count),
        cache_key = VALUES(cache_key),
        expires_at = VALUES(expires_at),
        fetch_duration = VALUES(fetch_duration)
    `;

    const timeInterval = (cache_data as any).time_interval ?? (cache_data as any).interval;

    const params = [
      cache_data.symbol,
      timeInterval,
      cache_data.start_time.getTime() / 1000,
      cache_data.end_time.getTime() / 1000,
      cache_data.data_count,
      cache_data.cache_key,
      cache_data.expires_at,
      cache_data.fetch_duration,
      cache_data.data_source
    ];

    await this.execute_query(sql, params);
  }

  /**
   * 查找有效的缓存记录
   */
  async find_valid_cache(symbol: string, interval: string, cache_key: string): Promise<HistoricalDataCache[]> {
    const sql = `
      SELECT * FROM historical_data_cache
      WHERE symbol = ? AND time_interval = ? AND cache_key = ? AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;

    return await this.execute_query(sql, [symbol, interval, cache_key]);
  }

  /**
   * 根据符号和时间间隔查找缓存记录
   */
  async find_by_symbol_interval(symbol: string, interval: string): Promise<HistoricalDataCache[]> {
    const sql = `
      SELECT * FROM historical_data_cache
      WHERE symbol = ? AND time_interval = ?
      ORDER BY created_at DESC
    `;

    return await this.execute_query(sql, [symbol, interval]);
  }

  /**
   * 获取所有有效的缓存记录
   */
  async find_all_valid(): Promise<HistoricalDataCache[]> {
    const sql = `
      SELECT * FROM historical_data_cache
      WHERE expires_at > NOW()
      ORDER BY symbol, time_interval, start_time
    `;

    return await this.execute_query(sql);
  }

  /**
   * 获取过期的缓存记录
   */
  async find_expired(): Promise<HistoricalDataCache[]> {
    const sql = `
      SELECT * FROM historical_data_cache
      WHERE expires_at <= NOW()
      ORDER BY expires_at ASC
    `;

    return await this.execute_query(sql);
  }

  /**
   * 删除过期的缓存记录
   */
  async delete_expired(): Promise<number> {
    const sql = `
      DELETE FROM historical_data_cache
      WHERE expires_at < NOW()
    `;

    const affected_rows = await this.delete_and_get_affected_rows(sql, []);
    logger.info(`删除了 ${affected_rows} 条过期缓存记录`);
    return affected_rows;
  }

  /**
   * 删除指定符号的所有缓存记录
   */
  async delete_by_symbol(symbol: string): Promise<number> {
    const sql = 'DELETE FROM historical_data_cache WHERE symbol = ?';
    return await this.delete_and_get_affected_rows(sql, [symbol]);
  }

  /**
   * 删除指定符号和时间间隔的缓存记录
   */
  async delete_by_symbol_interval(symbol: string, interval: string): Promise<number> {
    const sql = 'DELETE FROM historical_data_cache WHERE symbol = ? AND time_interval = ?';
    return await this.delete_and_get_affected_rows(sql, [symbol, interval]);
  }

  /**
   * 获取缓存统计信息
   */
  async get_statistics(): Promise<any> {
    const sql = `
      SELECT
        COUNT(*) as total_records,
        COUNT(CASE WHEN expires_at > NOW() THEN 1 END) as active_records,
        COUNT(CASE WHEN expires_at <= NOW() THEN 1 END) as expired_records,
        AVG(fetch_duration) as avg_fetch_duration,
        SUM(data_count) as total_data_points,
        COUNT(DISTINCT symbol) as unique_symbols,
        COUNT(DISTINCT time_interval) as unique_intervals
      FROM historical_data_cache
    `;

    const results = await this.execute_query(sql);
    return results[0];
  }

  /**
   * 获取符号的缓存统计
   */
  async get_symbol_statistics(symbol: string): Promise<any> {
    const sql = `
      SELECT
        time_interval,
        COUNT(*) as record_count,
        SUM(data_count) as total_data_points,
        AVG(fetch_duration) as avg_fetch_duration,
        MAX(expires_at) as latest_expires_at
      FROM historical_data_cache
      WHERE symbol = ?
      GROUP BY time_interval
      ORDER BY time_interval
    `;

    return await this.execute_query(sql, [symbol]);
  }

  /**
   * 更新缓存过期时间
   */
  async update_expires_at(id: number, expires_at: Date): Promise<boolean> {
    const sql = 'UPDATE historical_data_cache SET expires_at = ? WHERE id = ?';
    const affected_rows = await this.update_and_get_affected_rows(sql, [expires_at, id]);
    return affected_rows > 0;
  }

  /**
   * 检查缓存是否存在
   */
  async exists(symbol: string, interval: string, cache_key: string): Promise<boolean> {
    const sql = `
      SELECT 1 FROM historical_data_cache
      WHERE symbol = ? AND time_interval = ? AND cache_key = ? AND expires_at > NOW()
      LIMIT 1
    `;

    const results = await this.execute_query(sql, [symbol, interval, cache_key]);
    return results.length > 0;
  }

  /**
   * 获取最近的缓存记录
   */
  async find_recent(limit: number = 10): Promise<HistoricalDataCache[]> {
    const sql = `
      SELECT * FROM historical_data_cache
      ORDER BY created_at DESC
      LIMIT ?
    `;

    return await this.execute_query(sql, [limit]);
  }
}