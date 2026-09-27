/**
 * 第二波跟随服务（v2，纯计算、无 I/O）
 *
 * 设计依据（scripts/dev/analysis/second_wave_ground_truth.ts 的 4 个月标注结果）：
 *   - 第一波形态（涨幅/ATR倍数/用时）无法区分后续第二波成败 → 第一波只做「准入」，不做打分
 *   - 回调见底快的更易走出第二波（低点距高点中位 11 根 vs 失败 25 根）→ 回调拖太久直接放弃
 *   - 回调中途的分级报警不是入场点 → 观察/回调阶段静默，只在第二波启动时发一个信号
 *
 * 流程（每币种一个上下文，1h 收盘驱动）：
 *   IDLE ──创7天新高且满足第一波条件──▶ IMPULSE ──回撤≥23.6%──▶ PULLBACK ──突破回调结构──▶ 信号(回到 IDLE)
 *                                           │                         │
 *                                           └──── 过深 / 超时 / 回调低点形成太晚 ──▶ 过期(回到 IDLE)
 */

// ==================== 类型定义 ====================

/** 1h K线（已收盘） */
export interface SwBar {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SwState = 'IDLE' | 'IMPULSE' | 'PULLBACK';

/** 单币种观察上下文 */
export interface SwContext {
  symbol: string;
  state: SwState;
  L: number;                 // 第一波起点（最低价）
  t_L: number;
  H: number;                 // 第一波高点（最高价）
  t_H: number;
  amp: number;               // H - L
  gain: number;              // 第一波涨幅 amp / L
  atr_mult: number;          // 第一波幅度 / ATR
  impulse_avg_volume: number;// 第一波期间平均成交量
  qv24_m: number;            // 高点处 24h 成交额（百万 USDT，close × volume 近似）
  P: number;                 // 回调最低价（Infinity 表示尚未回调）
  t_P: number;
  retrace: number;           // 当前回撤比例 (H - P) / amp
  bars_since_high: number;
  ready: boolean;            // 回调形态到位（仅用于观察名单排序展示，不推送）
}

/** 第二波启动信号（唯一推送） */
export interface SecondWaveSignal {
  symbol: string;
  kline_time: number;        // 触发K线 open_time
  entry: number;             // 触发K线收盘价
  stop: number;              // 回调低点下方 stop_buffer
  risk_pct: number;          // (entry - stop) / entry
  L: number;
  H: number;
  P: number;
  retrace: number;
  bars_since_high: number;
  low_age_bars: number;      // 回调低点距第一波高点的根数
  target_ref: number;        // 参考目标：P + 第一波幅度（等幅测算）
  qv24_m: number;
  gain: number;
}

export type SwWatchEvent = 'enter' | 'pullback' | 'ready' | 'expire' | 'trigger';

// ==================== 配置 ====================

const DEFAULT_CONFIG = {
  // 第一波准入
  new_high_bars: 168,            // 高点须是近 N 根（7 天）新高
  impulse_max_bars: 72,          // 起点 L 取高点前 N 根内最低点
  impulse_min_bars: 3,           // 第一波最少用时
  min_gain: 0.10,                // 涨幅 >= 10%
  min_atr_mult: 6,               // 幅度 >= 6 × ATR(起点处)
  atr_period: 14,
  min_quote_volume_m: 100,       // 24h 成交额 >= 100M（close × volume 近似）

  // 回调
  setup_retrace: 0.236,          // 回撤达到该比例才算进入回调
  fail_retrace: 0.786,           // 收盘回撤超过该比例 → 过期（过深）
  max_watch_bars: 72,            // 高点后 N 根仍未触发 → 过期（超时）
  max_low_age_bars: 24,          // 回调低点在高点后 N 根之后才形成 → 过期（回调拖太久）

  // 触发（第二波启动）
  trigger_lookback: 5,           // 收盘突破最近 N 根最高价
  trigger_volume_ratio: 0,       // >0 时要求触发K线量 >= 回调期均量 × 该值
  stop_buffer: 0.003,            // 止损 = 回调低点 × (1 - buffer)
  max_risk_pct: 0.15,            // 入场到止损超过 15% 不发信号

  // 「就绪」标记（仅展示）
  ready_min_retrace: 0.30,
  ready_max_retrace: 0.62,
  ready_volume_ratio: 0.7,       // 最近 3 根均量 < 第一波均量 × 该值

  max_cache_size: 400,
};

export type SecondWaveConfig = typeof DEFAULT_CONFIG;

// ==================== 服务类 ====================

export class SecondWaveService {
  private config: SecondWaveConfig;
  private bars: Map<string, SwBar[]> = new Map();
  private atrs: Map<string, number[]> = new Map();
  private contexts: Map<string, SwContext> = new Map();

  private on_signal_cb?: (signal: SecondWaveSignal) => void;
  private on_watch_change_cb?: (ctx: SwContext, event: SwWatchEvent, reason?: string) => void;

  constructor(config_overrides?: Partial<SecondWaveConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config_overrides };
  }

  /** 注册第二波信号回调 */
  on_signal(cb: (signal: SecondWaveSignal) => void): void {
    this.on_signal_cb = cb;
  }

  /** 注册观察名单变化回调（进入 / 回调 / 就绪 / 过期 / 触发） */
  on_watch_change(cb: (ctx: SwContext, event: SwWatchEvent, reason?: string) => void): void {
    this.on_watch_change_cb = cb;
  }

  /** 当前观察名单（IMPULSE / PULLBACK），就绪的排前面 */
  get_watchlist(): SwContext[] {
    return Array.from(this.contexts.values())
      .filter(c => c.state !== 'IDLE')
      .sort((a, b) => Number(b.ready) - Number(a.ready) || b.qv24_m - a.qv24_m);
  }

  /** 冷启动预热：只灌历史K线，不做状态判断 */
  init_history(symbol: string, history: SwBar[]): void {
    this.bars.set(symbol, []);
    this.atrs.set(symbol, []);
    for (const b of history) this._append_bar(symbol, b);
  }

  /** 喂入一根已收盘 1h K线；触发第二波时返回信号 */
  process_bar(symbol: string, bar: SwBar): SecondWaveSignal | null {
    if (!this._append_bar(symbol, bar)) return null;
    const bars = this.bars.get(symbol)!;
    if (bars.length <= this.config.new_high_bars) return null;

    const ctx = this._get_context(symbol);
    const i = bars.length - 1;

    if (ctx.state === 'IDLE') {
      if (this._is_new_high(bars, i)) this._try_impulse(ctx, i);
      return null;
    }

    // 已在观察中：创新高 → 第一波延续（未触发就越过前高，按新高点重新评估）
    if (bar.high > ctx.H) {
      if (!this._try_impulse(ctx, i)) this._expire(ctx, '越过前高但不再满足第一波条件');
      return null;
    }
    return this._update_pullback(ctx, bars, i);
  }

  // ==================== 核心逻辑 ====================

  /** 追加K线并增量更新 ATR；重复 open_time 视为同一根（覆盖）。返回是否为新K线 */
  private _append_bar(symbol: string, bar: SwBar): boolean {
    let bars = this.bars.get(symbol);
    let atrs = this.atrs.get(symbol);
    if (!bars || !atrs) {
      bars = []; atrs = [];
      this.bars.set(symbol, bars);
      this.atrs.set(symbol, atrs);
    }
    const last = bars[bars.length - 1];
    if (last && bar.open_time <= last.open_time) {
      if (bar.open_time === last.open_time) bars[bars.length - 1] = bar;
      return false;
    }

    const p = this.config.atr_period;
    const prev_atr = atrs.length ? atrs[atrs.length - 1] : NaN;
    const tr = last
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - last.close), Math.abs(bar.low - last.close))
      : bar.high - bar.low;
    // 前 period 根用简单均值起步，之后 Wilder 平滑
    let atr: number;
    if (bars.length < p) {
      const sum = (isNaN(prev_atr) ? 0 : prev_atr * bars.length) + tr;
      atr = sum / (bars.length + 1);
    } else {
      atr = (prev_atr * (p - 1) + tr) / p;
    }
    bars.push(bar);
    atrs.push(atr);

    if (bars.length > this.config.max_cache_size) {
      bars.shift();
      atrs.shift();
    }
    return true;
  }

  private _get_context(symbol: string): SwContext {
    let ctx = this.contexts.get(symbol);
    if (!ctx) {
      ctx = this._empty_context(symbol);
      this.contexts.set(symbol, ctx);
    }
    return ctx;
  }

  private _empty_context(symbol: string): SwContext {
    return {
      symbol, state: 'IDLE', L: 0, t_L: 0, H: 0, t_H: 0, amp: 0, gain: 0, atr_mult: 0,
      impulse_avg_volume: 0, qv24_m: 0, P: Infinity, t_P: 0, retrace: 0, bars_since_high: 0, ready: false,
    };
  }

  /** 当前K线最高价是否为近 new_high_bars 根新高 */
  private _is_new_high(bars: SwBar[], i: number): boolean {
    const h = bars[i].high;
    for (let k = i - this.config.new_high_bars; k < i; k++) {
      if (bars[k].high > h) return false;
    }
    return true;
  }

  /** 以第 i 根为高点尝试建立第一波；满足条件则进入 IMPULSE */
  private _try_impulse(ctx: SwContext, i: number): boolean {
    const bars = this.bars.get(ctx.symbol)!;
    const atrs = this.atrs.get(ctx.symbol)!;
    const c = this.config;

    let j_L = i;
    for (let k = Math.max(0, i - c.impulse_max_bars); k < i; k++) {
      if (bars[k].low < bars[j_L].low) j_L = k;
    }
    const L = bars[j_L].low;
    const H = bars[i].high;
    const amp = H - L;
    const atr = atrs[j_L];
    if (i - j_L < c.impulse_min_bars || !(atr > 0) || !(L > 0)) return false;
    if (amp / L < c.min_gain || amp / atr < c.min_atr_mult) return false;

    let qv = 0;
    for (let k = Math.max(0, i - 23); k <= i; k++) qv += bars[k].close * bars[k].volume;
    if (qv / 1e6 < c.min_quote_volume_m) return false;

    let vol_sum = 0;
    for (let k = j_L; k <= i; k++) vol_sum += bars[k].volume;

    const was_idle = ctx.state === 'IDLE';
    Object.assign(ctx, {
      state: 'IMPULSE' as SwState,
      L, t_L: bars[j_L].open_time, H, t_H: bars[i].open_time, amp,
      gain: amp / L, atr_mult: amp / atr,
      impulse_avg_volume: vol_sum / (i - j_L + 1),
      qv24_m: qv / 1e6,
      P: Infinity, t_P: 0, retrace: 0, bars_since_high: 0, ready: false,
    });
    this.on_watch_change_cb?.({ ...ctx }, 'enter', was_idle ? undefined : '第一波延续，更新高点');
    return true;
  }

  /** 回调阶段：更新回撤、判断过期 / 就绪 / 触发 */
  private _update_pullback(ctx: SwContext, bars: SwBar[], i: number): SecondWaveSignal | null {
    const c = this.config;
    const bar = bars[i];
    const i_H = this._index_of(bars, ctx.t_H);
    ctx.bars_since_high = i_H >= 0 ? i - i_H : ctx.bars_since_high + 1;

    const new_low = bar.low < ctx.P;
    if (new_low) {
      ctx.P = bar.low;
      ctx.t_P = bar.open_time;
    }
    ctx.retrace = (ctx.H - ctx.P) / ctx.amp;

    // ---- 过期条件 ----
    if ((ctx.H - bar.close) / ctx.amp > c.fail_retrace) {
      return this._expire(ctx, `收盘回撤 ${(((ctx.H - bar.close) / ctx.amp) * 100).toFixed(0)}% 超过 ${c.fail_retrace * 100}%`);
    }
    if (ctx.bars_since_high > c.max_watch_bars) {
      return this._expire(ctx, `高点后 ${ctx.bars_since_high} 根未启动第二波`);
    }
    if (new_low && ctx.state === 'PULLBACK' && ctx.bars_since_high > c.max_low_age_bars) {
      return this._expire(ctx, `回调低点在高点后第 ${ctx.bars_since_high} 根才形成，回调拖太久`);
    }

    // ---- 进入回调 ----
    if (ctx.state === 'IMPULSE') {
      if (ctx.retrace < c.setup_retrace) return null;
      if (ctx.bars_since_high > c.max_low_age_bars) {
        return this._expire(ctx, `高点后第 ${ctx.bars_since_high} 根才回撤到位，回调拖太久`);
      }
      ctx.state = 'PULLBACK';
      this.on_watch_change_cb?.({ ...ctx }, 'pullback');
    }

    // ---- 就绪标记（展示用） ----
    const recent = bars.slice(-3);
    const recent_avg_vol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
    const ready = ctx.retrace >= c.ready_min_retrace && ctx.retrace <= c.ready_max_retrace
      && recent_avg_vol < ctx.impulse_avg_volume * c.ready_volume_ratio;
    if (ready && !ctx.ready) this.on_watch_change_cb?.({ ...ctx, ready }, 'ready');
    ctx.ready = ready;

    // ---- 触发：收盘突破最近 N 根高点（本根创回调新低时不触发），且仍在前高下方 ----
    if (new_low || i < c.trigger_lookback) return null;
    let recent_high = -Infinity;
    for (let k = i - c.trigger_lookback; k < i; k++) recent_high = Math.max(recent_high, bars[k].high);
    if (bar.close <= recent_high || bar.close > ctx.H) return null;

    if (c.trigger_volume_ratio > 0 && i_H >= 0) {
      let s = 0;
      for (let k = i_H + 1; k < i; k++) s += bars[k].volume;
      const pb_avg = s / Math.max(1, i - i_H - 1);
      if (bar.volume < pb_avg * c.trigger_volume_ratio) return null;
    }

    const stop = ctx.P * (1 - c.stop_buffer);
    const risk_pct = (bar.close - stop) / bar.close;
    if (risk_pct <= 0 || risk_pct > c.max_risk_pct) return null;

    const i_P = this._index_of(bars, ctx.t_P);
    const signal: SecondWaveSignal = {
      symbol: ctx.symbol,
      kline_time: bar.open_time,
      entry: bar.close,
      stop,
      risk_pct,
      L: ctx.L, H: ctx.H, P: ctx.P,
      retrace: ctx.retrace,
      bars_since_high: ctx.bars_since_high,
      low_age_bars: i_H >= 0 && i_P >= 0 ? i_P - i_H : 0,
      target_ref: ctx.P + ctx.amp,
      qv24_m: ctx.qv24_m,
      gain: ctx.gain,
    };
    this.on_watch_change_cb?.({ ...ctx }, 'trigger');
    this._reset(ctx);
    this.on_signal_cb?.(signal);
    return signal;
  }

  /** 过期并回到 IDLE */
  private _expire(ctx: SwContext, reason: string): null {
    this.on_watch_change_cb?.({ ...ctx }, 'expire', reason);
    this._reset(ctx);
    return null;
  }

  private _reset(ctx: SwContext): void {
    Object.assign(ctx, this._empty_context(ctx.symbol));
  }

  /** 按 open_time 查缓存下标（从尾部找，观察窗口都在近期） */
  private _index_of(bars: SwBar[], open_time: number): number {
    for (let k = bars.length - 1; k >= 0; k--) {
      if (bars[k].open_time === open_time) return k;
      if (bars[k].open_time < open_time) break;
    }
    return -1;
  }
}
