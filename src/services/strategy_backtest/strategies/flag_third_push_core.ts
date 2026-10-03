/**
 * 高位整理第三推：识别与出场的核心逻辑（逐根增量，回测与模拟盘共用）
 *
 * - FlagThirdPushCore：逐根喂入已收盘K线，维护 MACD / 24h 成交额 / 推动波 / 整理三推状态，
 *   第三推确认的那根K线返回事件（含全部过滤特征，是否入场由 flag_filter_pass 按参数判断）。
 *   回测（flag_third_push.ts）与模拟盘（paper_trading）都用它，保证两边识别逐根一致。
 * - flag_exit_step：持仓逐根出场判断（爆仓/止损 → 量度目标 → 突破后 MACD 柱缩短 → 未突破超时 → 持仓到时）。
 */

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

export const FLAG_THIRD_PUSH_CONFIRM_DEFAULTS: FlagThirdPushParams = {
  ...FLAG_THIRD_PUSH_DEFAULTS,
  entry_mode: 'confirm',
  max_hi_trend: 0,
};

export const FLAG_THIRD_PUSH_EXIT_REASONS: Record<string, string> = {
  target: '到量度目标',
  macd_shrink: '突破后 MACD 柱首次缩短',
  no_breakout: '规定根数内未突破区间上沿',
  liquidation: '爆仓（未设止损）',
  stop: '止损',
  time: '持仓到时',
};

/** 喂给核心的已收盘K线 */
export interface CoreBar {
  time: number;       // open_time
  open: number;
  high: number;
  low: number;
  close: number;
  quote: number;      // 成交额（close × volume）
}

/** 第三推确认事件（在确认K线收盘时产生；索引为喂入顺序的全局序号） */
export interface ThirdPushEvent {
  index: number;
  time: number;
  close: number;
  s0: number;              // 可见拉升段起点
  p: number;               // 推动高点
  lows: number[];          // 三推低点
  s0_time: number;
  p_time: number;
  low_times: number[];
  s0_low: number;
  p_high: number;
  push_lows: number[];     // 三推低点价
  top: number;             // 区间上沿（影线最高）
  box_low: number;         // 区间最低
  lamp: number;            // 拉升高度
  qv24: number;
  leg_bars: number;
  leg_pct: number;
  leg_max_bar: number;
  impulse_pct: number;
  retr: number;
  lows_rising: boolean;
  lows_flat: boolean;
  lows_ge_first: boolean;
  pre_waves: number;
  hi_trend: number;
  cons_bars: number;
}

interface Setup {
  a: number;
  L0: number;
  H: number;
  p: number;
  top: number;
  low: number;
  lows: number[];
}

const K12 = 2 / 13, K26 = 2 / 27, K9 = 2 / 10;

/**
 * 逐根增量识别
 * @param keep 最多保留的K线根数（模拟盘长时间运行用，Infinity 为不裁剪）
 */
export class FlagThirdPushCore {
  private readonly O: number[] = [];
  private readonly H: number[] = [];
  private readonly L: number[] = [];
  private readonly C: number[] = [];
  private readonly Q: number[] = [];
  private readonly T: number[] = [];
  private readonly HIST: number[] = [];
  private base = 0;                 // 数组首元素对应的全局序号
  private count = 0;                // 已喂入根数
  private qv_sum = 0;
  private e12 = 0;
  private e26 = 0;
  private dea = 0;
  private readonly dq: number[] = [];   // 前 high_lookback 根最高价的单调队列（全局序号）
  private waves: number[] = [];
  private st: Setup | null = null;
  private readonly start: number;

  constructor(private readonly P: FlagThirdPushParams, private readonly bars_per_day: number, private readonly keep = Infinity) {
    this.start = Math.max(P.high_lookback, bars_per_day + 1);
  }

  /** 已喂入根数 */
  get length(): number {
    return this.count;
  }

  /** 某根的 MACD 柱（已裁剪或越界为 NaN） */
  hist_at(i: number): number {
    const v = this.HIST[i - this.base];
    return v === undefined ? NaN : v;
  }

  private h(i: number): number { return this.H[i - this.base]; }
  private l(i: number): number { return this.L[i - this.base]; }
  private o(i: number): number { return this.O[i - this.base]; }
  private c(i: number): number { return this.C[i - this.base]; }
  private t(i: number): number { return this.T[i - this.base]; }

  /** 喂入一根已收盘K线；第三推确认时返回事件 */
  push(bar: CoreBar): ThirdPushEvent | null {
    const i = this.count++;
    const P = this.P, D = this.bars_per_day;
    this.O.push(bar.open); this.H.push(bar.high); this.L.push(bar.low); this.C.push(bar.close); this.Q.push(bar.quote); this.T.push(bar.time);

    // 24h 成交额（含当前根）
    this.qv_sum += bar.quote;
    if (i >= D) this.qv_sum -= this.Q[i - D - this.base];
    // MACD（与 series_utils.ema 相同递推：首值取第一根）
    if (i === 0) { this.e12 = bar.close; this.e26 = bar.close; }
    else { this.e12 = bar.close * K12 + this.e12 * (1 - K12); this.e26 = bar.close * K26 + this.e26 * (1 - K26); }
    const dif = this.e12 - this.e26;
    this.dea = i === 0 ? dif : dif * K9 + this.dea * (1 - K9);
    this.HIST.push(2 * (dif - this.dea));
    // 前 high_lookback 根最高价
    while (this.dq.length && this.dq[0] < i - P.high_lookback) this.dq.shift();
    const prev_max = this.dq.length ? this.h(this.dq[0]) : -Infinity;
    while (this.dq.length && this.h(this.dq[this.dq.length - 1]) <= bar.high) this.dq.pop();
    this.dq.push(i);

    const ev = i >= this.start ? this.step(i, prev_max) : null;
    this.trim();
    return ev;
  }

  /** 形态状态机（单根） */
  private step(i: number, prev_max: number): ThirdPushEvent | null {
    const P = this.P;
    const st = this.st;
    if (st) {
      const cons = i - 1 - st.p;
      if (this.c(i) > st.top) {
        if (cons < P.cons_min) {   // 回调太短：推动延续
          st.p = i; st.H = Math.max(st.H, this.h(i)); st.top = st.H; st.low = Infinity; st.lows = [];
          return null;
        }
        this.st = null;            // 收盘突破，本段结束（本根仍可成为新推动高点）
      } else {
        st.top = Math.max(st.top, this.h(i)); st.low = Math.min(st.low, this.l(i));
        if ((st.H - st.low) / (st.H - st.L0) > P.retr_max || this.l(i) < st.L0 || cons + 1 > P.cons_max || st.a < this.base) { this.st = null; return null; }
        const j = i - 2, l = (x: number) => this.l(x);
        if (j - 2 >= st.p && l(j) <= l(j - 1) && l(j) <= l(j - 2) && l(j) < l(j + 1) && l(j) < l(j + 2)) {
          if (this.add_push(st, j) && st.lows.length === 3) return this.make_event(st, i);
        }
        return null;
      }
    }
    // 识别推动高点
    if (this.h(i) < prev_max) return null;
    let L0 = Infinity, a = -1;
    for (let j = i - P.imp_lookback; j <= i; j++) if (this.l(j) < L0) { L0 = this.l(j); a = j; }
    if (this.h(i) / L0 - 1 < P.imp_min) return null;
    this.st = { a, L0, H: this.h(i), p: i, top: this.h(i), low: Infinity, lows: [] };
    this.waves.push(i);
    return null;
  }

  /** 新的分型低点归入推序列：新的一推返回 true；同一推内更低则替换低点 */
  private add_push(s: Setup, j: number): boolean {
    if (!s.lows.length) { s.lows.push(j); return true; }
    const q = s.lows[s.lows.length - 1];
    let hb = -Infinity;
    for (let x = q + 1; x < j; x++) hb = Math.max(hb, this.h(x));
    if (hb - Math.max(this.l(q), this.l(j)) >= this.P.push_bounce * (s.top - Math.min(this.l(q), this.l(j)))) { s.lows.push(j); return true; }
    if (this.l(j) < this.l(q)) s.lows[s.lows.length - 1] = j;
    return false;
  }

  /** 第三推确认：计算全部特征 */
  private make_event(s: Setup, i: number): ThirdPushEvent {
    const P = this.P, amp = s.H - s.L0;
    let s0 = s.a;
    for (let x = s.p; x >= s.a; x--) if (this.l(x) <= s.L0 + 0.35 * amp) { s0 = x; break; }
    const lamp = s.H - this.l(s0);
    let max_bar = 0;
    for (let x = s0; x <= s.p; x++) max_bar = Math.max(max_bar, (this.c(x) - this.o(x)) / lamp);
    const pl = s.lows.map(x => this.l(x));
    const tol = P.lows_tolerance * (s.top - Math.min(s.low, ...pl));
    const [j1, j2, j3] = s.lows;
    let hb12 = -Infinity, hb23 = -Infinity;
    for (let x = j1 + 1; x <= j2; x++) hb12 = Math.max(hb12, this.h(x));
    for (let x = j2 + 1; x <= j3; x++) hb23 = Math.max(hb23, this.h(x));
    return {
      index: i, time: this.t(i), close: this.c(i),
      s0, p: s.p, lows: s.lows.slice(),
      s0_time: this.t(s0), p_time: this.t(s.p), low_times: s.lows.map(x => this.t(x)),
      s0_low: this.l(s0), p_high: this.h(s.p), push_lows: pl,
      top: s.top, box_low: s.low, lamp,
      qv24: this.qv_sum,
      leg_bars: s.p - s0 + 1,
      leg_pct: s.H / this.l(s0) - 1,
      leg_max_bar: max_bar,
      impulse_pct: s.H / s.L0 - 1,
      retr: (s.H - s.low) / amp,
      lows_rising: pl[1] >= pl[0] && pl[2] >= pl[1],
      lows_flat: pl[1] >= pl[0] - tol && pl[2] >= pl[1] - tol,
      lows_ge_first: pl[2] >= pl[0] - tol,
      pre_waves: this.waves.filter(x => x < s0 && x >= s0 - this.bars_per_day).length,
      hi_trend: (hb23 - hb12) / (s.top - s.low),
      cons_bars: i - s.p,
    };
  }

  /** 裁剪过旧的K线（只在 keep 有限时） */
  private trim(): void {
    if (!Number.isFinite(this.keep) || this.count - this.base <= this.keep * 2) return;
    const drop = this.count - this.base - this.keep;
    for (const arr of [this.O, this.H, this.L, this.C, this.Q, this.T, this.HIST]) arr.splice(0, drop);
    this.base += drop;
    this.waves = this.waves.filter(x => x >= this.base);
  }
}

/** 按参数判断事件是否入场；dist 为入场价离区间上沿（限价=第三推低点，确认=收盘价） */
export function flag_filter_pass(P: FlagThirdPushParams, ev: ThirdPushEvent): { pass: boolean; entry_ref: number; dist: number } {
  const entry_ref = P.entry_mode === 'confirm' ? ev.close : ev.push_lows[2];
  const dist = ev.top / entry_ref - 1;
  const lows_ok = P.lows_mode === 'any' || (P.lows_mode === 'rising' ? ev.lows_rising : P.lows_mode === 'flat' ? ev.lows_flat : ev.lows_ge_first);
  const pass = ev.qv24 >= P.min_qv24 && ev.leg_bars >= P.leg_min_bars && ev.leg_max_bar <= P.leg_max_bar_ratio
    && ev.leg_pct >= P.leg_min_pct && ev.leg_pct <= P.leg_max_pct && ev.retr <= P.retr_limit && lows_ok
    && ev.pre_waves <= P.max_pre_waves && dist <= P.max_dist_to_top
    && (P.min_dist_to_top === null || dist >= P.min_dist_to_top)
    && (P.max_hi_trend === null || ev.hi_trend <= P.max_hi_trend);
  return { pass, entry_ref, dist };
}

/** 持仓状态（出场逐根判断用） */
export interface FlagPosition {
  entry_price: number;
  top: number;              // 区间上沿
  target: number;           // 量度目标（不设为 Infinity）
  liq: number;              // 爆仓价
  stop: number | null;      // 硬止损
  bars: number;             // 已持仓根数（成交K线之后）
  breakout: boolean;        // 是否已突破区间上沿
}

/** 新建持仓状态 */
export function new_flag_position(P: FlagThirdPushParams, entry_price: number, top: number, lamp: number): FlagPosition {
  return {
    entry_price, top,
    target: P.exit_mode === 'macd' ? Infinity : top + lamp,
    liq: entry_price * (1 - P.liq_drop),
    stop: P.stop_pct !== null ? entry_price * (1 - P.stop_pct) : null,
    bars: 0,
    breakout: false,
  };
}

/** 持仓推进一根K线（同根先判不利方向）；出场返回价格与原因，否则 null */
export function flag_exit_step(
  P: FlagThirdPushParams, pos: FlagPosition,
  bar: { open: number; high: number; low: number; close: number },
  hist: number, hist_prev: number,
): { price: number; reason: string } | null {
  pos.bars++;
  if (pos.stop !== null && pos.stop > pos.liq) {
    if (bar.open <= pos.stop) return { price: bar.open, reason: 'stop' };
    if (bar.low <= pos.stop) return { price: pos.stop, reason: 'stop' };
  } else if (bar.low <= pos.liq) return { price: pos.liq, reason: 'liquidation' };
  if (bar.high >= pos.target) return { price: Math.max(pos.target, bar.open), reason: 'target' };
  if (!pos.breakout && bar.high > pos.top) pos.breakout = true;
  if (pos.breakout && P.exit_mode !== 'target' && hist < hist_prev) return { price: bar.close, reason: 'macd_shrink' };
  if (!pos.breakout && pos.bars >= P.breakout_wait_bars) return { price: bar.close, reason: 'no_breakout' };
  if (pos.bars >= P.max_hold_bars) return { price: bar.close, reason: 'time' };
  return null;
}

/** 平仓净盈亏（USDT）：爆仓亏光保证金，否则按名义仓位扣双边手续费 */
export function flag_pnl(P: FlagThirdPushParams, entry_price: number, exit_price: number, reason: string): number {
  const notional = P.margin * P.leverage;
  return reason === 'liquidation' ? -P.margin : notional * (exit_price / entry_price - 1) - notional * P.fee_rate * 2;
}
