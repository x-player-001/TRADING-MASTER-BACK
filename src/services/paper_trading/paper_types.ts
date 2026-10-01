/**
 * 模拟盘（Paper Trading）类型定义
 *
 * 模拟盘以「真实行情 + 模拟撮合」运行策略信号：
 *   信号 → 条件单（pending）→ 成交开仓（open）→ 止损/止盈/时间平仓（closed）
 * 撮合以已收盘 5m K线为最小粒度，K线内路径按不利方向优先（先判止损）。
 */

/** 策略周期 */
export type PaperTimeframe = '5m' | '15m';

/** 背离方向：1 = 顶背离（做空），-1 = 底背离（做多） */
export type DivergenceDir = 1 | -1;

/** 已收盘K线（quote_volume 统一按 close × volume 计，与回测口径一致） */
export interface PaperBar {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
}

/** 背离信号特征（全部在信号成立那根K线收盘时可知，无未来函数） */
export interface DivergenceFeatures {
  dif_ratio: number;     // 触发K线 DIF / 前峰 DIF 峰值
  hist_ratio: number;    // 触发K线红柱 / 前峰红柱峰值
  gap: number;           // 两峰之间翻绿根数
  gdep: number;          // 两峰之间绿柱最深处 / 前峰红柱峰值
  imp_pct: number;       // 前波涨幅%：前峰之前 60 根内低点 → 新高
  leg_pct: number;       // 末段涨幅%：两峰间回调低点 → 新高
  qv24_m: number;        // 信号K线时刻的 24h 成交额（百万 USDT）
  atr_pct: number;       // 反转K线 ATR14 / 收盘价 %
  range48: number;       // 最近 48 根高低差 / 收盘价 %
  wait: number;          // 触发K线 → 反转K线 相隔根数
  wick: number;          // 反转K线上影（顶）/ 下影（底）占振幅比
  body: number;          // 反转K线实体占振幅比
}

/** 背离 + 反转K线 形成的交易机会（在反转K线收盘时产生） */
export interface DivergenceSetup {
  symbol: string;
  timeframe: PaperTimeframe;
  dir: DivergenceDir;
  trigger_time: number;      // 背离触发K线（峰内首次创新高）open_time
  setup_time: number;        // 反转K线 open_time
  setup_close_time: number;  // 反转K线 close_time（信号可用时刻）
  entry_trigger: number;     // 条件单触发价：顶=反转K线低点，底=反转K线高点
  extreme: number;           // 本峰至反转K线为止的极值（新高/新低），即基础止损
  atr: number;               // 反转K线 ATR14（价格单位）
  features: DivergenceFeatures;
}

/** 策略过滤条件 */
export interface DivergenceFilters {
  max_dif_ratio: number;
  max_hist_ratio: number;
  min_gap: number;
  min_gdep: number;
  min_imp_pct: number;
  min_leg_pct: number;
  min_qv24_m: number;
  min_risk_pct: number;      // 成交价到基础止损的距离下限（%）
  max_risk_pct: number;      // 上限（%）
}

/** 策略配置 */
export interface PaperStrategyConfig {
  id: string;
  name: string;
  timeframe: PaperTimeframe;
  dir: DivergenceDir;
  enabled: boolean;
  filters: DivergenceFilters;
  stop_atr_buffer: number;   // 止损 = 极值 + buffer × ATR（0 即止损放在新高/新低）
  take_profit_r: number;     // 止盈 R 倍数
  order_valid_bars: number;  // 条件单有效根数（策略周期）
  max_hold_bars: number;     // 最长持仓根数（策略周期），到期按收盘价平仓
}

/** 账户配置 */
export interface PaperAccountConfig {
  risk_per_trade_usdt: number;   // 每笔固定止损金额
  fee_rate: number;              // 单边手续费率（按名义价值）
  one_position_per_symbol: boolean;
}

/** 模拟交易状态 */
export type PaperTradeStatus = 'pending' | 'open' | 'closed' | 'cancelled' | 'expired' | 'skipped';

/** 平仓原因 */
export type PaperExitReason = 'stop' | 'take_profit' | 'time';

/** 一笔模拟交易（订单 + 持仓 + 结果） */
export interface PaperTrade {
  id?: number;
  strategy_id: string;
  symbol: string;
  timeframe: PaperTimeframe;
  side: 'short' | 'long';
  status: PaperTradeStatus;

  trigger_time: number;
  setup_time: number;
  signal_time: number;           // 反转K线收盘时刻（挂单时刻）
  entry_trigger: number;
  base_stop: number;             // 极值（未成交前价格触及即撤单）
  stop_price: number;            // 成交后止损价（极值 + ATR 缓冲）
  take_profit: number | null;    // 成交后按实际成交价计算
  expire_at: number;             // 条件单失效时刻（open_time 达到即失效）
  max_hold_until: number | null; // 时间平仓时刻（成交后计算）

  fill_time: number | null;
  fill_price: number | null;
  qty: number | null;
  notional: number | null;
  risk_usdt: number;

  exit_time: number | null;
  exit_price: number | null;
  exit_reason: PaperExitReason | null;
  gross_pnl: number | null;
  fees: number | null;
  pnl: number | null;
  r_multiple: number | null;
  mfe_r: number | null;          // 持仓期最大有利波动（R）
  mae_r: number | null;          // 持仓期最大不利波动（R）

  cancel_reason: string | null;
  last_bar_time: number;         // 已处理到的最后一根 5m open_time（重启续跑用）
  features: DivergenceFeatures;
}
