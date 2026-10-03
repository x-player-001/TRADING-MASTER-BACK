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
 *
 * 识别与出场逻辑在 flag_third_push_core.ts（逐根增量，模拟盘共用）；本文件负责批量回测：挂单管理、逐笔结果与画图标注。
 */

import { BacktestStrategy, BacktestTrade, ChartAnnotation, KlineSeries, TIMEFRAME_5M_MULTIPLE } from '../backtest_types';
import { macd_hist } from '../series_utils';
import {
  FlagThirdPushParams, FLAG_THIRD_PUSH_DEFAULTS, FLAG_THIRD_PUSH_CONFIRM_DEFAULTS, FLAG_THIRD_PUSH_EXIT_REASONS,
  FlagThirdPushCore, ThirdPushEvent, flag_filter_pass, new_flag_position, flag_exit_step, flag_pnl,
} from './flag_third_push_core';

export { FlagThirdPushParams, FLAG_THIRD_PUSH_DEFAULTS, FLAG_THIRD_PUSH_CONFIRM_DEFAULTS, FLAG_THIRD_PUSH_EXIT_REASONS };

/** 挂出的限价单 / 确认入场 */
interface Order {
  place: number;      // 第三推确认K线
  price: number;      // 第三推低点
  top: number;        // 区间上沿（限价单随成交前K线更新）
  box_low: number;
  lamp: number;       // 拉升高度
  ev: ThirdPushEvent;
  confirm: boolean;   // 确认入场（无挂单）
  features: Record<string, number | string | boolean | null>;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** 事件 → 交易特征（模拟盘共用） */
export function flag_event_features(ev: ThirdPushEvent, dist: number): Record<string, number | string | boolean | null> {
  return {
    leg_pct: r6(ev.leg_pct), leg_bars: ev.leg_bars, leg_max_bar: r6(ev.leg_max_bar), impulse_pct: r6(ev.impulse_pct), pre_waves: ev.pre_waves,
    retr: r6(ev.retr), cons_bars: ev.cons_bars, dist_to_top: r6(dist), qv24: Math.round(ev.qv24),
    push1: ev.push_lows[0], push2: ev.push_lows[1], push3: ev.push_lows[2], box_top: ev.top, box_low: ev.box_low, lamp: ev.lamp,
    lows_rising: ev.lows_rising, lows_flat: ev.lows_flat, lows_ge_first: ev.lows_ge_first, hi_trend: r6(ev.hi_trend),
  };
}

/** 运行策略（单币） */
export function run_flag_third_push(k: KlineSeries, params: Partial<FlagThirdPushParams> = {}, strategy_id = 'flag_third_push'): BacktestTrade[] {
  const P: FlagThirdPushParams = { ...FLAG_THIRD_PUSH_DEFAULTS, ...params };
  const n = k.length, D = 288 / TIMEFRAME_5M_MULTIPLE[k.timeframe];
  const { open: o, high: h, low: l, close: c, time } = k;
  const hist = macd_hist(c);
  const core = new FlagThirdPushCore(P, D);
  const trades: BacktestTrade[] = [];
  let orders: Order[] = [];

  /** 形态与挂单的公共标注 */
  const base_annotations = (od: Order, end_idx: number): ChartAnnotation[] => [
    { type: 'segment', points: [{ time: od.ev.s0_time, price: od.ev.s0_low }, { time: od.ev.p_time, price: od.ev.p_high }], label: `拉升 +${((od.ev.p_high / od.ev.s0_low - 1) * 100).toFixed(1)}%`, color: '#2962ff' },
    { type: 'box', from_time: od.ev.p_time, to_time: time[end_idx], top: od.top, bottom: od.box_low, label: '整理区间', color: '#9e9e9e' },
    ...od.ev.low_times.map((t, idx): ChartAnnotation => ({ type: 'marker', time: t, price: od.ev.push_lows[idx], label: `第${idx + 1}推`, role: 'point', position: 'below', color: '#ff9800' })),
    ...(od.confirm ? [] : [{ type: 'hline', from_time: time[od.place], to_time: time[end_idx], price: od.price, label: '限价挂单', style: 'dashed', color: '#ff9800' } as ChartAnnotation]),
  ];

  /** 成交后逐根模拟出场；数据不足返回 null */
  const simulate = (od: Order, g: number, E: number): BacktestTrade | null => {
    const notional = P.margin * P.leverage, fee = notional * P.fee_rate * 2;
    const pos = new_flag_position(P, E, od.top, od.lamp);
    let exit_idx = -1, exit_px = NaN, reason = '', breakout_idx = -1;
    if (!od.confirm) {   // 限价单在K线内成交：成交当根只判不利方向
      if (pos.stop !== null && l[g] <= pos.stop) { exit_idx = g; exit_px = pos.stop; reason = 'stop'; }
      else if (l[g] <= pos.liq) { exit_idx = g; exit_px = pos.liq; reason = 'liquidation'; }
    }
    for (let x = g + 1; exit_idx < 0; x++) {
      if (x >= n) return null;
      const ex = flag_exit_step(P, pos, { open: o[x], high: h[x], low: l[x], close: c[x] }, hist[x], hist[x - 1]);
      if (breakout_idx < 0 && pos.breakout) breakout_idx = x;
      if (ex) { exit_idx = x; exit_px = ex.price; reason = ex.reason; }
    }
    const pnl = flag_pnl(P, E, exit_px, reason);
    let mfe = 0, mae = Math.min(0, l[g] / E - 1);
    for (let x = g + 1; x <= exit_idx; x++) { mfe = Math.max(mfe, h[x] / E - 1); mae = Math.min(mae, l[x] / E - 1); }
    const tgt = pos.target, stop = pos.stop;
    const annotations: ChartAnnotation[] = [
      ...base_annotations(od, g),
      { type: 'hline', from_time: time[g], to_time: time[exit_idx], price: stop ?? pos.liq, label: stop !== null ? '止损' : '爆仓价', style: 'dashed', color: '#ef5350' },
      ...(Number.isFinite(tgt) ? [{ type: 'hline', from_time: time[g], to_time: time[exit_idx], price: tgt, label: '量度目标', style: 'dashed', color: '#26a69a' } as ChartAnnotation] : []),
      ...(breakout_idx >= 0 ? [{ type: 'marker', time: time[breakout_idx], price: od.top, label: '突破上沿', role: 'point', position: 'above', color: '#2962ff' } as ChartAnnotation] : []),
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

  for (let i = 0; i < n; i++) {
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

    // 2. 形态识别（第三推确认 → 过滤 → 挂单或直接入场）
    const ev = core.push({ time: time[i], open: o[i], high: h[i], low: l[i], close: c[i], quote: k.quote[i] });
    if (!ev) continue;
    const f = flag_filter_pass(P, ev);
    if (!f.pass) continue;
    const confirm = P.entry_mode === 'confirm';
    const od: Order = { place: i, price: ev.push_lows[2], top: ev.top, box_low: ev.box_low, lamp: ev.lamp, ev, confirm, features: flag_event_features(ev, f.dist) };
    if (!confirm) { orders.push(od); continue; }
    const t = simulate(od, i, c[i]);   // 确认K线收盘直接入场
    if (t) trades.push(t);
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
