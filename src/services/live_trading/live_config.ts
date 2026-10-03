/**
 * 实盘配置：S1（15m 顶背离）+ S2（5m 顶背离）
 *
 * 策略识别 / 过滤 / 出场参数直接取模拟盘 PAPER_STRATEGIES，保证与模拟盘同一信号、同一止损止盈口径；
 * 这里只放资金与风控参数。账户约 115U，用户决定每笔风险 10U、最多同时 5 笔（2026-10-03）：
 * 保证金不够时信号记为 skipped / insufficient_margin（只记录不告警）。
 */

import { DivergenceStrategyConfig, is_flag_strategy } from '@/services/paper_trading/paper_types';
import { PAPER_STRATEGIES } from '@/services/paper_trading/paper_strategies';
import { LiveConfig, LiveRunMode } from './live_types';

export const LIVE_CONFIG: LiveConfig = {
  strategy_ids: ['macd_top_div_15m', 'macd_top_div_5m'],
  risk_per_trade_usdt: 10,
  max_notional_usdt: 1000,    // 名义上限放宽，是否开得出由保证金检查决定
  max_leverage: 20,           // 实际杠杆仍按强平距离 ≥ 2 倍最差止损距离计算，上限放宽只为止损近的单少占保证金
  liq_distance_mult: 2,
  entry_slippage_mult: 1.5,
  take_profit_r: 2,
  max_active_trades: 5,
  daily_loss_limit_usdt: 30,  // 3R
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
