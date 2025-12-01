import { BinanceFuturesAPI } from '../api/binance_futures_api';
import { OIRepository } from '../database/oi_repository';
// DatabaseConfig no longer needed - using connection_pool through repository
import { OICacheManager } from '../core/cache/oi_cache_manager';
import { MarketSentimentManager } from './market_sentiment_manager';
import { TradingSystem } from '../trading/trading_system';
import { SignalGenerator } from '../trading/signal_generator';
import { TradingMode } from '../types/trading_types';
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
  private sentiment_manager: MarketSentimentManager | null = null;
  private trading_system: TradingSystem | null = null;
  private signal_generator: SignalGenerator;
  private polling_timer: NodeJS.Timeout | null = null;
  private symbol_refresh_timer: NodeJS.Timeout | null = null;

  private current_symbols: ContractSymbolConfig[] = [];
  private is_running = false;
  private start_time = 0;

  // 每日价格极值缓存（优化性能：避免重复查询数据库）
  private daily_price_extremes: Map<string, {
    date: string;           // 日期 YYYY-MM-DD
    low: number;            // 日内最低价
    high: number;           // 日内最高价
    last_update: number;    // 最后更新时间戳
  }> = new Map();

  // 2小时价格滑动窗口缓存（环形队列，保存120个价格点=2小时@1分钟间隔）
  private price_2h_window: Map<string, {
    prices: number[];       // 环形队列存储价格
    index: number;          // 当前写入位置
    count: number;          // 已有数据点数量
  }> = new Map();
  private readonly PRICE_WINDOW_SIZE = 120;  // 2小时 = 120分钟

  // 默认配置
  private config: OIMonitoringSystemConfig = {
    polling_interval_ms: 60000,        // 1分钟
    max_concurrent_requests: 40,       // 优化：从50降低到40，约13秒完成530个请求
    max_monitored_symbols: 300,        // 默认监控300个币种
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
  private dedup_threshold = 2;  // 默认2%
  private severity_thresholds = {
    high: 30,    // 默认30%
    medium: 15   // 默认15%
  };

  constructor() {
    this.binance_api = new BinanceFuturesAPI(this.config.max_concurrent_requests);
    this.oi_repository = new OIRepository();
    this.signal_generator = new SignalGenerator();
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
   * 初始化情绪数据管理器
   */
  initialize_sentiment_manager(cache_manager?: OICacheManager): void {
    this.sentiment_manager = new MarketSentimentManager(this.binance_api, cache_manager);
    logger.info('[OIPolling] Market sentiment manager initialized');
  }

  /**
   * 初始化交易系统
   */
  initialize_trading_system(enabled: boolean = false, config?: Partial<import('../types/trading_types').TradingSystemConfig>): void {
    this.trading_system = new TradingSystem({
      enabled,
      mode: TradingMode.PAPER, // 默认纸面交易模式（会被config覆盖）
      ...config
    });
    logger.info(`[OIPolling] Trading system initialized (enabled=${enabled}, mode=${config?.mode || TradingMode.PAPER})`);
  }

  /**
   * 获取交易系统实例
   */
  get_trading_system(): TradingSystem | null {
    return this.trading_system;
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

      // 预热2小时价格窗口缓存（从数据库加载历史数据）
      await this.preheat_price_2h_window();

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
      // 从环境变量读取最大监控币种数
      const env_max_symbols = process.env.OI_MAX_MONITORED_SYMBOLS;
      if (env_max_symbols) {
        if (env_max_symbols.toLowerCase() === 'max') {
          this.config.max_monitored_symbols = 'max';
          logger.info('[OIPolling] Max monitored symbols set to unlimited (max)');
        } else {
          const parsed = parseInt(env_max_symbols);
          if (!isNaN(parsed) && parsed > 0) {
            this.config.max_monitored_symbols = parsed;
            logger.info(`[OIPolling] Max monitored symbols set to ${parsed}`);
          }
        }
      }

      const configs = await this.oi_repository.get_monitoring_config();

      for (const config of configs) {
        switch (config.config_key) {
          case 'polling_interval_ms':
            this.config.polling_interval_ms = parseInt(config.config_value);
            break;
          case 'max_concurrent_requests':
            this.config.max_concurrent_requests = parseInt(config.config_value);
            break;
          case 'max_monitored_symbols':
            // 数据库配置优先级高于环境变量
            if (!env_max_symbols) {
              const value = config.config_value.toLowerCase();
              if (value === 'max') {
                this.config.max_monitored_symbols = 'max';
              } else {
                const parsed = parseInt(config.config_value);
                if (!isNaN(parsed) && parsed > 0) {
                  this.config.max_monitored_symbols = parsed;
                }
              }
            }
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
        max_monitored_symbols: this.config.max_monitored_symbols,
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

      // 从币安获取最新币种列表，传递配置的最大币种数
      const latest_symbols = await this.binance_api.get_usdt_perpetual_symbols(
        this.config.max_monitored_symbols
      );

      // 保存到数据库
      await this.oi_repository.save_symbol_configs(latest_symbols);

      // 获取启用的币种
      this.current_symbols = await this.oi_repository.get_enabled_symbols();

      logger.info(`[OIPolling] Symbol list refreshed: ${this.current_symbols.length} active symbols (config limit: ${this.config.max_monitored_symbols})`);
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

      // 2. 批量获取资金费率数据（权重10）
      const premium_data = await this.binance_api.get_all_premium_index();

      // 2.1. 构建premium数据Map（避免重复遍历）
      const premium_map = new Map(premium_data.map(p => [p.symbol, p]));

      // 2.2. 更新2小时价格滑动窗口（用于追高判断）
      this.update_all_price_2h_windows(premium_map);

      // 3. 保存快照数据（合并资金费率）
      await this.save_snapshots_with_premium(oi_results, premium_map, current_time.time_string);

      // 4. 检测异动（传入资金费率数据用于价格变化计算）
      const anomalies = await this.detect_anomalies(oi_results, premium_map, current_time.time_string);

      // 5. 保存异动记录
      await this.save_anomalies(anomalies);

      // 6. ✅ 缓存预热：主动查询统计数据并缓存
      await this.preheat_statistics_cache();

      // 7. ⭐ 传递信号给交易系统（如果有异动）
      // 交易系统会通过自己的定时任务独立管理持仓（同步、更新、超时检查等）
      // OI服务只负责监控和信号生成，不直接操作持仓管理

      const duration = Date.now() - start_time;
      if (anomalies.length > 0) {
        logger.oi(`${current_time.time_string} - ${oi_results.length} symbols, ${anomalies.length} anomalies detected (${duration}ms):`);
        anomalies.forEach(anomaly => {
          const priceInfo = anomaly.price_change_percent !== undefined
            ? `, Price: ${anomaly.price_change_percent > 0 ? '+' : ''}${anomaly.price_change_percent.toFixed(2)}%`
            : '';
          logger.oi(`  🚨 ${anomaly.symbol} [${anomaly.period_minutes}m]: OI ${anomaly.percent_change.toFixed(2)}%${priceInfo} [${anomaly.severity}]`);
        });
      } else {
        logger.oi(`${current_time.time_string} - ${oi_results.length} symbols, no anomalies (${duration}ms)`);
      }

    } catch (error) {
      logger.error(`OI Polling - ${current_time.time_string} - Poll failed`, error);
    }
  }

  /**
   * 保存OI快照数据（合并资金费率数据）
   */
  private async save_snapshots_with_premium(
    oi_results: OIPollingResult[],
    premium_map: Map<string, any>,
    timestamp_string: string
  ): Promise<void> {
    try {
      const snapshots: Omit<OpenInterestSnapshot, 'id' | 'created_at'>[] = oi_results.map(result => {
        const premium = premium_map.get(result.symbol);

        return {
          symbol: result.symbol,
          open_interest: result.open_interest,
          timestamp_ms: result.timestamp_ms,
          snapshot_time: new Date(result.timestamp_ms),
          data_source: 'binance_api',

          // 新增资金费率字段
          mark_price: premium ? parseFloat(premium.markPrice) : undefined,
          funding_rate: premium ? parseFloat(premium.lastFundingRate) : undefined,
          next_funding_time: premium?.nextFundingTime
        };
      });

      await this.oi_repository.batch_save_snapshots(snapshots);
      logger.debug(`[OIPolling] Saved ${snapshots.length} snapshots with funding rates`);
    } catch (error) {
      logger.error('[OIPolling] Failed to save snapshots with premium:', error);
    }
  }

  /**
   * 保存OI快照数据（旧方法，保留兼容性）
   * @deprecated 使用 save_snapshots_with_premium 替代
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
  private async detect_anomalies(
    oi_results: OIPollingResult[],
    premium_map: Map<string, any>,
    timestamp_string: string
  ): Promise<OIAnomalyDetectionResult[]> {
    const anomalies: OIAnomalyDetectionResult[] = [];

    for (const result of oi_results) {
      try {
        // 从premium_map获取当前币种的premium数据
        const premium = premium_map.get(result.symbol);
        const current_price = premium ? parseFloat(premium.markPrice) : undefined;

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

          // 计算OI变化率
          const oi_before = closest_snapshot.open_interest;
          const oi_after = result.open_interest;
          const percent_change = ((oi_after - oi_before) / oi_before) * 100;

          // 计算价格变化（如果有历史价格和当前价格）
          let price_before: number | undefined;
          let price_after: number | undefined;
          let price_change: number | undefined;
          let price_change_percent: number | undefined;

          if (closest_snapshot.mark_price && current_price) {
            price_before = typeof closest_snapshot.mark_price === 'string'
              ? parseFloat(closest_snapshot.mark_price)
              : closest_snapshot.mark_price;
            price_after = current_price;
            price_change = price_after - price_before;
            price_change_percent = (price_change / price_before) * 100;
          }

          // 计算资金费率变化（仅记录数据，不作为异动判断条件）
          let funding_rate_before: number | undefined;
          let funding_rate_after: number | undefined;
          let funding_rate_change: number | undefined;
          let funding_rate_change_percent: number | undefined;

          // 使用已获取的premium数据
          if (closest_snapshot.funding_rate !== undefined && premium && premium.lastFundingRate !== undefined) {
            funding_rate_before = typeof closest_snapshot.funding_rate === 'string'
              ? parseFloat(closest_snapshot.funding_rate)
              : closest_snapshot.funding_rate;
            funding_rate_after = parseFloat(premium.lastFundingRate);
            funding_rate_change = funding_rate_after - funding_rate_before;

            // 计算资金费率变化百分比（避免除以0）
            if (funding_rate_before !== 0) {
              funding_rate_change_percent = (funding_rate_change / Math.abs(funding_rate_before)) * 100;
            } else if (funding_rate_after !== 0) {
              funding_rate_change_percent = 100; // 从0变化到非0，视为100%变化
            }
          }

          // 检查是否超过OI阈值
          if (Math.abs(percent_change) >= threshold) {
            // 🔍 调试日志：异动触发时检查资金费率变量状态
            logger.debug(`[OIPolling] ${result.symbol} [${period_minutes}m] ANOMALY TRIGGERED - funding_rate_before=${funding_rate_before}, after=${funding_rate_after}, change=${funding_rate_change}, percent=${funding_rate_change_percent}`);

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

              // 🔍 调试日志：确认即将保存的资金费率数据
              logger.debug(`[OIPolling] ${result.symbol} [${period_minutes}m] BEFORE PUSH - funding_rate_before=${funding_rate_before}, after=${funding_rate_after}, change=${funding_rate_change}, percent=${funding_rate_change_percent}`);

              anomalies.push({
                symbol: result.symbol,
                period_minutes,
                percent_change,
                oi_before,
                oi_after,
                threshold,
                severity,
                anomaly_type: 'oi', // 仅基于OI判断异动，资金费率只是附加数据
                price_before,
                price_after,
                price_change,
                price_change_percent,
                funding_rate_before,
                funding_rate_after,
                funding_rate_change,
                funding_rate_change_percent
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
   * 保存异动记录（含情绪数据）
   */
  private async save_anomalies(anomalies: OIAnomalyDetectionResult[]): Promise<void> {
    if (anomalies.length === 0) return;

    try {
      // 1. 如果有情绪管理器，批量获取所有异动币种的情绪数据
      const sentiment_map = new Map<string, any>();
      if (this.sentiment_manager) {
        const unique_symbols = [...new Set(anomalies.map(a => a.symbol))];
        logger.debug(`[OIPolling] Fetching sentiment for ${unique_symbols.length} anomaly symbols...`);

        const sentiment_data = await this.sentiment_manager.get_batch_sentiment_data(unique_symbols, '5m');
        sentiment_data.forEach((data, symbol) => {
          sentiment_map.set(symbol, data);
        });
      }

      // 2. 保存每个异动记录
      for (const anomaly of anomalies) {
        const period_seconds = anomaly.period_minutes * 60;

        // 获取该币种的情绪数据
        const sentiment = sentiment_map.get(anomaly.symbol);

        // 🎯 获取或更新每日价格极值
        const current_price = anomaly.price_after || 0;
        const price_extremes = current_price > 0
          ? await this.get_or_update_daily_price_extremes(anomaly.symbol, current_price)
          : {
              daily_low: undefined,
              daily_high: undefined,
              price_from_low_pct: undefined,
              price_from_high_pct: undefined
            };

        // 🎯 获取2小时价格低点（更精准的追高判断）
        const price_2h_data = current_price > 0
          ? this.calculate_price_from_2h_low(anomaly.symbol, current_price)
          : { price_2h_low: undefined, price_from_2h_low_pct: undefined };

        // 构建临时的异动记录（用于信号评分计算）
        const temp_record: OIAnomalyRecord = {
          symbol: anomaly.symbol,
          period_seconds,
          percent_change: anomaly.percent_change,
          oi_before: anomaly.oi_before,
          oi_after: anomaly.oi_after,
          oi_change: anomaly.oi_after - anomaly.oi_before,
          threshold_value: anomaly.threshold,
          anomaly_time: new Date(),
          severity: anomaly.severity,
          anomaly_type: anomaly.anomaly_type,
          price_before: anomaly.price_before,
          price_after: anomaly.price_after,
          price_change: anomaly.price_change,
          price_change_percent: anomaly.price_change_percent,
          funding_rate_before: anomaly.funding_rate_before,
          funding_rate_after: anomaly.funding_rate_after,
          funding_rate_change: anomaly.funding_rate_change,
          funding_rate_change_percent: anomaly.funding_rate_change_percent,
          top_trader_long_short_ratio: sentiment?.top_trader_long_short_ratio,
          top_account_long_short_ratio: sentiment?.top_account_long_short_ratio,
          global_long_short_ratio: sentiment?.global_long_short_ratio,
          taker_buy_sell_ratio: sentiment?.taker_buy_sell_ratio,
          // 添加每日价格极值数据
          daily_price_low: price_extremes.daily_low,
          daily_price_high: price_extremes.daily_high,
          price_from_low_pct: price_extremes.price_from_low_pct,
          price_from_high_pct: price_extremes.price_from_high_pct,
          // 添加2小时价格极值数据（更精准的追高判断）
          price_2h_low: price_2h_data.price_2h_low,
          price_from_2h_low_pct: price_2h_data.price_from_2h_low_pct
        };

        // 🎯 计算信号评分
        const score_data = this.signal_generator.calculate_score_only(temp_record);

        const record: Omit<OIAnomalyRecord, 'id' | 'created_at'> = {
          ...temp_record,
          // 添加信号评分数据
          signal_score: score_data.signal_score,
          signal_confidence: score_data.signal_confidence,
          signal_direction: score_data.signal_direction,
          avoid_chase_reason: score_data.avoid_chase_reason || undefined
        };

        // 记录日志，方便调试
        logger.debug(`[OIPolling] ${anomaly.symbol} [${anomaly.period_minutes}m] - Score: ${score_data.signal_score.toFixed(2)}, Direction: ${score_data.signal_direction}, Confidence: ${(score_data.signal_confidence * 100).toFixed(1)}%${score_data.avoid_chase_reason ? `, Avoid: ${score_data.avoid_chase_reason}` : ''}`);

        // 插入数据库
        const saved_record = await this.oi_repository.save_anomaly_record(record);

        // 同时更新缓存（用于下次去重）
        if (this.oi_cache_manager) {
          await this.oi_cache_manager.cache_latest_anomaly(
            anomaly.symbol,
            period_seconds,
            anomaly.percent_change
          );
        }

        // 如果交易系统已启用，处理该异动
        if (this.trading_system && saved_record) {
          try {
            const trade_result = await this.trading_system.process_anomaly({
              ...record,
              id: saved_record
            } as OIAnomalyRecord);

            if (trade_result.action === 'POSITION_OPENED' && trade_result.position) {
              logger.info(`[OIPolling] 🚀 Trade executed: ${trade_result.position.symbol} ${trade_result.position.side} @ ${trade_result.position.entry_price}`);
            } else if (trade_result.action === 'SIGNAL_REJECTED') {
              // 信号被拒绝（追高、评分不足、方向过滤等），显示具体原因
              logger.oi(`    ↳ ❌ ${anomaly.symbol}: ${trade_result.reason}`);
            } else if (trade_result.action === 'RISK_REJECTED') {
              // 被风控拒绝，显示风控原因
              logger.oi(`    ↳ ⚠️ ${anomaly.symbol}: ${trade_result.reason}`);
            } else if (trade_result.action === 'DISABLED') {
              // 交易系统禁用，不打印
            } else if (trade_result.action === 'NO_SIGNAL') {
              // 兼容旧版：无信号生成
              logger.oi(`    ↳ ❌ ${anomaly.symbol}: 无有效信号`);
            }
          } catch (trade_error) {
            logger.error(`[OIPolling] Trading system error for ${anomaly.symbol}:`, trade_error);
          }
        }
      }

      const with_sentiment = Array.from(sentiment_map.keys()).length;
      logger.info(`[OIPolling] Saved ${anomalies.length} anomaly records (${with_sentiment} with sentiment data)`);
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

  /**
   * ⭐ 已移除 update_trading_positions() 方法
   *
   * 原因：职责分离 - OI监控服务不应该直接管理交易系统的持仓
   *
   * 新架构：
   * - OI服务：只负责监控OI变化、检测异动、生成信号
   * - 交易系统：通过自己的定时任务完全自主管理持仓
   *   └─ sync_positions_from_binance() 每30秒执行
   *      ├─ 同步币安持仓
   *      ├─ 更新价格和盈亏
   *      ├─ 检测部分止盈
   *      ├─ 检查保本止损
   *      └─ 检查超时平仓
   */

  /**
   * 获取或更新币种的每日价格极值
   * 使用内存缓存避免重复查询数据库
   * 首次初始化或跨日时会查询数据库获取当天已有的真实极值
   */
  private async get_or_update_daily_price_extremes(symbol: string, current_price: number): Promise<{
    daily_low: number;
    daily_high: number;
    price_from_low_pct: number;
    price_from_high_pct: number;
  }> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const now = Date.now();

    // 获取缓存
    let extremes = this.daily_price_extremes.get(symbol);

    // 检查是否需要重置（新的一天或首次记录）
    if (!extremes || extremes.date !== today) {
      // 🎯 新的一天或首次记录：查询数据库获取当天已有的极值
      try {
        const db_extremes = await this.oi_repository.get_daily_price_extremes(symbol, today);

        if (db_extremes.daily_low !== null && db_extremes.daily_high !== null) {
          // 数据库中有当天的历史数据，使用真实极值
          extremes = {
            date: today,
            low: Math.min(db_extremes.daily_low, current_price),
            high: Math.max(db_extremes.daily_high, current_price),
            last_update: now
          };
          logger.debug(`[OIPolling] ${symbol} - 从数据库加载日内价格极值并更新: low=${extremes.low}, high=${extremes.high}`);
        } else {
          // 数据库中没有数据（服务刚启动且是当天第一条记录），用当前价格初始化
          extremes = {
            date: today,
            low: current_price,
            high: current_price,
            last_update: now
          };
          logger.debug(`[OIPolling] ${symbol} - 数据库无历史数据，用当前价格初始化日内极值: low=${current_price}, high=${current_price}`);
        }
      } catch (error) {
        // 数据库查询失败，降级使用当前价格初始化
        logger.warn(`[OIPolling] ${symbol} - 查询数据库极值失败，降级使用当前价格初始化:`, error);
        extremes = {
          date: today,
          low: current_price,
          high: current_price,
          last_update: now
        };
      }
    } else {
      // 同一天的后续更新：直接更新内存缓存
      const old_low = extremes.low;
      const old_high = extremes.high;

      extremes.low = Math.min(extremes.low, current_price);
      extremes.high = Math.max(extremes.high, current_price);
      extremes.last_update = now;

      if (extremes.low !== old_low || extremes.high !== old_high) {
        logger.debug(`[OIPolling] ${symbol} - 更新日内价格极值: low=${extremes.low}, high=${extremes.high}`);
      }
    }

    // 更新缓存
    this.daily_price_extremes.set(symbol, extremes);

    // 计算当前价格相对于极值的百分比
    const price_from_low_pct = ((current_price - extremes.low) / extremes.low) * 100;
    const price_from_high_pct = ((extremes.high - current_price) / extremes.high) * 100;

    return {
      daily_low: extremes.low,
      daily_high: extremes.high,
      price_from_low_pct,
      price_from_high_pct
    };
  }

  /**
   * 更新2小时价格滑动窗口（环形队列）
   * 每次轮询时调用，为每个币种更新价格窗口
   */
  private update_price_2h_window(symbol: string, price: number): void {
    let window = this.price_2h_window.get(symbol);

    if (!window) {
      // 初始化环形队列
      window = {
        prices: new Array(this.PRICE_WINDOW_SIZE).fill(0),
        index: 0,
        count: 0
      };
      this.price_2h_window.set(symbol, window);
    }

    // 写入当前价格到环形队列
    window.prices[window.index] = price;
    window.index = (window.index + 1) % this.PRICE_WINDOW_SIZE;
    window.count = Math.min(window.count + 1, this.PRICE_WINDOW_SIZE);
  }

  /**
   * 获取2小时内的最低价
   * 从环形队列中计算最低价，效率O(n)但n最大120，非常快
   */
  private get_price_2h_low(symbol: string): number | undefined {
    const window = this.price_2h_window.get(symbol);
    if (!window || window.count === 0) {
      return undefined;
    }

    let min_price = Infinity;
    for (let i = 0; i < window.count; i++) {
      const price = window.prices[i];
      if (price > 0 && price < min_price) {
        min_price = price;
      }
    }

    return min_price === Infinity ? undefined : min_price;
  }

  /**
   * 计算相对于2小时低点的涨幅
   */
  private calculate_price_from_2h_low(symbol: string, current_price: number): {
    price_2h_low: number | undefined;
    price_from_2h_low_pct: number | undefined;
  } {
    const price_2h_low = this.get_price_2h_low(symbol);

    if (!price_2h_low || price_2h_low <= 0) {
      return { price_2h_low: undefined, price_from_2h_low_pct: undefined };
    }

    const price_from_2h_low_pct = ((current_price - price_2h_low) / price_2h_low) * 100;

    return { price_2h_low, price_from_2h_low_pct };
  }

  /**
   * 批量更新所有币种的2小时价格窗口
   * 在每次轮询时调用
   */
  private update_all_price_2h_windows(premium_map: Map<string, any>): void {
    for (const [symbol, premium] of premium_map) {
      if (premium && premium.markPrice) {
        const price = parseFloat(premium.markPrice);
        if (price > 0) {
          this.update_price_2h_window(symbol, price);
        }
      }
    }
  }

  /**
   * 预热2小时价格窗口缓存
   * 从数据库加载最近2小时的价格数据，填充环形队列
   * 这样启动后立即就能使用2小时低点判断，不需要等待2小时
   */
  private async preheat_price_2h_window(): Promise<void> {
    try {
      logger.info('[OIPolling] Preheating 2h price window cache from database...');
      const start_time = Date.now();

      // 查询最近2小时的价格数据（按币种和时间排序）
      const two_hours_ago = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const snapshots = await this.oi_repository.get_snapshots_for_price_window(two_hours_ago);

      if (snapshots.length === 0) {
        logger.warn('[OIPolling] No historical price data found for preheating');
        return;
      }

      // 按币种分组并填充环形队列
      let symbols_count = 0;
      let prices_count = 0;
      const symbol_prices = new Map<string, number[]>();

      // 先按币种分组
      for (const snapshot of snapshots) {
        if (!snapshot.mark_price || snapshot.mark_price <= 0) continue;

        if (!symbol_prices.has(snapshot.symbol)) {
          symbol_prices.set(snapshot.symbol, []);
        }
        symbol_prices.get(snapshot.symbol)!.push(snapshot.mark_price);
      }

      // 填充每个币种的环形队列
      for (const [symbol, prices] of symbol_prices) {
        // 初始化环形队列
        const window = {
          prices: new Array(this.PRICE_WINDOW_SIZE).fill(0),
          index: 0,
          count: 0
        };

        // 按时间顺序填充（最多120个点）
        const prices_to_use = prices.slice(-this.PRICE_WINDOW_SIZE);
        for (const price of prices_to_use) {
          window.prices[window.index] = price;
          window.index = (window.index + 1) % this.PRICE_WINDOW_SIZE;
          window.count = Math.min(window.count + 1, this.PRICE_WINDOW_SIZE);
        }

        this.price_2h_window.set(symbol, window);
        symbols_count++;
        prices_count += prices_to_use.length;
      }

      const duration = Date.now() - start_time;
      logger.info(`[OIPolling] ✅ Preheated 2h price window: ${symbols_count} symbols, ${prices_count} price points (${duration}ms)`);

    } catch (error) {
      logger.error('[OIPolling] ❌ Failed to preheat 2h price window:', error);
      // 预热失败不影响主流程，只是启动后需要等待缓存积累
    }
  }

  /**
   * 缓存预热：主动查询统计数据并写入Redis
   * 在每次轮询完成后调用，确保缓存始终是热的
   */
  private async preheat_statistics_cache(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];

      // 预热当天的全部统计数据（忽略symbol参数，统一缓存全部数据）
      // 内部会自动调用cache_statistics将结果写入Redis
      await this.oi_repository.get_oi_statistics({ date: today });

      // 可选：预热无日期参数的查询（最近24小时数据）
      await this.oi_repository.get_oi_statistics({});

      logger.debug('[OIPolling] ✅ Statistics cache preheated');
    } catch (error) {
      // 预热失败不影响主流程，只记录日志
      logger.error('[OIPolling] ❌ Failed to preheat statistics cache:', error);
    }
  }
}