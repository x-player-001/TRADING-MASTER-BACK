/**
 * 策略回测通用类型
 *
 * 任意策略实现 BacktestStrategy 即可复用：离线K线读取、回测运行脚本、结果入库、查询接口与前端画图。
 * 交易（BacktestTrade）自带画图标注（ChartAnnotation），前端按统一格式渲染，不需要理解策略细节。
 */

export type BacktestTimeframe = '5m' | '15m' | '1h' | '4h';

/** 周期 → 5m 根数 */
export const TIMEFRAME_5M_MULTIPLE: Record<BacktestTimeframe, number> = { '5m': 1, '15m': 3, '1h': 12, '4h': 48 };

/** 周期 → 毫秒 */
export const TIMEFRAME_MS: Record<BacktestTimeframe, number> = {
  '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000,
};

/** 单币K线序列（时间升序、等间隔；缺失K线已用前收盘填充，quote=0） */
export interface KlineSeries {
  symbol: string;
  timeframe: BacktestTimeframe;
  time: Float64Array;       // open_time（毫秒）
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  quote: Float64Array;      // 成交额（USDT，close × volume 近似）
  length: number;
}

/** 图上的一个价格点 */
export interface ChartPoint {
  time: number;             // K线 open_time（毫秒）
  price: number;
}

/**
 * 画图标注（前端按 type 渲染）
 *   marker  单点标记（入场/出场/关键点）
 *   hline   水平线段（挂单价、止损、目标）
 *   segment 折线（推动段等）
 *   box     矩形区域（整理区间）
 */
export type ChartAnnotation =
  | { type: 'marker'; time: number; price: number; label: string; role: 'entry' | 'exit' | 'point'; position: 'above' | 'below'; color?: string }
  | { type: 'hline'; from_time: number; to_time: number; price: number; label: string; style: 'solid' | 'dashed'; color?: string }
  | { type: 'segment'; points: ChartPoint[]; label: string; color?: string }
  | { type: 'box'; from_time: number; to_time: number; top: number; bottom: number; label: string; color?: string };

/** closed：已成交并平仓；unfilled：信号挂单未成交（失效） */
export type BacktestTradeStatus = 'closed' | 'unfilled';

/** 一笔回测交易（或未成交的信号） */
export interface BacktestTrade {
  strategy_id: string;
  symbol: string;
  timeframe: BacktestTimeframe;
  side: 'long' | 'short';
  status: BacktestTradeStatus;
  signal_time: number;            // 信号K线 open_time（该K线收盘时挂单/下单）
  entry_time: number | null;      // 成交K线 open_time
  entry_price: number | null;
  stop_price: number | null;      // 硬止损（null = 不设）
  target_price: number | null;
  exit_time: number | null;       // 出场K线 open_time
  exit_price: number | null;
  exit_reason: string | null;     // 策略自定义代码，含义见策略的 exit_reasons
  pnl: number | null;             // 净盈亏（USDT，已扣手续费）
  pnl_pct: number | null;         // 净盈亏 / 名义仓位
  r_multiple: number | null;      // 有硬止损时的 R 倍数
  mfe_pct: number | null;         // 持仓期最大有利波动（相对入场价）
  mae_pct: number | null;         // 持仓期最大不利波动（负数）
  bars_held: number | null;
  features: Record<string, number | string | boolean | null>;
  annotations: ChartAnnotation[];
}

/** 策略参数的说明（接口返回给前端展示） */
export interface ParamDoc {
  key: string;
  label: string;
  description?: string;
}

/** 回测策略 */
export interface BacktestStrategy<P extends object = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  timeframe: BacktestTimeframe;
  version: number;                               // 逻辑变更时递增，便于区分不同版本的回测记录
  default_params: P;
  param_docs: ParamDoc[];
  exit_reasons: Record<string, string>;          // 出场原因代码 → 中文说明
  /** 对单币完整序列运行，返回该币全部交易（含未成交信号） */
  run(series: KlineSeries, params: P): BacktestTrade[];
}
