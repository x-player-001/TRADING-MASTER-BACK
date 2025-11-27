/**
 * 跟踪止盈管理器
 * 处理分批止盈和动态跟踪止盈逻辑
 */

import { TakeProfitTarget, DynamicTakeProfitConfig, PositionSide } from '../types/trading_types';
import { logger } from '../utils/logger';

/**
 * 仓位跟踪状态
 */
interface PositionTrackingState {
  position_id: number;
  symbol: string;
  side: PositionSide;
  entry_price: number;
  current_price: number;
  remaining_quantity: number; // 剩余仓位数量
  initial_quantity: number;   // 初始仓位数量

  // 批次状态
  targets: TargetState[];

  // 跟踪止盈状态
  trailing_active: boolean;           // 是否启动跟踪
  highest_profit_price?: number;      // 最高盈利价格
  trailing_stop_price?: number;       // 当前跟踪止损价格

  // 统计
  total_realized_pnl: number;         // 已实现盈亏
  executed_targets: number;           // 已执行批次数量
}

/**
 * 批次状态
 */
interface TargetState {
  target: TakeProfitTarget;
  executed: boolean;           // 是否已执行
  executed_quantity?: number;  // 已执行数量
  executed_price?: number;     // 执行价格
  executed_at?: Date;          // 执行时间
}

export class TrailingStopManager {
  private tracking_positions: Map<number, PositionTrackingState> = new Map();

  /**
   * 开始跟踪一个仓位
   * @param position_id 仓位ID
   * @param symbol 币种
   * @param side 方向
   * @param entry_price 入场价格
   * @param quantity 仓位数量
   * @param config 动态止盈配置
   */
  start_tracking(
    position_id: number,
    symbol: string,
    side: PositionSide,
    entry_price: number,
    quantity: number,
    config: DynamicTakeProfitConfig
  ): void {
    // 初始化批次状态
    const targets: TargetState[] = config.targets.map(target => ({
      target,
      executed: false
    }));

    const state: PositionTrackingState = {
      position_id,
      symbol,
      side,
      entry_price,
      current_price: entry_price,
      remaining_quantity: quantity,
      initial_quantity: quantity,
      targets,
      trailing_active: false,
      total_realized_pnl: 0,
      executed_targets: 0
    };

    this.tracking_positions.set(position_id, state);

    logger.info(`[TrailingStopManager] Started tracking position ${position_id} (${symbol} ${side}) with ${config.targets.length} targets`);
  }

  /**
   * 更新价格并检查止盈条件
   * @param position_id 仓位ID
   * @param current_price 当前价格
   * @returns 需要执行的止盈操作列表
   */
  update_price(
    position_id: number,
    current_price: number
  ): TakeProfitAction[] {
    const state = this.tracking_positions.get(position_id);
    if (!state) {
      logger.warn(`[TrailingStopManager] Position ${position_id} not found in tracking`);
      return [];
    }

    state.current_price = current_price;

    const actions: TakeProfitAction[] = [];

    // 1. 检查固定批次止盈
    for (const target_state of state.targets) {
      if (target_state.executed || target_state.target.is_trailing) {
        continue; // 跳过已执行或跟踪批次
      }

      const should_execute = this.check_target_reached(
        state.side,
        state.entry_price,
        current_price,
        target_state.target
      );

      if (should_execute) {
        const quantity_to_close = (state.initial_quantity * target_state.target.percentage) / 100;

        actions.push({
          type: 'BATCH_TAKE_PROFIT',
          position_id,
          symbol: state.symbol,
          quantity: quantity_to_close,
          price: current_price,
          target_index: state.targets.indexOf(target_state),
          reason: `达到第${state.executed_targets + 1}批止盈目标 (+${target_state.target.target_profit_pct}%)`
        });

        // 标记为已执行
        target_state.executed = true;
        target_state.executed_quantity = quantity_to_close;
        target_state.executed_price = current_price;
        target_state.executed_at = new Date();

        state.remaining_quantity -= quantity_to_close;
        state.executed_targets++;

        logger.info(`[TrailingStopManager] Position ${position_id}: Target ${state.executed_targets} reached at ${current_price}`);
      }
    }

    // 2. 检查是否应该启动跟踪止盈
    if (!state.trailing_active && this.should_activate_trailing(state)) {
      state.trailing_active = true;
      state.highest_profit_price = current_price;
      logger.info(`[TrailingStopManager] Position ${position_id}: Trailing stop activated at ${current_price}`);
    }

    // 3. 更新跟踪止盈
    if (state.trailing_active) {
      const trailing_action = this.update_trailing_stop(state, current_price);
      if (trailing_action) {
        actions.push(trailing_action);
      }
    }

    return actions;
  }

  /**
   * 检查固定批次是否达到止盈条件
   */
  private check_target_reached(
    side: PositionSide,
    entry_price: number,
    current_price: number,
    target: TakeProfitTarget
  ): boolean {
    if (side === PositionSide.LONG) {
      return current_price >= target.price;
    } else {
      return current_price <= target.price;
    }
  }

  /**
   * 检查是否应该启动跟踪止盈
   */
  private should_activate_trailing(state: PositionTrackingState): boolean {
    // 查找配置中的跟踪止盈配置
    const trailing_target = state.targets.find(t => t.target.is_trailing);
    if (!trailing_target) {
      return false;
    }

    // 获取配置（通过遍历找到包含此target的配置）
    // 简化处理：当第一批次执行后即启动
    return state.executed_targets >= 1;
  }

  /**
   * 更新跟踪止盈价格
   */
  private update_trailing_stop(
    state: PositionTrackingState,
    current_price: number
  ): TakeProfitAction | null {
    // 查找跟踪批次
    const trailing_target = state.targets.find(t => t.target.is_trailing && !t.executed);
    if (!trailing_target) {
      return null;
    }

    const callback_pct = trailing_target.target.trailing_callback_pct || 30;

    // 更新最高价
    if (state.side === PositionSide.LONG) {
      if (!state.highest_profit_price || current_price > state.highest_profit_price) {
        state.highest_profit_price = current_price;
        // 计算跟踪止损价格：最高价 * (1 - 回调百分比)
        const profit_gained = state.highest_profit_price - state.entry_price;
        state.trailing_stop_price = state.entry_price + profit_gained * (1 - callback_pct / 100);

        logger.debug(`[TrailingStopManager] Position ${state.position_id}: New high ${state.highest_profit_price}, trailing stop updated to ${state.trailing_stop_price}`);
      }

      // 检查是否触发跟踪止损
      if (state.trailing_stop_price && current_price <= state.trailing_stop_price) {
        const quantity_to_close = state.remaining_quantity;

        trailing_target.executed = true;
        trailing_target.executed_quantity = quantity_to_close;
        trailing_target.executed_price = current_price;
        trailing_target.executed_at = new Date();

        logger.info(`[TrailingStopManager] Position ${state.position_id}: Trailing stop triggered at ${current_price} (high: ${state.highest_profit_price})`);

        return {
          type: 'TRAILING_STOP',
          position_id: state.position_id,
          symbol: state.symbol,
          quantity: quantity_to_close,
          price: current_price,
          target_index: state.targets.indexOf(trailing_target),
          reason: `跟踪止盈触发 (最高价: ${state.highest_profit_price}, 回调${callback_pct}%)`
        };
      }
    } else {
      // SHORT 逻辑
      if (!state.highest_profit_price || current_price < state.highest_profit_price) {
        state.highest_profit_price = current_price;
        // 计算跟踪止损价格：最低价 * (1 + 回调百分比)
        const profit_gained = state.entry_price - state.highest_profit_price;
        state.trailing_stop_price = state.entry_price - profit_gained * (1 - callback_pct / 100);

        logger.debug(`[TrailingStopManager] Position ${state.position_id}: New low ${state.highest_profit_price}, trailing stop updated to ${state.trailing_stop_price}`);
      }

      // 检查是否触发跟踪止损
      if (state.trailing_stop_price && current_price >= state.trailing_stop_price) {
        const quantity_to_close = state.remaining_quantity;

        trailing_target.executed = true;
        trailing_target.executed_quantity = quantity_to_close;
        trailing_target.executed_price = current_price;
        trailing_target.executed_at = new Date();

        logger.info(`[TrailingStopManager] Position ${state.position_id}: Trailing stop triggered at ${current_price} (low: ${state.highest_profit_price})`);

        return {
          type: 'TRAILING_STOP',
          position_id: state.position_id,
          symbol: state.symbol,
          quantity: quantity_to_close,
          price: current_price,
          target_index: state.targets.indexOf(trailing_target),
          reason: `跟踪止盈触发 (最低价: ${state.highest_profit_price}, 回调${callback_pct}%)`
        };
      }
    }

    return null;
  }

  /**
   * 停止跟踪仓位
   */
  stop_tracking(position_id: number): void {
    if (this.tracking_positions.has(position_id)) {
      this.tracking_positions.delete(position_id);
      logger.info(`[TrailingStopManager] Stopped tracking position ${position_id}`);
    }
  }

  /**
   * 获取仓位跟踪状态
   */
  get_tracking_state(position_id: number): PositionTrackingState | undefined {
    return this.tracking_positions.get(position_id);
  }

  /**
   * 获取所有跟踪中的仓位
   */
  get_all_tracking_positions(): PositionTrackingState[] {
    return Array.from(this.tracking_positions.values());
  }
}

/**
 * 止盈操作
 */
export interface TakeProfitAction {
  type: 'BATCH_TAKE_PROFIT' | 'TRAILING_STOP';
  position_id: number;
  symbol: string;
  quantity: number;         // 平仓数量
  price: number;            // 平仓价格
  target_index: number;     // 批次索引
  reason: string;           // 触发原因
}
