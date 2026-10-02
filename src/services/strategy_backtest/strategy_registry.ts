/**
 * 回测策略注册表：新增策略在这里登记后，回测脚本与接口即可使用
 */

import { BacktestStrategy } from './backtest_types';
import { FLAG_THIRD_PUSH } from './strategies/flag_third_push';

const STRATEGIES: BacktestStrategy<any>[] = [FLAG_THIRD_PUSH];

/** 全部已注册策略 */
export function list_strategies(): BacktestStrategy<any>[] {
  return STRATEGIES;
}

/** 按 id 取策略（不存在返回 null） */
export function get_strategy(id: string): BacktestStrategy<any> | null {
  return STRATEGIES.find(s => s.id === id) ?? null;
}
