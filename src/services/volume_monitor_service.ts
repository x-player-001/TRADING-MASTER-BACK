/**
 * 成交量监控服务
 *
 * 功能:
 * 1. 监控指定币种的成交量变化
 * 2. 当成交量激增时触发报警
 * 3. 支持动态加载监控列表
 */

import { Kline5mData, Kline5mRepository } from '@/database/kline_5m_repository';
import { VolumeMonitorRepository, VolumeMonitorSymbol, VolumeAlert } from '@/database/volume_monitor_repository';
import { logger } from '@/utils/logger';

/**
 * 成交量检测结果
 */
export interface VolumeCheckResult {
  symbol: string;
  is_surge: boolean;
  current_volume: number;
  avg_volume: number;
  volume_ratio: number;
  price_change_pct: number;
  direction: 'UP' | 'DOWN';
  current_price: number;
  kline_time: number;
}

export class VolumeMonitorService {
  private repository: VolumeMonitorRepository;
  private kline_repository: Kline5mRepository;

  // 监控配置缓存: symbol -> config
  private config_cache: Map<string, VolumeMonitorSymbol> = new Map();

  // K线缓存: symbol -> klines[]
  private kline_cache: Map<string, Kline5mData[]> = new Map();

  // 缓存大小限制
  private readonly MAX_KLINE_CACHE_SIZE = 100;

  // 配置刷新间隔
  private config_refresh_timer: NodeJS.Timeout | null = null;
  private readonly CONFIG_REFRESH_INTERVAL_MS = 60000;  // 1分钟刷新一次配置

  constructor() {
    this.repository = new VolumeMonitorRepository();
    this.kline_repository = new Kline5mRepository();
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    // 初始化表结构
    await this.repository.init_tables();

    // 加载监控配置
    await this.refresh_config();

    // 启动配置刷新定时器
    this.start_config_refresh_timer();

    logger.info(`[VolumeMonitor] Initialized with ${this.config_cache.size} symbols`);
  }

  /**
   * 刷新监控配置
   * 对于新增的币种，自动从数据库预加载 K 线缓存
   */
  async refresh_config(): Promise<void> {
    const symbols = await this.repository.get_enabled_symbols();

    // 找出新增的币种
    const new_symbols: string[] = [];
    for (const sym of symbols) {
      if (!this.config_cache.has(sym.symbol)) {
        new_symbols.push(sym.symbol);
      }
    }

    // 更新配置缓存
    this.config_cache.clear();
    for (const sym of symbols) {
      this.config_cache.set(sym.symbol, sym);
    }

    // 为新增币种预加载 K 线缓存
    if (new_symbols.length > 0) {
      await this.preload_kline_cache(new_symbols);
    }

    logger.debug(`[VolumeMonitor] Refreshed config: ${symbols.length} symbols enabled, ${new_symbols.length} new`);
  }

  /**
   * 为指定币种预加载 K 线缓存
   */
  private async preload_kline_cache(symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
      try {
        // 从数据库加载最近的 K 线（lookback_bars + 10 作为缓冲）
        const config = this.config_cache.get(symbol);
        const limit = config ? config.lookback_bars + 10 : 30;

        const klines = await this.kline_repository.get_recent_klines(symbol, limit);

        if (klines.length > 0) {
          this.kline_cache.set(symbol, klines);
          logger.info(`[VolumeMonitor] Preloaded ${klines.length} klines for ${symbol}`);
        } else {
          logger.debug(`[VolumeMonitor] No klines found in DB for ${symbol}`);
        }
      } catch (error) {
        logger.error(`[VolumeMonitor] Failed to preload klines for ${symbol}:`, error);
      }
    }
  }

  /**
   * 启动配置刷新定时器
   */
  private start_config_refresh_timer(): void {
    this.config_refresh_timer = setInterval(async () => {
      try {
        await this.refresh_config();
      } catch (error) {
        logger.error('[VolumeMonitor] Failed to refresh config:', error);
      }
    }, this.CONFIG_REFRESH_INTERVAL_MS);
  }

  /**
   * 停止服务
   */
  stop(): void {
    if (this.config_refresh_timer) {
      clearInterval(this.config_refresh_timer);
      this.config_refresh_timer = null;
    }
  }

  /**
   * 检查币种是否在监控列表中
   */
  is_monitored(symbol: string): boolean {
    return this.config_cache.has(symbol);
  }

  /**
   * 获取监控配置
   */
  get_config(symbol: string): VolumeMonitorSymbol | undefined {
    return this.config_cache.get(symbol);
  }

  /**
   * 获取所有监控币种
   */
  get_monitored_symbols(): string[] {
    return Array.from(this.config_cache.keys());
  }

  /**
   * 处理K线数据，检测成交量激增
   * @param kline 完结的K线数据
   * @returns 如果触发报警，返回检测结果
   */
  async process_kline(kline: Kline5mData): Promise<VolumeCheckResult | null> {
    const symbol = kline.symbol;

    // 检查是否在监控列表中
    const config = this.config_cache.get(symbol);
    if (!config) {
      return null;
    }

    // 更新K线缓存
    let cache = this.kline_cache.get(symbol);
    if (!cache) {
      cache = [];
      this.kline_cache.set(symbol, cache);
    }

    // 添加新K线（避免重复）
    if (cache.length === 0 || cache[cache.length - 1].open_time !== kline.open_time) {
      cache.push(kline);
      if (cache.length > this.MAX_KLINE_CACHE_SIZE) {
        cache.shift();
      }
    } else {
      // 更新最后一根
      cache[cache.length - 1] = kline;
    }

    // 检查是否有足够的历史数据
    if (cache.length < config.lookback_bars + 1) {
      return null;
    }

    // 计算成交量基准（不包括当前K线）
    const lookback_klines = cache.slice(-config.lookback_bars - 1, -1);
    const avg_volume = lookback_klines.reduce((sum, k) => sum + k.volume, 0) / lookback_klines.length;

    // 计算当前K线成交量倍数
    const current_volume = kline.volume;
    const volume_ratio = avg_volume > 0 ? current_volume / avg_volume : 0;

    // 计算K线涨跌幅
    const price_change_pct = ((kline.close - kline.open) / kline.open) * 100;
    const direction: 'UP' | 'DOWN' = price_change_pct >= 0 ? 'UP' : 'DOWN';

    // 检查是否满足报警条件
    const is_surge = volume_ratio >= config.volume_multiplier;

    // 检查最小成交额（需要知道价格来计算USDT成交额）
    const volume_usdt = current_volume * kline.close;
    if (volume_usdt < config.min_volume_usdt) {
      return null;
    }

    const result: VolumeCheckResult = {
      symbol,
      is_surge,
      current_volume,
      avg_volume,
      volume_ratio,
      price_change_pct,
      direction,
      current_price: kline.close,
      kline_time: kline.open_time
    };

    // 如果触发报警，保存到数据库
    if (is_surge) {
      try {
        await this.repository.save_alert({
          symbol,
          kline_time: kline.open_time,
          current_volume,
          avg_volume,
          volume_ratio,
          price_change_pct,
          direction,
          current_price: kline.close
        });
      } catch (error) {
        // 可能是重复报警，忽略
        logger.debug(`[VolumeMonitor] Alert already exists or save failed: ${symbol}`);
      }
    }

    return is_surge ? result : null;
  }

  /**
   * 初始化币种的K线缓存
   */
  init_kline_cache(symbol: string, klines: Kline5mData[]): void {
    this.kline_cache.set(symbol, klines.slice(-this.MAX_KLINE_CACHE_SIZE));
  }

  /**
   * 获取K线缓存
   */
  get_kline_cache(symbol: string): Kline5mData[] {
    return this.kline_cache.get(symbol) || [];
  }

  /**
   * 获取报警记录（代理到repository）
   */
  async get_alerts(options: {
    symbol?: string;
    start_time?: number;
    end_time?: number;
    min_ratio?: number;
    direction?: 'UP' | 'DOWN';
    limit?: number;
  } = {}): Promise<VolumeAlert[]> {
    return this.repository.get_alerts(options);
  }

  /**
   * 获取Repository实例（用于API路由）
   */
  get_repository(): VolumeMonitorRepository {
    return this.repository;
  }

  /**
   * 获取统计信息
   */
  get_statistics(): {
    monitored_count: number;
    cached_symbols: number;
    symbols: string[];
  } {
    return {
      monitored_count: this.config_cache.size,
      cached_symbols: this.kline_cache.size,
      symbols: Array.from(this.config_cache.keys())
    };
  }
}
