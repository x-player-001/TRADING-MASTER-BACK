import { BinanceFuturesAPI } from '../api/binance_futures_api';
import { OIRepository } from '../database/oi_repository';
// DatabaseConfig no longer needed - using connection_pool through repository
import { OICacheManager } from '../core/cache/oi_cache_manager';
import { logger } from '../utils/logger';
import {
  ContractSymbolConfig,
  OpenInterestSnapshot,
  OIAnomalyRecord,
  OIPollingResult,
  OIAnomalyDetectionResult,
  OIMonitoringSystemConfig,
  ThresholdConfig,
  OffHoursConfig
} from '../types/oi_types';
import { BusinessError, APIError, ErrorHandler } from '../utils/errors';

/**
 * OI数据轮询和异动检测服务
 */
export class OIPollingService {
  private binance_api: BinanceFuturesAPI;
  private oi_repository: OIRepository;
  private oi_cache_manager: OICacheManager | null = null;
  private polling_timer: NodeJS.Timeout | null = null;
  private symbol_refresh_timer: NodeJS.Timeout | null = null;

  private current_symbols: ContractSymbolConfig[] = [];
  private is_running = false;
  private start_time = 0;

  // 默认配置
  private config: OIMonitoringSystemConfig = {
    polling_interval_ms: 60000,        // 1分钟
    max_concurrent_requests: 50,
    thresholds: {
      60: 3,     // 1分钟: 3%
      120: 3,    // 2分钟: 3%
      300: 3,    // 5分钟: 3%
      900: 10    // 15分钟: 10%
    },
    symbol_refresh_interval_ms: 7200000, // 2小时
    off_hours_config: {
      start: 0,
      end: 7,
      interval_ms: 900000  // 15分钟
    }
  };

  // 去重阈值和严重程度配置(从数据库加载)
  private dedup_threshold = 1;  // 默认1%
  private severity_thresholds = {
    high: 30,    // 默认30%
    medium: 15   // 默认15%
  };

  constructor() {
    this.binance_api = new BinanceFuturesAPI(this.config.max_concurrent_requests);
    this.oi_repository = new OIRepository();
  }

  /**
   * 设置缓存管理器
   */
  set_cache_manager(cache_manager: OICacheManager): void {
    this.oi_cache_manager = cache_manager;
    // 同时设置给仓库
    this.oi_repository.set_cache_manager(cache_manager);
  }

  /**
   * 启动OI监控服务
   */
  async start(): Promise<void> {
    if (this.is_running) {
      logger.info('[OIPolling] Service already running');
      return;
    }

    try {
      logger.info('[OIPolling] Starting OI monitoring service...');

      // 加载配置
      await this.load_configuration();

      // 初始化币种列表
      await this.refresh_symbols();

      // 启动轮询
      this.start_time = Date.now();
      this.is_running = true;
      this.schedule_next_poll();

      // 定期刷新币种列表
      this.symbol_refresh_timer = setInterval(
        () => this.refresh_symbols(),
        this.config.symbol_refresh_interval_ms
      );

      logger.info('[OIPolling] Service started successfully');
    } catch (error) {
      logger.error('[OIPolling] Failed to start service:', error);
      throw error;
    }
  }

  /**
   * 停止OI监控服务
   */
  async stop(): Promise<void> {
    logger.info('[OIPolling] Stopping OI monitoring service...');

    this.is_running = false;

    if (this.polling_timer) {
      clearTimeout(this.polling_timer);
      this.polling_timer = null;
    }

    if (this.symbol_refresh_timer) {
      clearInterval(this.symbol_refresh_timer);
      this.symbol_refresh_timer = null;
    }

    logger.info('[OIPolling] Service stopped');
  }

  /**
   * 加载监控配置
   */
  private async load_configuration(): Promise<void> {
    try {
      const configs = await this.oi_repository.get_monitoring_config();

      for (const config of configs) {
        switch (config.config_key) {
          case 'polling_interval_ms':
            this.config.polling_interval_ms = parseInt(config.config_value);
            break;
          case 'max_concurrent_requests':
            this.config.max_concurrent_requests = parseInt(config.config_value);
            break;
          case 'thresholds':
            this.config.thresholds = JSON.parse(config.config_value);
            break;
          case 'symbol_refresh_interval_ms':
            this.config.symbol_refresh_interval_ms = parseInt(config.config_value);
            break;
          case 'off_hours_config':
            this.config.off_hours_config = JSON.parse(config.config_value);
            break;
          case 'dedup_change_diff_threshold':
            this.dedup_threshold = parseFloat(config.config_value);
            break;
          case 'severity_thresholds':
            this.severity_thresholds = JSON.parse(config.config_value);
            break;
        }
      }

      logger.info('[OIPolling] Configuration loaded successfully', {
        dedup_threshold: this.dedup_threshold,
        severity_thresholds: this.severity_thresholds
      });
    } catch (error) {
      logger.warn('[OIPolling] Failed to load configuration, using defaults:', error);
    }
  }

  /**
   * 刷新币种列表
   */
  private async refresh_symbols(): Promise<void> {
    try {
      logger.info('[OIPolling] Refreshing symbol list...');

      // 从币安获取最新币种列表
      const latest_symbols = await this.binance_api.get_usdt_perpetual_symbols();

      // 保存到数据库
      await this.oi_repository.save_symbol_configs(latest_symbols);

      // 获取启用的币种
      this.current_symbols = await this.oi_repository.get_enabled_symbols();

      logger.info(`[OIPolling] Symbol list refreshed: ${this.current_symbols.length} active symbols`);
    } catch (error) {
      logger.error('[OIPolling] Failed to refresh symbols:', error);
      // 如果刷新失败，继续使用现有币种列表
    }
  }

  /**
   * 执行一次完整的轮询
   */
  private async poll(): Promise<void> {
    const start_time = Date.now();
    const current_time = this.binance_api.get_current_time_info();

    try {
      // 1. 获取所有币种的OI数据
      const symbols_list = this.current_symbols.map(s => s.symbol);
      const oi_results = await this.binance_api.get_batch_open_interest(symbols_list);

      if (oi_results.length === 0) {
        logger.warn(`OI Polling - ${current_time.time_string} - No OI data received`);
        return;
      }

      // 2. 保存快照数据
      await this.save_snapshots(oi_results, current_time.time_string);

      // 3. 检测异动
      const anomalies = await this.detect_anomalies(oi_results, current_time.time_string);

      // 4. 保存异动记录
      await this.save_anomalies(anomalies);

      const duration = Date.now() - start_time;
      if (anomalies.length > 0) {
        logger.oi(`${current_time.time_string} - ${oi_results.length} symbols, ${anomalies.length} anomalies detected (${duration}ms):`);
        anomalies.forEach(anomaly => {
          logger.oi(`  🚨 ${anomaly.symbol} [${anomaly.period_minutes}m]: ${anomaly.percent_change.toFixed(2)}% [${anomaly.severity}]`);
        });
      } else {
        logger.oi(`${current_time.time_string} - ${oi_results.length} symbols, no anomalies (${duration}ms)`);
      }

    } catch (error) {
      logger.error(`OI Polling - ${current_time.time_string} - Poll failed`, error);
    }
  }

  /**
   * 保存OI快照数据
   */
  private async save_snapshots(oi_results: OIPollingResult[], timestamp_string: string): Promise<void> {
    try {
      const snapshots: Omit<OpenInterestSnapshot, 'id' | 'created_at'>[] = oi_results.map(result => ({
        symbol: result.symbol,
        open_interest: result.open_interest,
        timestamp_ms: result.timestamp_ms,
        snapshot_time: new Date(result.timestamp_ms),
        data_source: 'binance_api'
      }));

      await this.oi_repository.batch_save_snapshots(snapshots);
    } catch (error) {
      logger.error('[OIPolling] Failed to save snapshots:', error);
    }
  }

  /**
   * 检测OI异动
   */
  private async detect_anomalies(oi_results: OIPollingResult[], timestamp_string: string): Promise<OIAnomalyDetectionResult[]> {
    const anomalies: OIAnomalyDetectionResult[] = [];

    for (const result of oi_results) {
      try {
        // 检测每个时间周期的异动
        for (const [period_seconds_str, threshold] of Object.entries(this.config.thresholds)) {
          const period_seconds = parseInt(period_seconds_str);
          const period_minutes = period_seconds / 60;

          // 获取指定时间前的快照
          const since_timestamp = result.timestamp_ms - (period_seconds * 1000);
          const historical_snapshots = await this.oi_repository.get_snapshots_for_anomaly_detection(
            result.symbol,
            since_timestamp
          );

          if (historical_snapshots.length === 0) continue;

          // 找到最接近目标时间的快照
          const closest_snapshot = this.find_closest_snapshot(historical_snapshots, since_timestamp);
          if (!closest_snapshot || closest_snapshot.open_interest <= 0) continue;

          // 计算变化率
          const oi_before = closest_snapshot.open_interest;
          const oi_after = result.open_interest;
          const percent_change = ((oi_after - oi_before) / oi_before) * 100;

          // 检查是否超过阈值
          if (Math.abs(percent_change) >= threshold) {
            // 缓存优先的去重检测
            let should_insert = true;

            if (this.oi_cache_manager) {
              // 1. 先查缓存
              const cached_percent_change = await this.oi_cache_manager.get_latest_anomaly(result.symbol, period_seconds);

              if (cached_percent_change !== null) {
                // 缓存存在，比对变化率
                const change_diff = Math.abs(percent_change - cached_percent_change);

                if (change_diff < this.dedup_threshold) {
                  // 变化不显著，跳过插入
                  logger.debug(`[OIPolling] Skip duplicate anomaly (cache): ${result.symbol} ${period_minutes}m, change diff: ${change_diff.toFixed(2)}% < ${this.dedup_threshold}%`);
                  should_insert = false;
                }
              }
              // 缓存不存在 -> 直接插入(第一次异动)
            } else {
              // 无缓存管理器，回退到数据库查询
              const last_anomaly = await this.oi_repository.get_latest_anomaly(result.symbol, period_seconds);

              if (last_anomaly) {
                const change_diff = Math.abs(percent_change - last_anomaly.percent_change);

                if (change_diff < this.dedup_threshold) {
                  logger.debug(`[OIPolling] Skip duplicate anomaly (db): ${result.symbol} ${period_minutes}m, change diff: ${change_diff.toFixed(2)}% < ${this.dedup_threshold}%`);
                  should_insert = false;
                }
              }
            }

            if (should_insert) {
              const severity = this.calculate_severity(percent_change);

              anomalies.push({
                symbol: result.symbol,
                period_minutes,
                percent_change,
                oi_before,
                oi_after,
                threshold,
                severity
              });
            }
          }
        }
      } catch (error) {
        logger.error(`[OIPolling] Failed to detect anomalies for ${result.symbol}:`, error);
      }
    }

    return anomalies;
  }

  /**
   * 找到最接近目标时间的快照
   */
  private find_closest_snapshot(snapshots: OpenInterestSnapshot[], target_timestamp: number): OpenInterestSnapshot | null {
    let closest_snapshot: OpenInterestSnapshot | null = null;
    let min_diff = Infinity;

    for (const snapshot of snapshots) {
      const diff = Math.abs(snapshot.timestamp_ms - target_timestamp);
      if (diff < min_diff) {
        min_diff = diff;
        closest_snapshot = snapshot;
      }
    }

    return closest_snapshot;
  }

  /**
   * 计算异动严重程度
   */
  private calculate_severity(percent_change: number): 'low' | 'medium' | 'high' {
    const abs_change = Math.abs(percent_change);

    if (abs_change >= this.severity_thresholds.high) return 'high';
    if (abs_change >= this.severity_thresholds.medium) return 'medium';
    return 'low';
  }

  /**
   * 保存异动记录
   */
  private async save_anomalies(anomalies: OIAnomalyDetectionResult[]): Promise<void> {
    if (anomalies.length === 0) return;

    try {
      for (const anomaly of anomalies) {
        const period_seconds = anomaly.period_minutes * 60;
        const record: Omit<OIAnomalyRecord, 'id' | 'created_at'> = {
          symbol: anomaly.symbol,
          period_seconds,
          percent_change: anomaly.percent_change,
          oi_before: anomaly.oi_before,
          oi_after: anomaly.oi_after,
          oi_change: anomaly.oi_after - anomaly.oi_before,
          threshold_value: anomaly.threshold,
          anomaly_time: new Date(),
          severity: anomaly.severity
        };

        // 插入数据库
        await this.oi_repository.save_anomaly_record(record);

        // 同时更新缓存（用于下次去重）
        if (this.oi_cache_manager) {
          await this.oi_cache_manager.cache_latest_anomaly(
            anomaly.symbol,
            period_seconds,
            anomaly.percent_change
          );
        }
      }

      logger.info(`[OIPolling] Saved ${anomalies.length} anomaly records`);
    } catch (error) {
      logger.error('[OIPolling] Failed to save anomalies:', error);
    }
  }

  /**
   * 调度下次轮询
   */
  private schedule_next_poll(): void {
    if (!this.is_running) return;

    const interval = this.get_current_polling_interval();

    this.polling_timer = setTimeout(async () => {
      if (this.is_running) {
        await this.poll();
        this.schedule_next_poll();
      }
    }, interval);
  }

  /**
   * 获取当前轮询间隔（考虑非交易时段）
   */
  private get_current_polling_interval(): number {
    const current_hour = new Date().getHours();
    const off_hours = this.config.off_hours_config;

    if (current_hour >= off_hours.start && current_hour < off_hours.end) {
      return off_hours.interval_ms;
    }

    return this.config.polling_interval_ms;
  }

  /**
   * 获取服务状态
   */
  get_status(): any {
    return {
      is_running: this.is_running,
      uptime_ms: this.is_running ? Date.now() - this.start_time : 0,
      active_symbols_count: this.current_symbols.length,
      config: this.config,
      next_poll_in_ms: this.polling_timer ? this.get_current_polling_interval() : null
    };
  }

  /**
   * 获取OI Repository实例（已配置缓存）
   */
  get_repository(): OIRepository {
    return this.oi_repository;
  }

  /**
   * 更新配置
   */
  async update_config(key: string, value: any): Promise<void> {
    try {
      await this.oi_repository.update_monitoring_config(key, JSON.stringify(value));
      await this.load_configuration();
      logger.info(`[OIPolling] Updated config ${key}:`, value);
    } catch (error) {
      logger.error(`[OIPolling] Failed to update config ${key}:`, error);
      throw error;
    }
  }

  /**
   * 手动触发一次轮询
   */
  async trigger_manual_poll(): Promise<void> {
    if (!this.is_running) {
      throw new BusinessError('Service is not running');
    }

    logger.info('[OIPolling] Manual poll triggered');
    await this.poll();
  }
}