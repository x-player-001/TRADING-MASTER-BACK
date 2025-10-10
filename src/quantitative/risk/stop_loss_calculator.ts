import { StopLossTakeProfitParams, StopLossTakeProfitResult } from '../types/risk_types';
import { TradeSide } from '../types/trading_types';

/**
 * 止损止盈计算器
 * 根据入场价格和风险参数计算止损止盈价格
 */
export class StopLossCalculator {

  /**
   * 计算固定百分比止损止盈
   */
  static calculate_percent_based(params: StopLossTakeProfitParams): StopLossTakeProfitResult {
    const { entry_price, side, stop_loss_percent, take_profit_percent } = params;

    let stop_loss: number;
    let take_profit: number;

    if (side === 'LONG') {
      stop_loss = entry_price * (1 - stop_loss_percent / 100);
      take_profit = entry_price * (1 + take_profit_percent / 100);
    } else {
      stop_loss = entry_price * (1 + stop_loss_percent / 100);
      take_profit = entry_price * (1 - take_profit_percent / 100);
    }

    const risk_amount = Math.abs(entry_price - stop_loss);
    const reward_amount = Math.abs(take_profit - entry_price);
    const risk_reward_ratio = reward_amount / risk_amount;

    return {
      stop_loss,
      take_profit,
      risk_amount,
      reward_amount,
      risk_reward_ratio
    };
  }

  /**
   * 基于ATR(平均真实波幅)的止损止盈
   * @param entry_price 入场价格
   * @param side 交易方向
   * @param atr ATR值
   * @param stop_loss_atr_multiplier 止损ATR倍数 (默认2)
   * @param take_profit_atr_multiplier 止盈ATR倍数 (默认4)
   */
  static calculate_atr_based(
    entry_price: number,
    side: TradeSide,
    atr: number,
    stop_loss_atr_multiplier: number = 2,
    take_profit_atr_multiplier: number = 4
  ): StopLossTakeProfitResult {
    let stop_loss: number;
    let take_profit: number;

    if (side === TradeSide.LONG) {
      stop_loss = entry_price - (atr * stop_loss_atr_multiplier);
      take_profit = entry_price + (atr * take_profit_atr_multiplier);
    } else {
      stop_loss = entry_price + (atr * stop_loss_atr_multiplier);
      take_profit = entry_price - (atr * take_profit_atr_multiplier);
    }

    const risk_amount = Math.abs(entry_price - stop_loss);
    const reward_amount = Math.abs(take_profit - entry_price);
    const risk_reward_ratio = reward_amount / risk_amount;

    return {
      stop_loss,
      take_profit,
      risk_amount,
      reward_amount,
      risk_reward_ratio
    };
  }

  /**
   * 基于支撑阻力位的止损止盈
   * @param entry_price 入场价格
   * @param side 交易方向
   * @param support_level 支撑位
   * @param resistance_level 阻力位
   * @param buffer_percent 缓冲区百分比 (默认0.5%)
   */
  static calculate_support_resistance_based(
    entry_price: number,
    side: TradeSide,
    support_level: number,
    resistance_level: number,
    buffer_percent: number = 0.5
  ): StopLossTakeProfitResult {
    let stop_loss: number;
    let take_profit: number;

    if (side === TradeSide.LONG) {
      // 做多：止损设在支撑位下方
      stop_loss = support_level * (1 - buffer_percent / 100);
      // 止盈设在阻力位下方
      take_profit = resistance_level * (1 - buffer_percent / 100);
    } else {
      // 做空：止损设在阻力位上方
      stop_loss = resistance_level * (1 + buffer_percent / 100);
      // 止盈设在支撑位上方
      take_profit = support_level * (1 + buffer_percent / 100);
    }

    const risk_amount = Math.abs(entry_price - stop_loss);
    const reward_amount = Math.abs(take_profit - entry_price);
    const risk_reward_ratio = reward_amount / risk_amount;

    return {
      stop_loss,
      take_profit,
      risk_amount,
      reward_amount,
      risk_reward_ratio
    };
  }

  /**
   * 追踪止损计算
   * @param entry_price 入场价格
   * @param current_price 当前价格
   * @param side 交易方向
   * @param trailing_percent 追踪百分比
   * @param initial_stop_loss 初始止损价格
   */
  static calculate_trailing_stop(
    entry_price: number,
    current_price: number,
    side: TradeSide,
    trailing_percent: number,
    initial_stop_loss: number
  ): number {
    let trailing_stop: number;

    if (side === TradeSide.LONG) {
      // 做多：止损价格随价格上涨而上移
      trailing_stop = current_price * (1 - trailing_percent / 100);
      // 止损价格只能上移，不能下移
      trailing_stop = Math.max(trailing_stop, initial_stop_loss);
    } else {
      // 做空：止损价格随价格下跌而下移
      trailing_stop = current_price * (1 + trailing_percent / 100);
      // 止损价格只能下移，不能上移
      trailing_stop = Math.min(trailing_stop, initial_stop_loss);
    }

    return trailing_stop;
  }

  /**
   * 验证风险回报比是否合理
   * @param risk_reward_ratio 风险回报比
   * @param min_risk_reward 最小风险回报比要求
   */
  static validate_risk_reward_ratio(
    risk_reward_ratio: number,
    min_risk_reward: number = 1.5
  ): { valid: boolean; reason?: string } {
    if (risk_reward_ratio < min_risk_reward) {
      return {
        valid: false,
        reason: `Risk/reward ratio (${risk_reward_ratio.toFixed(2)}) is below minimum (${min_risk_reward})`
      };
    }

    return { valid: true };
  }

  /**
   * 根据最大风险金额调整止损价格
   * @param entry_price 入场价格
   * @param side 交易方向
   * @param quantity 数量
   * @param max_risk_amount 最大风险金额
   */
  static adjust_stop_loss_by_risk(
    entry_price: number,
    side: TradeSide,
    quantity: number,
    max_risk_amount: number
  ): number {
    // 计算每单位价格差
    const max_price_diff = max_risk_amount / quantity;

    let stop_loss: number;

    if (side === TradeSide.LONG) {
      stop_loss = entry_price - max_price_diff;
    } else {
      stop_loss = entry_price + max_price_diff;
    }

    return stop_loss;
  }
}
