import { PositionSizeResult } from '../types/risk_types';
import { TradeSide } from '../types/trading_types';
import { logger } from '@/utils/logger';

/**
 * 仓位计算器
 * 根据资金和风险参数计算开仓数量
 */
export class PositionSizer {

  /**
   * 固定比例仓位计算
   * @param total_capital 总资金
   * @param position_percent 仓位占比%
   * @param entry_price 入场价格
   * @param stop_loss_percent 止损百分比%
   * @param take_profit_percent 止盈百分比%
   * @param side 交易方向
   */
  static calculate_fixed_percent(
    total_capital: number,
    position_percent: number,
    entry_price: number,
    stop_loss_percent: number,
    take_profit_percent: number,
    side: TradeSide
  ): PositionSizeResult {
    // 计算仓位价值
    const position_value = total_capital * (position_percent / 100);

    // 计算数量
    const quantity = position_value / entry_price;

    // 计算止损止盈价格
    let stop_loss_price: number;
    let take_profit_price: number;

    if (side === TradeSide.LONG) {
      stop_loss_price = entry_price * (1 - stop_loss_percent / 100);
      take_profit_price = entry_price * (1 + take_profit_percent / 100);
    } else {
      stop_loss_price = entry_price * (1 + stop_loss_percent / 100);
      take_profit_price = entry_price * (1 - take_profit_percent / 100);
    }

    // 计算风险金额
    const risk_amount = Math.abs(entry_price - stop_loss_price) * quantity;

    return {
      quantity,
      position_value,
      position_percent,
      risk_amount,
      stop_loss_price,
      take_profit_price
    };
  }

  /**
   * 固定风险金额仓位计算
   * @param total_capital 总资金
   * @param risk_amount 愿意承受的风险金额
   * @param entry_price 入场价格
   * @param stop_loss_percent 止损百分比%
   * @param take_profit_percent 止盈百分比%
   * @param side 交易方向
   */
  static calculate_fixed_risk(
    total_capital: number,
    risk_amount: number,
    entry_price: number,
    stop_loss_percent: number,
    take_profit_percent: number,
    side: TradeSide
  ): PositionSizeResult {
    // 计算止损价格
    let stop_loss_price: number;
    let take_profit_price: number;

    if (side === TradeSide.LONG) {
      stop_loss_price = entry_price * (1 - stop_loss_percent / 100);
      take_profit_price = entry_price * (1 + take_profit_percent / 100);
    } else {
      stop_loss_price = entry_price * (1 + stop_loss_percent / 100);
      take_profit_price = entry_price * (1 - take_profit_percent / 100);
    }

    // 根据风险金额计算数量
    const price_diff = Math.abs(entry_price - stop_loss_price);
    const quantity = risk_amount / price_diff;

    // 计算仓位价值
    const position_value = entry_price * quantity;

    // 计算仓位占比
    const position_percent = (position_value / total_capital) * 100;

    return {
      quantity,
      position_value,
      position_percent,
      risk_amount,
      stop_loss_price,
      take_profit_price
    };
  }

  /**
   * Kelly公式仓位计算
   * @param total_capital 总资金
   * @param win_rate 胜率 (0-1)
   * @param avg_win 平均盈利
   * @param avg_loss 平均亏损
   * @param entry_price 入场价格
   * @param stop_loss_percent 止损百分比%
   * @param take_profit_percent 止盈百分比%
   * @param side 交易方向
   * @param max_kelly_fraction Kelly比例上限 (默认0.25，即Kelly值的25%)
   */
  static calculate_kelly(
    total_capital: number,
    win_rate: number,
    avg_win: number,
    avg_loss: number,
    entry_price: number,
    stop_loss_percent: number,
    take_profit_percent: number,
    side: TradeSide,
    max_kelly_fraction: number = 0.25
  ): PositionSizeResult {
    // Kelly公式: f* = (bp - q) / b
    // 其中:
    // f* = 最优仓位比例
    // b = 赔率 (avg_win / avg_loss)
    // p = 胜率
    // q = 败率 (1 - p)

    const loss_rate = 1 - win_rate;
    const odds = avg_win / avg_loss;

    // 计算Kelly值
    let kelly_percent = ((odds * win_rate) - loss_rate) / odds;

    // Kelly值限制
    if (kelly_percent < 0) {
      kelly_percent = 0; // 负Kelly值表示不应该交易
    }

    // 应用Kelly比例上限（保守策略）
    kelly_percent = Math.min(kelly_percent, max_kelly_fraction);

    // 使用Kelly值计算仓位
    const position_percent = kelly_percent * 100;

    return this.calculate_fixed_percent(
      total_capital,
      position_percent,
      entry_price,
      stop_loss_percent,
      take_profit_percent,
      side
    );
  }

  /**
   * 验证仓位大小是否符合风控要求
   */
  static validate_position_size(
    result: PositionSizeResult,
    max_position_size_percent: number,
    max_risk_percent: number,
    total_capital: number
  ): { valid: boolean; reason?: string } {
    // 检查仓位占比
    if (result.position_percent > max_position_size_percent) {
      return {
        valid: false,
        reason: `Position size (${result.position_percent.toFixed(2)}%) exceeds max allowed (${max_position_size_percent}%)`
      };
    }

    // 检查风险占比
    const risk_percent = (result.risk_amount / total_capital) * 100;
    if (risk_percent > max_risk_percent) {
      return {
        valid: false,
        reason: `Risk (${risk_percent.toFixed(2)}%) exceeds max allowed (${max_risk_percent}%)`
      };
    }

    return { valid: true };
  }

  /**
   * 记录仓位计算日志
   */
  static log_position_size(symbol: string, result: PositionSizeResult): void {
    logger.info(`[PositionSizer] Calculated position size for ${symbol}`, {
      quantity: result.quantity.toFixed(4),
      position_value: result.position_value.toFixed(2),
      position_percent: `${result.position_percent.toFixed(2)}%`,
      risk_amount: result.risk_amount.toFixed(2),
      stop_loss: result.stop_loss_price.toFixed(4),
      take_profit: result.take_profit_price.toFixed(4)
    });
  }
}
