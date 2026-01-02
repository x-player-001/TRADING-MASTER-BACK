/**
 * 形态扫描服务
 *
 * 功能:
 * 1. 异步扫描所有币种的形态
 * 2. 支持多种K线周期
 * 3. 结果存储到数据库
 *
 * 注意: 仅使用本地数据库数据，不请求币安API（避免触发限流）
 */

import { PatternScanRepository, PatternScanTask, PatternScanResult, PatternType } from '@/database/pattern_scan_repository';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { KlineAggregator, AggregatedKline } from '@/core/data/kline_aggregator';
import { PatternDetector, KlineData, PatternResult } from '@/analysis/pattern_detector';
import { logger } from '@/utils/logger';

/**
 * 扫描请求参数
 */
export interface ScanRequest {
  interval: string;           // K线周期: 5m, 15m, 1h, 4h
  lookback_bars: number;      // 分析的K线数量
}

/**
 * 黑名单配置 - 不扫描的币种
 * 通常是稳定币、指数类、流动性差的币种
 */
const BLACKLIST: string[] = [
  'USDCUSDT',      // 稳定币
  'FDUSDUSDT',     // 稳定币
  'BTCDOMUSDT',    // BTC市占率指数
  'DEFIUSDT',      // DeFi指数
];

/**
 * 形态扫描服务
 */
export class PatternScanService {
  private repository: PatternScanRepository;
  private kline_5m_repository: Kline5mRepository;
  private aggregator: KlineAggregator;
  private detector: PatternDetector;

  // 当前运行的任务
  private running_tasks: Map<string, boolean> = new Map();

  // 黑名单
  private blacklist: Set<string> = new Set(BLACKLIST);

  constructor(aggregator?: KlineAggregator) {
    this.repository = new PatternScanRepository();
    this.kline_5m_repository = new Kline5mRepository();
    this.aggregator = aggregator || new KlineAggregator();
    this.detector = new PatternDetector();
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    await this.repository.init_tables();
    logger.info('[PatternScan] Service initialized');
  }

  /**
   * 启动形态扫描任务
   */
  async start_scan(request: ScanRequest): Promise<string> {
    // 创建任务
    const task_id = await this.repository.create_task(request.interval, request.lookback_bars);

    // 异步执行扫描
    this.run_scan(task_id, request).catch(error => {
      logger.error(`[PatternScan] Task ${task_id} failed:`, error);
      this.repository.fail_task(task_id, error.message).catch(() => {});
    });

    return task_id;
  }

  /**
   * 执行扫描任务
   */
  private async run_scan(task_id: string, request: ScanRequest): Promise<void> {
    this.running_tasks.set(task_id, true);

    try {
      // 从数据库获取有数据的交易对（不请求API）
      const symbols = await this.get_symbols_from_db(request.interval);

      if (symbols.length === 0) {
        logger.warn(`[PatternScan] Task ${task_id}: 数据库中没有 ${request.interval} K线数据，请先运行数据补全脚本`);
        await this.repository.fail_task(task_id, `数据库中没有 ${request.interval} K线数据`);
        return;
      }

      logger.info(`[PatternScan] Task ${task_id}: Scanning ${symbols.length} symbols (from local DB)`);

      // 更新任务状态
      await this.repository.start_task(task_id, symbols.length);

      let scanned = 0;
      let found = 0;
      let skipped_insufficient = 0;  // 数据不足跳过的币种
      const batch_results: Omit<PatternScanResult, 'id' | 'created_at'>[] = [];

      for (const symbol of symbols) {
        // 黑名单过滤
        if (this.blacklist.has(symbol)) {
          scanned++;
          continue;
        }

        try {
          // 获取K线数据（仅从本地数据库）
          const klines = await this.get_klines_from_db_only(symbol, request.interval, request.lookback_bars);

          if (klines.length < 30) {
            skipped_insufficient++;
            scanned++;
            continue;
          }

          // 转换为PatternDetector需要的格式
          const kline_data: KlineData[] = klines.map(k => ({
            open_time: k.open_time,
            close_time: k.close_time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume
          }));

          // 检测形态
          const patterns = this.detector.detect_all(kline_data);

          // 保存结果
          for (const pattern of patterns) {
            batch_results.push({
              task_id,
              symbol,
              pattern_type: pattern.pattern_type,
              score: pattern.score,
              description: pattern.description,
              key_levels: pattern.key_levels,
              kline_interval: request.interval,
              detected_at: pattern.detected_at
            });
            found++;
          }

          scanned++;

          // 每扫描50个币种更新一次进度
          if (scanned % 50 === 0) {
            await this.repository.update_progress(task_id, scanned, found);
            logger.debug(`[PatternScan] Task ${task_id}: ${scanned}/${symbols.length} scanned, ${found} patterns found`);
          }

          // 每100个结果批量保存一次
          if (batch_results.length >= 100) {
            await this.repository.save_results_batch(batch_results);
            batch_results.length = 0;
          }
        } catch (error) {
          logger.debug(`[PatternScan] Failed to scan ${symbol}: ${error}`);
          scanned++;
        }
      }

      // 保存剩余结果
      if (batch_results.length > 0) {
        await this.repository.save_results_batch(batch_results);
      }

      // 完成任务
      await this.repository.complete_task(task_id, found);
      logger.info(`[PatternScan] Task ${task_id} completed: ${found} patterns found in ${symbols.length} symbols`);
      if (skipped_insufficient > 0) {
        logger.info(`[PatternScan] Task ${task_id}: ${skipped_insufficient} symbols skipped due to insufficient data`);
      }
    } finally {
      this.running_tasks.delete(task_id);
    }
  }

  /**
   * 从数据库获取有数据的交易对列表
   * 不请求币安API，避免触发限流
   */
  private async get_symbols_from_db(interval: string): Promise<string[]> {
    if (interval === '5m') {
      // 从5m表获取去重的symbol列表
      return this.get_5m_symbols_from_db();
    } else {
      // 从聚合表获取symbol列表
      return this.aggregator.get_symbols_from_db(interval);
    }
  }

  /**
   * 从5m K线表获取有数据的交易对
   */
  private async get_5m_symbols_from_db(): Promise<string[]> {
    const now = Date.now();
    // 获取最近24小时有数据的币种
    const start_time = now - 24 * 60 * 60 * 1000;

    const { DatabaseConfig } = await import('@/core/config/database');
    const connection = await DatabaseConfig.get_mysql_connection();

    try {
      // 获取今天和昨天的表名
      const today = new Date();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

      const today_table = `kline_5m_${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
      const yesterday_table = `kline_5m_${yesterday.getUTCFullYear()}${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}${String(yesterday.getUTCDate()).padStart(2, '0')}`;

      const symbols = new Set<string>();

      // 查询今天的表
      try {
        const [rows] = await connection.execute(
          `SELECT DISTINCT symbol FROM ${today_table} WHERE open_time >= ?`,
          [start_time]
        );
        for (const row of rows as any[]) {
          symbols.add(row.symbol);
        }
      } catch {
        // 表不存在则忽略
      }

      // 查询昨天的表
      try {
        const [rows] = await connection.execute(
          `SELECT DISTINCT symbol FROM ${yesterday_table} WHERE open_time >= ?`,
          [start_time]
        );
        for (const row of rows as any[]) {
          symbols.add(row.symbol);
        }
      } catch {
        // 表不存在则忽略
      }

      return Array.from(symbols).sort();
    } finally {
      connection.release();
    }
  }

  /**
   * 仅从本地数据库获取K线数据（不请求API）
   */
  private async get_klines_from_db_only(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<(Kline5mData | AggregatedKline)[]> {
    if (interval === '5m') {
      // 直接从数据库获取5m K线
      return this.get_5m_klines_from_db(symbol, limit);
    } else {
      // 聚合周期，先尝试从聚合缓存获取
      const cached = this.aggregator.get_aggregated_klines(symbol, interval);
      if (cached.length >= limit) {
        return cached.slice(-limit);
      }

      // 缓存不足，从聚合表获取
      const db_klines = await this.get_aggregated_klines_from_db(symbol, interval, limit);
      if (db_klines.length >= limit * 0.5) {
        return db_klines;
      }

      // 聚合表数据不足，尝试从5m数据聚合
      const interval_ms = this.get_interval_ms(interval);
      const required_5m = Math.ceil(limit * interval_ms / (5 * 60 * 1000)) + 10;
      const klines_5m = await this.get_5m_klines_from_db(symbol, required_5m);

      if (klines_5m.length >= required_5m * 0.5) {
        // 手动聚合
        return this.aggregate_klines(symbol, klines_5m, interval);
      }

      // 数据不足，返回已有数据
      return db_klines;
    }
  }

  /**
   * 仅从数据库获取5m K线（不请求API）
   */
  private async get_5m_klines_from_db(symbol: string, limit: number): Promise<Kline5mData[]> {
    const now = Date.now();
    const start_time = now - (limit + 10) * 5 * 60 * 1000;

    return this.kline_5m_repository.get_klines_by_time_range(symbol, start_time, now);
  }

  /**
   * 从数据库获取聚合K线
   */
  private async get_aggregated_klines_from_db(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<AggregatedKline[]> {
    const interval_ms = this.get_interval_ms(interval);
    const now = Date.now();
    const start_time = now - (limit + 10) * interval_ms;

    return this.aggregator.get_klines_from_db(symbol, interval, start_time, now);
  }

  /**
   * 手动聚合K线
   */
  private aggregate_klines(
    symbol: string,
    klines_5m: Kline5mData[],
    target_interval: string
  ): AggregatedKline[] {
    const interval_ms = this.get_interval_ms(target_interval);
    const bars_count = interval_ms / (5 * 60 * 1000);

    const groups = new Map<number, Kline5mData[]>();

    for (const kline of klines_5m) {
      const period_start = Math.floor(kline.open_time / interval_ms) * interval_ms;

      let group = groups.get(period_start);
      if (!group) {
        group = [];
        groups.set(period_start, group);
      }
      group.push(kline);
    }

    const result: AggregatedKline[] = [];

    for (const [period_start, group] of groups.entries()) {
      if (group.length === bars_count) {
        group.sort((a, b) => a.open_time - b.open_time);

        result.push({
          symbol,
          interval: target_interval,
          open_time: period_start,
          close_time: period_start + interval_ms - 1,
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
   * 获取周期毫秒数
   */
  private get_interval_ms(interval: string): number {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 5 * 60 * 1000;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }

  /**
   * 获取任务状态
   */
  async get_task(task_id: string): Promise<PatternScanTask | null> {
    return this.repository.get_task(task_id);
  }

  /**
   * 获取任务结果
   */
  async get_results(task_id: string, options: {
    pattern_type?: PatternType;
    min_score?: number;
    symbol?: string;
    limit?: number;
  } = {}): Promise<PatternScanResult[]> {
    return this.repository.get_results(task_id, options);
  }

  /**
   * 获取任务列表
   */
  async get_tasks(options: {
    status?: 'pending' | 'running' | 'completed' | 'failed';
    limit?: number;
  } = {}): Promise<PatternScanTask[]> {
    return this.repository.get_tasks(options);
  }

  /**
   * 获取最新结果
   */
  async get_latest_results(options: {
    pattern_type?: PatternType;
    min_score?: number;
    limit?: number;
  } = {}): Promise<PatternScanResult[]> {
    return this.repository.get_latest_results(options);
  }

  /**
   * 检查任务是否在运行
   */
  is_task_running(task_id: string): boolean {
    return this.running_tasks.has(task_id);
  }

  /**
   * 获取运行中的任务数
   */
  get_running_count(): number {
    return this.running_tasks.size;
  }

  /**
   * 获取Repository实例
   */
  get_repository(): PatternScanRepository {
    return this.repository;
  }

  /**
   * 获取黑名单列表
   */
  get_blacklist(): string[] {
    return Array.from(this.blacklist);
  }

  /**
   * 添加到黑名单
   */
  add_to_blacklist(symbol: string): void {
    this.blacklist.add(symbol.toUpperCase());
    logger.info(`[PatternScan] Added ${symbol} to blacklist`);
  }

  /**
   * 从黑名单移除
   */
  remove_from_blacklist(symbol: string): void {
    this.blacklist.delete(symbol.toUpperCase());
    logger.info(`[PatternScan] Removed ${symbol} from blacklist`);
  }

  /**
   * 检查是否在黑名单中
   */
  is_blacklisted(symbol: string): boolean {
    return this.blacklist.has(symbol.toUpperCase());
  }
}
