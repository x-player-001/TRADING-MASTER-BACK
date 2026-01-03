/**
 * 成交量监控服务
 *
 * 功能:
 * 1. 监控所有订阅币种的成交量变化
 * 2. 完结K线：放量≥5x + 阳线 + 上影线<50%，≥10x标记为重要
 * 3. 未完结K线：放量≥10x + 成交额≥1M，递进报警（10x→15x→20x），上涨时上影线<50%，都标记为重要
 * 4. 支持黑名单过滤
 * 5. 启动时从数据库预加载历史K线，避免冷启动延迟
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
  is_final: boolean;          // 是否为完结K线
  alert_level?: number;       // 报警级别 (未完结: 1=10x, 2=15x, 3=20x)
  is_important: boolean;      // 是否为重要信号 (未完结K线或完结K线≥10x)
}

/**
 * 默认监控配置
 */
const DEFAULT_CONFIG = {
  // 完结K线配置
  volume_multiplier: 5.0,        // 放量倍数阈值
  max_upper_shadow_pct: 50,      // 上影线最大比例 (%)
  important_threshold: 10,       // 重要信号阈值 (≥10x)
  // 未完结K线配置 (递进报警阈值)
  pending_thresholds: [10, 15, 20] as const,  // 10倍→15倍→20倍，最多报警3次
  pending_min_volume_usdt: 180000,   // 未完结K线最小成交额 180K USDT
  // 通用配置
  lookback_bars: 10,             // 计算平均成交量的K线数
  min_volume_usdt: 180000,       // 完结K线最小成交额 180K USDT
};

/**
 * 黑名单 - 不监控的币种
 */
const BLACKLIST: string[] = [
  'USDCUSDT',
  'FDUSDUSDT',
];

/**
 * 未完结K线报警记录
 * key: symbol_openTime
 * value: 已触发的最高报警级别 (1=3x, 2=5x, 3=10x)
 */
interface PendingAlertRecord {
  alert_level: number;       // 已触发的最高级别
  last_ratio: number;        // 上次报警时的倍数
}

export class VolumeMonitorService {
  private repository: VolumeMonitorRepository;
  private kline_repository: Kline5mRepository;

  // K线缓存: symbol -> klines[]
  private kline_cache: Map<string, Kline5mData[]> = new Map();

  // 缓存大小限制
  private readonly MAX_KLINE_CACHE_SIZE = 100;

  // 黑名单
  private blacklist: Set<string> = new Set(BLACKLIST);

  // 未完结K线报警记录: "symbol_openTime" -> PendingAlertRecord
  private pending_alerts: Map<string, PendingAlertRecord> = new Map();

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
    this.pending_alerts.clear();
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
   * 获取未完结K线的报警级别
   * @returns 报警级别 (1=10x, 2=15x, 3=20x)，如果不满足任何阈值返回0
   */
  private get_pending_alert_level(volume_ratio: number): number {
    const thresholds = DEFAULT_CONFIG.pending_thresholds;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (volume_ratio >= thresholds[i]) {
        return i + 1;  // 1, 2, 3
      }
    }
    return 0;
  }

  /**
   * 处理K线数据，检测成交量激增
   * - 完结K线：放量≥3x + 阳线 + 上影线<50%，≥10x标记为重要
   * - 未完结K线：放量≥10x 递进报警（10x→15x→20x），都标记为重要
   * @param kline K线数据
   * @param is_final 是否为完结K线
   * @returns 如果触发报警，返回检测结果
   */
  async process_kline(kline: Kline5mData, is_final: boolean = true): Promise<VolumeCheckResult | null> {
    const symbol = kline.symbol;
    const pending_key = `${symbol}_${kline.open_time}`;

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

    // 计算成交额
    const volume_usdt = current_volume * kline.close;

    let should_alert = false;
    let alert_level: number | undefined;
    let is_important = false;

    if (is_final) {
      // 完结K线：清理未完结记录
      this.pending_alerts.delete(pending_key);

      // 检查完结K线最小成交额
      if (volume_usdt < DEFAULT_CONFIG.min_volume_usdt) {
        return null;
      }

      // 完结K线条件：放量≥3x + 阳线 + 上影线<50%
      const is_volume_surge = volume_ratio >= DEFAULT_CONFIG.volume_multiplier;
      const is_bullish = kline.close > kline.open;
      const upper_shadow_pct = this.calculate_upper_shadow_pct(kline);
      const is_low_upper_shadow = upper_shadow_pct < DEFAULT_CONFIG.max_upper_shadow_pct;

      should_alert = is_volume_surge && is_bullish && is_low_upper_shadow;
      is_important = volume_ratio >= DEFAULT_CONFIG.important_threshold;
    } else {
      // 未完结K线：检查最小成交额 (1M USDT)
      if (volume_usdt < DEFAULT_CONFIG.pending_min_volume_usdt) {
        return null;
      }

      // 未完结K线：检查是否满足10x阈值
      const current_level = this.get_pending_alert_level(volume_ratio);

      if (current_level === 0) {
        // 不满足最低阈值 (10x)
        return null;
      }

      // 上涨时检查上影线限制
      if (direction === 'UP') {
        const upper_shadow_pct = this.calculate_upper_shadow_pct(kline);
        if (upper_shadow_pct >= DEFAULT_CONFIG.max_upper_shadow_pct) {
          return null;
        }
      }

      // 检查是否已经在该级别报过警
      const existing = this.pending_alerts.get(pending_key);

      if (!existing) {
        // 首次报警
        should_alert = true;
        alert_level = current_level;
        this.pending_alerts.set(pending_key, {
          alert_level: current_level,
          last_ratio: volume_ratio
        });
      } else if (current_level > existing.alert_level) {
        // 升级报警（从10x升到15x，或从15x升到20x）
        should_alert = true;
        alert_level = current_level;
        this.pending_alerts.set(pending_key, {
          alert_level: current_level,
          last_ratio: volume_ratio
        });
      }
      // 如果 current_level <= existing.alert_level，不再报警

      // 未完结K线报警都标记为重要
      is_important = true;
    }

    if (!should_alert) {
      return null;
    }

    const result: VolumeCheckResult = {
      symbol,
      is_surge: true,
      current_volume,
      avg_volume,
      volume_ratio,
      price_change_pct,
      direction,
      current_price: kline.close,
      kline_time: kline.open_time,
      is_final,
      alert_level,
      is_important
    };

    // 保存报警到数据库
    try {
      await this.repository.save_alert({
        symbol,
        kline_time: kline.open_time,
        current_volume,
        avg_volume,
        volume_ratio,
        price_change_pct,
        direction,
        current_price: kline.close,
        is_important
      });
    } catch (error) {
      // 可能是重复报警，忽略（对于完结K线的重复检测）
      logger.debug(`[VolumeMonitor] Alert save failed or duplicate: ${symbol}`);
    }

    return result;
  }

  /**
   * 清理过期的未完结K线报警记录
   * 建议每5分钟调用一次，清理超过10分钟的记录
   */
  cleanup_pending_alerts(): number {
    const now = Date.now();
    const max_age = 10 * 60 * 1000; // 10分钟
    let cleaned = 0;

    for (const [key] of this.pending_alerts) {
      const parts = key.split('_');
      const open_time = parseInt(parts[parts.length - 1]);
      if (now - open_time > max_age) {
        this.pending_alerts.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[VolumeMonitor] Cleaned ${cleaned} expired pending alert records`);
    }
    return cleaned;
  }

  /**
   * 初始化币种的K线缓存
   */
  init_kline_cache(symbol: string, klines: Kline5mData[]): void {
    this.kline_cache.set(symbol, klines.slice(-this.MAX_KLINE_CACHE_SIZE));
  }

  /**
   * 从数据库预加载所有币种的历史K线
   * 解决冷启动问题，避免需要等待 lookback_bars 根K线才能开始检测
   * @param symbols 需要预加载的币种列表
   */
  async preload_klines_from_db(symbols: string[]): Promise<{ loaded: number; failed: number }> {
    let loaded = 0;
    let failed = 0;

    // 需要加载的K线数量 (lookback_bars + 一些缓冲)
    const klines_to_load = DEFAULT_CONFIG.lookback_bars + 5;

    logger.info(`[VolumeMonitor] Preloading ${klines_to_load} klines for ${symbols.length} symbols from database...`);

    for (const symbol of symbols) {
      // 跳过黑名单
      if (this.blacklist.has(symbol)) {
        continue;
      }

      try {
        // 从数据库获取最近的K线数据
        const klines = await this.kline_repository.get_recent_klines(symbol, klines_to_load);

        if (klines.length > 0) {
          // 按时间升序排列（最早的在前）
          klines.sort((a, b) => a.open_time - b.open_time);
          this.kline_cache.set(symbol, klines);
          loaded++;
        }
      } catch (error) {
        failed++;
        logger.debug(`[VolumeMonitor] Failed to preload klines for ${symbol}: ${error}`);
      }
    }

    logger.info(`[VolumeMonitor] Preload complete: ${loaded} symbols loaded, ${failed} failed`);
    return { loaded, failed };
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
    pending_alerts_count: number;
    config: typeof DEFAULT_CONFIG;
  } {
    return {
      cached_symbols: this.kline_cache.size,
      blacklist_count: this.blacklist.size,
      pending_alerts_count: this.pending_alerts.size,
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
