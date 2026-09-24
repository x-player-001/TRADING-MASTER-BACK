/**
 * K线回放 + 模拟交易 类型定义
 *
 * 本文件不依赖任何项目模块（纯类型）。前端可与 replay_matching_engine.ts / replay_account.ts 一起直接复制使用。
 * 仓位/委托/成交之间用前端生成的 client_id 关联，后端入库时换算成数据库 id。
 */

/** 回放最小步进周期（固定 5m） */
export const REPLAY_BASE_INTERVAL = '5m';
export const REPLAY_BASE_INTERVAL_MS = 5 * 60 * 1000;

/** 支持的展示周期（大周期由 5m 实时聚合出未完成K线） */
export const REPLAY_INTERVALS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

export type ReplaySide = 'buy' | 'sell';
export type ReplayDirection = 'long' | 'short';
export type ReplayOrderType = 'market' | 'limit' | 'stop';
export type ReplayOrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
export type ReplaySessionStatus = 'active' | 'finished';
export type ReplayPositionStatus = 'open' | 'closed';

/** 成交触发来源 */
export type ReplayFillTrigger =
  | 'market'        // 市价单（按当前K线收盘价立即成交）
  | 'limit'         // 限价单
  | 'stop'          // 止损/突破单（条件市价）
  | 'stop_loss'     // 持仓止损
  | 'take_profit'   // 持仓止盈
  | 'manual'        // 手动平仓
  | 'session_end';  // 结束会话强平

/** 成交对仓位的作用 */
export type ReplayFillAction = 'open' | 'add' | 'reduce' | 'close';

/** 出场原因 */
export type ReplayExitReason =
  | 'take_profit' | 'stop_loss' | 'manual' | 'order' | 'reverse' | 'session_end';

/** 回放K线（5m 或聚合后的大周期） */
export interface ReplayBar {
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 大周期K线（带是否已收盘标记） */
export interface ReplayIntervalBar extends ReplayBar {
  is_closed: boolean;
}

/** 撮合参数 */
export interface ReplayEngineConfig {
  leverage: number;
  taker_fee_rate: number;     // 如 0.0005
  maker_fee_rate: number;     // 如 0.0002
  slippage_rate: number;      // 市价/条件单的不利滑点比例，如 0.0002
}

/** 订单 */
export interface ReplayOrder {
  id?: number;                        // 数据库 id（后端返回）
  client_id: string;                  // 前端生成的唯一 id
  session_id: number;
  position_id?: number | null;        // 数据库 id（后端返回）
  position_client_id: string | null;  // 成交后作用的仓位（反手单 = 新开的仓位）
  side: ReplaySide;
  order_type: ReplayOrderType;
  qty: number;
  price: number | null;               // limit=限价；stop=触发价；market=null
  reduce_only: boolean;
  stop_loss: number | null;           // 开仓单附带的止损（成交后挂到仓位上）
  take_profit: number | null;         // 开仓单附带的止盈
  status: ReplayOrderStatus;
  created_bar_time: number;           // 下单时游标K线 open_time（只从下一根开始参与撮合）
  filled_bar_time: number | null;
  filled_price: number | null;
  fee: number;
  reject_reason: string | null;
  tags: string[];
  note: string | null;
}

/** 仓位（一个开平回合） */
export interface ReplayPosition {
  id?: number;                        // 数据库 id（后端返回）
  client_id: string;                  // 前端生成的唯一 id
  session_id: number;
  symbol: string;
  direction: ReplayDirection;
  status: ReplayPositionStatus;
  qty: number;                        // 当前持仓数量
  max_qty: number;                    // 回合内最大持仓
  avg_entry_price: number;
  exit_qty: number;                   // 已平数量
  avg_exit_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  initial_stop_loss: number | null;   // 首次止损（定义 1R）
  risk_amount: number | null;         // 计划风险（USDT）= Σ|入场价-止损价|×数量
  realized_pnl: number;               // 毛盈亏（不含手续费）
  fee_total: number;
  net_pnl: number;                    // realized_pnl - fee_total
  r_multiple: number | null;          // net_pnl / risk_amount
  max_favorable_price: number;        // 持仓期间最有利价格
  max_adverse_price: number;          // 持仓期间最不利价格
  mfe_pct: number;                    // 最大有利偏移 %（正数）
  mae_pct: number;                    // 最大不利偏移 %（负数）
  open_bar_time: number;
  close_bar_time: number | null;
  bars_held: number | null;
  exit_reason: ReplayExitReason | null;
  tags: string[];
  note: string | null;
}

/** 成交明细（用于图表打点） */
export interface ReplayFill {
  id?: number;                        // 数据库 id（后端返回）
  client_id: string;
  session_id: number;
  position_id?: number;               // 数据库 id（后端返回）
  order_id?: number | null;           // 数据库 id（后端返回）
  position_client_id: string;
  order_client_id: string | null;
  side: ReplaySide;
  qty: number;
  price: number;
  fee: number;
  liquidity: 'maker' | 'taker';
  trigger_type: ReplayFillTrigger;
  action: ReplayFillAction;
  realized_pnl: number;
  bar_time: number;
}

/** 回放会话 */
export interface ReplaySession {
  id?: number;
  name: string;
  symbol: string;
  start_time: number;                 // 起始K线 open_time（该根及之前为已知历史）
  cursor_time: number;                // 当前游标：最后一根已揭示 5m K线的 open_time
  last_price: number;                 // 游标K线收盘价
  initial_balance: number;
  balance: number;                    // 已实现资金
  leverage: number;
  taker_fee_rate: number;
  maker_fee_rate: number;
  slippage_rate: number;
  status: ReplaySessionStatus;
  bars_stepped: number;               // 已推进的 5m 根数
  sync_revision: number;              // 最近一次同步的版本号（前端每次同步递增）
  note: string | null;
  created_at?: Date;
  updated_at?: Date;
  finished_at?: Date | null;
}

/** 撮合过程中产生的事件（返回给前端做提示） */
export type ReplayEvent =
  | { type: 'fill'; fill: ReplayFill }
  | { type: 'position_opened'; position: ReplayPosition }
  | { type: 'position_closed'; position: ReplayPosition }
  | { type: 'order_cancelled'; order: ReplayOrder; reason: string }
  | { type: 'order_rejected'; order: ReplayOrder; reason: string }
  | { type: 'gap'; from_time: number; to_time: number; missing_bars: number };
