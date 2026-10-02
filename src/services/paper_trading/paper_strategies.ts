/**
 * 模拟盘策略与账户配置
 *
 * 研究记录见 docs/MACD_DIVERGENCE_STRATEGIES.md（S1~S5）。所有策略：
 *   顶背离（DIF比<0.6、红柱比<0.3、两峰间翻绿≥3根且深≥20%）+ 反转K线 → 跌破反转K线低点做空，
 *   固定 2R 止盈，48 根时间平仓；15m 止损=新高，5m 止损=新高+0.5ATR（5m 噪音大）
 */

import { PaperAccountConfig, PaperStrategyConfig, DivergenceFilters } from './paper_types';

/** 顶背离共同过滤条件 */
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

/** 周期共用的出场参数 */
const EXIT_15M = { timeframe: '15m' as const, stop_atr_buffer: 0, take_profit_r: 2, order_valid_bars: 6, max_hold_bars: 48 };
const EXIT_5M = { timeframe: '5m' as const, stop_atr_buffer: 0.5, take_profit_r: 2, order_valid_bars: 6, max_hold_bars: 48 };

export const PAPER_STRATEGIES: PaperStrategyConfig[] = [
  {
    id: 'macd_top_div_15m',
    name: 'S1 15m 顶背离',
    dir: 1, enabled: true, ...EXIT_15M,
    filters: { ...TOP_DIVERGENCE_FILTERS },
  },
  {
    id: 'macd_top_div_5m',
    name: 'S2 5m 顶背离',
    dir: 1, enabled: true, ...EXIT_5M,
    filters: { ...TOP_DIVERGENCE_FILTERS },
  },
  {
    id: 'macd_top_div_15m_vol',
    name: 'S3 15m 顶背离 + 放量',
    dir: 1, enabled: true, ...EXIT_15M,
    filters: { ...TOP_DIVERGENCE_FILTERS, min_qv_surge: 2 },
  },
  {
    id: 'macd_top_div_5m_vol',
    name: 'S4 5m 顶背离 + 放量',
    dir: 1, enabled: true, ...EXIT_5M,
    filters: { ...TOP_DIVERGENCE_FILTERS, min_qv_surge: 2 },
  },
  {
    id: 'macd_top_div_5m_imp30',
    name: 'S5 5m 顶背离 前波≥30%',
    dir: 1, enabled: true, ...EXIT_5M,
    filters: { ...TOP_DIVERGENCE_FILTERS, min_imp_pct: 30 },
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
