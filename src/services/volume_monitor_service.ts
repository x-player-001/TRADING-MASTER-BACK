/**
 * 成交量监控服务
 *
 * 功能:
 * 1. 监控所有订阅币种的成交量变化
 * 2. 完结K线：放量≥5x + 阳线 + 上影线<50%，≥10x标记为重要
 * 3. 未完结K线：
 *    - 上涨：放量≥10x + 成交额≥180K，递进报警（10x→15x→20x），上影线<50%，都标记为重要
 *    - 下跌：放量≥20x + 成交额≥180K，无递进报警，标记为重要
 * 4. 倒锤头穿越EMA120形态检测：下影线>50%，上影线<20%，最低价<EMA120<收盘价
 * 5. 支持黑名单过滤
 * 6. 启动时从数据库预加载历史K线，避免冷启动延迟
 */

import { Kline5mData, Kline5mRepository } from '@/database/kline_5m_repository';
import { VolumeMonitorRepository, VolumeAlert } from '@/database/volume_monitor_repository';
import { TelegramService, MessagePriority } from '@/services/telegram_service';
import { AggregatedKline } from '@/core/data/kline_aggregator';
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
 * 倒锤头穿越EMA检测结果
 */
export interface HammerCrossResult {
  symbol: string;
  kline_time: number;
  current_price: number;
  ema120: number;
  lower_shadow_pct: number;   // 下影线比例
  upper_shadow_pct: number;   // 上影线比例
  price_change_pct: number;   // K线涨跌幅
}

/**
 * 完美倒锤头检测结果（独立检测，不依赖EMA，仅完结K线）
 */
export interface PerfectHammerResult {
  symbol: string;
  kline_time: number;
  current_price: number;
  lower_shadow_pct: number;   // 下影线比例
  upper_shadow_pct: number;   // 上影线比例
  price_change_pct: number;   // K线涨跌幅
}

/**
 * 1h十字星检测结果
 */
export interface DojiResult {
  symbol: string;
  kline_time: number;
  interval: string;           // K线周期 (1h)
  current_price: number;
  open_price: number;
  high_price: number;
  low_price: number;
  body_pct: number;           // 实体占比 (%)
  upper_shadow_pct: number;   // 上影线比例 (%)
  lower_shadow_pct: number;   // 下影线比例 (%)
  price_change_pct: number;   // K线涨跌幅
  volume: number;             // 成交量
}

/**
 * 默认监控配置
 */
const DEFAULT_CONFIG = {
  // 完结K线配置
  volume_multiplier: 5.0,        // 放量倍数阈值
  max_upper_shadow_pct: 60,      // 上影线最大比例 (%)
  important_threshold: 10,       // 重要信号阈值 (≥10x)
  // 未完结K线配置 (递进报警阈值)
  pending_thresholds: [10, 15, 20] as const,  // 上涨时: 10倍→15倍→20倍，最多报警3次
  pending_down_threshold: 20,    // 下跌时: 固定20倍门槛，无递进报警
  pending_min_volume_usdt: 180000,   // 未完结K线最小成交额 180K USDT
  // 通用配置
  lookback_bars: 20,             // 计算平均成交量的K线数
  min_volume_usdt: 180000,       // 完结K线最小成交额 180K USDT
  // 倒锤头穿越EMA120配置
  hammer_ema_period: 120,        // EMA周期
  hammer_min_lower_shadow: 50,   // 下影线最小比例 (%)
  hammer_max_upper_shadow: 20,   // 上影线最大比例 (%)
  // 1h十字星配置
  doji_max_body_pct: 5,          // 实体最大占比 (%) - 实体/振幅 <= 5%
  doji_min_range_pct: 1,         // 最小振幅 (%) - 过滤横盘小K线
  doji_lookback_bars: 100,       // 回溯K线数量
  doji_min_surge_pct: 15,        // 最小涨幅 (%) - 需要有过15%以上涨幅
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

  // 缓存大小限制 (需要支持EMA120计算，至少130根)
  private readonly MAX_KLINE_CACHE_SIZE = 150;

  // 黑名单
  private blacklist: Set<string> = new Set(BLACKLIST);

  // 未完结K线报警记录: "symbol_openTime" -> PendingAlertRecord
  private pending_alerts: Map<string, PendingAlertRecord> = new Map();

  // Telegram 推送服务
  private telegram: TelegramService;

  // 当天报警计数: symbol -> count (每天重置)
  private daily_alert_count: Map<string, number> = new Map();
  private daily_alert_date: string = '';  // 当前统计的日期 YYYY-MM-DD

  // 倒锤头形态报警记录: "symbol_openTime" -> true (避免同一根K线重复报警)
  private hammer_alerts: Map<string, boolean> = new Map();

  // 完美倒锤头报警记录: "symbol_openTime" -> true (独立的报警记录)
  private perfect_hammer_alerts: Map<string, boolean> = new Map();

  // 1h十字星报警记录: "symbol_openTime" -> true (避免同一根K线重复报警)
  private doji_alerts: Map<string, boolean> = new Map();

  // 1h K线缓存: symbol -> klines[] (用于十字星检测)
  private kline_1h_cache: Map<string, AggregatedKline[]> = new Map();
  private readonly MAX_1H_CACHE_SIZE = 120;  // 缓存120根1h K线

  constructor() {
    this.repository = new VolumeMonitorRepository();
    this.kline_repository = new Kline5mRepository();
    this.telegram = TelegramService.getInstance();
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
    this.hammer_alerts.clear();
    this.perfect_hammer_alerts.clear();
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
   * 计算下影线比例
   * 下影线 = (min(开盘价, 收盘价) - 最低价) / K线振幅 * 100
   */
  private calculate_lower_shadow_pct(kline: Kline5mData): number {
    const body_bottom = Math.min(kline.open, kline.close);
    const lower_shadow = body_bottom - kline.low;
    const total_range = kline.high - kline.low;

    if (total_range === 0) return 0;
    return (lower_shadow / total_range) * 100;
  }

  /**
   * 计算EMA (指数移动平均线)
   * @param prices 价格数组（按时间升序）
   * @param period EMA周期
   * @returns EMA值，如果数据不足返回null
   */
  private calculate_ema(prices: number[], period: number): number | null {
    if (prices.length < period) {
      return null;
    }

    // EMA 乘数: 2 / (period + 1)
    const multiplier = 2 / (period + 1);

    // 使用前period个价格的SMA作为初始EMA
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

    // 从第period个价格开始计算EMA
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
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
      // 未完结K线：检查最小成交额
      if (volume_usdt < DEFAULT_CONFIG.pending_min_volume_usdt) {
        return null;
      }

      if (direction === 'UP') {
        // 上涨：递进报警 10x→15x→20x，检查上影线
        const current_level = this.get_pending_alert_level(volume_ratio);

        if (current_level === 0) {
          // 不满足最低阈值 (10x)
          return null;
        }

        // 上涨时检查上影线限制
        const upper_shadow_pct = this.calculate_upper_shadow_pct(kline);
        if (upper_shadow_pct >= DEFAULT_CONFIG.max_upper_shadow_pct) {
          return null;
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
      } else {
        // 下跌：固定20x门槛，无递进报警
        if (volume_ratio < DEFAULT_CONFIG.pending_down_threshold) {
          return null;
        }

        // 检查是否已经报过警（下跌只报一次）
        const existing = this.pending_alerts.get(pending_key);
        if (!existing) {
          should_alert = true;
          alert_level = 1;  // 下跌只有一个级别
          this.pending_alerts.set(pending_key, {
            alert_level: 1,
            last_ratio: volume_ratio
          });
        }
        // 下跌不做递进报警
      }

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

      // 发送 Telegram 推送（只推送重要信号）
      if (is_important) {
        this.send_telegram_alert(result);
      }
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

    // 需要加载的K线数量 (EMA120需要至少120根 + 一些缓冲)
    const klines_to_load = Math.max(DEFAULT_CONFIG.lookback_bars, DEFAULT_CONFIG.hammer_ema_period) + 10;

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
   * 获取当天的报警次数并递增
   * 每天自动重置计数
   */
  private get_and_increment_daily_alert_count(symbol: string): number {
    // 获取当前北京时间日期
    const now = new Date();
    const beijing_date = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today = beijing_date.toISOString().split('T')[0];

    // 如果日期变了，重置计数
    if (today !== this.daily_alert_date) {
      this.daily_alert_count.clear();
      this.daily_alert_date = today;
    }

    // 递增并返回当前计数
    const count = (this.daily_alert_count.get(symbol) || 0) + 1;
    this.daily_alert_count.set(symbol, count);
    return count;
  }

  /**
   * 发送 Telegram 报警
   */
  private send_telegram_alert(result: VolumeCheckResult): void {
    const final_tag = result.is_final ? '完结' : '未完结';
    const level_tag = result.alert_level ? `Lv${result.alert_level}` : '';

    // 获取当天第几次报警
    const alert_index = this.get_and_increment_daily_alert_count(result.symbol);

    // 计算成交额 (USDT)
    const volume_usdt = result.current_volume * result.current_price;
    const volume_str = volume_usdt >= 1000000
      ? `${(volume_usdt / 1000000).toFixed(2)}M`
      : `${(volume_usdt / 1000).toFixed(0)}K`;

    this.telegram.send_alert({
      symbol: result.symbol,
      message: `放量${result.volume_ratio.toFixed(1)}x ${final_tag} ${level_tag} [今日第${alert_index}次]`,
      price: result.current_price,
      change_pct: result.price_change_pct,
      volume_ratio: result.volume_ratio,
      direction: result.direction,
      is_important: result.is_important,
      extra_info: `成交额: ${volume_str} USDT`
    }, MessagePriority.HIGH).catch(err => {
      logger.debug(`[VolumeMonitor] Telegram send failed: ${err.message}`);
    });
  }

  /**
   * 检测倒锤头穿越EMA120形态
   * 条件：
   * 1. 下影线 > 50%
   * 2. 上影线 < 20%
   * 3. 最低价 < EMA120 < 收盘价 (穿越)
   * 4. 前30根K线的最低价都在EMA120之上（首次下探EMA120）
   *
   * @param kline K线数据
   * @param is_final 是否为完结K线
   * @returns 如果检测到形态，返回结果
   */
  check_hammer_cross_ema(kline: Kline5mData, is_final: boolean): HammerCrossResult | null {
    const symbol = kline.symbol;
    const alert_key = `${symbol}_${kline.open_time}`;

    // 黑名单过滤
    if (this.blacklist.has(symbol)) {
      return null;
    }

    // 检查是否已经报过警
    if (this.hammer_alerts.has(alert_key)) {
      return null;
    }

    // 获取K线缓存
    const cache = this.kline_cache.get(symbol);
    if (!cache || cache.length < DEFAULT_CONFIG.hammer_ema_period) {
      return null;
    }

    // 计算EMA120
    const close_prices = cache.map(k => k.close);
    const ema120 = this.calculate_ema(close_prices, DEFAULT_CONFIG.hammer_ema_period);
    if (ema120 === null) {
      return null;
    }

    // 计算影线比例
    const lower_shadow_pct = this.calculate_lower_shadow_pct(kline);
    const upper_shadow_pct = this.calculate_upper_shadow_pct(kline);

    // 检查倒锤头条件
    const is_lower_shadow_ok = lower_shadow_pct >= DEFAULT_CONFIG.hammer_min_lower_shadow;
    const is_upper_shadow_ok = upper_shadow_pct <= DEFAULT_CONFIG.hammer_max_upper_shadow;

    // 检查穿越EMA120条件：最低价 < EMA120 < 收盘价
    const is_cross_ema = kline.low < ema120 && kline.close > ema120;

    if (!is_lower_shadow_ok || !is_upper_shadow_ok || !is_cross_ema) {
      return null;
    }

    // 检查前30根K线的最低价是否都在EMA120之上（首次下探）
    // 需要至少有30根历史K线（不包括当前K线）
    const lookback_bars = 30;
    if (cache.length < lookback_bars + 1) {
      return null;
    }

    // 获取前30根K线（不包括当前K线，当前K线是cache的最后一根）
    const prev_klines = cache.slice(-lookback_bars - 1, -1);
    const all_above_ema = prev_klines.every(k => k.low > ema120);

    if (!all_above_ema) {
      return null;
    }

    // 记录已报警，避免重复
    this.hammer_alerts.set(alert_key, true);

    const price_change_pct = ((kline.close - kline.open) / kline.open) * 100;

    const result: HammerCrossResult = {
      symbol,
      kline_time: kline.open_time,
      current_price: kline.close,
      ema120,
      lower_shadow_pct,
      upper_shadow_pct,
      price_change_pct
    };

    // 保存形态报警到数据库
    this.repository.save_pattern_alert({
      symbol,
      kline_time: kline.open_time,
      pattern_type: 'HAMMER_CROSS_EMA',
      current_price: kline.close,
      price_change_pct,
      ema120,
      lower_shadow_pct,
      upper_shadow_pct,
      is_final
    }).catch(err => {
      logger.debug(`[VolumeMonitor] Pattern alert save failed: ${err.message}`);
    });

    // 发送 Telegram 推送
    this.send_hammer_telegram_alert(result, is_final);

    logger.info(`[VolumeMonitor] 🔨 Hammer cross EMA120: ${symbol} @ ${kline.close.toFixed(4)}, EMA120=${ema120.toFixed(4)}, 下影线=${lower_shadow_pct.toFixed(1)}%`);

    return result;
  }

  /**
   * 发送倒锤头形态 Telegram 报警
   */
  private send_hammer_telegram_alert(result: HammerCrossResult, is_final: boolean): void {
    const final_tag = is_final ? '完结' : '未完结';

    // 获取当天第几次报警
    const alert_index = this.get_and_increment_daily_alert_count(result.symbol);

    this.telegram.send_alert({
      symbol: result.symbol,
      message: `🔨 倒锤头穿越EMA120 ${final_tag} [今日第${alert_index}次]`,
      price: result.current_price,
      change_pct: result.price_change_pct,
      direction: 'UP',
      is_important: true,
      extra_info: `EMA120: ${result.ema120.toFixed(4)} | 下影线: ${result.lower_shadow_pct.toFixed(1)}% | 上影线: ${result.upper_shadow_pct.toFixed(1)}%`
    }, MessagePriority.HIGH).catch(err => {
      logger.debug(`[VolumeMonitor] Telegram send failed: ${err.message}`);
    });
  }

  /**
   * 检测完美倒锤头形态（独立检测，不依赖EMA，仅完结K线）
   * 条件：
   * 1. K线为阳线 (close > open)
   * 2. 下影线 >= 85% (回测优化，原为70%)
   * 3. 上影线 <= 5%
   * 4. 当前K线最低价是最近40根K线的最低价
   *
   * @param kline K线数据
   * @param is_final 是否为完结K线（仅完结K线触发）
   * @returns 如果检测到形态，返回结果
   */
  check_perfect_hammer(kline: Kline5mData, is_final: boolean): PerfectHammerResult | null {
    const symbol = kline.symbol;
    const alert_key = `${symbol}_${kline.open_time}`;

    // 黑名单过滤
    if (this.blacklist.has(symbol)) {
      return null;
    }

    // 检查是否已经报过警
    if (this.perfect_hammer_alerts.has(alert_key)) {
      return null;
    }

    // 获取K线缓存，检查是否有足够的历史数据
    const cache = this.kline_cache.get(symbol);
    if (!cache || cache.length < 40) {
      return null;
    }

    // 计算影线比例
    const lower_shadow_pct = this.calculate_lower_shadow_pct(kline);
    const upper_shadow_pct = this.calculate_upper_shadow_pct(kline);

    // 检查完美倒锤头条件
    const is_bullish = kline.close > kline.open;                 // 阳线
    const is_lower_shadow_ok = lower_shadow_pct >= 85;           // 下影线 >= 85% (回测优化)
    const is_upper_shadow_ok = upper_shadow_pct <= 5;            // 上影线 <= 5%

    if (!is_bullish || !is_lower_shadow_ok || !is_upper_shadow_ok) {
      return null;
    }

    // 检查当前K线最低价是否是最近40根K线的最低价
    const recent_40_klines = cache.slice(-40);
    const min_low_in_recent = Math.min(...recent_40_klines.map(k => k.low));
    if (kline.low > min_low_in_recent) {
      return null;
    }

    // 记录已报警，避免重复
    this.perfect_hammer_alerts.set(alert_key, true);

    const price_change_pct = ((kline.close - kline.open) / kline.open) * 100;

    const result: PerfectHammerResult = {
      symbol,
      kline_time: kline.open_time,
      current_price: kline.close,
      lower_shadow_pct,
      upper_shadow_pct,
      price_change_pct
    };

    // 保存形态报警到数据库
    this.repository.save_pattern_alert({
      symbol,
      kline_time: kline.open_time,
      pattern_type: 'PERFECT_HAMMER',
      current_price: kline.close,
      price_change_pct,
      ema120: 0,  // 不依赖EMA
      lower_shadow_pct,
      upper_shadow_pct,
      is_final
    }).catch(err => {
      logger.debug(`[VolumeMonitor] Pattern alert save failed: ${err.message}`);
    });

    // 发送 Telegram 推送
    this.send_perfect_hammer_telegram_alert(result, is_final);

    logger.info(`[VolumeMonitor] ⭐🔨 Perfect Hammer: ${symbol} @ ${kline.close.toFixed(4)}, 下影线=${lower_shadow_pct.toFixed(1)}%, 上影线=${upper_shadow_pct.toFixed(1)}%`);

    return result;
  }

  /**
   * 发送完美倒锤头形态 Telegram 报警
   */
  private send_perfect_hammer_telegram_alert(result: PerfectHammerResult, is_final: boolean): void {
    const final_tag = is_final ? '完结' : '未完结';

    // 获取当天第几次报警
    const alert_index = this.get_and_increment_daily_alert_count(result.symbol);

    this.telegram.send_alert({
      symbol: result.symbol,
      message: `⭐🔨 完美倒锤头 ${final_tag} [今日第${alert_index}次]`,
      price: result.current_price,
      change_pct: result.price_change_pct,
      direction: 'UP',
      is_important: true,
      extra_info: `下影线: ${result.lower_shadow_pct.toFixed(1)}% | 上影线: ${result.upper_shadow_pct.toFixed(1)}%`
    }, MessagePriority.HIGH).catch(err => {
      logger.debug(`[VolumeMonitor] Telegram send failed: ${err.message}`);
    });
  }

  /**
   * 清理过期的完美倒锤头报警记录
   * 建议每5分钟调用一次，清理超过10分钟的记录
   */
  cleanup_perfect_hammer_alerts(): number {
    const now = Date.now();
    const max_age = 10 * 60 * 1000; // 10分钟
    let cleaned = 0;

    for (const [key] of this.perfect_hammer_alerts) {
      const parts = key.split('_');
      const open_time = parseInt(parts[parts.length - 1]);
      if (now - open_time > max_age) {
        this.perfect_hammer_alerts.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[VolumeMonitor] Cleaned ${cleaned} expired perfect hammer alert records`);
    }
    return cleaned;
  }

  /**
   * 清理过期的倒锤头报警记录
   * 建议每5分钟调用一次，清理超过10分钟的记录
   */
  cleanup_hammer_alerts(): number {
    const now = Date.now();
    const max_age = 10 * 60 * 1000; // 10分钟
    let cleaned = 0;

    for (const [key] of this.hammer_alerts) {
      const parts = key.split('_');
      const open_time = parseInt(parts[parts.length - 1]);
      if (now - open_time > max_age) {
        this.hammer_alerts.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[VolumeMonitor] Cleaned ${cleaned} expired hammer alert records`);
    }
    return cleaned;
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

  /**
   * 检测1h十字星形态
   * 条件：
   * 1. 实体占比 <= 10% (实体/振幅)
   * 2. 振幅 >= 0.5% (过滤横盘小K线)
   * 3. 最近100根K线内有过15%以上涨幅
   * 4. 当前价格未跌破起涨点
   *
   * @param kline 聚合后的1h K线数据
   * @returns 如果检测到十字星，返回结果
   */
  check_doji(kline: AggregatedKline): DojiResult | null {
    const symbol = kline.symbol;
    const alert_key = `${symbol}_${kline.open_time}`;

    // 黑名单过滤
    if (this.blacklist.has(symbol)) {
      return null;
    }

    // 更新1h K线缓存
    let cache = this.kline_1h_cache.get(symbol);
    if (!cache) {
      cache = [];
      this.kline_1h_cache.set(symbol, cache);
    }

    // 添加新K线（避免重复）
    if (cache.length === 0 || cache[cache.length - 1].open_time !== kline.open_time) {
      cache.push(kline);
      if (cache.length > this.MAX_1H_CACHE_SIZE) {
        cache.shift();
      }
    } else {
      // 更新最后一根
      cache[cache.length - 1] = kline;
    }

    // 检查是否已经报过警
    if (this.doji_alerts.has(alert_key)) {
      return null;
    }

    // 计算K线振幅
    const total_range = kline.high - kline.low;
    const range_pct = (total_range / kline.low) * 100;

    // 过滤横盘小K线
    if (range_pct < DEFAULT_CONFIG.doji_min_range_pct) {
      return null;
    }

    // 计算实体大小
    const body = Math.abs(kline.close - kline.open);
    const body_pct = total_range > 0 ? (body / total_range) * 100 : 0;

    // 检查十字星条件：实体占比 <= 10%
    if (body_pct > DEFAULT_CONFIG.doji_max_body_pct) {
      return null;
    }

    // 检查涨幅条件：最近100根K线内有过15%以上涨幅，且当前价格未跌破起涨点
    const surge_check = this.check_surge_condition(cache, kline.close);
    if (!surge_check.has_surge) {
      return null;
    }

    // 计算影线比例
    const body_top = Math.max(kline.open, kline.close);
    const body_bottom = Math.min(kline.open, kline.close);
    const upper_shadow = kline.high - body_top;
    const lower_shadow = body_bottom - kline.low;
    const upper_shadow_pct = total_range > 0 ? (upper_shadow / total_range) * 100 : 0;
    const lower_shadow_pct = total_range > 0 ? (lower_shadow / total_range) * 100 : 0;

    // 计算涨跌幅
    const price_change_pct = ((kline.close - kline.open) / kline.open) * 100;

    // 记录已报警
    this.doji_alerts.set(alert_key, true);

    const result: DojiResult = {
      symbol,
      kline_time: kline.open_time,
      interval: kline.interval,
      current_price: kline.close,
      open_price: kline.open,
      high_price: kline.high,
      low_price: kline.low,
      body_pct,
      upper_shadow_pct,
      lower_shadow_pct,
      price_change_pct,
      volume: kline.volume
    };

    // 保存形态报警到数据库
    this.repository.save_pattern_alert({
      symbol,
      kline_time: kline.open_time,
      pattern_type: 'DOJI_1H',
      current_price: kline.close,
      price_change_pct,
      ema120: 0,
      lower_shadow_pct,
      upper_shadow_pct,
      is_final: true
    }).catch(err => {
      logger.debug(`[VolumeMonitor] Doji alert save failed: ${err.message}`);
    });

    // 发送 Telegram 推送
    this.send_doji_telegram_alert(result, surge_check);

    logger.info(`[VolumeMonitor] ✚ Doji 1h: ${symbol} @ ${kline.close.toFixed(4)}, 实体=${body_pct.toFixed(1)}%, 涨幅=${surge_check.max_surge_pct.toFixed(1)}%`);

    return result;
  }

  /**
   * 检查涨幅条件
   * 在最近100根K线内查找是否有过15%以上涨幅，且当前价格未跌破起涨点
   */
  private check_surge_condition(cache: AggregatedKline[], current_price: number): {
    has_surge: boolean;
    max_surge_pct: number;
    surge_start_price: number;
    surge_high_price: number;
  } {
    const lookback = Math.min(cache.length, DEFAULT_CONFIG.doji_lookback_bars);
    const min_surge = DEFAULT_CONFIG.doji_min_surge_pct;

    let max_surge_pct = 0;
    let best_start_price = 0;
    let best_high_price = 0;

    // 从最早的K线开始，寻找起涨点到最高点的涨幅
    for (let i = cache.length - lookback; i < cache.length; i++) {
      if (i < 0) continue;

      const start_price = cache[i].low;  // 起涨点用最低价

      // 从起涨点向后找最高价
      let high_price = start_price;
      for (let j = i; j < cache.length; j++) {
        if (cache[j].high > high_price) {
          high_price = cache[j].high;
        }
      }

      // 计算涨幅
      const surge_pct = ((high_price - start_price) / start_price) * 100;

      // 检查是否满足条件：涨幅>=15% 且 当前价格未跌破起涨点
      if (surge_pct >= min_surge && current_price >= start_price) {
        if (surge_pct > max_surge_pct) {
          max_surge_pct = surge_pct;
          best_start_price = start_price;
          best_high_price = high_price;
        }
      }
    }

    return {
      has_surge: max_surge_pct >= min_surge,
      max_surge_pct,
      surge_start_price: best_start_price,
      surge_high_price: best_high_price
    };
  }

  /**
   * 发送十字星 Telegram 报警
   */
  private send_doji_telegram_alert(result: DojiResult, surge_check: {
    max_surge_pct: number;
    surge_start_price: number;
    surge_high_price: number;
  }): void {
    // 获取当天第几次报警
    const alert_index = this.get_and_increment_daily_alert_count(result.symbol);

    this.telegram.send_alert({
      symbol: result.symbol,
      message: `✚ 1h十字星 (涨幅${surge_check.max_surge_pct.toFixed(0)}%) [今日第${alert_index}次]`,
      price: result.current_price,
      change_pct: result.price_change_pct,
      direction: result.price_change_pct >= 0 ? 'UP' : 'DOWN',
      is_important: true,
      extra_info: `实体: ${result.body_pct.toFixed(1)}% | 起涨: ${surge_check.surge_start_price.toFixed(4)} | 最高: ${surge_check.surge_high_price.toFixed(4)}`
    }, MessagePriority.HIGH).catch(err => {
      logger.debug(`[VolumeMonitor] Telegram send failed: ${err.message}`);
    });
  }

  /**
   * 清理过期的十字星报警记录
   * 建议每小时调用一次，清理超过2小时的记录
   */
  cleanup_doji_alerts(): number {
    const now = Date.now();
    const max_age = 2 * 60 * 60 * 1000; // 2小时
    let cleaned = 0;

    for (const [key] of this.doji_alerts) {
      const parts = key.split('_');
      const open_time = parseInt(parts[parts.length - 1]);
      if (now - open_time > max_age) {
        this.doji_alerts.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[VolumeMonitor] Cleaned ${cleaned} expired doji alert records`);
    }
    return cleaned;
  }
}
