/**
 * 实盘配置：S1（15m 顶背离）+ S2（5m 顶背离）
 *
 * 策略识别 / 过滤 / 出场参数直接取模拟盘 PAPER_STRATEGIES，保证与模拟盘同一信号、同一止损止盈口径；
 * 这里只放资金与风控参数。账户 100U 起步：每笔风险 2U（2%），最多同时 3 笔。
 */

import { DivergenceStrategyConfig, is_flag_strategy } from '@/services/paper_trading/paper_types';
import { PAPER_STRATEGIES } from '@/services/paper_trading/paper_strategies';
import { LiveConfig, LiveRunMode } from './live_types';

export const LIVE_CONFIG: LiveConfig = {
  strategy_ids: ['macd_top_div_15m', 'macd_top_div_5m'],
  risk_per_trade_usdt: 2,
  max_notional_usdt: 150,
  max_leverage: 10,
  liq_distance_mult: 2,
  entry_slippage_mult: 1.5,
  take_profit_r: 2,
  max_active_trades: 3,
  daily_loss_limit_usdt: 8,
  margin_buffer_usdt: 5,
  signal_max_delay_ms: 90_000,
  shadow_balance_usdt: 100,
};

/** 运行模式：只有显式设置 LIVE_TRADING_MODE=live 才真实下单 */
export function live_run_mode(): LiveRunMode {
  return process.env.LIVE_TRADING_MODE === 'live' ? 'live' : 'shadow';
}

/** 接入的策略配置（取自模拟盘，缺失或类型不符直接报错） */
export function live_strategies(cfg: LiveConfig = LIVE_CONFIG): DivergenceStrategyConfig[] {
  return cfg.strategy_ids.map(id => {
    const s = PAPER_STRATEGIES.find(x => x.id === id);
    if (!s || is_flag_strategy(s)) throw new Error(`实盘策略 ${id} 不存在或不是背离策略`);
    if (s.take_profit_r !== cfg.take_profit_r) throw new Error(`实盘止盈 ${cfg.take_profit_r}R 与模拟盘 ${id} 的 ${s.take_profit_r}R 不一致`);
    return s;
  });
}
