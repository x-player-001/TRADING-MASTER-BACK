import { Trade, TradeSide, ExitReason, Position, PositionStatus } from '../types/trading_types';
import { logger } from '@/utils/logger';

/**
 * 交易模拟器
 * 负责模拟交易执行、计算盈亏、更新资金
 */
export class TradeSimulator {
  private current_equity: number;
  private initial_capital: number;
  private open_positions: Map<string, Position>;
  private closed_trades: Trade[];
  private commission_rate: number;

  constructor(initial_capital: number, commission_rate: number = 0.001) {
    this.initial_capital = initial_capital;
    this.current_equity = initial_capital;
    this.open_positions = new Map();
    this.closed_trades = [];
    this.commission_rate = commission_rate;
  }

  /**
   * 获取当前权益
   */
  get_current_equity(): number {
    return this.current_equity;
  }

  /**
   * 获取初始资金
   */
  get_initial_capital(): number {
    return this.initial_capital;
  }

  /**
   * 获取开仓持仓
   */
  get_open_positions(): Position[] {
    return Array.from(this.open_positions.values());
  }

  /**
   * 获取已平仓交易
   */
  get_closed_trades(): Trade[] {
    return this.closed_trades;
  }

  /**
   * 获取可用资金
   */
  get_available_capital(): number {
    // 计算所有开仓占用的资金
    let used_capital = 0;
    for (const position of this.open_positions.values()) {
      used_capital += position.entry_price * position.quantity;
    }

    return this.current_equity - used_capital;
  }

  /**
   * 开仓
   */
  open_position(
    symbol: string,
    interval: string,
    side: TradeSide,
    entry_price: number,
    quantity: number,
    entry_time: number,
    stop_loss?: number,
    take_profit?: number,
    entry_indicators?: Record<string, any>
  ): Position | null {
    // 检查是否已有持仓
    const position_key = `${symbol}_${interval}`;
    if (this.open_positions.has(position_key)) {
      logger.warn(`[TradeSimulator] Position already exists for ${symbol} ${interval}`);
      return null;
    }

    // 计算开仓金额
    const position_value = entry_price * quantity;

    // 计算手续费
    const commission = position_value * this.commission_rate;

    // 检查资金是否足够
    const required_capital = position_value + commission;
    if (this.get_available_capital() < required_capital) {
      logger.warn(`[TradeSimulator] Insufficient capital for opening position: ${symbol}`);
      return null;
    }

    // 扣除手续费
    this.current_equity -= commission;

    // 创建持仓
    const position: Position = {
      strategy_id: 0, // 回测时设置为0
      symbol,
      interval,
      side,
      entry_price,
      quantity,
      current_price: entry_price,
      stop_loss,
      take_profit,
      unrealized_pnl: 0,
      unrealized_pnl_percent: 0,
      status: PositionStatus.OPEN,
      entry_time,
      entry_indicators
    };

    this.open_positions.set(position_key, position);

    logger.debug(`[TradeSimulator] Opened ${side} position: ${symbol} @ ${entry_price}, qty: ${quantity}, fee: ${commission.toFixed(2)}`);

    return position;
  }

  /**
   * 平仓
   */
  close_position(
    symbol: string,
    interval: string,
    exit_price: number,
    exit_time: number,
    exit_reason: ExitReason,
    exit_indicators?: Record<string, any>
  ): Trade | null {
    const position_key = `${symbol}_${interval}`;
    const position = this.open_positions.get(position_key);

    if (!position) {
      logger.warn(`[TradeSimulator] No open position found for ${symbol} ${interval}`);
      return null;
    }

    // 计算持仓时长
    const holding_duration = Math.floor((exit_time - position.entry_time) / 1000);

    // 计算平仓金额
    const exit_value = exit_price * position.quantity;

    // 计算手续费
    const commission = exit_value * this.commission_rate;

    // 计算盈亏
    let pnl: number;
    if (position.side === TradeSide.LONG) {
      pnl = (exit_price - position.entry_price) * position.quantity - commission;
    } else {
      pnl = (position.entry_price - exit_price) * position.quantity - commission;
    }

    const pnl_percent = (pnl / (position.entry_price * position.quantity)) * 100;

    // 更新权益
    this.current_equity += pnl;

    // 创建交易记录
    const trade: Trade = {
      strategy_id: 0, // 回测时设置为0
      symbol,
      interval,
      side: position.side,
      entry_price: position.entry_price,
      exit_price,
      quantity: position.quantity,
      entry_time: position.entry_time,
      exit_time,
      holding_duration,
      pnl,
      pnl_percent,
      commission: commission * 2, // 开仓+平仓手续费
      exit_reason,
      trade_data: {
        entry_indicators: position.entry_indicators,
        exit_indicators,
        stop_loss: position.stop_loss,
        take_profit: position.take_profit
      }
    };

    // 移除持仓
    this.open_positions.delete(position_key);

    // 添加到已平仓列表
    this.closed_trades.push(trade);

    logger.debug(`[TradeSimulator] Closed ${position.side} position: ${symbol} @ ${exit_price}, PnL: ${pnl.toFixed(2)} (${pnl_percent.toFixed(2)}%), reason: ${exit_reason}`);

    return trade;
  }

  /**
   * 更新持仓当前价格和浮动盈亏
   */
  update_position_price(symbol: string, interval: string, current_price: number): void {
    const position_key = `${symbol}_${interval}`;
    const position = this.open_positions.get(position_key);

    if (!position) {
      return;
    }

    position.current_price = current_price;

    // 计算浮动盈亏
    let unrealized_pnl: number;
    if (position.side === TradeSide.LONG) {
      unrealized_pnl = (current_price - position.entry_price) * position.quantity;
    } else {
      unrealized_pnl = (position.entry_price - current_price) * position.quantity;
    }

    position.unrealized_pnl = unrealized_pnl;
    position.unrealized_pnl_percent = (unrealized_pnl / (position.entry_price * position.quantity)) * 100;
  }

  /**
   * 检查是否触发止损止盈
   */
  check_stop_loss_take_profit(
    symbol: string,
    interval: string,
    current_price: number,
    current_time: number
  ): { should_exit: boolean; reason: ExitReason } | null {
    const position_key = `${symbol}_${interval}`;
    const position = this.open_positions.get(position_key);

    if (!position) {
      return null;
    }

    // 检查止损
    if (position.stop_loss) {
      if (position.side === TradeSide.LONG && current_price <= position.stop_loss) {
        return { should_exit: true, reason: ExitReason.STOP_LOSS };
      }
      if (position.side === TradeSide.SHORT && current_price >= position.stop_loss) {
        return { should_exit: true, reason: ExitReason.STOP_LOSS };
      }
    }

    // 检查止盈
    if (position.take_profit) {
      if (position.side === TradeSide.LONG && current_price >= position.take_profit) {
        return { should_exit: true, reason: ExitReason.TAKE_PROFIT };
      }
      if (position.side === TradeSide.SHORT && current_price <= position.take_profit) {
        return { should_exit: true, reason: ExitReason.TAKE_PROFIT };
      }
    }

    return null;
  }

  /**
   * 获取持仓
   */
  get_position(symbol: string, interval: string): Position | null {
    const position_key = `${symbol}_${interval}`;
    return this.open_positions.get(position_key) || null;
  }

  /**
   * 重置模拟器
   */
  reset(): void {
    this.current_equity = this.initial_capital;
    this.open_positions.clear();
    this.closed_trades = [];
  }

  /**
   * 获取交易统计
   */
  get_statistics(): {
    total_trades: number;
    win_trades: number;
    loss_trades: number;
    total_pnl: number;
    total_commission: number;
  } {
    const win_trades = this.closed_trades.filter(t => t.pnl > 0).length;
    const loss_trades = this.closed_trades.filter(t => t.pnl <= 0).length;
    const total_pnl = this.closed_trades.reduce((sum, t) => sum + t.pnl, 0);
    const total_commission = this.closed_trades.reduce((sum, t) => sum + t.commission, 0);

    return {
      total_trades: this.closed_trades.length,
      win_trades,
      loss_trades,
      total_pnl,
      total_commission
    };
  }
}
