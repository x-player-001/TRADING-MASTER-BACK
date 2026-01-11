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
 * 回调扫描请求参数
 */
export interface PullbackScanRequest {
  interval: string;           // K线周期: 5m, 15m, 1h, 4h
  lookback_bars: number;      // 分析的K线数量
  min_surge_pct: number;      // 最小上涨幅度 (%)
  max_retrace_pct: number;    // 最大回调幅度 (%)
  end_time?: number;          // 最后一根K线时间 (ms)，默认当前时间
}

/**
 * 横盘扫描请求参数
 */
export interface ConsolidationScanRequest {
  interval: string;               // K线周期: 5m, 15m, 1h, 4h
  min_bars: number;               // 最小横盘K线数量
  max_range_pct: number;          // 最大震荡幅度 (%)
  require_fake_breakdown: boolean; // 是否要求有向下假突破
  end_time?: number;              // 最后一根K线时间 (ms)，默认当前时间
}

/**
 * 双底扫描请求参数
 */
export interface DoubleBottomScanRequest {
  interval: string;               // K线周期: 5m, 15m, 1h, 4h
  lookback_bars: number;          // 分析的K线数量
  min_bars_between: number;       // 两个底之间最小K线数量
  bottom_tolerance_pct: number;   // 底部价差容忍度 (%)
  end_time?: number;              // 最后一根K线时间 (ms)，默认当前时间
}

/**
 * 上涨后W底扫描请求参数
 */
export interface SurgeWBottomScanRequest {
  interval: string;                     // K线周期: 5m, 15m, 1h, 4h
  lookback_bars: number;                // 分析的K线数量
  min_surge_pct: number;                // 最小上涨幅度 (%)
  max_retrace_pct: number;              // 最大回调幅度 (%)
  max_distance_to_bottom_pct: number;   // 当前价格距W底底部的最大距离 (%)
  end_time?: number;                    // 最后一根K线时间 (ms)，默认当前时间
}

/**
 * 上涨回调靠近EMA扫描请求参数
 */
export interface SurgeEmaPullbackScanRequest {
  interval: string;                     // K线周期: 5m, 15m, 1h, 4h
  lookback_bars: number;                // 分析的K线数量
  min_surge_pct: number;                // 最小上涨幅度 (%)
  max_retrace_pct: number;              // 最大回调幅度 (%)
  min_retrace_bars: number;             // 最小回调K线数
  max_distance_to_ema_pct: number;      // 当前价格距EMA的最大距离 (%)
  ema_period: number;                   // EMA周期，默认120
  end_time?: number;                    // 最后一根K线时间 (ms)，默认当前时间
}

/**
 * 单根K线形态扫描请求参数
 */
export interface SingleCandleScanRequest {
  interval: string;                     // K线周期: 5m, 15m, 1h, 4h
  lookback_bars: number;                // 扫描的K线数量
  max_distance?: number;                // 距离最后一根K线的最大距离（K线数），默认不限
  min_upper_shadow_pct?: number;        // 最小上影线占比 (%)
  max_upper_shadow_pct?: number;        // 最大上影线占比 (%)
  min_lower_shadow_pct?: number;        // 最小下影线占比 (%)
  max_lower_shadow_pct?: number;        // 最大下影线占比 (%)
  min_body_pct?: number;                // 最小实体占比 (%)
  max_body_pct?: number;                // 最大实体占比 (%)
  is_bullish?: boolean | null;          // 是否要求阳线，null/undefined表示不限
  min_range_pct?: number;               // 最小振幅 (%)
  max_range_pct?: number;               // 最大振幅 (%)
  end_time?: number;                    // 最后一根K线时间 (ms)，默认当前时间
}

/**
 * 通用扫描结果
 */
export interface PatternScanResultItem {
  symbol: string;
  score: number;
  description: string;
  key_levels: any;
  kline_interval: string;
  detected_at: number;
}

/**
 * 回调扫描结果 (兼容旧接口)
 */
export interface PullbackScanResult extends PatternScanResultItem {}

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
   *
   * @param symbol 交易对
   * @param interval K线周期
   * @param limit K线数量
   * @param end_time 最后一根K线时间 (ms)，默认当前时间
   */
  private async get_klines_from_db_only(
    symbol: string,
    interval: string,
    limit: number,
    end_time?: number
  ): Promise<(Kline5mData | AggregatedKline)[]> {
    if (interval === '5m') {
      // 直接从数据库获取5m K线
      return this.get_5m_klines_from_db(symbol, limit, end_time);
    } else {
      // 如果指定了 end_time，直接从数据库获取（不使用缓存）
      if (end_time) {
        const db_klines = await this.get_aggregated_klines_from_db(symbol, interval, limit, end_time);
        if (db_klines.length >= limit * 0.5) {
          return db_klines;
        }

        // 聚合表数据不足，尝试从5m数据聚合
        const interval_ms = this.get_interval_ms(interval);
        const required_5m = Math.ceil(limit * interval_ms / (5 * 60 * 1000)) + 10;
        const klines_5m = await this.get_5m_klines_from_db(symbol, required_5m, end_time);

        if (klines_5m.length >= required_5m * 0.5) {
          return this.aggregate_klines(symbol, klines_5m, interval);
        }

        return db_klines;
      }

      // 未指定 end_time，使用缓存逻辑
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
   *
   * @param symbol 交易对
   * @param limit K线数量
   * @param end_time 最后一根K线时间 (ms)，默认当前时间
   */
  private async get_5m_klines_from_db(symbol: string, limit: number, end_time?: number): Promise<Kline5mData[]> {
    const end = end_time || Date.now();
    const start_time = end - (limit + 10) * 5 * 60 * 1000;

    return this.kline_5m_repository.get_klines_by_time_range(symbol, start_time, end);
  }

  /**
   * 从数据库获取聚合K线
   *
   * @param symbol 交易对
   * @param interval K线周期
   * @param limit K线数量
   * @param end_time 最后一根K线时间 (ms)，默认当前时间
   */
  private async get_aggregated_klines_from_db(
    symbol: string,
    interval: string,
    limit: number,
    end_time?: number
  ): Promise<AggregatedKline[]> {
    const interval_ms = this.get_interval_ms(interval);
    const end = end_time || Date.now();
    const start_time = end - (limit + 10) * interval_ms;

    return this.aggregator.get_klines_from_db(symbol, interval, start_time, end);
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

  /**
   * 扫描上涨回调形态（同步执行，直接返回结果）
   *
   * @param request 扫描参数
   * @returns 符合条件的币种列表
   */
  async scan_pullback(request: PullbackScanRequest): Promise<PullbackScanResult[]> {
    const results: PullbackScanResult[] = [];

    // 从数据库获取有数据的交易对
    const symbols = await this.get_symbols_from_db(request.interval);

    if (symbols.length === 0) {
      logger.warn(`[PatternScan] Pullback scan: 数据库中没有 ${request.interval} K线数据`);
      return results;
    }

    logger.info(`[PatternScan] Pullback scan: Scanning ${symbols.length} symbols (surge>=${request.min_surge_pct}%, retrace<=${request.max_retrace_pct}%${request.end_time ? `, end_time=${new Date(request.end_time).toISOString()}` : ''})`);

    for (const symbol of symbols) {
      // 黑名单过滤
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 获取K线数据
        const klines = await this.get_klines_from_db_only(symbol, request.interval, request.lookback_bars, request.end_time);

        if (klines.length < 30) {
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

        // 使用自定义参数检测回调形态
        const pattern = this.detector.detect_pullback_custom(
          kline_data,
          request.min_surge_pct,
          request.max_retrace_pct
        );

        if (pattern) {
          results.push({
            symbol,
            score: pattern.score,
            description: pattern.description,
            key_levels: pattern.key_levels,
            kline_interval: request.interval,
            detected_at: pattern.detected_at
          });
        }
      } catch (error) {
        logger.debug(`[PatternScan] Pullback scan failed for ${symbol}: ${error}`);
      }
    }

    // 按评分降序排序
    results.sort((a, b) => b.score - a.score);

    logger.info(`[PatternScan] Pullback scan completed: ${results.length} patterns found`);

    return results;
  }

  /**
   * 扫描横盘震荡形态（同步执行，直接返回结果）
   *
   * @param request 扫描参数
   * @returns 符合条件的币种列表
   */
  async scan_consolidation(request: ConsolidationScanRequest): Promise<PatternScanResultItem[]> {
    const results: PatternScanResultItem[] = [];

    // 从数据库获取有数据的交易对
    const symbols = await this.get_symbols_from_db(request.interval);

    if (symbols.length === 0) {
      logger.warn(`[PatternScan] Consolidation scan: 数据库中没有 ${request.interval} K线数据`);
      return results;
    }

    const fake_desc = request.require_fake_breakdown ? ', 要求假突破' : '';
    const end_time_desc = request.end_time ? `, end_time=${new Date(request.end_time).toISOString()}` : '';
    logger.info(`[PatternScan] Consolidation scan: Scanning ${symbols.length} symbols (bars>=${request.min_bars}, range<=${request.max_range_pct}%${fake_desc}${end_time_desc})`);

    for (const symbol of symbols) {
      // 黑名单过滤
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 获取K线数据
        const klines = await this.get_klines_from_db_only(symbol, request.interval, request.min_bars + 20, request.end_time);

        if (klines.length < request.min_bars) {
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

        // 使用自定义参数检测横盘形态
        const pattern = this.detector.detect_consolidation_custom(
          kline_data,
          request.min_bars,
          request.max_range_pct,
          request.require_fake_breakdown
        );

        if (pattern) {
          results.push({
            symbol,
            score: pattern.score,
            description: pattern.description,
            key_levels: pattern.key_levels,
            kline_interval: request.interval,
            detected_at: pattern.detected_at
          });
        }
      } catch (error) {
        logger.debug(`[PatternScan] Consolidation scan failed for ${symbol}: ${error}`);
      }
    }

    // 按评分降序排序
    results.sort((a, b) => b.score - a.score);

    logger.info(`[PatternScan] Consolidation scan completed: ${results.length} patterns found`);

    return results;
  }

  /**
   * 扫描双底形态（同步执行，直接返回结果）
   *
   * @param request 扫描参数
   * @returns 符合条件的币种列表
   */
  async scan_double_bottom(request: DoubleBottomScanRequest): Promise<PatternScanResultItem[]> {
    const results: PatternScanResultItem[] = [];

    // 从数据库获取有数据的交易对
    const symbols = await this.get_symbols_from_db(request.interval);

    if (symbols.length === 0) {
      logger.warn(`[PatternScan] Double bottom scan: 数据库中没有 ${request.interval} K线数据`);
      return results;
    }

    logger.info(`[PatternScan] Double bottom scan: Scanning ${symbols.length} symbols (min_bars_between>=${request.min_bars_between}, tolerance<=${request.bottom_tolerance_pct}%${request.end_time ? `, end_time=${new Date(request.end_time).toISOString()}` : ''})`);

    for (const symbol of symbols) {
      // 黑名单过滤
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 获取K线数据
        const klines = await this.get_klines_from_db_only(symbol, request.interval, request.lookback_bars, request.end_time);

        if (klines.length < 30) {
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

        // 使用自定义参数检测双底形态
        const pattern = this.detector.detect_double_bottom_custom(
          kline_data,
          request.min_bars_between,
          request.bottom_tolerance_pct
        );

        if (pattern) {
          results.push({
            symbol,
            score: pattern.score,
            description: pattern.description,
            key_levels: pattern.key_levels,
            kline_interval: request.interval,
            detected_at: pattern.detected_at
          });
        }
      } catch (error) {
        logger.debug(`[PatternScan] Double bottom scan failed for ${symbol}: ${error}`);
      }
    }

    // 按评分降序排序
    results.sort((a, b) => b.score - a.score);

    logger.info(`[PatternScan] Double bottom scan completed: ${results.length} patterns found`);

    return results;
  }

  /**
   * 扫描上涨后W底形态（同步执行，直接返回结果）
   *
   * @param request 扫描参数
   * @returns 符合条件的币种列表
   */
  async scan_surge_w_bottom(request: SurgeWBottomScanRequest): Promise<PatternScanResultItem[]> {
    const results: PatternScanResultItem[] = [];

    // 从数据库获取有数据的交易对
    const symbols = await this.get_symbols_from_db(request.interval);

    if (symbols.length === 0) {
      logger.warn(`[PatternScan] Surge W bottom scan: 数据库中没有 ${request.interval} K线数据`);
      return results;
    }

    logger.info(`[PatternScan] Surge W bottom scan: Scanning ${symbols.length} symbols (surge>=${request.min_surge_pct}%, retrace<=${request.max_retrace_pct}%, distance<=${request.max_distance_to_bottom_pct}%${request.end_time ? `, end_time=${new Date(request.end_time).toISOString()}` : ''})`);

    for (const symbol of symbols) {
      // 黑名单过滤
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 获取K线数据
        const klines = await this.get_klines_from_db_only(symbol, request.interval, request.lookback_bars, request.end_time);

        if (klines.length < 50) {
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

        // 使用自定义参数检测上涨后W底形态
        const pattern = this.detector.detect_surge_w_bottom_custom(
          kline_data,
          request.min_surge_pct,
          request.max_retrace_pct,
          request.max_distance_to_bottom_pct
        );

        if (pattern) {
          results.push({
            symbol,
            score: pattern.score,
            description: pattern.description,
            key_levels: pattern.key_levels,
            kline_interval: request.interval,
            detected_at: pattern.detected_at
          });
        }
      } catch (error) {
        logger.debug(`[PatternScan] Surge W bottom scan failed for ${symbol}: ${error}`);
      }
    }

    // 按评分降序排序
    results.sort((a, b) => b.score - a.score);

    logger.info(`[PatternScan] Surge W bottom scan completed: ${results.length} patterns found`);

    return results;
  }

  /**
   * 扫描上涨回调靠近EMA形态（同步执行，直接返回结果）
   *
   * @param request 扫描参数
   * @returns 符合条件的币种列表
   */
  async scan_surge_ema_pullback(request: SurgeEmaPullbackScanRequest): Promise<PatternScanResultItem[]> {
    const results: PatternScanResultItem[] = [];

    // 从数据库获取有数据的交易对
    const symbols = await this.get_symbols_from_db(request.interval);

    if (symbols.length === 0) {
      logger.warn(`[PatternScan] Surge EMA pullback scan: 数据库中没有 ${request.interval} K线数据`);
      return results;
    }

    logger.info(`[PatternScan] Surge EMA pullback scan: Scanning ${symbols.length} symbols (surge>=${request.min_surge_pct}%, retrace<=${request.max_retrace_pct}%, bars>=${request.min_retrace_bars}, ema_distance<=${request.max_distance_to_ema_pct}%, ema_period=${request.ema_period}${request.end_time ? `, end_time=${new Date(request.end_time).toISOString()}` : ''})`);

    for (const symbol of symbols) {
      // 黑名单过滤
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 获取K线数据（需要足够的数据计算EMA）
        const klines = await this.get_klines_from_db_only(symbol, request.interval, request.lookback_bars, request.end_time);

        if (klines.length < request.ema_period + 20) {
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

        // 使用自定义参数检测上涨回调靠近EMA形态
        const pattern = this.detector.detect_surge_ema_pullback_custom(
          kline_data,
          request.min_surge_pct,
          request.max_retrace_pct,
          request.min_retrace_bars,
          request.max_distance_to_ema_pct,
          request.ema_period
        );

        if (pattern) {
          results.push({
            symbol,
            score: pattern.score,
            description: pattern.description,
            key_levels: pattern.key_levels,
            kline_interval: request.interval,
            detected_at: pattern.detected_at
          });
        }
      } catch (error) {
        logger.debug(`[PatternScan] Surge EMA pullback scan failed for ${symbol}: ${error}`);
      }
    }

    // 按评分降序排序
    results.sort((a, b) => b.score - a.score);

    logger.info(`[PatternScan] Surge EMA pullback scan completed: ${results.length} patterns found`);

    return results;
  }

  /**
   * 扫描单根K线形态（同步执行，直接返回结果）
   *
   * @param request 扫描参数
   * @returns 符合条件的币种列表
   */
  async scan_single_candle(request: SingleCandleScanRequest): Promise<PatternScanResultItem[]> {
    const results: PatternScanResultItem[] = [];

    // 从数据库获取有数据的交易对
    const symbols = await this.get_symbols_from_db(request.interval);

    if (symbols.length === 0) {
      logger.warn(`[PatternScan] Single candle scan: 数据库中没有 ${request.interval} K线数据`);
      return results;
    }

    // 构建日志描述
    const conditions: string[] = [];
    conditions.push(`lookback=${request.lookback_bars}`);
    if (request.max_distance !== undefined) conditions.push(`max_distance=${request.max_distance}`);
    if (request.min_upper_shadow_pct !== undefined) conditions.push(`上影>=${request.min_upper_shadow_pct}%`);
    if (request.max_upper_shadow_pct !== undefined) conditions.push(`上影<=${request.max_upper_shadow_pct}%`);
    if (request.min_lower_shadow_pct !== undefined) conditions.push(`下影>=${request.min_lower_shadow_pct}%`);
    if (request.max_lower_shadow_pct !== undefined) conditions.push(`下影<=${request.max_lower_shadow_pct}%`);
    if (request.min_body_pct !== undefined) conditions.push(`实体>=${request.min_body_pct}%`);
    if (request.max_body_pct !== undefined) conditions.push(`实体<=${request.max_body_pct}%`);
    if (request.is_bullish === true) conditions.push('阳线');
    if (request.is_bullish === false) conditions.push('阴线');
    if (request.min_range_pct !== undefined) conditions.push(`振幅>=${request.min_range_pct}%`);
    if (request.max_range_pct !== undefined) conditions.push(`振幅<=${request.max_range_pct}%`);
    const end_time_desc = request.end_time ? `, end_time=${new Date(request.end_time).toISOString()}` : '';

    logger.info(`[PatternScan] Single candle scan: Scanning ${symbols.length} symbols (${conditions.join(', ')}${end_time_desc})`);

    // 单根K线扫描需要扫描历史K线，强制使用当前时间作为end_time确保从数据库获取完整数据
    // 这样可以避免使用可能不完整的缓存数据
    const effective_end_time = request.end_time || Date.now();

    for (const symbol of symbols) {
      // 黑名单过滤
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 获取K线数据（强制指定end_time以绕过缓存，直接从数据库获取）
        const klines = await this.get_klines_from_db_only(symbol, request.interval, request.lookback_bars, effective_end_time);

        if (klines.length < 1) {
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

        // 计算要扫描的K线范围
        // max_distance 限制从最后一根K线往前最多扫描多少根
        const total_klines = kline_data.length;
        const max_distance = request.max_distance !== undefined ? request.max_distance : total_klines;
        const start_index = Math.max(0, total_klines - max_distance);

        // 扫描每一根K线
        for (let i = start_index; i < total_klines; i++) {
          // 使用自定义参数检测单根K线形态
          // 传入单根K线的数组
          const pattern = this.detector.detect_single_candle_custom(
            [kline_data[i]],
            request.min_upper_shadow_pct,
            request.max_upper_shadow_pct,
            request.min_lower_shadow_pct,
            request.max_lower_shadow_pct,
            request.min_body_pct,
            request.max_body_pct,
            request.is_bullish,
            request.min_range_pct,
            request.max_range_pct
          );

          if (pattern) {
            // 添加距离信息到key_levels
            const distance_from_end = total_klines - 1 - i;
            results.push({
              symbol,
              score: pattern.score,
              description: pattern.description + `, 距当前${distance_from_end}根`,
              key_levels: {
                ...pattern.key_levels,
                distance_from_end
              },
              kline_interval: request.interval,
              detected_at: pattern.detected_at
            });
          }
        }
      } catch (error) {
        logger.debug(`[PatternScan] Single candle scan failed for ${symbol}: ${error}`);
      }
    }

    // 按评分降序排序
    results.sort((a, b) => b.score - a.score);

    logger.info(`[PatternScan] Single candle scan completed: ${results.length} patterns found`);

    return results;
  }
}
