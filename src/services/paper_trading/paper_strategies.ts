/**
 * 模拟盘策略与账户配置
 *
 * 参数来自 2026-06~09 全市场回测（反转K线 + 突破低点入场、止损新高口径）：
 *   15m 顶背离：前波≥20% & 末段≥10%，止损=新高，2R 止盈 → 约 +0.28R/笔
 *   5m  顶背离：同过滤，止损=新高+0.5ATR（5m 噪音大），2R 止盈 → 约 +0.28R/笔
 */

import { PaperAccountConfig, PaperStrategyConfig, DivergenceFilters } from './paper_types';

/** 顶背离通用过滤条件 */
const TOP_DIVERGENCE_FILTERS: DivergenceFilters = {
  max_dif_ratio: 0.6,
  max_hist_ratio: 0.3,
  min_gap: 3,
  min_gdep: 0.2,
  min_imp_pct: 20,
  min_leg_pct: 10,
  min_qv24_m: 10,
  min_risk_pct: 0.3,
  max_risk_pct: 10,
};

export const PAPER_STRATEGIES: PaperStrategyConfig[] = [
  {
    id: 'macd_top_div_15m',
    name: '15m MACD 顶背离 + 反转K线',
    timeframe: '15m',
    dir: 1,
    enabled: true,
    filters: { ...TOP_DIVERGENCE_FILTERS },
    stop_atr_buffer: 0,
    take_profit_r: 2,
    order_valid_bars: 6,
    max_hold_bars: 48,
  },
  {
    id: 'macd_top_div_5m',
    name: '5m MACD 顶背离 + 反转K线',
    timeframe: '5m',
    dir: 1,
    enabled: true,
    filters: { ...TOP_DIVERGENCE_FILTERS },
    stop_atr_buffer: 0.5,
    take_profit_r: 2,
    order_valid_bars: 6,
    max_hold_bars: 48,
  },
];

export const PAPER_ACCOUNT: PaperAccountConfig = {
  risk_per_trade_usdt: 10,
  fee_rate: 0.0005,
  one_position_per_symbol: true,
};

/** 周期毫秒数 */
export const TIMEFRAME_MS: Record<'5m' | '15m', number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
};
