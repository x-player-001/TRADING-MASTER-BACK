/**
 * 实盘交易（MACD 顶背离 S1/S2）类型定义
 *
 * 一笔实盘交易的生命周期（以交易所状态为准，本地只做编排）：
 *
 *   placing  ─ 已落库、入场条件单请求在途（结果未知时靠 clientAlgoId 查询确认）
 *   pending  ─ 入场条件单（STOP 卖出 + IOC 限价）在交易所等待触发
 *   entering ─ 已成交，正在挂保护单（止损 / 止盈，均为 closePosition 条件单）
 *   open     ─ 持仓中，止损止盈都在交易所
 *   closing  ─ 正在主动平仓（到期 / 保护单失败 / 一键平仓），或已平仓待结算
 *   closed   ─ 已平仓并结算（盈亏取自成交明细）
 *   cancelled─ 入场单未成交即结束（过期 / 先破新高 / 被拒 / IOC 未成交）
 *   skipped  ─ 未下单（风控 / 同币占用 / 计划不合格），仅留痕
 *   shadow   ─ 影子模式：只算计划不下单
 *   error    ─ 程序无法自动收敛（例如平仓失败），需人工处理，期间禁止开新仓
 */

import { DivergenceFeatures, PaperTimeframe } from '@/services/paper_trading/paper_types';

/** 实盘交易状态 */
export type LiveTradeStatus =
  | 'placing' | 'pending' | 'entering' | 'open' | 'closing'
  | 'closed' | 'cancelled' | 'skipped' | 'shadow' | 'error';

/** 进行中的状态（需要持续同步） */
export const ACTIVE_STATUSES: LiveTradeStatus[] = ['placing', 'pending', 'entering', 'open', 'closing'];

/** 平仓原因 */
export type LiveExitReason =
  | 'stop'            // 止损单触发
  | 'take_profit'     // 止盈单触发
  | 'time'            // 到达最长持仓，市价平仓
  | 'flatten'         // 人工一键平仓
  | 'protect_failed'  // 保护单挂不上，市价平仓
  | 'wrong_side'      // 持仓方向异常，市价平仓
  | 'external';       // 非本程序触发（手动 / 强平 / ADL）

/** 运行模式：live 真实下单；shadow 只算计划不下单 */
export type LiveRunMode = 'live' | 'shadow';

/** 控制开关（live_control 表，可在运行中修改） */
export type LiveControlMode = 'running' | 'paused' | 'flatten';

/** 一笔实盘交易 */
export interface LiveTrade {
  id?: number;
  strategy_id: string;
  symbol: string;
  timeframe: PaperTimeframe;
  side: 'short';
  status: LiveTradeStatus;

  trigger_time: number;          // 背离触发K线 open_time
  setup_time: number;            // 反转K线 open_time（与 paper_trades 同一唯一键，便于对拍）
  signal_time: number;           // 反转K线收盘时刻（挂单时刻）

  entry_trigger: number;         // 入场触发价（反转K线低点）
  entry_limit: number;           // 入场 IOC 限价（最差可接受成交价）
  base_stop: number;             // 背离极值（未成交前触及即撤单）
  stop_price: number;            // 止损触发价
  take_profit: number | null;    // 止盈触发价（按实际成交均价计算）
  planned_qty: number;
  leverage: number;
  risk_usdt: number;             // 计划风险（planned_qty × (止损 − 触发价)）
  expire_at: number;             // 入场单失效时刻（到达即撤）
  max_hold_until: number | null; // 时间平仓时刻（成交后计算）

  entry_mode: 'algo' | 'ioc' | null;    // algo = 条件单入场；ioc = 挂单时已越过触发价，直接 IOC 限价
  entry_order_id: number | null;        // 实际成交的普通订单号
  filled_qty: number | null;
  fill_price: number | null;            // 成交均价
  fill_time: number | null;

  sl_seq: number;                // 止损单序号（重挂时递增，用于生成 clientAlgoId）
  tp_seq: number;
  exit_seq: number;              // 市价平仓单序号

  exit_time: number | null;
  exit_price: number | null;     // 平仓成交均价
  exit_reason: LiveExitReason | null;
  gross_pnl: number | null;      // 已实现盈亏（成交明细 realizedPnl 之和，不含手续费）
  fees: number | null;           // 手续费（开 + 平，USDT）
  funding: number | null;        // 资金费（正 = 收入）
  pnl: number | null;            // 净盈亏 = gross − fees + funding
  r_multiple: number | null;     // pnl / 实际风险
  mfe_r: number | null;
  mae_r: number | null;

  cancel_reason: string | null;
  error_msg: string | null;
  last_bar_time: number;         // 已处理到的最后一根 5m open_time
  features: DivergenceFeatures;
}

/** 交易规则（exchangeInfo 解析结果） */
export interface SymbolRules {
  symbol: string;
  status: string;                // TRADING 才可交易
  tick_size: string;             // 价格步长（保留字符串以精确计算小数位）
  step_size: string;             // 数量步长
  min_qty: number;
  max_qty: number;
  market_step_size: string;
  market_max_qty: number;
  min_notional: number;
  percent_down: number;          // PERCENT_PRICE 卖出限价下限倍数（相对标记价，如 0.95；无该过滤器为 0）
}

/** 杠杆分层（取名义价值所在档） */
export interface LeverageBracket {
  max_leverage: number;
  notional_cap: number;
  maint_margin_ratio: number;
}

/** 条件单状态 */
export type AlgoStatus = 'NEW' | 'TRIGGERING' | 'TRIGGERED' | 'FINISHED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

/** 条件单 */
export interface AlgoOrderInfo {
  algo_id: number;
  client_algo_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  status: AlgoStatus;
  trigger_price: number;
  price: number;
  quantity: number;
  close_position: boolean;
  actual_order_id: number | null;   // 触发后在撮合引擎生成的普通订单号
  update_time: number;
}

/** 普通订单状态 */
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'EXPIRED_IN_MATCH';

/** 普通订单 */
export interface OrderInfo {
  order_id: number;
  client_order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  status: OrderStatus;
  orig_qty: number;
  executed_qty: number;
  avg_price: number;
  update_time: number;
}

/** 持仓（单向持仓模式，amount 带符号：负 = 空） */
export interface PositionInfo {
  symbol: string;
  amount: number;
  entry_price: number;
  liquidation_price: number;
  margin_type: string;
  leverage: number;
}

/** 成交明细 */
export interface UserTrade {
  id: number;
  order_id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realized_pnl: number;
  commission: number;
  commission_asset: string;
  time: number;
}

/** 下条件单参数 */
export interface NewAlgoOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  client_algo_id: string;
  trigger_price: string;
  quantity?: string;
  price?: string;
  time_in_force?: 'GTC' | 'IOC';
  close_position?: boolean;
}

/** 下普通单参数 */
export interface NewOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  client_order_id: string;
  quantity: string;
  price?: string;
  time_in_force?: 'IOC' | 'GTC';
  reduce_only?: boolean;
}

/**
 * 交易所网关（实盘由 BinanceLiveClient 实现，单测用 FakeExchange）
 *
 * 错误约定：抛 ExchangeError；definite=true 表示交易所明确拒绝（请求未生效），
 * definite=false 表示结果未知（超时 / 断网 / 5xx），调用方必须查询确认，不能当作失败重试。
 */
export interface ExchangeGateway {
  new_algo_order(p: NewAlgoOrderParams): Promise<AlgoOrderInfo>;
  /** 按 clientAlgoId 查询，不存在返回 null */
  get_algo_order(client_algo_id: string): Promise<AlgoOrderInfo | null>;
  /** 撤条件单；已是终态或不存在不抛错 */
  cancel_algo_order(client_algo_id: string): Promise<void>;
  get_open_algo_orders(symbol?: string): Promise<AlgoOrderInfo[]>;

  new_order(p: NewOrderParams): Promise<OrderInfo>;
  /** 按订单号或 clientOrderId 查询，不存在返回 null */
  get_order(symbol: string, ref: { order_id?: number; client_order_id?: string }): Promise<OrderInfo | null>;
  /** 撤普通单；已是终态或不存在不抛错 */
  cancel_order(symbol: string, ref: { order_id?: number; client_order_id?: string }): Promise<void>;
  get_open_orders(symbol?: string): Promise<OrderInfo[]>;

  get_position(symbol: string): Promise<PositionInfo>;
  get_open_positions(): Promise<PositionInfo[]>;
  get_user_trades(symbol: string, start_time: number): Promise<UserTrade[]>;
  get_funding_fee(symbol: string, start_time: number, end_time: number): Promise<number>;
  get_available_balance(): Promise<number>;
  get_leverage_bracket(symbol: string, notional: number): Promise<LeverageBracket>;
  set_isolated_margin(symbol: string): Promise<void>;
  set_leverage(symbol: string, leverage: number): Promise<void>;
}

/** 交易所错误 */
export class ExchangeError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly http_status: number | null,
    readonly definite: boolean,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}

/** 币安错误码：条件单会立即触发（挂单时价格已越过触发价） */
export const ERR_WOULD_IMMEDIATELY_TRIGGER = -2021;
/** 币安错误码：reduceOnly 单被拒（通常是已无持仓） */
export const ERR_REDUCE_ONLY_REJECTED = -2022;

/** 实盘配置 */
export interface LiveConfig {
  strategy_ids: string[];          // 接入的模拟盘策略（参数直接取 PAPER_STRATEGIES，保证同一信号）
  risk_per_trade_usdt: number;     // 每笔计划风险（触发价到止损）
  max_notional_usdt: number;       // 单笔名义价值上限（超出按比例缩小数量，风险随之变小）
  max_leverage: number;            // 杠杆上限（实际杠杆按止损距离自动取，保证强平价远在止损之外）
  liq_distance_mult: number;       // 强平距离 ≥ 该倍数 × 最差止损距离
  entry_slippage_mult: number;     // IOC 限价 = 止损 − 该倍数 × (止损 − 触发价)，即最多多亏 (倍数−1)R
  take_profit_r: number;           // 止盈 R 倍数（按实际成交均价）
  max_active_trades: number;       // 同时进行中的交易上限（挂单 + 持仓）
  daily_loss_limit_usdt: number;   // 当日（北京时间）已实现亏损达到即停止开新仓
  margin_buffer_usdt: number;      // 开仓后可用余额至少保留
  signal_max_delay_ms: number;     // 信号超过该延迟（如补缺口补出来的旧信号）不下单
  shadow_balance_usdt: number;     // 影子模式假设的可用余额
}
