/**
 * 形态扫描服务
 *
 * 功能:
 * 1. 异步扫描所有币种的形态
 * 2. 支持多种K线周期
 * 3. 结果存储到数据库
 */

import axios from 'axios';
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
 * 形态扫描服务
 */
export class PatternScanService {
  private repository: PatternScanRepository;
  private kline_5m_repository: Kline5mRepository;
  private aggregator: KlineAggregator;
  private detector: PatternDetector;

  // 当前运行的任务
  private running_tasks: Map<string, boolean> = new Map();

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
      // 获取所有交易对
      const symbols = await this.get_all_symbols();
      logger.info(`[PatternScan] Task ${task_id}: Scanning ${symbols.length} symbols`);

      // 更新任务状态
      await this.repository.start_task(task_id, symbols.length);

      let scanned = 0;
      let found = 0;
      const batch_results: Omit<PatternScanResult, 'id' | 'created_at'>[] = [];

      for (const symbol of symbols) {
        try {
          // 获取K线数据
          const klines = await this.get_klines(symbol, request.interval, request.lookback_bars);

          if (klines.length < 30) {
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
    } finally {
      this.running_tasks.delete(task_id);
    }
  }

  /**
   * 获取所有交易对
   */
  private async get_all_symbols(): Promise<string[]> {
    const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
    const response = await axios.get(url);

    return response.data.symbols
      .filter((s: any) =>
        s.status === 'TRADING' &&
        s.contractType === 'PERPETUAL' &&
        s.symbol.endsWith('USDT')
      )
      .map((s: any) => s.symbol);
  }

  /**
   * 获取K线数据
   */
  private async get_klines(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<(Kline5mData | AggregatedKline)[]> {
    if (interval === '5m') {
      // 直接从数据库获取5m K线
      return this.get_5m_klines_from_db_or_api(symbol, limit);
    } else {
      // 聚合周期，先尝试从聚合缓存获取
      const cached = this.aggregator.get_aggregated_klines(symbol, interval);
      if (cached.length >= limit) {
        return cached.slice(-limit);
      }

      // 缓存不足，从数据库获取
      const db_klines = await this.get_aggregated_klines_from_db(symbol, interval, limit);
      if (db_klines.length >= limit * 0.8) {
        return db_klines;
      }

      // 数据库也不足，从API获取5m数据然后聚合
      const interval_ms = this.get_interval_ms(interval);
      const required_5m = Math.ceil(limit * interval_ms / (5 * 60 * 1000)) + 10;
      const klines_5m = await this.get_5m_klines_from_db_or_api(symbol, required_5m);

      // 手动聚合
      return this.aggregate_klines(symbol, klines_5m, interval);
    }
  }

  /**
   * 从数据库或API获取5m K线
   */
  private async get_5m_klines_from_db_or_api(symbol: string, limit: number): Promise<Kline5mData[]> {
    // 先尝试数据库
    const now = Date.now();
    const start_time = now - (limit + 10) * 5 * 60 * 1000;

    const db_klines = await this.kline_5m_repository.get_klines_by_time_range(symbol, start_time, now);

    if (db_klines.length >= limit * 0.8) {
      return db_klines.slice(-limit);
    }

    // 数据库不足，从API获取
    try {
      const url = 'https://fapi.binance.com/fapi/v1/klines';
      const response = await axios.get(url, {
        params: { symbol, interval: '5m', limit }
      });

      return response.data.map((k: any[]) => ({
        symbol,
        open_time: k[0],
        close_time: k[6],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch {
      return db_klines;
    }
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
}
