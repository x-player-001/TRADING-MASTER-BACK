/**
 * 策略：高位整理第三推低点限价做多（flag_third_push）
 *
 * 识别（全部只用挂单时刻之前已收盘的K线）：
 *   1. 推动波：当前K线最高价为近 high_lookback 根最高，且相对近 imp_lookback 根最低点涨幅 ≥ imp_min；
 *      回调不足 cons_min 根又收盘创新高视为推动延续。
 *   2. 整理区间：推动高点之后收盘未突破区间上沿；回撤超过 retr_max、跌破推动起点或整理超过 cons_max 根则作废。
 *   3. 三推：整理区间内的分型低点（左右各 2 根更高，低点后 2 根确认）；两个低点之间反弹 ≥ 区间高度 × push_bounce
 *      才算新的一推，否则视为同一推（更低则替换）。
 *   4. 第三推确认的K线收盘时，若满足过滤条件：
 *      entry_mode=limit   在第三推低点挂限价买单，有效 order_valid_bars 根（策略 flag_third_push）
 *      entry_mode=confirm 以确认K线收盘价直接入场（策略 flag_third_push_confirm）
 *
 * 过滤（挂单时判断）：可见拉升段（推动起点之后最后一根仍在底部 35% 振幅内的K线 → 推动高点）根数 ≥ leg_min_bars、
 *   涨幅在 [leg_min_pct, leg_max_pct]、单根实体 ≤ 拉升高度 × leg_max_bar_ratio；回撤 ≤ retr_limit；
 *   三推低点关系（lows_mode）；拉升起点前 24h 推动波个数 ≤ max_pre_waves；入场价离区间上沿 ≤ max_dist_to_top（可选 ≥ min_dist_to_top）；
 *   24h 成交额 ≥ min_qv24；可选 第三推前反弹高点 − 第二推前反弹高点 ≤ 区间高度 × max_hi_trend（上沿不抬高）。
 *
 * 出场（逐根K线，同根先判不利方向）：
 *   止损（stop_pct，不设则仅爆仓：保证金 × 杠杆下跌 liq_drop 亏光保证金）→ 量度目标（区间上沿 + 拉升高度）
 *   → 突破区间上沿后 MACD 柱首次缩短 → breakout_wait_bars 根内未突破区间上沿 → max_hold_bars 根到时。
 *
 * 研究记录见 memory「旗形/整理突破研究」；与研究脚本相比修正了两处前视：过滤条件在挂单时判断（原为成交时），
 * 挂单不因形态在成交K线上失效而丢失。
 */

import { BacktestStrategy, BacktestTrade, ChartAnnotation, KlineSeries, TIMEFRAME_5M_MULTIPLE } from '../backtest_types';
import { macd_hist, rolling_sum } from '../series_utils';

export interface FlagThirdPushParams {
  high_lookback: number;
  imp_lookback: number;
  imp_min: number;
  cons_min: number;
  cons_max: number;
  retr_max: number;
  push_bounce: number;
  order_valid_bars: number;
  min_qv24: number;
  leg_min_bars: number;
  leg_max_bar_ratio: number;
  leg_min_pct: number;
  leg_max_pct: number;
  retr_limit: number;
  lows_mode: 'rising' | 'flat' | 'ge_first' | 'any';
  lows_tolerance: number;
  max_pre_waves: number;
  max_dist_to_top: number;
  min_dist_to_top: number | null;
  max_hi_trend: number | null;
  entry_mode: 'limit' | 'confirm';
  margin: number;
  leverage: number;
  fee_rate: number;
  liq_drop: number;
  stop_pct: number | null;
  breakout_wait_bars: number;
  max_hold_bars: number;
  exit_mode: 'target_or_macd' | 'target' | 'macd';
}

export const FLAG_THIRD_PUSH_DEFAULTS: FlagThirdPushParams = {
  high_lookback: 150,
  imp_lookback: 30,
  imp_min: 0.03,
  cons_min: 5,
  cons_max: 96,
  retr_max: 0.786,
  push_bounce: 0.5,
  order_valid_bars: 40,
  min_qv24: 5e6,
  leg_min_bars: 3,
  leg_max_bar_ratio: 0.6,
  leg_min_pct: 0.04,
  leg_max_pct: 0.2,
  retr_limit: 0.5,
  lows_mode: 'rising',
  lows_tolerance: 0.1,
  max_pre_waves: 2,
  max_dist_to_top: 0.05,
  min_dist_to_top: null,
  max_hi_trend: null,
  entry_mode: 'limit',
  margin: 10,
  leverage: 10,
  fee_rate: 0.0005,
  liq_drop: 0.095,
  stop_pct: null,
  breakout_wait_bars: 20,
  max_hold_bars: 288,
  exit_mode: 'target_or_macd',
};

export const FLAG_THIRD_PUSH_EXIT_REASONS: Record<string, string> = {
  target: '到量度目标',
  macd_shrink: '突破后 MACD 柱首次缩短',
  no_breakout: '规定根数内未突破区间上沿',
  liquidation: '爆仓（未设止损）',
  stop: '止损',
  time: '持仓到时',
};

/** 整理中的形态 */
interface Setup {
  a: number;          // 推动起点（近 imp_lookback 根最低）
  L0: number;
  H: number;          // 推动高点价（影线）
  p: number;          // 推动高点K线
  top: number;        // 区间上沿（影线最高）
  low: number;        // 区间最低
  lows: number[];     // 已确认的推（分型低点索引）
}

/** 挂出的限价单 */
interface Order {
  place: number;      // 第三推确认K线（收盘挂单）
  price: number;      // 第三推低点
  top: number;        // 区间上沿（随成交前K线更新）
  box_low: number;
  lamp: number;       // 拉升高度
  s0: number;
  p: number;
  lows: number[];
  confirm: boolean;   // 确认入场（无挂单）
  features: Record<string, number | string | boolean | null>;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** 前 window 根（不含当前）最高价，单调队列 O(n) */
function prev_window_max(high: Float64Array, window: number): Float64Array {
  const n = high.length, out = new Float64Array(n).fill(-Infinity), dq: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) {
    while (head < dq.length && dq[head] < i - window) head++;
    if (head < dq.length) out[i] = high[dq[head]];
    while (dq.length > head && high[dq[dq.length - 1]] <= high[i]) dq.pop();
    dq.push(i);
  }
  return out;
}

/** 运行策略（单币） */
export function run_flag_third_push(k: KlineSeries, params: Partial<FlagThirdPushParams> = {}, strategy_id = 'flag_third_push'): BacktestTrade[] {
  const P: FlagThirdPushParams = { ...FLAG_THIRD_PUSH_DEFAULTS, ...params };
  const n = k.length, D = 288 / TIMEFRAME_5M_MULTIPLE[k.timeframe];
  const { open: o, high: h, low: l, close: c, time } = k;
  const qv = rolling_sum(k.quote, D), hist = macd_hist(c), prev_max = prev_window_max(h, P.high_lookback);
  const trades: BacktestTrade[] = [];
  const waves: number[] = [];
  let orders: Order[] = [];
  let st: Setup | null = null;

  /** 新的分型低点归入推序列：新的一推返回 true */
  const add_push = (s: Setup, j: number): boolean => {
    if (!s.lows.length) { s.lows.push(j); return true; }
    const q = s.lows[s.lows.length - 1];
    let hb = -Infinity;
    for (let x = q + 1; x < j; x++) hb = Math.max(hb, h[x]);
    if (hb - Math.max(l[q], l[j]) >= P.push_bounce * (s.top - Math.min(l[q], l[j]))) { s.lows.push(j); return true; }
    if (l[j] < l[q]) s.lows[s.lows.length - 1] = j;
    return false;
  };

  /** 第三推确认：判断过滤条件，合格则挂单 */
  const try_place = (s: Setup, i: number): void => {
    const amp = s.H - s.L0;
    let s0 = s.a;
    for (let x = s.p; x >= s.a; x--) if (l[x] <= s.L0 + 0.35 * amp) { s0 = x; break; }
    const lamp = s.H - l[s0], leg_bars = s.p - s0 + 1, leg_pct = s.H / l[s0] - 1;
    let max_bar = 0;
    for (let x = s0; x <= s.p; x++) max_bar = Math.max(max_bar, (c[x] - o[x]) / lamp);
    const pl = s.lows.map(x => l[x]), price = pl[2];
    const retr = (s.H - s.low) / amp;
    const tol = P.lows_tolerance * (s.top - Math.min(s.low, ...pl));
    const rising = pl[1] >= pl[0] && pl[2] >= pl[1];
    const flat = pl[1] >= pl[0] - tol && pl[2] >= pl[1] - tol;
    const ge_first = pl[2] >= pl[0] - tol;
    const lows_ok = P.lows_mode === 'any' || (P.lows_mode === 'rising' ? rising : P.lows_mode === 'flat' ? flat : ge_first);
    const pre_waves = waves.filter(x => x < s0 && x >= s0 - D).length;
    const confirm = P.entry_mode === 'confirm';
    const entry_ref = confirm ? c[i] : price;
    const dist = s.top / entry_ref - 1;
    // 上沿走向：第三推前反弹高点相对第二推前反弹高点（区间高度为单位）
    const [j1, j2, j3] = s.lows;
    let hb12 = -Infinity, hb23 = -Infinity;
    for (let x = j1 + 1; x <= j2; x++) hb12 = Math.max(hb12, h[x]);
    for (let x = j2 + 1; x <= j3; x++) hb23 = Math.max(hb23, h[x]);
    const hi_trend = (hb23 - hb12) / (s.top - s.low);
    const pass = qv[i] >= P.min_qv24 && leg_bars >= P.leg_min_bars && max_bar <= P.leg_max_bar_ratio
      && leg_pct >= P.leg_min_pct && leg_pct <= P.leg_max_pct && retr <= P.retr_limit && lows_ok
      && pre_waves <= P.max_pre_waves && dist <= P.max_dist_to_top
      && (P.min_dist_to_top === null || dist >= P.min_dist_to_top)
      && (P.max_hi_trend === null || hi_trend <= P.max_hi_trend);
    if (!pass) return;
    const od: Order = {
      place: i, price, top: s.top, box_low: s.low, lamp, s0, p: s.p, lows: s.lows.slice(), confirm,
      features: {
        leg_pct: r6(leg_pct), leg_bars, leg_max_bar: r6(max_bar), impulse_pct: r6(s.H / s.L0 - 1), pre_waves,
        retr: r6(retr), cons_bars: i - s.p, dist_to_top: r6(dist), qv24: Math.round(qv[i]),
        push1: pl[0], push2: pl[1], push3: pl[2], box_top: s.top, box_low: s.low, lamp,
        lows_rising: rising, lows_flat: flat, lows_ge_first: ge_first, hi_trend: r6(hi_trend),
      },
    };
    if (!confirm) { orders.push(od); return; }
    const t = simulate(od, i, c[i]);   // 确认K线收盘直接入场
    if (t) trades.push(t);
  };

  /** 形态与挂单的公共标注 */
  const base_annotations = (od: Order, end_idx: number): ChartAnnotation[] => [
    { type: 'segment', points: [{ time: time[od.s0], price: l[od.s0] }, { time: time[od.p], price: h[od.p] }], label: `拉升 +${((h[od.p] / l[od.s0] - 1) * 100).toFixed(1)}%`, color: '#2962ff' },
    { type: 'box', from_time: time[od.p], to_time: time[end_idx], top: od.top, bottom: od.box_low, label: '整理区间', color: '#9e9e9e' },
    ...od.lows.map((x, idx): ChartAnnotation => ({ type: 'marker', time: time[x], price: l[x], label: `第${idx + 1}推`, role: 'point', position: 'below', color: '#ff9800' })),
    ...(od.confirm ? [] : [{ type: 'hline', from_time: time[od.place], to_time: time[end_idx], price: od.price, label: '限价挂单', style: 'dashed', color: '#ff9800' } as ChartAnnotation]),
  ];

  /** 成交后逐根模拟出场；数据不足返回 null */
  const simulate = (od: Order, g: number, E: number): BacktestTrade | null => {
    const notional = P.margin * P.leverage, fee = notional * P.fee_rate * 2;
    const liq = E * (1 - P.liq_drop), stop = P.stop_pct !== null ? E * (1 - P.stop_pct) : null;
    const top = od.top, tgt = P.exit_mode === 'macd' ? Infinity : top + od.lamp;
    let exit_idx = -1, exit_px = NaN, reason = '', breakout_idx = -1;
    if (!od.confirm) {   // 限价单在K线内成交：成交当根只判不利方向
      if (stop !== null && l[g] <= stop) { exit_idx = g; exit_px = stop; reason = 'stop'; }
      else if (l[g] <= liq) { exit_idx = g; exit_px = liq; reason = 'liquidation'; }
    }
    for (let x = g + 1; exit_idx < 0 && x <= g + P.max_hold_bars; x++) {
      if (x >= n) return null;
      if (stop !== null && stop > liq) {
        if (o[x] <= stop) { exit_idx = x; exit_px = o[x]; reason = 'stop'; break; }
        if (l[x] <= stop) { exit_idx = x; exit_px = stop; reason = 'stop'; break; }
      } else if (l[x] <= liq) { exit_idx = x; exit_px = liq; reason = 'liquidation'; break; }
      if (h[x] >= tgt) { exit_idx = x; exit_px = Math.max(tgt, o[x]); reason = 'target'; break; }
      if (breakout_idx < 0 && h[x] > top) breakout_idx = x;
      if (breakout_idx >= 0 && P.exit_mode !== 'target' && hist[x] < hist[x - 1]) { exit_idx = x; exit_px = c[x]; reason = 'macd_shrink'; break; }
      if (breakout_idx < 0 && x - g >= P.breakout_wait_bars) { exit_idx = x; exit_px = c[x]; reason = 'no_breakout'; break; }
    }
    if (exit_idx < 0) {
      if (g + P.max_hold_bars >= n) return null;
      exit_idx = g + P.max_hold_bars; exit_px = c[exit_idx]; reason = 'time';
    }
    const pnl = reason === 'liquidation' ? -P.margin : notional * (exit_px / E - 1) - fee;
    let mfe = 0, mae = Math.min(0, l[g] / E - 1);
    for (let x = g + 1; x <= exit_idx; x++) { mfe = Math.max(mfe, h[x] / E - 1); mae = Math.min(mae, l[x] / E - 1); }
    const annotations: ChartAnnotation[] = [
      ...base_annotations(od, g),
      { type: 'hline', from_time: time[g], to_time: time[exit_idx], price: stop ?? liq, label: stop !== null ? '止损' : '爆仓价', style: 'dashed', color: '#ef5350' },
      ...(Number.isFinite(tgt) ? [{ type: 'hline', from_time: time[g], to_time: time[exit_idx], price: tgt, label: '量度目标', style: 'dashed', color: '#26a69a' } as ChartAnnotation] : []),
      ...(breakout_idx >= 0 ? [{ type: 'marker', time: time[breakout_idx], price: top, label: '突破上沿', role: 'point', position: 'above', color: '#2962ff' } as ChartAnnotation] : []),
      { type: 'marker', time: time[g], price: E, label: '入场', role: 'entry', position: 'below', color: '#26a69a' },
      { type: 'marker', time: time[exit_idx], price: exit_px, label: FLAG_THIRD_PUSH_EXIT_REASONS[reason], role: 'exit', position: 'above', color: pnl > 0 ? '#26a69a' : '#ef5350' },
    ];
    return {
      strategy_id, symbol: k.symbol, timeframe: k.timeframe, side: 'long', status: 'closed',
      signal_time: time[od.place], entry_time: time[g], entry_price: E, stop_price: stop, target_price: Number.isFinite(tgt) ? tgt : null,
      exit_time: time[exit_idx], exit_price: exit_px, exit_reason: reason,
      pnl: r6(pnl), pnl_pct: r6(pnl / notional),
      r_multiple: stop !== null ? r6((exit_px - E) / (E - stop) - fee / notional * E / (E - stop)) : null,
      mfe_pct: r6(mfe), mae_pct: r6(mae), bars_held: exit_idx - g,
      features: { ...od.features, fill_wait_bars: g - od.place, breakout: breakout_idx >= 0 },
      annotations,
    };
  };

  for (let i = Math.max(P.high_lookback, D + 1); i < n; i++) {
    // 1. 挂单：先于形态状态处理（挂单一经挂出，独立于形态是否失效）
    if (orders.length) {
      const rest: Order[] = [];
      for (const od of orders) {
        if (l[i] <= od.price) {
          const t = simulate(od, i, Math.min(o[i], od.price));
          if (t) trades.push(t);
        } else if (i - od.place >= P.order_valid_bars) {
          trades.push({
            strategy_id, symbol: k.symbol, timeframe: k.timeframe, side: 'long', status: 'unfilled',
            signal_time: time[od.place], entry_time: null, entry_price: null, stop_price: null, target_price: null,
            exit_time: time[i], exit_price: null, exit_reason: 'expired', pnl: null, pnl_pct: null, r_multiple: null,
            mfe_pct: null, mae_pct: null, bars_held: null, features: od.features, annotations: base_annotations(od, i),
          });
        } else {
          od.top = Math.max(od.top, h[i]);
          rest.push(od);
        }
      }
      orders = rest;
    }

    // 2. 形态状态机
    if (st) {
      const cons = i - 1 - st.p;
      if (c[i] > st.top) {
        if (cons < P.cons_min) {   // 回调太短：推动延续
          st.p = i; st.H = Math.max(st.H, h[i]); st.top = st.H; st.low = Infinity; st.lows = [];
          continue;
        }
        st = null;                 // 收盘突破，本段结束（本根仍可成为新推动高点）
      } else {
        st.top = Math.max(st.top, h[i]); st.low = Math.min(st.low, l[i]);
        if ((st.H - st.low) / (st.H - st.L0) > P.retr_max || l[i] < st.L0 || cons + 1 > P.cons_max) { st = null; continue; }
        const j = i - 2;
        if (j - 2 >= st.p && l[j] <= l[j - 1] && l[j] <= l[j - 2] && l[j] < l[j + 1] && l[j] < l[j + 2]) {
          if (add_push(st, j) && st.lows.length === 3) try_place(st, i);
        }
        continue;
      }
    }

    // 3. 识别推动高点
    if (h[i] < prev_max[i]) continue;
    let L0 = Infinity, a = -1;
    for (let j = i - P.imp_lookback; j <= i; j++) if (l[j] < L0) { L0 = l[j]; a = j; }
    if (h[i] / L0 - 1 < P.imp_min) continue;
    st = { a, L0, H: h[i], p: i, top: h[i], low: Infinity, lows: [] };
    waves.push(i);
  }
  return trades;
}

export const FLAG_THIRD_PUSH: BacktestStrategy<FlagThirdPushParams> = {
  id: 'flag_third_push',
  name: '高位整理第三推低点限价做多',
  description: '推动后高位整理，三推低点逐个抬高，第三推确认后在其低点挂限价单；未破上沿按时间离场，突破后到量度目标或 MACD 柱缩短离场。',
  timeframe: '5m',
  version: 1,
  default_params: FLAG_THIRD_PUSH_DEFAULTS,
  param_docs: [
    { key: 'leg_min_pct', label: '拉升最小涨幅' },
    { key: 'leg_max_pct', label: '拉升最大涨幅', description: '排除暴拉出货' },
    { key: 'leg_min_bars', label: '拉升最少根数' },
    { key: 'leg_max_bar_ratio', label: '单根实体占拉升上限' },
    { key: 'retr_limit', label: '整理最大回撤（相对推动）' },
    { key: 'lows_mode', label: '三推低点关系', description: 'rising 严格抬高 / flat 后一推不低于前一推−容差 / ge_first 第三推不低于第一推−容差 / any 不限' },
    { key: 'lows_tolerance', label: '低点持平容差（区间高度比例）' },
    { key: 'max_pre_waves', label: '拉升前 24h 推动波上限', description: '避开最后一波' },
    { key: 'max_dist_to_top', label: '挂单价离区间上沿上限' },
    { key: 'order_valid_bars', label: '限价单有效根数' },
    { key: 'stop_pct', label: '固定止损比例', description: 'null 为不设止损（仅爆仓）' },
    { key: 'margin', label: '保证金（USDT）' },
    { key: 'leverage', label: '杠杆' },
    { key: 'breakout_wait_bars', label: '等待突破根数' },
    { key: 'exit_mode', label: '突破后离场', description: 'target_or_macd / target / macd' },
  ],
  exit_reasons: FLAG_THIRD_PUSH_EXIT_REASONS,
  run: (series, params) => run_flag_third_push(series, params),
};

export const FLAG_THIRD_PUSH_CONFIRM_DEFAULTS: FlagThirdPushParams = {
  ...FLAG_THIRD_PUSH_DEFAULTS,
  entry_mode: 'confirm',
  max_hi_trend: 0,
};

export const FLAG_THIRD_PUSH_CONFIRM: BacktestStrategy<FlagThirdPushParams> = {
  id: 'flag_third_push_confirm',
  name: '高位整理第三推确认做多',
  description: '与 flag_third_push 同一识别，第三推确认K线收盘直接入场（不挂限价单），并要求反弹高点不抬高（区间上沿持平或走低）。',
  timeframe: '5m',
  version: 1,
  default_params: FLAG_THIRD_PUSH_CONFIRM_DEFAULTS,
  param_docs: [
    ...FLAG_THIRD_PUSH.param_docs.filter(d => d.key !== 'order_valid_bars'),
    { key: 'max_hi_trend', label: '上沿走向上限', description: '第三推前反弹高点 − 第二推前反弹高点，以区间高度为单位；0 表示不抬高，null 不限' },
    { key: 'min_dist_to_top', label: '入场离区间上沿下限', description: 'null 不限' },
  ],
  exit_reasons: FLAG_THIRD_PUSH_EXIT_REASONS,
  run: (series, params) => run_flag_third_push(series, { ...FLAG_THIRD_PUSH_CONFIRM_DEFAULTS, ...params }, 'flag_third_push_confirm'),
};
