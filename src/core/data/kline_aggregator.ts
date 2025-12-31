/**
 * K线聚合器
 *
 * 将5分钟K线聚合为更大周期的K线 (15m/1h/4h)
 * 聚合后的K线也存储到数据库（分表存储）
 */

import { Kline5mData } from '@/database/kline_5m_repository';
import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';

// 聚合后的K线数据结构
export interface AggregatedKline {
  symbol: string;
  interval: string;      // 15m, 1h, 4h
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 聚合配置
interface AggregateConfig {
  interval: string;
  bars_count: number;      // 需要多少根5m K线
  interval_ms: number;     // 周期毫秒数
  table_name: string;      // 表名（15m分表用前缀，1h/4h用固定表名）
  use_partition: boolean;  // 是否按日期分表
}

const AGGREGATE_CONFIGS: AggregateConfig[] = [
  { interval: '15m', bars_count: 3, interval_ms: 15 * 60 * 1000, table_name: 'kline_15m_agg', use_partition: true },
  { interval: '1h', bars_count: 12, interval_ms: 60 * 60 * 1000, table_name: 'kline_1h_agg', use_partition: false },
  { interval: '4h', bars_count: 48, interval_ms: 4 * 60 * 60 * 1000, table_name: 'kline_4h_agg', use_partition: false }
];

export class KlineAggregator {
  // 5m K线缓存: symbol -> klines[]
  private kline_5m_cache: Map<string, Kline5mData[]> = new Map();

  // 聚合后的K线缓存: `${symbol}_${interval}` -> klines[]
  private aggregated_cache: Map<string, AggregatedKline[]> = new Map();

  // 写入缓冲区: table_name -> klines[]
  private write_buffer: Map<string, AggregatedKline[]> = new Map();
  private readonly BUFFER_SIZE = 100;
  private flush_timer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 30000;

  // 缓存大小限制
  private readonly MAX_5M_CACHE_SIZE = 500;   // 每个币种最多缓存500根5m K线
  private readonly MAX_AGG_CACHE_SIZE = 200;  // 每个周期最多缓存200根聚合K线

  constructor() {
    this.start_flush_timer();
  }

  /**
   * 处理新的5分钟K线
   * @param kline 5分钟K线数据
   * @returns 聚合完成的K线列表（可能为空）
   */
  process_5m_kline(kline: Kline5mData): AggregatedKline[] {
    const symbol = kline.symbol;

    // 更新5m缓存
    let cache = this.kline_5m_cache.get(symbol);
    if (!cache) {
      cache = [];
      this.kline_5m_cache.set(symbol, cache);
    }

    // 检查是否是更新还是新增
    if (cache.length > 0 && cache[cache.length - 1].open_time === kline.open_time) {
      cache[cache.length - 1] = kline;
    } else {
      cache.push(kline);
      if (cache.length > this.MAX_5M_CACHE_SIZE) {
        cache.shift();
      }
    }

    // 尝试聚合各个周期
    const aggregated: AggregatedKline[] = [];

    for (const config of AGGREGATE_CONFIGS) {
      const agg_kline = this.try_aggregate(symbol, cache, config);
      if (agg_kline) {
        aggregated.push(agg_kline);

        // 更新聚合缓存
        this.update_aggregated_cache(agg_kline);

        // 添加到写入缓冲区
        this.add_to_write_buffer(agg_kline, config);
      }
    }

    return aggregated;
  }

  /**
   * 尝试聚合K线
   */
  private try_aggregate(
    symbol: string,
    klines: Kline5mData[],
    config: AggregateConfig
  ): AggregatedKline | null {
    if (klines.length < config.bars_count) {
      return null;
    }

    const last_kline = klines[klines.length - 1];

    // 检查最后一根K线是否是该周期的结束点
    // 例如：15m周期，最后一根5m应该是 xx:10 或 xx:25 或 xx:40 或 xx:55
    const close_time = last_kline.close_time;
    if ((close_time + 1) % config.interval_ms !== 0) {
      return null;
    }

    // 计算该周期的起始时间
    const period_start = last_kline.close_time + 1 - config.interval_ms;

    // 从缓存中找出属于该周期的所有5m K线
    const period_klines = klines.filter(k =>
      k.open_time >= period_start && k.close_time <= last_kline.close_time
    );

    if (period_klines.length !== config.bars_count) {
      return null;
    }

    // 聚合
    return {
      symbol,
      interval: config.interval,
      open_time: period_klines[0].open_time,
      close_time: last_kline.close_time,
      open: period_klines[0].open,
      high: Math.max(...period_klines.map(k => k.high)),
      low: Math.min(...period_klines.map(k => k.low)),
      close: last_kline.close,
      volume: period_klines.reduce((sum, k) => sum + k.volume, 0)
    };
  }

  /**
   * 更新聚合K线缓存
   */
  private update_aggregated_cache(kline: AggregatedKline): void {
    const cache_key = `${kline.symbol}_${kline.interval}`;
    let cache = this.aggregated_cache.get(cache_key);

    if (!cache) {
      cache = [];
      this.aggregated_cache.set(cache_key, cache);
    }

    // 检查是否是更新还是新增
    if (cache.length > 0 && cache[cache.length - 1].open_time === kline.open_time) {
      cache[cache.length - 1] = kline;
    } else {
      cache.push(kline);
      if (cache.length > this.MAX_AGG_CACHE_SIZE) {
        cache.shift();
      }
    }
  }

  /**
   * 添加到写入缓冲区
   */
  private add_to_write_buffer(kline: AggregatedKline, config: AggregateConfig): void {
    const table_name = this.get_table_name_for_config(config, kline.open_time);

    let buffer = this.write_buffer.get(table_name);
    if (!buffer) {
      buffer = [];
      this.write_buffer.set(table_name, buffer);
    }

    buffer.push(kline);

    // 检查是否需要刷新
    if (buffer.length >= this.BUFFER_SIZE) {
      this.flush_table(table_name).catch(err => {
        logger.error(`[KlineAggregator] Failed to flush ${table_name}:`, err);
      });
    }
  }

  /**
   * 根据配置获取表名
   * 15m: 按日期分表 (kline_15m_agg_20241231)
   * 1h/4h: 固定表名 (kline_1h_agg, kline_4h_agg)
   */
  private get_table_name_for_config(config: AggregateConfig, timestamp: number): string {
    if (!config.use_partition) {
      return config.table_name;
    }
    const d = new Date(timestamp);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${config.table_name}_${year}${month}${day}`;
  }

  /**
   * 确保表存在
   */
  private async ensure_table_exists(table_name: string, connection: any): Promise<void> {
    const create_sql = `
      CREATE TABLE IF NOT EXISTS ${table_name} (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        open_time BIGINT NOT NULL,
        close_time BIGINT NOT NULL,
        open DECIMAL(20,8) NOT NULL,
        high DECIMAL(20,8) NOT NULL,
        low DECIMAL(20,8) NOT NULL,
        close DECIMAL(20,8) NOT NULL,
        volume DECIMAL(30,8) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_symbol_time (symbol, open_time),
        INDEX idx_open_time (open_time),
        INDEX idx_symbol (symbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    try {
      await connection.execute(create_sql);
    } catch (error: any) {
      if (!error.message?.includes('already exists')) {
        throw error;
      }
    }
  }

  /**
   * 刷新指定表的缓冲区
   */
  private async flush_table(table_name: string): Promise<void> {
    const buffer = this.write_buffer.get(table_name);
    if (!buffer || buffer.length === 0) return;

    const klines_to_write = [...buffer];
    this.write_buffer.set(table_name, []);

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      await this.ensure_table_exists(table_name, connection);

      const placeholders = klines_to_write.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values: any[] = [];

      for (const k of klines_to_write) {
        values.push(k.symbol, k.open_time, k.close_time, k.open, k.high, k.low, k.close, k.volume);
      }

      const sql = `
        INSERT IGNORE INTO ${table_name}
        (symbol, open_time, close_time, open, high, low, close, volume)
        VALUES ${placeholders}
      `;

      await connection.execute(sql, values);
    } catch (error) {
      logger.error(`[KlineAggregator] Batch insert failed for ${table_name}:`, error);
      // 写入失败的数据放回缓冲区
      const current = this.write_buffer.get(table_name) || [];
      this.write_buffer.set(table_name, [...klines_to_write, ...current]);
    } finally {
      connection.release();
    }
  }

  /**
   * 刷新所有缓冲区
   */
  async flush(): Promise<void> {
    const tables = Array.from(this.write_buffer.keys());
    for (const table of tables) {
      await this.flush_table(table);
    }
  }

  /**
   * 启动定时刷新
   */
  private start_flush_timer(): void {
    this.flush_timer = setInterval(async () => {
      try {
        await this.flush();
      } catch (error) {
        logger.error('[KlineAggregator] Flush timer error:', error);
      }
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * 停止定时刷新
   */
  stop_flush_timer(): void {
    if (this.flush_timer) {
      clearInterval(this.flush_timer);
      this.flush_timer = null;
    }
  }

  /**
   * 获取聚合后的K线缓存
   */
  get_aggregated_klines(symbol: string, interval: string): AggregatedKline[] {
    const cache_key = `${symbol}_${interval}`;
    return this.aggregated_cache.get(cache_key) || [];
  }

  /**
   * 获取5分钟K线缓存
   */
  get_5m_klines(symbol: string): Kline5mData[] {
    return this.kline_5m_cache.get(symbol) || [];
  }

  /**
   * 初始化缓存（从数据库加载历史数据）
   */
  async init_cache(symbol: string, klines_5m: Kline5mData[]): Promise<void> {
    // 设置5m缓存
    this.kline_5m_cache.set(symbol, klines_5m.slice(-this.MAX_5M_CACHE_SIZE));

    // 重新计算所有聚合周期
    for (const config of AGGREGATE_CONFIGS) {
      const aggregated = this.aggregate_from_history(symbol, klines_5m, config);
      if (aggregated.length > 0) {
        const cache_key = `${symbol}_${config.interval}`;
        this.aggregated_cache.set(cache_key, aggregated.slice(-this.MAX_AGG_CACHE_SIZE));
      }
    }
  }

  /**
   * 从历史数据聚合K线
   */
  private aggregate_from_history(
    symbol: string,
    klines: Kline5mData[],
    config: AggregateConfig
  ): AggregatedKline[] {
    const result: AggregatedKline[] = [];

    // 按周期分组
    const groups = new Map<number, Kline5mData[]>();

    for (const kline of klines) {
      // 计算该K线属于哪个周期
      const period_start = Math.floor(kline.open_time / config.interval_ms) * config.interval_ms;

      let group = groups.get(period_start);
      if (!group) {
        group = [];
        groups.set(period_start, group);
      }
      group.push(kline);
    }

    // 只聚合完整的周期
    for (const [period_start, group] of groups.entries()) {
      if (group.length === config.bars_count) {
        // 按时间排序
        group.sort((a, b) => a.open_time - b.open_time);

        result.push({
          symbol,
          interval: config.interval,
          open_time: period_start,
          close_time: period_start + config.interval_ms - 1,
          open: group[0].open,
          high: Math.max(...group.map(k => k.high)),
          low: Math.min(...group.map(k => k.low)),
          close: group[group.length - 1].close,
          volume: group.reduce((sum, k) => sum + k.volume, 0)
        });
      }
    }

    return result.sort((a, b) => a.open_time - b.open_time);
  }

  /**
   * 从数据库查询聚合K线
   */
  async get_klines_from_db(
    symbol: string,
    interval: string,
    start_time: number,
    end_time: number
  ): Promise<AggregatedKline[]> {
    const config = AGGREGATE_CONFIGS.find(c => c.interval === interval);
    if (!config) {
      throw new Error(`Unsupported interval: ${interval}`);
    }

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      // 根据是否分表，获取需要查询的表
      const tables = new Set<string>();

      if (config.use_partition) {
        // 15m: 按日期分表
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        let current_ts = start_time;
        while (current_ts <= end_time) {
          tables.add(this.get_table_name_for_config(config, current_ts));
          current_ts += ONE_DAY_MS;
        }
        tables.add(this.get_table_name_for_config(config, end_time));
      } else {
        // 1h/4h: 固定表名
        tables.add(config.table_name);
      }

      const results: AggregatedKline[] = [];

      for (const table of tables) {
        try {
          const sql = `
            SELECT symbol, '${interval}' as \`interval\`, open_time, close_time,
                   open, high, low, close, volume
            FROM ${table}
            WHERE symbol = ? AND open_time >= ? AND open_time <= ?
            ORDER BY open_time
          `;
          const [rows] = await connection.execute(sql, [symbol, start_time, end_time]);

          for (const row of rows as any[]) {
            results.push({
              symbol: row.symbol,
              interval: row.interval,
              open_time: Number(row.open_time),
              close_time: Number(row.close_time),
              open: parseFloat(row.open),
              high: parseFloat(row.high),
              low: parseFloat(row.low),
              close: parseFloat(row.close),
              volume: parseFloat(row.volume)
            });
          }
        } catch (error: any) {
          if (error.code !== 'ER_NO_SUCH_TABLE') {
            throw error;
          }
        }
      }

      return results.sort((a, b) => a.open_time - b.open_time);
    } finally {
      connection.release();
    }
  }

  /**
   * 从聚合表获取有数据的交易对列表
   * @param interval K线周期 (15m, 1h, 4h)
   */
  async get_symbols_from_db(interval: string): Promise<string[]> {
    const config = AGGREGATE_CONFIGS.find(c => c.interval === interval);
    if (!config) {
      return [];
    }

    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      const symbols = new Set<string>();

      if (config.use_partition) {
        // 15m: 分表存储，查询今天和昨天的表
        const today = new Date();
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

        const tables = [
          this.get_table_name_for_config(config, today.getTime()),
          this.get_table_name_for_config(config, yesterday.getTime())
        ];

        for (const table of tables) {
          try {
            const [rows] = await connection.execute(
              `SELECT DISTINCT symbol FROM ${table}`
            );
            for (const row of rows as any[]) {
              symbols.add(row.symbol);
            }
          } catch {
            // 表不存在则忽略
          }
        }
      } else {
        // 1h/4h: 固定表名
        try {
          const [rows] = await connection.execute(
            `SELECT DISTINCT symbol FROM ${config.table_name}`
          );
          for (const row of rows as any[]) {
            symbols.add(row.symbol);
          }
        } catch {
          // 表不存在则忽略
        }
      }

      return Array.from(symbols).sort();
    } finally {
      connection.release();
    }
  }

  /**
   * 获取统计信息
   */
  get_statistics(): {
    symbols_in_5m_cache: number;
    symbols_in_agg_cache: number;
    buffer_tables: number;
    total_buffer_size: number;
  } {
    let total_buffer = 0;
    for (const buffer of this.write_buffer.values()) {
      total_buffer += buffer.length;
    }

    return {
      symbols_in_5m_cache: this.kline_5m_cache.size,
      symbols_in_agg_cache: this.aggregated_cache.size,
      buffer_tables: this.write_buffer.size,
      total_buffer_size: total_buffer
    };
  }

  /**
   * 清理旧表（仅清理分表的15m数据）
   */
  async cleanup_old_tables(days_to_keep: number = 7): Promise<number> {
    const connection = await DatabaseConfig.get_mysql_connection();
    let dropped = 0;

    try {
      // 只清理分表的配置（15m）
      for (const config of AGGREGATE_CONFIGS.filter(c => c.use_partition)) {
        const [tables] = await connection.execute(`
          SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '${config.table_name}_%'
        `);

        const cutoff_date = new Date();
        cutoff_date.setDate(cutoff_date.getDate() - days_to_keep);
        const cutoff_str = this.get_table_name_for_config(config, cutoff_date.getTime())
          .replace(`${config.table_name}_`, '');

        for (const row of tables as any[]) {
          const table_name = row.TABLE_NAME;
          const date_str = table_name.replace(`${config.table_name}_`, '');

          if (date_str < cutoff_str) {
            try {
              await connection.execute(`DROP TABLE IF EXISTS ${table_name}`);
              logger.info(`[KlineAggregator] Dropped old table: ${table_name}`);
              dropped++;
            } catch (error) {
              logger.error(`[KlineAggregator] Failed to drop table ${table_name}:`, error);
            }
          }
        }
      }

      return dropped;
    } finally {
      connection.release();
    }
  }
}
