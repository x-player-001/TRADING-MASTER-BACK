/**
 * 风险管理器
 * 负责仓位管理、止损止盈、熔断机制
 */

import {
  TradingSignal,
  SignalStrength,
  RiskConfig,
  PositionRecord,
  OrderRecord
} from '../types/trading_types';
import { logger } from '../utils/logger';

export class RiskManager {
  private config: RiskConfig;
  private daily_pnl: number = 0;
  private daily_pnl_reset_time: Date;
  private consecutive_losses: number = 0;
  private is_paused: boolean = false;

  constructor(config?: Partial<RiskConfig>) {
    // 默认风险配置
    this.config = {
      max_position_size_percent: 3,
      max_total_positions: 5,
      max_positions_per_symbol: 1,
      default_stop_loss_percent: 2,
      default_take_profit_percent: 5,
      use_trailing_stop: true,
      trailing_stop_callback_rate: 1,
      daily_loss_limit_percent: 5,
      consecutive_loss_limit: 3,
      pause_after_loss_limit: true,
      max_leverage: 3,
      leverage_by_signal_strength: {
        weak: 1,
        medium: 2,
        strong: 3
      },
      ...config
    };

    this.daily_pnl_reset_time = this.get_next_reset_time();
  }

  /**
   * 检查是否可以开仓
   * @param signal 交易信号
   * @param current_positions 当前持仓列表
   * @param account_balance 账户余额
   * @returns 是否允许开仓及原因
   */
  can_open_position(
    signal: TradingSignal,
    current_positions: PositionRecord[],
    account_balance: number
  ): {
    allowed: boolean;
    reason?: string;
    position_size?: number;
    leverage?: number;
  } {
    // 1. 检查是否暂停交易
    if (this.is_paused) {
      return {
        allowed: false,
        reason: 'Trading paused due to risk limits'
      };
    }

    // 2. 检查每日亏损限制
    const daily_check = this.check_daily_loss_limit(account_balance);
    if (!daily_check.allowed) {
      return daily_check;
    }

    // 3. 检查连续亏损限制
    const consecutive_check = this.check_consecutive_losses();
    if (!consecutive_check.allowed) {
      return consecutive_check;
    }

    // 4. 检查总持仓数量
    const open_positions = current_positions.filter(p => p.is_open);
    if (open_positions.length >= this.config.max_total_positions) {
      return {
        allowed: false,
        reason: `Maximum total positions (${this.config.max_total_positions}) reached`
      };
    }

    // 5. 检查单币种持仓数量
    const symbol_positions = open_positions.filter(p => p.symbol === signal.symbol);
    if (symbol_positions.length >= this.config.max_positions_per_symbol) {
      return {
        allowed: false,
        reason: `Maximum positions for ${signal.symbol} (${this.config.max_positions_per_symbol}) reached`
      };
    }

    // 6. 计算仓位大小
    const position_size = this.calculate_position_size(signal, account_balance);

    // 7. 确定杠杆倍数
    const leverage = this.determine_leverage(signal);

    logger.info(`[RiskManager] Position check passed for ${signal.symbol}: size=${position_size.toFixed(2)}, leverage=${leverage}x`);

    return {
      allowed: true,
      position_size,
      leverage
    };
  }

  /**
   * 检查每日亏损限制
   */
  private check_daily_loss_limit(account_balance: number): {
    allowed: boolean;
    reason?: string;
  } {
    // 重置每日PnL（如果到了新的一天）
    if (new Date() >= this.daily_pnl_reset_time) {
      this.daily_pnl = 0;
      this.daily_pnl_reset_time = this.get_next_reset_time();
      logger.info('[RiskManager] Daily PnL reset');
    }

    const daily_loss_limit = account_balance * (this.config.daily_loss_limit_percent / 100);

    if (this.daily_pnl < -daily_loss_limit) {
      if (this.config.pause_after_loss_limit) {
        this.pause_trading();
      }

      return {
        allowed: false,
        reason: `Daily loss limit reached (${this.daily_pnl.toFixed(2)} / -${daily_loss_limit.toFixed(2)})`
      };
    }

    return { allowed: true };
  }

  /**
   * 检查连续亏损限制
   */
  private check_consecutive_losses(): {
    allowed: boolean;
    reason?: string;
  } {
    if (this.consecutive_losses >= this.config.consecutive_loss_limit) {
      if (this.config.pause_after_loss_limit) {
        this.pause_trading();
      }

      return {
        allowed: false,
        reason: `Consecutive loss limit reached (${this.consecutive_losses})`
      };
    }

    return { allowed: true };
  }

  /**
   * 计算仓位大小
   */
  private calculate_position_size(signal: TradingSignal, account_balance: number): number {
    // 基础仓位：根据账户余额和最大仓位百分比
    let position_percent = this.config.max_position_size_percent;

    // 根据信号强度调整仓位
    if (signal.strength === SignalStrength.STRONG) {
      position_percent = this.config.max_position_size_percent;
    } else if (signal.strength === SignalStrength.MEDIUM) {
      position_percent = this.config.max_position_size_percent * 0.7;
    } else {
      position_percent = this.config.max_position_size_percent * 0.5;
    }

    // 根据置信度进一步调整
    position_percent *= signal.confidence;

    // 计算实际金额
    const position_size = account_balance * (position_percent / 100);

    return position_size;
  }

  /**
   * 确定杠杆倍数
   */
  private determine_leverage(signal: TradingSignal): number {
    let leverage: number;

    switch (signal.strength) {
      case SignalStrength.STRONG:
        leverage = this.config.leverage_by_signal_strength.strong;
        break;
      case SignalStrength.MEDIUM:
        leverage = this.config.leverage_by_signal_strength.medium;
        break;
      case SignalStrength.WEAK:
        leverage = this.config.leverage_by_signal_strength.weak;
        break;
      default:
        leverage = 1;
    }

    // 不超过最大杠杆
    return Math.min(leverage, this.config.max_leverage);
  }

  /**
   * 计算止损止盈价格
   * 强制使用配置值，忽略信号的建议价格
   */
  calculate_stop_loss_take_profit(signal: TradingSignal): {
    stop_loss: number;
    take_profit: number;
  } {
    // 强制使用配置计算，不使用信号的建议价格
    const entry_price = signal.entry_price || 0;
    if (entry_price === 0) {
      return { stop_loss: 0, take_profit: 0 };
    }

    const stop_loss_percent = this.config.default_stop_loss_percent / 100;
    const take_profit_percent = this.config.default_take_profit_percent / 100;

    let stop_loss: number;
    let take_profit: number;

    if (signal.direction === 'LONG') {
      stop_loss = entry_price * (1 - stop_loss_percent);
      take_profit = entry_price * (1 + take_profit_percent);
    } else {
      stop_loss = entry_price * (1 + stop_loss_percent);
      take_profit = entry_price * (1 - take_profit_percent);
    }

    return { stop_loss, take_profit };
  }

  /**
   * 更新持仓的移动止损
   */
  update_trailing_stop(position: PositionRecord, current_price: number): number | null {
    if (!this.config.use_trailing_stop || !position.stop_loss_price) {
      return null;
    }

    const callback_rate = this.config.trailing_stop_callback_rate / 100;
    let new_stop_loss: number | null = null;

    if (position.side === 'LONG') {
      // 多头：价格上涨时提升止损
      const price_from_entry = (current_price - position.entry_price) / position.entry_price;

      if (price_from_entry > 0.01) { // 至少盈利1%才启动移动止损
        const trailing_stop = current_price * (1 - callback_rate);

        if (trailing_stop > position.stop_loss_price) {
          new_stop_loss = trailing_stop;
        }
      }
    } else {
      // 空头：价格下跌时降低止损
      const price_from_entry = (position.entry_price - current_price) / position.entry_price;

      if (price_from_entry > 0.01) {
        const trailing_stop = current_price * (1 + callback_rate);

        if (trailing_stop < position.stop_loss_price) {
          new_stop_loss = trailing_stop;
        }
      }
    }

    if (new_stop_loss) {
      logger.info(`[RiskManager] Trailing stop updated for ${position.symbol}: ${position.stop_loss_price.toFixed(2)} -> ${new_stop_loss.toFixed(2)}`);
    }

    return new_stop_loss;
  }

  /**
   * 记录交易结果，更新风险状态
   */
  record_trade_result(pnl: number, is_win: boolean): void {
    // 更新每日PnL
    this.daily_pnl += pnl;

    // 更新连续亏损计数
    if (is_win) {
      this.consecutive_losses = 0;
    } else {
      this.consecutive_losses++;
    }

    logger.info(`[RiskManager] Trade result: PnL=${pnl.toFixed(2)}, Daily PnL=${this.daily_pnl.toFixed(2)}, Consecutive losses=${this.consecutive_losses}`);
  }

  /**
   * 暂停交易
   */
  pause_trading(): void {
    this.is_paused = true;
    logger.warn('[RiskManager] Trading paused due to risk limits');
  }

  /**
   * 恢复交易
   */
  resume_trading(): void {
    this.is_paused = false;
    this.consecutive_losses = 0;
    logger.info('[RiskManager] Trading resumed');
  }

  /**
   * 重置每日统计
   */
  reset_daily_stats(): void {
    this.daily_pnl = 0;
    this.daily_pnl_reset_time = this.get_next_reset_time();
    logger.info('[RiskManager] Daily stats reset');
  }

  /**
   * 获取下一次重置时间（UTC 0点）
   */
  private get_next_reset_time(): Date {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow;
  }

  /**
   * 获取当前风险状态
   */
  get_risk_status(): {
    is_paused: boolean;
    daily_pnl: number;
    consecutive_losses: number;
    next_reset_time: Date;
  } {
    return {
      is_paused: this.is_paused,
      daily_pnl: this.daily_pnl,
      consecutive_losses: this.consecutive_losses,
      next_reset_time: this.daily_pnl_reset_time
    };
  }

  /**
   * 更新风险配置
   */
  update_config(new_config: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...new_config };
    logger.info('[RiskManager] Config updated');
  }

  /**
   * 获取当前配置
   */
  get_config(): RiskConfig {
    return { ...this.config };
  }
}
