/**
 * 成交量监控服务
 *
 * 功能:
 * 1. 监控所有订阅币种的成交量变化
 * 2. 放量3倍以上 + 阳线 + 上影线不超过20% 时报警
 * 3. 支持黑名单过滤
 */

import { Kline5mData, Kline5mRepository } from '@/database/kline_5m_repository';
import { VolumeMonitorRepository, VolumeAlert } from '@/database/volume_monitor_repository';
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
  upper_shadow_pct?: number;   // 上影线比例
}

/**
 * 默认监控配置
 */
const DEFAULT_CONFIG = {
  volume_multiplier: 3.0,        // 放量倍数阈值
  lookback_bars: 20,             // 计算平均成交量的K线数
  min_volume_usdt: 50000,        // 最小成交额（USDT）
  max_upper_shadow_pct: 20,      // 上影线最大比例 (%)
};

/**
 * 黑名单 - 不监控的币种
 */
const BLACKLIST: string[] = [
  'USDCUSDT',
  'FDUSDUSDT',
];

export class VolumeMonitorService {
  private repository: VolumeMonitorRepository;
  private kline_repository: Kline5mRepository;

  // K线缓存: symbol -> klines[]
  private kline_cache: Map<string, Kline5mData[]> = new Map();

  // 缓存大小限制
  private readonly MAX_KLINE_CACHE_SIZE = 100;

  // 黑名单
  private blacklist: Set<string> = new Set(BLACKLIST);

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

    logger.info(`[VolumeMonitor] Initialized - monitoring all symbols (blacklist: ${this.blacklist.size})`);
  }

  /**
   * 停止服务
   */
  stop(): void {
    // 清理缓存
    this.kline_cache.clear();
  }

  /**
   * 检查币种是否在黑名单中
   */
  is_blacklisted(symbol: string): boolean {
    return this.blacklist.has(symbol.toUpperCase());
  }

  /**
   * 添加到黑名单
   */
  add_to_blacklist(symbol: string): void {
    this.blacklist.add(symbol.toUpperCase());
    logger.info(`[VolumeMonitor] Added ${symbol} to blacklist`);
  }

  /**
   * 从黑名单移除
   */
  remove_from_blacklist(symbol: string): void {
    this.blacklist.delete(symbol.toUpperCase());
    logger.info(`[VolumeMonitor] Removed ${symbol} from blacklist`);
  }

  /**
   * 获取黑名单列表
   */
  get_blacklist(): string[] {
    return Array.from(this.blacklist);
  }

  /**
   * 计算上影线比例
   * 上影线 = (最高价 - max(开盘价, 收盘价)) / K线振幅 * 100
   */
  private calculate_upper_shadow_pct(kline: Kline5mData): number {
    const body_top = Math.max(kline.open, kline.close);
    const upper_shadow = kline.high - body_top;
    const total_range = kline.high - kline.low;

    if (total_range === 0) return 0;
    return (upper_shadow / total_range) * 100;
  }

  /**
   * 处理K线数据，检测成交量激增
   * 条件：放量3倍以上 + 阳线 + 上影线不超过20%
   * @param kline 完结的K线数据
   * @returns 如果触发报警，返回检测结果
   */
  async process_kline(kline: Kline5mData): Promise<VolumeCheckResult | null> {
    const symbol = kline.symbol;

    // 黑名单过滤
    if (this.blacklist.has(symbol)) {
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
    if (cache.length < DEFAULT_CONFIG.lookback_bars + 1) {
      return null;
    }

    // 计算成交量基准（不包括当前K线）
    const lookback_klines = cache.slice(-DEFAULT_CONFIG.lookback_bars - 1, -1);
    const avg_volume = lookback_klines.reduce((sum, k) => sum + k.volume, 0) / lookback_klines.length;

    // 计算当前K线成交量倍数
    const current_volume = kline.volume;
    const volume_ratio = avg_volume > 0 ? current_volume / avg_volume : 0;

    // 计算K线涨跌幅
    const price_change_pct = ((kline.close - kline.open) / kline.open) * 100;
    const direction: 'UP' | 'DOWN' = price_change_pct >= 0 ? 'UP' : 'DOWN';

    // 计算上影线比例
    const upper_shadow_pct = this.calculate_upper_shadow_pct(kline);

    // 检查最小成交额
    const volume_usdt = current_volume * kline.close;
    if (volume_usdt < DEFAULT_CONFIG.min_volume_usdt) {
      return null;
    }

    // 报警条件:
    // 1. 放量3倍以上
    // 2. 阳线 (收盘价 > 开盘价)
    // 3. 上影线不超过20%
    const is_volume_surge = volume_ratio >= DEFAULT_CONFIG.volume_multiplier;
    const is_bullish = kline.close > kline.open;
    const is_low_upper_shadow = upper_shadow_pct <= DEFAULT_CONFIG.max_upper_shadow_pct;

    const is_surge = is_volume_surge && is_bullish && is_low_upper_shadow;

    const result: VolumeCheckResult = {
      symbol,
      is_surge,
      current_volume,
      avg_volume,
      volume_ratio,
      price_change_pct,
      direction,
      current_price: kline.close,
      kline_time: kline.open_time,
      upper_shadow_pct
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
    cached_symbols: number;
    blacklist_count: number;
    config: typeof DEFAULT_CONFIG;
  } {
    return {
      cached_symbols: this.kline_cache.size,
      blacklist_count: this.blacklist.size,
      config: DEFAULT_CONFIG
    };
  }

  /**
   * 获取当前配置
   */
  get_config(): typeof DEFAULT_CONFIG {
    return { ...DEFAULT_CONFIG };
  }
}
