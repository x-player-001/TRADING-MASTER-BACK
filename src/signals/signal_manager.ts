import { EventEmitter } from 'events';
import { SignalGenerator } from './signal_generator';
import { SignalRepository } from '@/database/signal_repository';
import { KlineMultiTableRepository } from '@/database/kline_multi_table_repository';
import { MultiSymbolManager } from '@/core/data/multi_symbol_manager';
import { logger } from '@/utils/logger';
import { TradingSignal } from '@/types/signal';

/**
 * 信号管理器
 * 负责监听K线完成事件，自动生成和保存交易信号
 */
export class SignalManager extends EventEmitter {
  private static instance: SignalManager;
  private signal_repository: SignalRepository;
  private kline_repository: KlineMultiTableRepository;
  private multi_symbol_manager: MultiSymbolManager;
  private is_initialized: boolean = false;

  // 监控的时间周期（只为这些周期生成信号）
  private monitored_intervals: string[] = ['15m', '1h', '4h'];

  private constructor() {
    super();
    this.signal_repository = new SignalRepository();
    this.kline_repository = new KlineMultiTableRepository();
    this.multi_symbol_manager = MultiSymbolManager.getInstance();
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

      // 获取足够的K线数据用于技术分析
      const klines = await this.kline_repository.find_latest(symbol, interval, 100);

      if (klines.length < 60) {
        logger.warn(`Insufficient klines for ${symbol}:${interval}, got ${klines.length}, need at least 60`);
        return;
      }

      // 生成信号
      const signal = await SignalGenerator.generate_signal(symbol, interval, klines);

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
      const klines = await this.kline_repository.find_latest(symbol, interval, 100);

      if (klines.length < 60) {
        logger.warn(`Insufficient klines for ${symbol}:${interval}`);
        return null;
      }

      const signal = await SignalGenerator.generate_signal(symbol, interval, klines);

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
