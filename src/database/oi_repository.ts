import { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DatabaseConfig } from '../core/config/database';
import { OICacheManager } from '../core/cache/oi_cache_manager';
import { daily_table_manager } from './daily_table_manager';
import { logger } from '../utils/logger';
import {
  ContractSymbolConfig,
  OpenInterestSnapshot,
  OIAnomalyRecord,
  OIMonitoringConfig,
  OISnapshotQueryParams,
  OIAnomalyQueryParams,
  OIStatisticsQueryParams,
  OIStatistics
} from '../types/oi_types';

/**
 * OI数据库操作层
 */
export class OIRepository {
  private cache_manager: OICacheManager | null = null;

  /**
   * 执行数据库操作的统一方法，自动管理连接释放
   */
  private async execute_with_connection<T>(
    operation: (conn: PoolConnection) => Promise<T>
  ): Promise<T> {
    const conn = await DatabaseConfig.get_mysql_connection();
    try {
      return await operation(conn);
    } finally {
      conn.release(); // 释放连接回池
    }
  }

  /**
   * 设置缓存管理器
   */
  set_cache_manager(cache_manager: OICacheManager): void {
    this.cache_manager = cache_manager;
  }

  // ===================== 合约币种配置操作 =====================

  /**
   * 批量保存币种配置
   *
   * ⚠️ 重要：不能删除币种记录，因为有外键级联会清空所有OI历史数据！
   * 策略：只更新/插入新币种，禁用已下架的币种
   */
  async save_symbol_configs(symbols: Omit<ContractSymbolConfig, 'id'>[]): Promise<void> {
    if (symbols.length === 0) return;

    return this.execute_with_connection(async (conn) => {
      try {
        // 开启事务
        await conn.beginTransaction();

        // 第一步：禁用所有币种（准备更新）
        await conn.execute('UPDATE contract_symbols_config SET enabled = 0');

        // 第二步：插入或更新币安返回的最新币种（enabled=1）
        const values = symbols.map(s => [
          s.symbol, s.base_asset, s.quote_asset, s.contract_type, s.status, s.enabled, s.priority
        ]);

        const placeholders = symbols.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
        const insert_sql = `
          INSERT INTO contract_symbols_config
          (symbol, base_asset, quote_asset, contract_type, status, enabled, priority)
          VALUES ${placeholders}
          ON DUPLICATE KEY UPDATE
            base_asset = VALUES(base_asset),
            quote_asset = VALUES(quote_asset),
            contract_type = VALUES(contract_type),
            status = VALUES(status),
            enabled = VALUES(enabled),
            priority = VALUES(priority),
            updated_at = CURRENT_TIMESTAMP
        `;

        await conn.execute(insert_sql, values.flat());

        // 提交事务
        await conn.commit();

        logger.info(`[OIRepository] Saved ${symbols.length} symbols (enabled), old symbols disabled`);
      } catch (error) {
        // 回滚事务
        await conn.rollback();
        logger.error('[OIRepository] Failed to save symbol configs, transaction rolled back', error);
        throw error;
      }
    });
  }

  /**
   * 获取启用的币种列表（已过滤黑名单）
   */
  async get_enabled_symbols(): Promise<ContractSymbolConfig[]> {
    // 先尝试从缓存获取币种名称
    if (this.cache_manager) {
      const cached_symbols = await this.cache_manager.get_enabled_symbols();
      if (cached_symbols && cached_symbols.length > 0) {
        logger.debug(`[OIRepository] Found ${cached_symbols.length} cached enabled symbols`);
      }
    }

    // 从数据库获取完整配置
    return this.execute_with_connection(async (conn) => {
      const sql = `
        SELECT * FROM contract_symbols_config
        WHERE enabled = 1 AND status = 'TRADING'
        ORDER BY priority DESC, symbol ASC
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql);
      let symbols = rows as ContractSymbolConfig[];

      // 获取黑名单并过滤
      const blacklist = await this.get_symbol_blacklist(conn);
      if (blacklist.length > 0) {
        const before_count = symbols.length;
        symbols = symbols.filter(s => {
          // 检查symbol是否包含黑名单中的任何关键词
          return !blacklist.some(blocked => s.symbol.includes(blocked));
        });
        const filtered_count = before_count - symbols.length;
        if (filtered_count > 0) {
          logger.info(`[OIRepository] Filtered ${filtered_count} symbols by blacklist: ${blacklist.join(', ')}`);
        }
      }

      // 更新缓存
      if (this.cache_manager && symbols.length > 0) {
        const symbol_names = symbols.map(s => s.symbol);
        await this.cache_manager.cache_enabled_symbols(symbol_names);
      }

      return symbols;
    });
  }

  /**
   * 获取币种黑名单
   */
  private async get_symbol_blacklist(conn: PoolConnection): Promise<string[]> {
    try {
      const sql = `
        SELECT config_value FROM oi_monitoring_config
        WHERE config_key = 'symbol_blacklist' AND is_active = 1
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql);
      if (rows.length === 0) {
        return [];
      }

      const config_value = rows[0].config_value;
      const blacklist = JSON.parse(config_value) as string[];
      return Array.isArray(blacklist) ? blacklist : [];
    } catch (error) {
      logger.error('[OIRepository] Failed to get blacklist config:', error);
      return [];
    }
  }

  /**
   * 更新币种状态
   */
  async update_symbol_status(symbol: string, status: 'TRADING' | 'BREAK'): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        UPDATE contract_symbols_config
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE symbol = ?
      `;

      await conn.execute(sql, [status, symbol]);
    });
  }

  // ===================== OI快照数据操作 =====================

  /**
   * 批量保存OI快照数据（日期分表版本）
   */
  async batch_save_snapshots(snapshots: Omit<OpenInterestSnapshot, 'id' | 'created_at'>[]): Promise<void> {
    if (snapshots.length === 0) return;

    return this.execute_with_connection(async (conn) => {
      // 按日期分组快照数据
      const snapshots_by_date = new Map<string, typeof snapshots>();

      for (const snapshot of snapshots) {
        const snapshot_date = new Date(snapshot.snapshot_time);
        const date_key = snapshot_date.toISOString().split('T')[0]; // YYYY-MM-DD

        if (!snapshots_by_date.has(date_key)) {
          snapshots_by_date.set(date_key, []);
        }
        snapshots_by_date.get(date_key)!.push(snapshot);
      }

      // 为每个日期写入对应的日期表
      for (const [date_key, date_snapshots] of snapshots_by_date.entries()) {
        // 确保目标日期表存在
        await daily_table_manager.create_table_if_not_exists(date_key);

        // 获取表名
        const table_name = daily_table_manager.get_table_name(date_key);

        const values = date_snapshots.map(s => [
          s.symbol,
          s.open_interest,
          s.timestamp_ms,
          s.snapshot_time,
          s.data_source,
          s.mark_price ?? null,
          s.funding_rate ?? null,
          s.next_funding_time ?? null
        ]);

        const placeholders = date_snapshots.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        const sql = `
          INSERT IGNORE INTO ${table_name}
          (symbol, open_interest, timestamp_ms, snapshot_time, data_source,
           mark_price, funding_rate, next_funding_time)
          VALUES ${placeholders}
        `;

        await conn.execute(sql, values.flat());
        logger.debug(`[OIRepository] 保存 ${date_snapshots.length} 条快照数据（含资金费率）到表: ${table_name}`);
      }

      // 更新缓存：最新OI数据
      if (this.cache_manager) {
        await this.cache_manager.batch_cache_latest_oi(snapshots.map(s => ({
          ...s,
          id: undefined,
          created_at: undefined
        } as OpenInterestSnapshot)));
      }
    });
  }

  /**
   * 获取指定币种在指定日期的OI曲线数据（用于前端绘图）
   * @param symbol 币种符号（如：BTCUSDT）
   * @param date 日期字符串（格式：YYYY-MM-DD）
   * @returns 按时间排序的OI快照数组
   */
  async get_symbol_oi_curve(symbol: string, date: string): Promise<OpenInterestSnapshot[]> {
    return this.execute_with_connection(async (conn) => {
      // 获取日期表名
      const table_name = daily_table_manager.get_table_name(date);

      // 查询该币种当天的所有OI快照，按时间升序排列
      const sql = `
        SELECT
          id,
          symbol,
          open_interest,
          timestamp_ms,
          snapshot_time,
          data_source,
          created_at
        FROM ${table_name}
        WHERE symbol = ?
        ORDER BY timestamp_ms ASC
      `;

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol]);
        logger.debug(`[OIRepository] 查询到 ${rows.length} 条 ${symbol} 在 ${date} 的OI曲线数据`);
        return rows as OpenInterestSnapshot[];
      } catch (error: any) {
        // 如果日期表不存在，尝试从原始表查询
        if (error.code === 'ER_NO_SUCH_TABLE') {
          logger.warn(`[OIRepository] 日期表 ${table_name} 不存在，尝试从原始表查询`);

          const fallback_sql = `
            SELECT
              id,
              symbol,
              open_interest,
              timestamp_ms,
              snapshot_time,
              data_source,
              created_at
            FROM open_interest_snapshots
            WHERE symbol = ?
              AND DATE(snapshot_time) = ?
            ORDER BY timestamp_ms ASC
          `;

          const [fallback_rows] = await conn.execute<RowDataPacket[]>(fallback_sql, [symbol, date]);
          logger.debug(`[OIRepository] 从原始表查询到 ${fallback_rows.length} 条数据`);
          return fallback_rows as OpenInterestSnapshot[];
        }

        throw error;
      }
    });
  }

  /**
   * 查询OI快照数据
   */
  async get_snapshots(params: OISnapshotQueryParams): Promise<OpenInterestSnapshot[]> {
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM open_interest_snapshots WHERE 1=1';
      const conditions: any[] = [];

      if (params.symbol) {
        sql += ' AND symbol = ?';
        conditions.push(params.symbol);
      }

      if (params.start_time) {
        sql += ' AND snapshot_time >= ?';
        conditions.push(params.start_time);
      }

      if (params.end_time) {
        sql += ' AND snapshot_time <= ?';
        conditions.push(params.end_time);
      }

      sql += ` ORDER BY snapshot_time ${params.order || 'DESC'}`;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, conditions);
      return rows as OpenInterestSnapshot[];
    });
  }

  /**
   * 获取指定时间范围内的快照数据（用于异动检测）
   * 支持日期分表查询，跨天时合并多个表的数据
   */
  async get_snapshots_for_anomaly_detection(symbol: string, since_timestamp: number): Promise<OpenInterestSnapshot[]> {
    return this.execute_with_connection(async (conn) => {
      // 计算时间范围对应的日期
      const since_date = new Date(since_timestamp);
      const now_date = new Date();

      // 获取需要查询的日期范围内的所有表
      const tables: string[] = [];
      const current_date = new Date(since_date);

      while (current_date <= now_date) {
        const table_name = daily_table_manager.get_table_name(current_date);
        tables.push(table_name);
        current_date.setDate(current_date.getDate() + 1);
      }

      // 如果只有一个表，直接查询
      if (tables.length === 1) {
        try {
          const sql = `
            SELECT * FROM ${tables[0]}
            WHERE symbol = ? AND timestamp_ms >= ?
            ORDER BY timestamp_ms ASC
          `;
          const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol, since_timestamp]);
          return rows as OpenInterestSnapshot[];
        } catch (error: any) {
          // 如果表不存在，降级到原始表
          if (error.code === 'ER_NO_SUCH_TABLE') {
            logger.debug(`[OIRepository] Daily table ${tables[0]} not found, fallback to original table`);
            const fallback_sql = `
              SELECT * FROM open_interest_snapshots
              WHERE symbol = ? AND timestamp_ms >= ?
              ORDER BY timestamp_ms ASC
            `;
            const [fallback_rows] = await conn.execute<RowDataPacket[]>(fallback_sql, [symbol, since_timestamp]);
            return fallback_rows as OpenInterestSnapshot[];
          }
          throw error;
        }
      }

      // 跨天查询：使用 UNION ALL 合并多个表
      const union_queries = tables.map(table => `
        SELECT * FROM ${table}
        WHERE symbol = ? AND timestamp_ms >= ?
      `).join(' UNION ALL ');

      const final_sql = `
        SELECT * FROM (${union_queries}) AS combined
        ORDER BY timestamp_ms ASC
      `;

      // 为每个UNION部分准备参数
      const params: any[] = [];
      tables.forEach(() => {
        params.push(symbol, since_timestamp);
      });

      try {
        const [rows] = await conn.execute<RowDataPacket[]>(final_sql, params);
        return rows as OpenInterestSnapshot[];
      } catch (error: any) {
        // 如果任何表不存在，降级到原始表
        if (error.code === 'ER_NO_SUCH_TABLE') {
          logger.warn(`[OIRepository] Some daily tables not found, fallback to original table`);
          const fallback_sql = `
            SELECT * FROM open_interest_snapshots
            WHERE symbol = ? AND timestamp_ms >= ?
            ORDER BY timestamp_ms ASC
          `;
          const [fallback_rows] = await conn.execute<RowDataPacket[]>(fallback_sql, [symbol, since_timestamp]);
          return fallback_rows as OpenInterestSnapshot[];
        }
        throw error;
      }
    });
  }

  /**
   * 获取最新的OI快照
   * 优先查询今天的日期表，失败则降级到原始表
   */
  async get_latest_snapshot(symbol: string): Promise<OpenInterestSnapshot | null> {
    return this.execute_with_connection(async (conn) => {
      // 先尝试今天的日期表
      const today_table = daily_table_manager.get_table_name(new Date());

      try {
        const sql = `
          SELECT * FROM ${today_table}
          WHERE symbol = ?
          ORDER BY timestamp_ms DESC
          LIMIT 1
        `;
        const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol]);
        if (rows.length > 0) {
          return rows[0] as OpenInterestSnapshot;
        }
      } catch (error: any) {
        // 表不存在，继续降级
        if (error.code !== 'ER_NO_SUCH_TABLE') {
          throw error;
        }
      }

      // 降级到原始表
      const fallback_sql = `
        SELECT * FROM open_interest_snapshots
        WHERE symbol = ?
        ORDER BY timestamp_ms DESC
        LIMIT 1
      `;
      const [fallback_rows] = await conn.execute<RowDataPacket[]>(fallback_sql, [symbol]);
      return fallback_rows.length > 0 ? fallback_rows[0] as OpenInterestSnapshot : null;
    });
  }

  // ===================== OI异动记录操作 =====================

  /**
   * 获取指定币种、周期的最近一条异动记录
   */
  async get_latest_anomaly(symbol: string, period_seconds: number): Promise<OIAnomalyRecord | null> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        SELECT * FROM oi_anomaly_records
        WHERE symbol = ? AND period_seconds = ?
        ORDER BY anomaly_time DESC
        LIMIT 1
      `;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [symbol, period_seconds]);
      return rows.length > 0 ? rows[0] as OIAnomalyRecord : null;
    });
  }

  /**
   * 保存OI异动记录
   */
  async save_anomaly_record(anomaly: Omit<OIAnomalyRecord, 'id' | 'created_at'>): Promise<number> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        INSERT INTO oi_anomaly_records
        (symbol, period_seconds, percent_change, oi_before, oi_after, oi_change,
         threshold_value, anomaly_time, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await conn.execute<ResultSetHeader>(sql, [
        anomaly.symbol,
        anomaly.period_seconds,
        anomaly.percent_change,
        anomaly.oi_before,
        anomaly.oi_after,
        anomaly.oi_change,
        anomaly.threshold_value,
        anomaly.anomaly_time,
        anomaly.severity
      ]);

      return result.insertId;
    });
  }

  /**
   * 查询异动记录
   */
  async get_anomaly_records(params: OIAnomalyQueryParams): Promise<OIAnomalyRecord[]> {
    // 1. 尝试从缓存获取数据
    if (this.cache_manager) {
      const cached_anomalies = await this.cache_manager.get_anomalies(params);
      if (cached_anomalies) {
        logger.debug(`[OIRepository] Using cached anomalies for params: ${JSON.stringify(params)}`);
        return cached_anomalies;
      }
    }

    // 2. 缓存未命中，查询数据库
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM oi_anomaly_records WHERE 1=1';
      const conditions: any[] = [];

      if (params.symbol) {
        sql += ' AND symbol = ?';
        conditions.push(params.symbol);
      }

      if (params.period_seconds) {
        sql += ' AND period_seconds = ?';
        conditions.push(params.period_seconds);
      }

      if (params.severity) {
        sql += ' AND severity = ?';
        conditions.push(params.severity);
      }

      if (params.start_time) {
        sql += ' AND anomaly_time >= ?';
        conditions.push(params.start_time);
      }

      if (params.end_time) {
        sql += ' AND anomaly_time <= ?';
        conditions.push(params.end_time);
      }

      sql += ` ORDER BY anomaly_time ${params.order || 'DESC'}`;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, conditions);
      const anomalies = rows as OIAnomalyRecord[];

      // 3. 将查询结果存入缓存
      if (this.cache_manager && anomalies.length > 0) {
        await this.cache_manager.cache_anomalies(params, anomalies);
        logger.debug(`[OIRepository] Cached anomalies for params: ${JSON.stringify(params)}, count: ${anomalies.length}`);
      }

      return anomalies;
    });
  }

  // ===================== 监控配置操作 =====================

  /**
   * 获取监控配置
   */
  async get_monitoring_config(key?: string): Promise<OIMonitoringConfig[]> {
    // 如果查询单个配置，先尝试从缓存获取
    if (key && this.cache_manager) {
      const cached_value = await this.cache_manager.get_config(key);
      if (cached_value !== null) {
        logger.debug(`[OIRepository] Using cached config for key: ${key}`);
        return [{
          config_key: key,
          config_value: JSON.stringify(cached_value),
          description: '',
          is_active: true
        } as OIMonitoringConfig];
      }
    }

    // 从数据库获取
    return this.execute_with_connection(async (conn) => {
      let sql = 'SELECT * FROM oi_monitoring_config WHERE is_active = 1';
      const conditions: any[] = [];

      if (key) {
        sql += ' AND config_key = ?';
        conditions.push(key);
      }

      sql += ' ORDER BY config_key';

      const [rows] = await conn.execute<RowDataPacket[]>(sql, conditions);
      const configs = rows as OIMonitoringConfig[];

      // 缓存配置
      if (this.cache_manager && configs.length > 0) {
        for (const config of configs) {
          try {
            const value = JSON.parse(config.config_value);
            await this.cache_manager.cache_config(config.config_key, value);
          } catch (error) {
            // 如果不是JSON格式，直接缓存字符串
            await this.cache_manager.cache_config(config.config_key, config.config_value);
          }
        }
      }

      return configs;
    });
  }

  /**
   * 更新监控配置
   */
  async update_monitoring_config(key: string, value: string): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      const sql = `
        UPDATE oi_monitoring_config
        SET config_value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE config_key = ?
      `;

      await conn.execute(sql, [value, key]);
    });
  }

  // ===================== 统计查询操作 =====================

  /**
   * 获取OI统计数据（日期分表版本 - 性能优化）
   */
  async get_oi_statistics(params: OIStatisticsQueryParams = {}): Promise<OIStatistics[]> {
    // 1. 尝试从缓存获取数据
    if (this.cache_manager) {
      const cached_stats = await this.cache_manager.get_statistics(params);
      if (cached_stats) {
        logger.debug(`[OIRepository] Using cached statistics for params: ${JSON.stringify(params)}`);
        return cached_stats;
      }
    }

    // 2. 缓存未命中，查询数据库
    return this.execute_with_connection(async (conn) => {
      let start_time: Date;
      let end_time: Date;
      let query_date: string; // YYYY-MM-DD格式

      if (params.date) {
        // 传入了日期，获取该日期当天的数据
        const date = new Date(params.date);
        start_time = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
        end_time = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
        query_date = params.date; // 使用传入的日期
      } else {
        // 没有传入日期，获取最近24小时数据（可能跨天，需要查询多个表）
        end_time = new Date();
        start_time = new Date(end_time.getTime() - 24 * 60 * 60 * 1000);
        query_date = end_time.toISOString().split('T')[0]; // 使用今天作为主要查询日期
      }

      // 获取需要查询的日期表
      const table_name = daily_table_manager.get_table_name(query_date);

      // 检查表是否存在
      const table_exists = await this.check_table_exists(conn, table_name);
      if (!table_exists) {
        logger.warn(`[OIRepository] 日期表不存在: ${table_name}，返回空结果`);
        return [];
      }

      // ⭐ 关键优化：直接查询单日分表，避免扫描大表
      // V4 优化版SQL：针对单日表优化，数据量从30万降低到4万
      let sql = `
        WITH anomaly_symbols AS (
          -- 第1步：找出有异动的币种（快速过滤）
          SELECT DISTINCT symbol COLLATE utf8mb4_general_ci as symbol
          FROM oi_anomaly_records
          WHERE anomaly_time >= ? AND anomaly_time <= ?
        ),
        latest_oi AS (
          -- 第2步：从日期表获取最新OI值（单表查询，极快）
          SELECT
            s.symbol,
            s.open_interest as latest_oi,
            s.snapshot_time
          FROM ${table_name} s
          WHERE s.symbol IN (SELECT symbol FROM anomaly_symbols)
            AND (s.symbol, s.timestamp_ms) IN (
              SELECT symbol, MAX(timestamp_ms)
              FROM ${table_name}
              WHERE snapshot_time >= ? AND snapshot_time <= ?
                AND symbol IN (SELECT symbol FROM anomaly_symbols)
              GROUP BY symbol
            )
        ),
        earliest_oi AS (
          -- 第3步：从日期表获取最早OI值
          SELECT
            s.symbol,
            s.open_interest as start_oi
          FROM ${table_name} s
          WHERE s.symbol IN (SELECT symbol FROM anomaly_symbols)
            AND (s.symbol, s.timestamp_ms) IN (
              SELECT symbol, MIN(timestamp_ms)
              FROM ${table_name}
              WHERE snapshot_time >= ? AND snapshot_time <= ?
                AND symbol IN (SELECT symbol FROM anomaly_symbols)
              GROUP BY symbol
            )
        ),
        avg_oi AS (
          -- 第4步：从日期表计算平均OI
          SELECT
            s.symbol,
            AVG(s.open_interest) as avg_oi_24h
          FROM ${table_name} s
          WHERE s.symbol IN (SELECT symbol FROM anomaly_symbols)
            AND s.snapshot_time >= ? AND s.snapshot_time <= ?
          GROUP BY s.symbol
        ),
        period_stats AS (
          -- 第5步：合并统计数据
          SELECT
            l.symbol,
            l.latest_oi,
            e.start_oi,
            a.avg_oi_24h
          FROM latest_oi l
          INNER JOIN earliest_oi e ON l.symbol = e.symbol
          INNER JOIN avg_oi a ON l.symbol = a.symbol
        ),
        anomaly_stats AS (
          SELECT
            symbol COLLATE utf8mb4_general_ci as symbol,
            COUNT(*) as anomaly_count,
            MAX(anomaly_time) as last_anomaly_time,
            MIN(anomaly_time) as first_anomaly_time
          FROM oi_anomaly_records
          WHERE anomaly_time >= ? AND anomaly_time <= ?
          GROUP BY symbol
        )
        SELECT
          ps.symbol,
          ps.latest_oi,
          COALESCE(
            ((ps.latest_oi - ps.start_oi) / NULLIF(ps.start_oi, 0) * 100), 0
          ) as daily_change_pct,
          a.anomaly_count as anomaly_count_24h,
          a.last_anomaly_time,
          a.first_anomaly_time,
          COALESCE(ps.avg_oi_24h, ps.latest_oi) as avg_oi_24h
        FROM period_stats ps
        INNER JOIN anomaly_stats a ON ps.symbol = a.symbol
        WHERE ps.latest_oi IS NOT NULL
      `;

      const conditions: any[] = [
        start_time,    // anomaly_symbols CTE - 开始时间
        end_time,      // anomaly_symbols CTE - 结束时间
        start_time,    // latest_oi CTE - MAX子查询 - 开始时间
        end_time,      // latest_oi CTE - MAX子查询 - 结束时间
        start_time,    // earliest_oi CTE - MIN子查询 - 开始时间
        end_time,      // earliest_oi CTE - MIN子查询 - 结束时间
        start_time,    // avg_oi CTE - 开始时间
        end_time,      // avg_oi CTE - 结束时间
        start_time,    // anomaly_stats CTE - 开始时间
        end_time       // anomaly_stats CTE - 结束时间
      ];

      if (params.symbol) {
        sql += ' AND ps.symbol = ?';
        conditions.push(params.symbol);
      }

      sql += ' ORDER BY COALESCE(a.anomaly_count, 0) DESC, ps.symbol ASC';

      logger.debug(`[OIRepository] 查询日期表: ${table_name}, 时间范围: ${start_time.toISOString()} ~ ${end_time.toISOString()}`);

      const [rows] = await conn.execute<RowDataPacket[]>(sql, conditions);
      const statistics = rows as OIStatistics[];

      // 3. 将查询结果存入缓存
      if (this.cache_manager && statistics.length > 0) {
        await this.cache_manager.cache_statistics(params, statistics);
        logger.debug(`[OIRepository] Cached statistics for params: ${JSON.stringify(params)}, count: ${statistics.length}`);
      }

      return statistics;
    });
  }

  /**
   * 检查表是否存在
   */
  private async check_table_exists(conn: PoolConnection, table_name: string): Promise<boolean> {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
      [table_name]
    );
    return (rows[0] as any).count > 0;
  }

  /**
   * 清理过期数据
   */
  async cleanup_old_data(days_to_keep: number = 30): Promise<void> {
    return this.execute_with_connection(async (conn) => {
      // 清理快照数据
      await conn.execute(`
        DELETE FROM open_interest_snapshots
        WHERE snapshot_time < NOW() - INTERVAL ? DAY
      `, [days_to_keep]);

      // 清理异动记录
      await conn.execute(`
        DELETE FROM oi_anomaly_records
        WHERE anomaly_time < NOW() - INTERVAL ? DAY
      `, [days_to_keep]);
    });
  }
}