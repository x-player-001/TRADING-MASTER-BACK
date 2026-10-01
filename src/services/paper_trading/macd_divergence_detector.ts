/**
 * MACD 背离 + 反转K线 检测器（增量、纯计算、无 IO）
 *
 * 逐根喂入已收盘K线，在「反转K线」收盘时产出交易机会（DivergenceSetup）。
 * 逻辑与回测脚本逐行对齐（2026-10 研究，rev 口径）：
 *
 *   1. MACD(12,26,9)，柱 = 2×(DIF−DEA)；ATR14 为 Wilder 平滑；EMA 以首根收盘价起算
 *   2. 「峰」= 连续红柱段（顶）/ 绿柱段（底）。预热 150 根后才开始识别峰
 *   3. 新峰开始时，若前一峰 DIF 峰值在零轴同侧（>0），记录：
 *        ref  = 前峰起点到本峰开始前的最高价（参考高点）
 *        gdep = 两峰之间绿柱最深处 / 前峰红柱峰值
 *   4. 本峰内首次有K线最高价 > ref → 背离触发（每峰只触发一次），
 *      记录该根的 DIF 比、红柱比
 *   5. 触发后 0~3 根内（含触发K线本身）出现反转K线：顶 = 阴线且收盘在中点及以下
 *      → 产出 setup：条件单触发价 = 反转K线低点，基础止损 = 本峰至反转K线的最高价
 *
 * 底背离为镜像（ext 取 −low）。
 */

import { DivergenceDir, DivergenceSetup, PaperBar, PaperTimeframe } from './paper_types';

const WARM_BARS = 150;
const REVERSAL_WINDOW = 3;
const IMPULSE_LOOKBACK = 60;
const RANGE_BARS = 48;

/** 已完成的峰 */
interface Hump {
  s: number;     // 起始下标
  e: number;     // 结束下标
  ext: number;   // 峰内极值（ext 空间：顶=high，底=−low）
  dif: number;   // 峰内 dir×DIF 最大值
  hist: number;  // 峰内 dir×柱 最大值
}

/** 进行中的峰 */
interface CurrentHump extends Hump {
  fired: boolean;
  prev?: Hump;
  ref?: number;
  gdep?: number;
}

/** 已触发、等待反转K线的观察者 */
interface ReversalWatcher {
  i: number;           // 触发K线下标
  deadline: number;    // 最晚反转K线下标
  top: number;         // ext 空间极值（随后续K线更新）
  prev: Hump;
  cur_s: number;
  dif_ratio: number;
  hist_ratio: number;
  gdep: number;
}

/** 固定容量环形序列 + 增量指标 */
class IndicatorSeries {
  readonly cap: number;
  n = 0;
  readonly t: Float64Array; readonly ct: Float64Array;
  readonly o: Float64Array; readonly h: Float64Array; readonly l: Float64Array; readonly c: Float64Array;
  readonly q: Float64Array; readonly dif: Float64Array; readonly hist: Float64Array; readonly atr: Float64Array;
  readonly q24: Float64Array;
  private e12 = 0; private e26 = 0; private dea = 0; private q_acc = 0;

  constructor(cap: number, private readonly w24: number) {
    this.cap = cap;
    this.t = new Float64Array(cap); this.ct = new Float64Array(cap);
    this.o = new Float64Array(cap); this.h = new Float64Array(cap); this.l = new Float64Array(cap); this.c = new Float64Array(cap);
    this.q = new Float64Array(cap); this.dif = new Float64Array(cap); this.hist = new Float64Array(cap); this.atr = new Float64Array(cap);
    this.q24 = new Float64Array(cap);
  }

  /** 绝对下标 → 环形位置 */
  p(i: number): number { return i % this.cap; }

  /** 最早仍在缓冲区内的绝对下标 */
  first(): number { return Math.max(0, this.n - this.cap); }

  /** 追加一根K线并更新指标，返回其绝对下标 */
  push(bar: PaperBar): number {
    const i = this.n, k = this.p(i);
    this.t[k] = bar.open_time; this.ct[k] = bar.close_time;
    this.o[k] = bar.open; this.h[k] = bar.high; this.l[k] = bar.low; this.c[k] = bar.close; this.q[k] = bar.quote_volume;
    if (i === 0) {
      this.e12 = this.e26 = bar.close; this.dea = 0;
      this.atr[k] = bar.high - bar.low;
    } else {
      const pc = this.c[this.p(i - 1)];
      this.e12 = bar.close * (2 / 13) + this.e12 * (11 / 13);
      this.e26 = bar.close * (2 / 27) + this.e26 * (25 / 27);
      const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
      this.atr[k] = (this.atr[this.p(i - 1)] * 13 + tr) / 14;
    }
    const dif = this.e12 - this.e26;
    this.dea = i === 0 ? dif : dif * (2 / 10) + this.dea * (8 / 10);
    this.dif[k] = dif;
    this.hist[k] = 2 * (dif - this.dea);
    this.q_acc += bar.quote_volume;
    if (i >= this.w24) this.q_acc -= this.q[this.p(i - this.w24)];
    this.q24[k] = this.q_acc;
    this.n++;
    return i;
  }
}

export interface DetectorOptions {
  capacity?: number;
  directions?: DivergenceDir[];
}

export class MacdDivergenceDetector {
  private readonly s: IndicatorSeries;
  private readonly dirs: DivergenceDir[];
  private readonly last_hump = new Map<DivergenceDir, Hump | undefined>();
  private readonly cur = new Map<DivergenceDir, CurrentHump | null>();
  private watchers: { dir: DivergenceDir; w: ReversalWatcher }[] = [];

  constructor(readonly symbol: string, readonly timeframe: PaperTimeframe, opts: DetectorOptions = {}) {
    const bars_per_day = timeframe === '5m' ? 288 : 96;
    this.s = new IndicatorSeries(opts.capacity ?? 1200, bars_per_day);
    this.dirs = opts.directions ?? [1];
    for (const d of this.dirs) { this.last_hump.set(d, undefined); this.cur.set(d, null); }
  }

  /** 已处理K线数 */
  get bar_count(): number { return this.s.n; }

  /** 最后一根K线 open_time（无则 0） */
  get last_open_time(): number { return this.s.n ? this.s.t[this.s.p(this.s.n - 1)] : 0; }

  /** ext 空间取值：顶 = high，底 = −low */
  private ext(dir: DivergenceDir, i: number): number {
    const k = this.s.p(i);
    return dir > 0 ? this.s.h[k] : -this.s.l[k];
  }

  /** 喂入一根已收盘K线，返回本根收盘时成立的 setup */
  on_bar(bar: PaperBar): DivergenceSetup[] {
    const i = this.s.push(bar);
    const out: DivergenceSetup[] = [];

    // 1. 已触发的观察者：本根是否为反转K线
    this.check_watchers(i, out);

    // 2. 峰识别（预热后）
    if (i >= WARM_BARS) {
      for (const dir of this.dirs) this.step_hump(dir, i, out);
    }
    return out;
  }

  /** 推进某方向的峰状态 */
  private step_hump(dir: DivergenceDir, i: number, out: DivergenceSetup[]): void {
    const s = this.s, k = s.p(i);
    const hs = dir * s.hist[k];
    let cur = this.cur.get(dir) ?? null;

    if (hs > 0) {
      if (!cur) {
        cur = { s: i, e: i, ext: -Infinity, dif: -Infinity, hist: -Infinity, fired: false };
        const prev = this.last_hump.get(dir);
        cur.prev = prev;
        if (prev && prev.dif > 0) {
          let ref = -Infinity;
          for (let j = Math.max(prev.s, s.first()); j < i; j++) ref = Math.max(ref, this.ext(dir, j));
          let g = 0;
          for (let j = Math.max(prev.e + 1, s.first()); j < i; j++) g = Math.min(g, dir * s.hist[s.p(j)]);
          cur.ref = ref;
          cur.gdep = -g / prev.hist;
        }
        this.cur.set(dir, cur);
      }

      // 背离触发：本峰内首次创新高（每峰一次）
      if (!cur.fired && cur.ref !== undefined && cur.prev && this.ext(dir, i) > cur.ref) {
        cur.fired = true;
        const w: ReversalWatcher = {
          i,
          deadline: i + REVERSAL_WINDOW,
          top: cur.ext,               // 本峰 [s, i-1] 的极值；i 在 check 中并入
          prev: cur.prev,
          cur_s: cur.s,
          dif_ratio: dir * s.dif[k] / cur.prev.dif,
          hist_ratio: hs / cur.prev.hist,
          gdep: cur.gdep ?? 0,
        };
        const setup = this.advance_watcher(dir, w, i);
        if (setup) out.push(setup);
        else this.watchers.push({ dir, w });
      }

      if (this.ext(dir, i) > cur.ext) cur.ext = this.ext(dir, i);
      cur.dif = Math.max(cur.dif, dir * s.dif[k]);
      cur.hist = Math.max(cur.hist, hs);
      cur.e = i;
      return;
    }

    if (cur) {
      this.last_hump.set(dir, { s: cur.s, e: cur.e, ext: cur.ext, dif: cur.dif, hist: cur.hist });
      this.cur.set(dir, null);
    }
  }

  /** 处理等待中的观察者（不含本根新触发的） */
  private check_watchers(i: number, out: DivergenceSetup[]): void {
    if (this.watchers.length === 0) return;
    const keep: { dir: DivergenceDir; w: ReversalWatcher }[] = [];
    for (const item of this.watchers) {
      const setup = this.advance_watcher(item.dir, item.w, i);
      if (setup) out.push(setup);
      else if (i < item.w.deadline) keep.push(item);
    }
    this.watchers = keep;
  }

  /** 观察者推进到第 j 根：更新极值，若为反转K线则产出 setup */
  private advance_watcher(dir: DivergenceDir, w: ReversalWatcher, j: number): DivergenceSetup | null {
    const s = this.s, k = s.p(j);
    w.top = Math.max(w.top, this.ext(dir, j));
    const o = s.o[k], c = s.c[k], h = s.h[k], l = s.l[k];
    const is_reversal = dir * (o - c) > 0 && dir * ((h + l) / 2 - c) >= 0;
    if (!is_reversal) return null;
    return this.build_setup(dir, w, j);
  }

  /** 组装 setup 与特征 */
  private build_setup(dir: DivergenceDir, w: ReversalWatcher, rj: number): DivergenceSetup {
    const s = this.s, k = s.p(rj), first = s.first();
    const extreme = dir > 0 ? w.top : -w.top;
    const entry_trigger = dir > 0 ? s.l[k] : s.h[k];
    const atr = s.atr[k];

    let base = dir > 0 ? Infinity : -Infinity, lb = dir > 0 ? Infinity : -Infinity;
    for (let j = Math.max(first, w.prev.s - IMPULSE_LOOKBACK); j <= w.i; j++) {
      const p = s.p(j);
      base = dir > 0 ? Math.min(base, s.l[p]) : Math.max(base, s.h[p]);
    }
    for (let j = Math.max(first, w.prev.e + 1); j <= w.i; j++) {
      const p = s.p(j);
      lb = dir > 0 ? Math.min(lb, s.l[p]) : Math.max(lb, s.h[p]);
    }
    let rh = -Infinity, rl = Infinity;
    for (let j = Math.max(first, rj - RANGE_BARS + 1); j <= rj; j++) {
      const p = s.p(j);
      rh = Math.max(rh, s.h[p]); rl = Math.min(rl, s.l[p]);
    }
    const o = s.o[k], c = s.c[k], h = s.h[k], l = s.l[k];
    const rg = h - l || 1e-12;

    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      dir,
      trigger_time: s.t[s.p(w.i)],
      setup_time: s.t[k],
      setup_close_time: s.ct[k],
      entry_trigger,
      extreme,
      atr,
      features: {
        dif_ratio: w.dif_ratio,
        hist_ratio: w.hist_ratio,
        gap: w.cur_s - w.prev.e - 1,
        gdep: w.gdep,
        imp_pct: dir * (extreme - base) / base * 100,
        leg_pct: dir * (extreme - lb) / lb * 100,
        qv24_m: s.q24[k] / 1e6,
        atr_pct: atr / c * 100,
        range48: (rh - rl) / c * 100,
        wait: rj - w.i,
        wick: (dir > 0 ? h - Math.max(o, c) : Math.min(o, c) - l) / rg,
        body: Math.abs(o - c) / rg,
      },
    };
  }
}
