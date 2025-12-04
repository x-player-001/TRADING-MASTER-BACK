/**
 * 持仓跟踪器
 * 跟踪所有持仓，监控止损止盈，计算盈亏
 */

import {
  PositionRecord,
  PositionSide,
  TradingSignal,
  OrderRecord
} from '../types/trading_types';
import { logger } from '../utils/logger';
import { OrderExecutor } from './order_executor';
import { RiskManager } from './risk_manager';

export class PositionTracker {
  private positions: Map<number, PositionRecord> = new Map();
  private position_id_counter = 1;
  private order_executor: OrderExecutor;
  private risk_manager: RiskManager;

  constructor(order_executor: OrderExecutor, risk_manager: RiskManager) {
    this.order_executor = order_executor;
    this.risk_manager = risk_manager;
  }

  /**
   * 开仓
   */
  open_position(
    signal: TradingSignal,
    entry_order: OrderRecord,
    leverage: number,
    stop_loss: number,
    take_profit: number
  ): PositionRecord {
    const position: PositionRecord = {
      id: this.position_id_counter++,
      symbol: signal.symbol,
      side: signal.direction === 'LONG' ? PositionSide.LONG : PositionSide.SHORT,
      entry_price: entry_order.average_price || signal.entry_price || 0,
      current_price: entry_order.average_price || signal.entry_price || 0,
      quantity: entry_order.filled_quantity || entry_order.quantity,
      leverage,
      unrealized_pnl: 0,
      unrealized_pnl_percent: 0,
      stop_loss_price: stop_loss,
      take_profit_price: take_profit,
      signal_id: signal.source_anomaly_id,
      entry_order_id: entry_order.id,
      is_open: true,
      opened_at: new Date(),
      updated_at: new Date()
    };

    this.positions.set(position.id!, position);

    logger.info(`[PositionTracker] Position opened: ${position.symbol} ${position.side} @ ${position.entry_price}, qty=${position.quantity}, leverage=${leverage}x`);

    return position;
  }

  /**
   * 更新持仓价格和盈亏
   */
  update_position(position_id: number, current_price: number): PositionRecord | null {
    const position = this.positions.get(position_id);
    if (!position || !position.is_open) {
      return null;
    }

    // 更新当前价格
    position.current_price = current_price;

    // 计算未实现盈亏
    const pnl_info = this.calculate_pnl(position);
    position.unrealized_pnl = pnl_info.pnl;
    position.unrealized_pnl_percent = pnl_info.pnl_percent;

    position.updated_at = new Date();

    // 检查是否需要更新移动止损
    const new_stop_loss = this.risk_manager.update_trailing_stop(position, current_price);
    if (new_stop_loss) {
      position.stop_loss_price = new_stop_loss;
    }

    return position;
  }

  /**
   * 检查是否触发止损或止盈
   */
  check_stop_triggers(position_id: number, current_price: number): {
    should_close: boolean;
    reason?: 'STOP_LOSS' | 'TAKE_PROFIT';
  } {
    const position = this.positions.get(position_id);
    if (!position || !position.is_open) {
      return { should_close: false };
    }

    // 多头持仓
    if (position.side === PositionSide.LONG) {
      // 检查止损
      if (position.stop_loss_price && current_price <= position.stop_loss_price) {
        return { should_close: true, reason: 'STOP_LOSS' };
      }

      // 检查止盈
      if (position.take_profit_price && current_price >= position.take_profit_price) {
        return { should_close: true, reason: 'TAKE_PROFIT' };
      }
    }

    // 空头持仓
    if (position.side === PositionSide.SHORT) {
      // 检查止损
      if (position.stop_loss_price && current_price >= position.stop_loss_price) {
        return { should_close: true, reason: 'STOP_LOSS' };
      }

      // 检查止盈
      if (position.take_profit_price && current_price <= position.take_profit_price) {
        return { should_close: true, reason: 'TAKE_PROFIT' };
      }
    }

    return { should_close: false };
  }

  /**
   * 平仓
   */
  async close_position(
    position_id: number,
    current_price: number,
    reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'RISK_LIMIT' | 'TIMEOUT'
  ): Promise<PositionRecord | null> {
    const position = this.positions.get(position_id);
    if (!position) {
      logger.error(`[PositionTracker] close_position failed: position_id=${position_id} not found in positions map (size=${this.positions.size}, keys=[${Array.from(this.positions.keys()).join(',')}])`);
      return null;
    }
    if (!position.is_open) {
      logger.error(`[PositionTracker] close_position failed: position ${position.symbol} (id=${position_id}) is already closed`);
      return null;
    }

    // 更新最终价格和盈亏
    position.current_price = current_price;
    const pnl_info = this.calculate_pnl(position);
    position.realized_pnl = pnl_info.pnl;
    position.unrealized_pnl = 0;
    position.unrealized_pnl_percent = 0;

    // 执行平仓订单
    try {
      const close_order = await this.order_executor.close_position_market(
        position.symbol,
        position.side,
        position.quantity,
        current_price
      );

      // 更新持仓状态
      position.is_open = false;
      position.closed_at = new Date();
      position.close_reason = reason;
      position.updated_at = new Date();
      // 保存平仓订单ID（用于查询手续费）
      if (close_order.order_id) {
        position.exit_order_id = parseInt(close_order.order_id);
      }

      // 记录交易结果到风险管理器
      const is_win = position.realized_pnl! > 0;
      this.risk_manager.record_trade_result(position.realized_pnl!, is_win);

      logger.info(`[PositionTracker] Position closed: ${position.symbol} ${position.side} @ ${current_price}, PnL=${position.realized_pnl!.toFixed(2)} (${pnl_info.pnl_percent.toFixed(2)}%), reason=${reason}`);

      return position;
    } catch (error) {
      logger.error('[PositionTracker] Failed to close position:', error);
      return null;
    }
  }

  /**
   * 计算盈亏
   */
  private calculate_pnl(position: PositionRecord): {
    pnl: number;
    pnl_percent: number;
  } {
    const price_diff = position.current_price - position.entry_price;

    let pnl: number;

    if (position.side === PositionSide.LONG) {
      // 多头：价格上涨盈利
      pnl = price_diff * position.quantity * position.leverage;
    } else {
      // 空头：价格下跌盈利
      pnl = -price_diff * position.quantity * position.leverage;
    }

    // 计算百分比（相对于投入资金）
    const capital = position.entry_price * position.quantity; // 实际投入（不含杠杆）
    const pnl_percent = capital > 0 ? (pnl / capital) * 100 : 0;

    return { pnl, pnl_percent };
  }

  /**
   * 获取所有持仓
   */
  get_all_positions(): PositionRecord[] {
    return Array.from(this.positions.values());
  }

  /**
   * 获取开仓持仓
   */
  get_open_positions(): PositionRecord[] {
    return Array.from(this.positions.values()).filter(p => p.is_open);
  }

  /**
   * 获取已平仓持仓
   */
  get_closed_positions(): PositionRecord[] {
    return Array.from(this.positions.values()).filter(p => !p.is_open);
  }

  /**
   * 获取指定币种的持仓
   */
  get_positions_by_symbol(symbol: string): PositionRecord[] {
    return Array.from(this.positions.values()).filter(p => p.symbol === symbol);
  }

  /**
   * 获取单个持仓
   */
  get_position(position_id: number): PositionRecord | undefined {
    return this.positions.get(position_id);
  }

  /**
   * 批量更新所有开仓持仓的价格
   */
  async update_all_positions_prices(price_map: Map<string, number>): Promise<void> {
    const open_positions = this.get_open_positions();

    for (const position of open_positions) {
      const current_price = price_map.get(position.symbol);
      if (!current_price || !position.id) {
        continue;
      }

      // 更新价格
      this.update_position(position.id, current_price);

      // 检查止损止盈
      const trigger_check = this.check_stop_triggers(position.id, current_price);
      if (trigger_check.should_close && trigger_check.reason) {
        await this.close_position(position.id, current_price, trigger_check.reason);
      }
    }
  }

  /**
   * 计算总盈亏
   */
  calculate_total_pnl(): {
    realized_pnl: number;
    unrealized_pnl: number;
    total_pnl: number;
  } {
    const closed_positions = this.get_closed_positions();
    const open_positions = this.get_open_positions();

    const realized_pnl = closed_positions.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);
    const unrealized_pnl = open_positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);

    return {
      realized_pnl,
      unrealized_pnl,
      total_pnl: realized_pnl + unrealized_pnl
    };
  }

  /**
   * 清空已平仓的历史记录
   */
  clear_closed_positions(): void {
    const closed_ids: number[] = [];
    this.positions.forEach((position, id) => {
      if (!position.is_open) {
        closed_ids.push(id);
      }
    });

    closed_ids.forEach(id => this.positions.delete(id));
    logger.info(`[PositionTracker] Cleared ${closed_ids.length} closed positions`);
  }

  /**
   * 添加从币安同步的持仓（用于持仓同步）
   */
  add_synced_position(position: PositionRecord): void {
    // 检查是否已存在相同的持仓（防止重复添加）
    const existing = this.find_open_position(position.symbol, position.side);
    if (existing) {
      logger.warn(`[PositionTracker] Position already exists: ${position.symbol} ${position.side}, skipping duplicate add`);
      return;
    }

    // 使用字符串ID生成数字ID
    const numeric_id = this.position_id_counter++;
    position.id = numeric_id;
    position.is_open = true;

    this.positions.set(numeric_id, position);
    logger.info(`[PositionTracker] Synced position added: ${position.symbol} ${position.side} @ ${position.entry_price}`);
  }

  /**
   * 标记持仓为已关闭（用于持仓同步）
   */
  mark_position_closed(position_id: number | string, realized_pnl: number): void {
    // 查找持仓
    let target_position: PositionRecord | undefined;
    let target_id: number | undefined;

    this.positions.forEach((position, id) => {
      if (position.id === position_id || id === position_id) {
        target_position = position;
        target_id = id;
      }
    });

    if (target_position && target_id !== undefined) {
      target_position.is_open = false;
      target_position.realized_pnl = realized_pnl;
      target_position.closed_at = new Date();
      target_position.close_reason = 'SYNC_CLOSED';

      logger.info(`[PositionTracker] Position marked as closed: ${target_position.symbol} ${target_position.side}, PnL: ${realized_pnl.toFixed(2)}`);
    }
  }

  /**
   * 根据symbol和side查找开仓持仓
   */
  find_open_position(symbol: string, side: PositionSide): PositionRecord | undefined {
    return Array.from(this.positions.values()).find(
      p => p.is_open && p.symbol === symbol && p.side === side
    );
  }
}
