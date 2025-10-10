import { EventEmitter } from 'events';
import { AdvancedSignalGenerator } from './advanced_signal_generator'; // 高级信号生成器
import { SignalRepository } from '@/database/signal_repository';
import { StructureRepository } from '@/database/structure_repository';
import { KlineMultiTableRepository } from '@/database/kline_multi_table_repository';
import { MultiSymbolManager } from '@/core/data/multi_symbol_manager';
import { RangeDetector } from '@/analysis/range_detector';
import { BreakoutAnalyzer } from '@/analysis/breakout_analyzer';
import { StructureConfigManager } from '@/core/config/structure_config';
import { logger } from '@/utils/logger';
import { TradingSignal } from '@/types/signal';
import { RangeBox, BreakoutSignal } from '@/types/structure';

/**
 * 信号管理器
 * 负责监听K线完成事件，自动生成和保存交易信号
 */
export class SignalManager extends EventEmitter {
  private static instance: SignalManager;
  private signal_repository: SignalRepository;
  private structure_repository: StructureRepository;
  private kline_repository: KlineMultiTableRepository;
  private multi_symbol_manager: MultiSymbolManager;
  private structure_config: StructureConfigManager;
  private is_initialized: boolean = false;

  // 监控的时间周期（只为这些周期生成信号）
  private monitored_intervals: string[] = ['5m','15m', '1h', '4h'];

  // 结构检测计数器 (每N根K线检测一次，避免过度计算)
  private range_detection_counters: Map<string, number> = new Map();

  // 已识别的区间缓存 (symbol:interval => RangeBox[])
  private detected_ranges_cache: Map<string, { ranges: RangeBox[]; last_update: number }> = new Map();

  private constructor() {
    super();
    this.signal_repository = new SignalRepository();
    this.structure_repository = new StructureRepository();
    this.kline_repository = new KlineMultiTableRepository();
    this.multi_symbol_manager = MultiSymbolManager.getInstance();
    this.structure_config = StructureConfigManager.getInstance();
  }

  /**
   * 获取单例实例
   */
  static getInstance(): SignalManager {
    if (!SignalManager.instance) {
      SignalManager.instance = new SignalManager();
    }
    return SignalManager.instance;
  }

  /**
   * 初始化信号管理器
   */
  async initialize(): Promise<void> {
    if (this.is_initialized) {
      logger.warn('SignalManager already initialized');
      return;
    }

    try {
      // 监听K线完成事件
      this.multi_symbol_manager.on('kline_completed', this.handle_kline_completed.bind(this));

      this.is_initialized = true;
      logger.info('SignalManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize SignalManager', error);
      throw error;
    }
  }

  /**
   * 获取或更新区间检测计数器
   */
  private increment_detection_counter(symbol: string, interval: string): number {
    const key = `${symbol}:${interval}`;
    const current = this.range_detection_counters.get(key) || 0;
    const next = current + 1;
    this.range_detection_counters.set(key, next);
    return next;
  }

  /**
   * 获取缓存的区间 (如果未过期)
   */
  private get_cached_ranges(symbol: string, interval: string): RangeBox[] | null {
    const key = `${symbol}:${interval}`;
    const cached = this.detected_ranges_cache.get(key);

    if (!cached) return null;

    const now = Date.now();
    const cache_ttl = this.structure_config.get_cache_ttl();
    if (now - cached.last_update > cache_ttl) {
      // 缓存过期，删除
      this.detected_ranges_cache.delete(key);
      return null;
    }

    return cached.ranges;
  }

  /**
   * 更新区间缓存
   */
  private update_ranges_cache(symbol: string, interval: string, ranges: RangeBox[]): void {
    const key = `${symbol}:${interval}`;
    this.detected_ranges_cache.set(key, {
      ranges,
      last_update: Date.now()
    });
  }

  /**
   * 检测交易区间 (每N根K线执行一次)
   */
  private async detect_and_cache_ranges(symbol: string, interval: string, klines: any[]): Promise<RangeBox[]> {
    try {
      // 使用配置中的lookback值
      const lookback = this.structure_config.get_config().range_detection.lookback;

      // 创建RangeDetector实例并检测
      const range_detector = new RangeDetector();
      const ranges = range_detector.detect_ranges(klines, lookback);

      if (ranges.length > 0) {
        // 去重：检查是否存在相似的区间 (支撑阻力位相差<1%)
        const unique_ranges = await this.deduplicate_ranges(symbol, interval, ranges);

        if (unique_ranges.length > 0) {
          // 保存到数据库
          for (const range of unique_ranges) {
            await this.structure_repository.save_range(range);
          }

          logger.info(`[SignalManager] ${symbol}:${interval} - 保存区间`, {
            detected: ranges.length,
            unique: unique_ranges.length,
            saved: unique_ranges.length,
            duplicates_filtered: ranges.length - unique_ranges.length
          });
        } else {
          logger.debug(`[SignalManager] ${symbol}:${interval} - 所有检测到的区间已存在，跳过保存`);
        }

        // 更新缓存 (使用去重后的结果)
        this.update_ranges_cache(symbol, interval, unique_ranges);

        return unique_ranges;
      }

      return ranges;
    } catch (error) {
      logger.error(`[SignalManager] Range detection error:`, error);
      return [];
    }
  }

  /**
   * 去重区间：检查数据库中是否已存在相似区间
   * 判断条件：价格相似 + 时间重叠
   */
  private async deduplicate_ranges(symbol: string, interval: string, new_ranges: RangeBox[]): Promise<RangeBox[]> {
    try {
      // 获取最近的forming区间（未突破的）
      const existing_ranges = await this.structure_repository.get_forming_ranges(symbol, interval, 10);

      const unique_ranges: RangeBox[] = [];

      for (const new_range of new_ranges) {
        let is_duplicate = false;

        for (const existing of existing_ranges) {
          // 1. 判断支撑阻力位是否相似（允许1%误差）
          const support_diff = Math.abs(new_range.support - existing.support) / existing.support;
          const resistance_diff = Math.abs(new_range.resistance - existing.resistance) / existing.resistance;

          const price_similar = support_diff < 0.01 && resistance_diff < 0.01;

          if (price_similar) {
            // 2. 判断时间区间是否重叠
            const new_start = new_range.start_time;
            const new_end = new_range.end_time;
            const existing_start = existing.start_time;
            const existing_end = existing.end_time;

            // 时间重叠判断：新区间的开始时间在已有区间内，或结束时间在已有区间内
            const time_overlap =
              (new_start >= existing_start && new_start <= existing_end) ||
              (new_end >= existing_start && new_end <= existing_end) ||
              (new_start <= existing_start && new_end >= existing_end);

            if (time_overlap) {
              is_duplicate = true;
              logger.debug(`[SignalManager] Skipping duplicate range: ${new_range.support.toFixed(2)}-${new_range.resistance.toFixed(2)} (time overlap)`);
              break;
            } else {
              // 价格相似但时间不重叠 - 这是同一位置的新区间，应该保存
              logger.debug(`[SignalManager] Same price level but different time period, will save as new range`);
            }
          }
        }

        if (!is_duplicate) {
          unique_ranges.push(new_range);
        }
      }

      return unique_ranges;
    } catch (error) {
      logger.error('[SignalManager] Error deduplicating ranges:', error);
      return new_ranges; // 出错时返回所有区间
    }
  }

  /**
   * 检测突破信号 (轻量级，每根K线执行)
   */
  private async detect_breakout_signals(
    symbol: string,
    interval: string,
    ranges: RangeBox[],
    klines: any[]
  ): Promise<void> {
    if (ranges.length === 0 || klines.length < 3) return;

    try {
      const current_kline = klines[klines.length - 1];
      const recent_klines = klines.slice(-5); // 最近5根K线用于确认

      for (const range of ranges) {
        // 创建RangeDetector实例并检测突破
        const range_detector = new RangeDetector();
        const breakout_direction = range_detector.detect_breakout(range, current_kline, recent_klines);

        if (breakout_direction) {
          // 分析突破信号质量
          const signal = await BreakoutAnalyzer.analyze_breakout(range, recent_klines, breakout_direction);

          if (signal && BreakoutAnalyzer.is_tradeable(signal, range)) {
            // 保存突破信号到数据库
            await this.structure_repository.save_breakout_signal(signal);

            const emoji = breakout_direction === 'up' ? '🚀' : '📉';
            logger.info(`[SignalManager] ${emoji} Breakout ${breakout_direction.toUpperCase()} detected: ${symbol} ${interval}`, {
              price: signal.breakout_price,
              target: signal.target_price,
              stop: signal.stop_loss,
              risk_reward: signal.risk_reward_ratio
            });

            // 发出事件通知
            this.emit('breakout_signal', signal);
          }
        }
      }
    } catch (error) {
      logger.error(`[SignalManager] Breakout detection error:`, error);
    }
  }

  /**
   * 处理K线完成事件
   */
  private async handle_kline_completed(data: { symbol: string; interval: string; kline: any }): Promise<void> {
    try {
      const { symbol, interval } = data;

      // 只为监控的时间周期生成信号
      if (!this.monitored_intervals.includes(interval)) {
        return;
      }

      logger.info(`Generating signal for ${symbol}:${interval}`);

      // 获取足够的K线数据用于技术分析和结构检测
      // 结构检测需要500根，信号生成需要250根（MA200）
      const klines = await this.kline_repository.find_latest(symbol, interval, 500);

      if (klines.length < 250) {
        logger.warn(`Insufficient klines for ${symbol}:${interval}, got ${klines.length}, need at least 250`);
        return;
      }

      // ========== 结构性形态检测 (智能节流) ==========

      if (this.structure_config.is_enabled()) {
        // 1. 增加计数器
        const counter = this.increment_detection_counter(symbol, interval);

        // 2. 获取缓存的区间
        let cached_ranges = this.get_cached_ranges(symbol, interval);

        // 3. 每N根K线重新扫描区间 (或缓存为空时)
        const detection_interval = this.structure_config.get_detection_interval();
        if (counter % detection_interval === 0 || !cached_ranges) {
          logger.info(`[SignalManager] ${symbol}:${interval} - 触发区间扫描 (第${counter}根K线)`);
          cached_ranges = await this.detect_and_cache_ranges(symbol, interval, klines);
        } else {
          logger.debug(`[SignalManager] ${symbol}:${interval} - 使用缓存区间 (${cached_ranges?.length || 0}个)`);
        }

        // 4. 轻量级突破检测 (每根K线执行)
        if (cached_ranges && cached_ranges.length > 0) {
          await this.detect_breakout_signals(symbol, interval, cached_ranges, klines);
        }
      }

      // ========== 传统信号生成 (高级多指标) ==========

      // 使用高级信号生成器 (提升准确度)
      // 注: 单K线形态(锤子线/吞没等)只用于信号分析，不单独存储
      const signal = await AdvancedSignalGenerator.generate_signal(symbol, interval, klines);

      if (!signal) {
        logger.debug(`No signal generated for ${symbol}:${interval} (strength too weak or neutral)`);
        return;
      }

      // 保存信号
      const signal_id = await this.signal_repository.save_signal(signal);
      logger.info(`Signal generated and saved: ${symbol} ${signal.signal_type} @ ${signal.price}, strength: ${signal.strength}, id: ${signal_id}`);

      // 发出信号事件，供WebSocket推送使用
      this.emit('signal_generated', { ...signal, id: signal_id });

    } catch (error) {
      logger.error(`Failed to handle kline completed for ${data.symbol}:${data.interval}`, error);
    }
  }

  /**
   * 设置监控的时间周期
   */
  set_monitored_intervals(intervals: string[]): void {
    this.monitored_intervals = intervals;
    logger.info(`Monitored intervals updated: ${intervals.join(', ')}`);
  }

  /**
   * 获取监控的时间周期
   */
  get_monitored_intervals(): string[] {
    return this.monitored_intervals;
  }

  /**
   * 手动触发信号生成（用于测试）
   */
  async generate_signal_manually(symbol: string, interval: string): Promise<TradingSignal | null> {
    try {
      const klines = await this.kline_repository.find_latest(symbol, interval, 500);

      if (klines.length < 250) {
        logger.warn(`Insufficient klines for ${symbol}:${interval}, need at least 250`);
        return null;
      }

      // 使用高级信号生成器
      const signal = await AdvancedSignalGenerator.generate_signal(symbol, interval, klines);

      if (signal) {
        const signal_id = await this.signal_repository.save_signal(signal);
        logger.info(`Manual signal generated: ${symbol} ${signal.signal_type} @ ${signal.price}`);
        this.emit('signal_generated', { ...signal, id: signal_id });
        return { ...signal, id: signal_id };
      }

      return null;
    } catch (error) {
      logger.error(`Failed to generate signal manually for ${symbol}:${interval}`, error);
      return null;
    }
  }
}
