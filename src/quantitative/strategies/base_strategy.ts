import { EntrySignal, ExitSignal, TradeSide } from '../types/trading_types';
import { StrategyConfig } from '../types/strategy_types';
import { logger } from '@/utils/logger';

/**
 * 策略抽象基类
 * 所有量化策略必须继承此类
 */
export abstract class BaseStrategy {
  protected config: StrategyConfig;
  protected name: string;
  protected description: string;

  constructor(config: StrategyConfig) {
    this.config = config;
    this.name = config.name;
    this.description = config.description || '';
  }

  /**
   * 获取策略配置
   */
  get_config(): StrategyConfig {
    return this.config;
  }

  /**
   * 更新策略参数
   */
  update_parameters(parameters: Record<string, any>): void {
    this.config.parameters = { ...this.config.parameters, ...parameters };
  }

  /**
   * 分析入场信号
   * @param symbol 币种
   * @param interval 时间周期
   * @param klines K线数据 (按时间升序)
   * @param current_positions 当前持仓
   * @returns 入场信号或null
   */
  abstract analyze_entry(
    symbol: string,
    interval: string,
    klines: any[],
    current_positions: any[]
  ): Promise<EntrySignal | null>;

  /**
   * 分析出场信号
   * @param position 当前持仓
   * @param current_kline 当前K线
   * @returns 出场信号或null
   */
  abstract analyze_exit(
    position: any,
    current_kline: any
  ): Promise<ExitSignal | null>;

  /**
   * 计算指标
   * 子类可以重写此方法以添加自定义指标计算
   */
  protected calculate_indicators(klines: any[]): Record<string, any> {
    return {};
  }

  /**
   * 验证K线数据是否足够
   */
  protected validate_klines(klines: any[], min_count: number): boolean {
    if (klines.length < min_count) {
      logger.warn(`Insufficient klines: got ${klines.length}, need at least ${min_count}`);
      return false;
    }
    return true;
  }

  /**
   * 获取最新价格
   */
  protected get_latest_price(klines: any[]): number {
    if (klines.length === 0) {
      throw new Error('No klines available');
    }
    return parseFloat(klines[klines.length - 1].close);
  }

  /**
   * 获取最新K线
   */
  protected get_latest_kline(klines: any[]): any {
    if (klines.length === 0) {
      throw new Error('No klines available');
    }
    return klines[klines.length - 1];
  }

  /**
   * 计算简单移动平均线 (SMA)
   */
  protected calculate_sma(values: number[], period: number): number | null {
    if (values.length < period) {
      return null;
    }

    const slice = values.slice(-period);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / period;
  }

  /**
   * 计算指数移动平均线 (EMA)
   */
  protected calculate_ema(values: number[], period: number): number | null {
    if (values.length < period) {
      return null;
    }

    const multiplier = 2 / (period + 1);
    let ema = values[0];

    for (let i = 1; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * 计算RSI
   */
  protected calculate_rsi(prices: number[], period: number = 14): number | null {
    if (prices.length < period + 1) {
      return null;
    }

    let gains = 0;
    let losses = 0;

    // 计算价格变化
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avg_gain = gains / period;
    const avg_loss = losses / period;

    if (avg_loss === 0) {
      return 100;
    }

    const rs = avg_gain / avg_loss;
    const rsi = 100 - (100 / (1 + rs));

    return rsi;
  }

  /**
   * 检查是否发生均线交叉
   * @returns 'golden' (金叉), 'death' (死叉), null (无交叉)
   */
  protected check_ma_cross(
    fast_ma_prev: number,
    fast_ma_curr: number,
    slow_ma_prev: number,
    slow_ma_curr: number
  ): 'golden' | 'death' | null {
    // 金叉：快线从下方上穿慢线
    if (fast_ma_prev < slow_ma_prev && fast_ma_curr > slow_ma_curr) {
      return 'golden';
    }

    // 死叉：快线从上方下穿慢线
    if (fast_ma_prev > slow_ma_prev && fast_ma_curr < slow_ma_curr) {
      return 'death';
    }

    return null;
  }

  /**
   * 判断趋势方向
   * @returns 'up' (上升), 'down' (下降), 'sideways' (震荡)
   */
  protected identify_trend(prices: number[], ma_period: number = 20): 'up' | 'down' | 'sideways' {
    if (prices.length < ma_period + 5) {
      return 'sideways';
    }

    const current_price = prices[prices.length - 1];
    const ma = this.calculate_sma(prices, ma_period);

    if (!ma) {
      return 'sideways';
    }

    const diff_percent = ((current_price - ma) / ma) * 100;

    if (diff_percent > 2) {
      return 'up';
    } else if (diff_percent < -2) {
      return 'down';
    } else {
      return 'sideways';
    }
  }

  /**
   * 计算平均真实波幅 (ATR)
   */
  protected calculate_atr(klines: any[], period: number = 14): number | null {
    if (klines.length < period + 1) {
      return null;
    }

    const true_ranges: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i].high);
      const low = parseFloat(klines[i].low);
      const prev_close = parseFloat(klines[i - 1].close);

      const tr = Math.max(
        high - low,
        Math.abs(high - prev_close),
        Math.abs(low - prev_close)
      );

      true_ranges.push(tr);
    }

    const atr = this.calculate_sma(true_ranges, period);
    return atr;
  }

  /**
   * 记录日志
   */
  protected log(message: string, data?: any): void {
    logger.info(`[${this.name}] ${message}`, data);
  }

  /**
   * 记录调试日志
   */
  protected debug(message: string, data?: any): void {
    logger.debug(`[${this.name}] ${message}`, data);
  }
}
