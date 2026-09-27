/**
 * 日线趋势线突破检测器（纯函数，无 IO）
 *
 * 识别两类形态并统一处理：
 * - 下降趋势线突破：连接多个逐级降低的摆动高点，收盘站上压力线
 * - 长期盘整上沿突破：斜率≈0 的压力线（水平线是趋势线的特例）
 *
 * 算法：
 * 1. 找摆动高点（左右各 pivot_window 根更低）
 * 2. 任意两个高点连线（x 轴按真实时间，跨数据空洞也不失真；默认线性坐标），斜率须 ≤ 水平阈值
 * 3. 从起点向右推进：收盘站上线 → 突破；影线刺穿过深超过 max_wick_breaks 根 → 线无效
 *    （允许零星插针：收盘回到线下的长上影，人工画线通常忽略）
 *    突破前第二个锚点必须已确认（b + pivot_window < t），避免前视
 * 4. 统计突破前所有贴线的摆动高点作为触点，相邻触点间隔过远的线丢弃（远隔两点连线无意义），
 *    按「触点数 → 跨度 → 拟合误差」择优
 * 5. 突破后跟踪：回踩（低点回到线附近）/ 失败（收盘跌破线）
 * 6. 时间相近的突破归为同一事件，只保留最优连线
 */

/** 日线K线 */
export interface DailyBar {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TrendlineType = 'descending' | 'horizontal';
export type TrendlineBreakoutStatus = 'breakout' | 'retest' | 'failed';

/** 趋势线触点 */
export interface TrendlineTouch {
  time: number;
  price: number;
}

/** 检测参数（百分比参数均为相对线值的百分比） */
export interface TrendlineBreakoutConfig {
  price_scale: 'log' | 'linear';       // 连线坐标：默认线性（与人工画线一致），可选对数
  pivot_window: number;                // 摆动高点左右确认根数
  min_span_days: number;               // 两锚点最小间隔（天）
  max_lookback_days: number;           // 起始锚点最远回看（天）
  horizontal_slope_pct: number;        // |斜率| 小于此（%/天）视为水平线；上升线超过此值丢弃
  touch_tol_pct: number;               // 高点离线在此范围内算触点
  wick_tol_pct: number;                // 突破前影线刺穿线在此幅度内不计
  max_wick_breaks: number;             // 允许刺穿超过 wick_tol 的插针根数（只计收盘在线下的）
  breakout_min_pct: number;            // 收盘高出线此幅度算突破
  min_depth_pct: number;               // 首尾触点之间价格离线的最大深度下限（排除贴着线横走）
  min_touches: number;                 // 最少触点数
  max_touch_gap_days: number;          // 相邻触点最大间隔（天），超出则线无意义
  retest_tol_pct: number;              // 突破后低点离线在此范围内算回踩
  fail_tol_pct: number;                // 突破后收盘跌破线此幅度算失败
  max_breakout_age_days: number;       // 只输出最近 N 天内的突破（Infinity = 全部历史）
  event_merge_days: number;            // 突破时间相差不超过此天数视为同一事件
  volume_lookback: number;             // 突破量比的均量回看根数
}

export const DEFAULT_TRENDLINE_CONFIG: TrendlineBreakoutConfig = {
  price_scale: 'linear',
  pivot_window: 5,
  min_span_days: 30,
  max_lookback_days: 730,
  horizontal_slope_pct: 0.05,
  touch_tol_pct: 2,
  wick_tol_pct: 4,
  max_wick_breaks: 1,
  breakout_min_pct: 1,
  min_depth_pct: 12,
  min_touches: 2,
  max_touch_gap_days: 180,
  retest_tol_pct: 3,
  fail_tol_pct: 3,
  max_breakout_age_days: 30,
  event_merge_days: 10,
  volume_lookback: 20,
};

/** 检测结果：一次突破事件 */
export interface TrendlineBreakout {
  line_type: TrendlineType;
  price_scale: 'log' | 'linear';
  touches: TrendlineTouch[];
  touch_count: number;
  slope_pct_per_day: number;           // 线的日变化率（%）
  span_days: number;                   // 首尾触点跨度
  depth_pct: number;                   // 首尾触点之间离线最深处（%）
  fit_error_pct: number;               // 触点平均偏离（%）

  breakout_time: number;
  breakout_close: number;
  breakout_line_value: number;
  breakout_pct: number;                // 突破日收盘高出线（%）
  breakout_volume_ratio: number;       // 突破日量 / 前 N 日均量

  status: TrendlineBreakoutStatus;
  retest_time: number | null;          // 首次回踩日
  retest_low: number | null;           // 回踩区间最低价
  retest_distance_pct: number | null;  // 回踩低点离线最近距离（%，负数=刺穿）
  fail_time: number | null;
  max_gain_pct: number;                // 突破后最高价相对突破收盘（%）

  last_time: number;
  last_close: number;
  last_line_value: number;
  last_distance_pct: number;           // 最新收盘离线（%）
  days_since_breakout: number;

  /** 由线参数计算任意时间点的线值 */
  line_value_at: (time: number) => number;
}

const DAY_MS = 86_400_000;

/**
 * 找摆动高点：高于左侧 window 根、不低于右侧 window 根
 * @returns 摆动高点下标（升序）
 */
export function find_pivot_highs(bars: DailyBar[], window: number): number[] {
  const result: number[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const h = bars[i].high;
    let is_pivot = true;
    for (let j = i - window; j < i && is_pivot; j++) if (bars[j].high >= h) is_pivot = false;
    for (let j = i + 1; j <= i + window && is_pivot; j++) if (bars[j].high > h) is_pivot = false;
    if (is_pivot) result.push(i);
  }
  return result;
}

/** 内部候选线 */
interface Candidate {
  a: number;
  slope: number;           // 变换坐标下每天斜率
  t: number;               // 突破K线下标
  touches: number[];       // 触点下标
  span_days: number;
  depth: number;           // 相对值（非百分比）
  fit_error: number;
}

/**
 * 检测日线趋势线 / 盘整上沿突破
 * @param bars 已收盘日线（按时间升序，可含数据空洞）
 * @param partial_config 覆盖默认参数
 * @returns 突破事件列表（按突破时间升序）
 */
export function detect_trendline_breakouts(
  bars: DailyBar[],
  partial_config: Partial<TrendlineBreakoutConfig> = {}
): TrendlineBreakout[] {
  const cfg = { ...DEFAULT_TRENDLINE_CONFIG, ...partial_config };
  const n = bars.length;
  const w = cfg.pivot_window;
  if (n < w * 2 + 2) return [];

  const is_log = cfg.price_scale === 'log';
  const tf = (p: number) => (is_log ? Math.log(p) : p);
  const inv = (v: number) => (is_log ? Math.exp(v) : v);
  /** 价格相对线的偏离（变换坐标输入，返回相对值） */
  const rel = (pv: number, lv: number) => (is_log ? Math.exp(pv - lv) - 1 : pv / lv - 1);

  const x = bars.map(b => b.open_time / DAY_MS);
  const th = bars.map(b => tf(b.high));
  const tl = bars.map(b => tf(b.low));
  const tc = bars.map(b => tf(b.close));

  const touch_tol = cfg.touch_tol_pct / 100;
  const wick_tol = cfg.wick_tol_pct / 100;
  const breakout_min = cfg.breakout_min_pct / 100;
  const min_depth = cfg.min_depth_pct / 100;
  const retest_tol = cfg.retest_tol_pct / 100;
  const fail_tol = cfg.fail_tol_pct / 100;

  const last_time = bars[n - 1].open_time;
  const earliest_anchor = last_time - cfg.max_lookback_days * DAY_MS;
  const earliest_breakout = Number.isFinite(cfg.max_breakout_age_days)
    ? last_time - cfg.max_breakout_age_days * DAY_MS
    : -Infinity;

  const pivots = find_pivot_highs(bars, w);
  const candidates: Candidate[] = [];

  for (let ai = 0; ai < pivots.length; ai++) {
    const a = pivots[ai];
    if (bars[a].open_time < earliest_anchor) continue;

    for (let bi = ai + 1; bi < pivots.length; bi++) {
      const b = pivots[bi];
      const span = x[b] - x[a];
      if (span < cfg.min_span_days) continue;

      const slope = (th[b] - th[a]) / span;
      // 上升线不要：用 a 点价格换算斜率百分比
      const slope_pct = (rel(th[a] + slope, th[a])) * 100;
      if (slope_pct > cfg.horizontal_slope_pct) continue;

      const cand = evaluate_line(a, b, slope);
      if (cand) candidates.push(cand);
    }
  }

  /**
   * 沿线向右推进，找突破点并校验线的有效性
   * @returns 有效且在输出窗口内突破的候选；否则 null
   */
  function evaluate_line(a: number, b: number, slope: number): Candidate | null {
    const line = (k: number) => th[a] + slope * (x[k] - x[a]);
    let t = -1;
    let wick_breaks = 0;
    for (let k = a + 1; k < n; k++) {
      const lv = line(k);
      if (!is_log && lv <= 0) return null;
      if (rel(tc[k], lv) > breakout_min) {
        if (k <= b + w) return null;   // 第二锚点确认前已站上 → 不是有效压力线
        t = k;
        break;
      }
      // 只有收盘回到线下的长上影才算插针；收盘在线上（未达突破幅度）是突破尝试，不计
      if (tc[k] < lv && rel(th[k], lv) > wick_tol && ++wick_breaks > cfg.max_wick_breaks) return null;
    }
    if (t < 0 || bars[t].open_time < earliest_breakout) return null;

    // 触点：突破前已确认的摆动高点中贴线者
    const touches: number[] = [];
    let err_sum = 0;
    for (const p of pivots) {
      if (p < a) continue;
      if (p + w >= t) break;
      const d = rel(th[p], line(p));
      if (Math.abs(d) <= touch_tol) {
        touches.push(p);
        err_sum += Math.abs(d);
      }
    }
    if (touches.length < cfg.min_touches) return null;
    for (let i = 1; i < touches.length; i++) {
      if (x[touches[i]] - x[touches[i - 1]] > cfg.max_touch_gap_days) return null;
    }

    const first = touches[0];
    const last = touches[touches.length - 1];
    let depth = 0;
    for (let k = first; k <= last; k++) depth = Math.max(depth, -rel(tl[k], line(k)));
    if (depth < min_depth) return null;

    return {
      a, slope, t, touches,
      span_days: x[last] - x[first],
      depth,
      fit_error: err_sum / touches.length,
    };
  }

  /** 候选排序：触点多 → 跨度长 → 误差小 */
  const better = (p: Candidate, q: Candidate) =>
    p.touches.length !== q.touches.length ? q.touches.length - p.touches.length
      : p.span_days !== q.span_days ? q.span_days - p.span_days
        : p.fit_error - q.fit_error;

  // 同一事件（突破时间相近）只保留最优连线
  candidates.sort(better);
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const dup = kept.some(k => Math.abs(x[k.t] - x[c.t]) <= cfg.event_merge_days);
    if (!dup) kept.push(c);
  }
  kept.sort((p, q) => p.t - q.t);

  return kept.map(c => build_result(c));

  /** 组装结果并跟踪突破后状态 */
  function build_result(c: Candidate): TrendlineBreakout {
    const { a, slope, t } = c;
    const line = (k: number) => th[a] + slope * (x[k] - x[a]);
    const line_value_at = (time: number) => inv(th[a] + slope * (time / DAY_MS - x[a]));

    let status: TrendlineBreakoutStatus = 'breakout';
    let retest_time: number | null = null;
    let retest_low: number | null = null;
    let retest_distance: number | null = null;
    let fail_time: number | null = null;
    let max_high = bars[t].high;

    for (let k = t + 1; k < n; k++) {
      const lv = line(k);
      max_high = Math.max(max_high, bars[k].high);
      if (rel(tc[k], lv) < -fail_tol) {
        status = 'failed';
        fail_time = bars[k].open_time;
        break;
      }
      const d = rel(tl[k], lv);
      if (d <= retest_tol) {
        status = 'retest';
        if (retest_time === null) retest_time = bars[k].open_time;
        retest_low = retest_low === null ? bars[k].low : Math.min(retest_low, bars[k].low);
        retest_distance = retest_distance === null ? d : Math.min(retest_distance, d);
      }
    }

    const vol_from = Math.max(0, t - cfg.volume_lookback);
    const vol_bars = bars.slice(vol_from, t);
    const avg_vol = vol_bars.length ? vol_bars.reduce((s, b) => s + b.volume, 0) / vol_bars.length : 0;

    const slope_rel = rel(th[a] + slope, th[a]);
    const pct = (v: number) => v * 100;

    return {
      line_type: pct(Math.abs(slope_rel)) < cfg.horizontal_slope_pct ? 'horizontal' : 'descending',
      price_scale: cfg.price_scale,
      touches: c.touches.map(k => ({ time: bars[k].open_time, price: bars[k].high })),
      touch_count: c.touches.length,
      slope_pct_per_day: pct(slope_rel),
      span_days: c.span_days,
      depth_pct: pct(c.depth),
      fit_error_pct: pct(c.fit_error),

      breakout_time: bars[t].open_time,
      breakout_close: bars[t].close,
      breakout_line_value: inv(line(t)),
      breakout_pct: pct(rel(tc[t], line(t))),
      breakout_volume_ratio: avg_vol > 0 ? bars[t].volume / avg_vol : 0,

      status,
      retest_time,
      retest_low,
      retest_distance_pct: retest_distance === null ? null : pct(retest_distance),
      fail_time,
      max_gain_pct: pct(max_high / bars[t].close - 1),

      last_time,
      last_close: bars[n - 1].close,
      last_line_value: inv(line(n - 1)),
      last_distance_pct: pct(rel(tc[n - 1], line(n - 1))),
      days_since_breakout: x[n - 1] - x[t],

      line_value_at,
    };
  }
}
