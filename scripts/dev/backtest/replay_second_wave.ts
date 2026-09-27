/**
 * 第二波跟随 v2 离线回测
 *
 * 数据：second_wave_ground_truth.ts 生成的 1h K线缓存与第二波标注（不查数据库）
 * 评估：
 *   - 标注对照：信号落在哪类 setup 的入场窗口（精确率）、≥100M 第二波被信号覆盖的比例（召回率）
 *   - 交易模拟：入场 = 触发K线收盘，初始止损 = 信号 stop，三种出场口径，扣 0.1% 往返费用，以 R 计
 *       target  → 固定目标 H + 38.2% 幅度（与标注口径一致）
 *       ema20   → 1h 收盘跌破 EMA20 出场
 *       chand   → 吊灯止损：入场后最高价 - 3 × ATR14（不低于初始止损）
 *     同根K线先检查止损（保守）；跳空低开按开盘价成交；最长持有 240 根
 *   - 参数只做「单参数偏离默认值」的对照，不做全网格，降低过拟合
 *
 * 在服务器 /tmp 目录运行（数据在 SW_DIR）：
 *   SW_DIR=/tmp/sw_study/out nice -n 19 node --max-old-space-size=900 -r ts-node/register -r tsconfig-paths/register \
 *     scripts/dev/backtest/replay_second_wave.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { SecondWaveService, SecondWaveConfig, SecondWaveSignal, SwBar } from '@/services/second_wave/second_wave_service';

const H1 = 3600_000;
const FEE = 0.001;
const MAX_HOLD = 240;
const EVAL_FROM = Date.UTC(2026, 5, 1);
const SW_DIR = process.env.SW_DIR || 'exports';

type Exit = 'target' | 'ema20' | 'chand';
const EXITS: Exit[] = ['target', 'ema20', 'chand'];

interface Trade { sig: SecondWaveSignal; r: Record<Exit, number>; bars: Record<Exit, number>; label: string }

const VARIANTS: { name: string; overrides: Partial<SecondWaveConfig> }[] = [
  { name: '默认', overrides: {} },
  { name: '低点时限12根', overrides: { max_low_age_bars: 12 } },
  { name: '低点时限48根', overrides: { max_low_age_bars: 48 } },
  { name: '突破3根高点', overrides: { trigger_lookback: 3 } },
  { name: '突破8根高点', overrides: { trigger_lookback: 8 } },
  { name: '触发需放量1.2', overrides: { trigger_volume_ratio: 1.2 } },
  { name: '回撤≥38.2%才算回调', overrides: { setup_retrace: 0.382 } },
  { name: '观察上限48根', overrides: { max_watch_bars: 48 } },
  { name: '不限成交额(对照)', overrides: { min_quote_volume_m: 0 } },
];

/** EMA 序列 */
function ema_series(bars: SwBar[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const k = 2 / (period + 1);
  let e = NaN;
  for (let i = 0; i < bars.length; i++) {
    e = isNaN(e) ? bars[i].close : bars[i].close * k + e * (1 - k);
    if (i >= period - 1) out[i] = e;
  }
  return out;
}

/** Wilder ATR 序列 */
function atr_series(bars: SwBar[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  let a = NaN, sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i < period) { sum += tr; continue; }
    a = i === period ? (sum + tr) / period : (a * (period - 1) + tr) / period;
    out[i] = a;
  }
  return out;
}

/** 单笔交易模拟，返回各出场口径的 R（已扣费）与持有根数 */
function simulate(sig: SecondWaveSignal, bars: SwBar[], i0: number, ema: number[], atr: number[]) {
  const risk = sig.entry - sig.stop;
  const fee_r = FEE / sig.risk_pct;
  const target = sig.H + 0.382 * (sig.H - sig.L);
  const r: any = {}, held: any = {};

  for (const exit of EXITS) {
    let stop = sig.stop, hi = sig.entry, out = NaN, k = i0 + 1;
    for (; k < Math.min(bars.length, i0 + 1 + MAX_HOLD); k++) {
      const b = bars[k];
      if (b.low <= stop) { out = Math.min(b.open, stop); break; }
      if (exit === 'target' && b.high >= target) { out = Math.max(b.open, target); break; }
      if (exit === 'ema20' && b.close < ema[k]) { out = b.close; break; }
      hi = Math.max(hi, b.high);
      if (exit === 'chand' && atr[k] > 0) stop = Math.max(stop, hi - 3 * atr[k]);
    }
    if (isNaN(out)) { k = Math.min(bars.length, i0 + 1 + MAX_HOLD) - 1; out = bars[k].close; }
    r[exit] = (out - sig.entry) / risk - fee_r;
    held[exit] = k - i0;
  }
  return { r: r as Record<Exit, number>, bars: held as Record<Exit, number> };
}

/** R 序列统计 */
function stats(rs: number[]) {
  if (!rs.length) return null;
  const n = rs.length, m = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  const sorted = [...rs].sort((a, b) => b - a);
  const trim = sorted.slice(Math.ceil(n * 0.05));
  let eq = 0, peak = 0, dd = 0;
  for (const x of rs) { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return {
    n, win: rs.filter(x => x > 0).length / n, ev: m, t: sd ? m / (sd / Math.sqrt(n)) : 0,
    ev_trim: trim.reduce((a, b) => a + b, 0) / trim.length, sum: eq, max_dd: dd,
  };
}

const f2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(SW_DIR, 'sw_1h_cache.json'), 'utf8')) as Record<string, number[][]>;
  const all = new Map<string, SwBar[]>();
  for (const [s, arr] of Object.entries(raw)) {
    all.set(s, arr.map(([t, o, h, l, c, v]) => ({ open_time: t, open: o, high: h, low: l, close: c, volume: v })));
  }
  const labels = JSON.parse(fs.readFileSync(path.join(SW_DIR, 'second_wave_setups.json'), 'utf8')) as any[];
  const label_by = new Map<string, any[]>();
  for (const l of labels) { let a = label_by.get(l.symbol); if (!a) label_by.set(l.symbol, a = []); a.push(l); }
  const ind = new Map<string, { ema: number[]; atr: number[]; idx: Map<number, number> }>();
  for (const [s, bars] of all) {
    ind.set(s, { ema: ema_series(bars, 20), atr: atr_series(bars, 14), idx: new Map(bars.map((b, i) => [b.open_time, i])) });
  }
  const last_t = Math.max(...[...all.values()].map(b => b[b.length - 1]?.open_time ?? 0));
  const eval_to = last_t - MAX_HOLD * H1;   // 留足持仓窗口，避免尾部未完成交易
  const days = (eval_to - EVAL_FROM) / (24 * H1);

  const classify = (sym: string, t: number) => {
    const ss = (label_by.get(sym) ?? []).filter(l => t >= l.t_setup && t <= (l.t_break ?? l.t_end));
    if (!ss.length) return 'none';
    return ss.some(l => l.outcome === 'second_wave') ? 'second_wave' : ss[0].outcome;
  };

  const lines: string[] = [];
  const P = (s = '') => { lines.push(s); console.log(s); };
  P(`# 第二波 v2 回测（${new Date(EVAL_FROM).toISOString().slice(0, 10)} ~ ${new Date(eval_to).toISOString().slice(0, 10)}，${days.toFixed(0)} 天，扣 ${FEE * 100}% 费用，单位 R）`);
  P('\n| 变体 | 信号 | 每天 | 固定目标 EV / t / 胜率 | EMA20 EV / t / 胜率 | 吊灯 EV / t / 胜率 | 去掉前5%(吊灯) | 落在第二波 / 失败 / 超时 / 无 | 召回(≥100M第二波) |');
  P('|---|---|---|---|---|---|---|---|---|');

  let default_trades: Trade[] = [];
  for (const v of VARIANTS) {
    const trades: Trade[] = [];
    for (const [sym, bars] of all) {
      const svc = new SecondWaveService(v.overrides);
      const { ema, atr, idx } = ind.get(sym)!;
      for (const b of bars) {
        const sig = svc.process_bar(sym, b);
        if (!sig || sig.kline_time < EVAL_FROM || sig.kline_time > eval_to) continue;
        const i0 = idx.get(sig.kline_time)!;
        const sim = simulate(sig, bars, i0, ema, atr);
        trades.push({ sig, ...sim, label: classify(sym, sig.kline_time) });
      }
    }
    trades.sort((a, b) => a.sig.kline_time - b.sig.kline_time);
    if (v.name === '默认') default_trades = trades;

    const cell = (e: Exit) => { const s = stats(trades.map(t => t.r[e])); return s ? `${f2(s.ev)} / ${s.t.toFixed(1)} / ${(s.win * 100).toFixed(0)}%` : '-'; };
    const sc = stats(trades.map(t => t.r.chand));
    const lab = (k: string) => `${((trades.filter(t => t.label === k).length / (trades.length || 1)) * 100).toFixed(0)}%`;
    const pos = labels.filter(l => l.outcome === 'second_wave' && l.qv24_m >= 100 && l.t_H >= EVAL_FROM && l.t_H <= eval_to);
    const covered = pos.filter(l => trades.some(t => t.sig.symbol === l.symbol && t.sig.kline_time >= l.t_setup && t.sig.kline_time <= (l.t_break ?? l.t_end))).length;
    P(`| ${v.name} | ${trades.length} | ${(trades.length / days).toFixed(1)} | ${cell('target')} | ${cell('ema20')} | ${cell('chand')} | ${sc ? f2(sc.ev_trim) : '-'} | ${lab('second_wave')} / ${lab('failed')} / ${lab('timeout')} / ${lab('none')} | ${((covered / (pos.length || 1)) * 100).toFixed(0)}% (${covered}/${pos.length}) |`);
  }

  // 默认变体细节
  const T = default_trades;
  P('\n## 默认参数：按月（EV / 笔数）');
  P('| 月份 | 笔数 | 固定目标 | EMA20 | 吊灯 |'); P('|---|---|---|---|---|');
  const months = [...new Set(T.map(t => new Date(t.sig.kline_time).toISOString().slice(0, 7)))];
  for (const m of months) {
    const g = T.filter(t => new Date(t.sig.kline_time).toISOString().slice(0, 7) === m);
    P(`| ${m} | ${g.length} | ${EXITS.map(e => f2(stats(g.map(t => t.r[e]))!.ev)).join(' | ')} |`);
  }

  P('\n## 默认参数：各出场口径明细');
  P('| 口径 | 总R | 最大回撤R | 平均持有(根) | 中位R |'); P('|---|---|---|---|---|');
  for (const e of EXITS) {
    const s = stats(T.map(t => t.r[e]))!;
    const med = [...T.map(t => t.r[e])].sort((a, b) => a - b)[Math.floor(T.length / 2)];
    P(`| ${e} | ${f2(s.sum)} | ${s.max_dd.toFixed(1)} | ${(T.reduce((a, t) => a + t.bars[e], 0) / T.length).toFixed(0)} | ${f2(med)} |`);
  }

  P('\n## 默认参数：按信号特征分组（吊灯口径）');
  P('| 分组 | 笔数 | EV | t |'); P('|---|---|---|---|');
  const grp = (label: string, f: (t: Trade) => boolean) => {
    const s = stats(T.filter(f).map(t => t.r.chand));
    if (s) P(`| ${label} | ${s.n} | ${f2(s.ev)} | ${s.t.toFixed(1)} |`);
  };
  grp('回撤 < 38.2%', t => t.sig.retrace < 0.382);
  grp('回撤 38.2~61.8%', t => t.sig.retrace >= 0.382 && t.sig.retrace <= 0.618);
  grp('回撤 > 61.8%', t => t.sig.retrace > 0.618);
  grp('低点距高点 ≤ 8 根', t => t.sig.low_age_bars <= 8);
  grp('低点距高点 9~24 根', t => t.sig.low_age_bars > 8);
  grp('止损距离 ≤ 5%', t => t.sig.risk_pct <= 0.05);
  grp('止损距离 5~10%', t => t.sig.risk_pct > 0.05 && t.sig.risk_pct <= 0.10);
  grp('止损距离 > 10%', t => t.sig.risk_pct > 0.10);
  grp('24h成交额 100~300M', t => t.sig.qv24_m < 300);
  grp('24h成交额 ≥ 300M', t => t.sig.qv24_m >= 300);
  grp('第一波涨幅 < 20%', t => t.sig.gain < 0.2);
  grp('第一波涨幅 ≥ 20%', t => t.sig.gain >= 0.2);

  const bj = (t: number) => new Date(t + 8 * H1).toISOString().slice(5, 16).replace('T', ' ');
  P('\n## 默认参数：最近 20 笔信号');
  P('| 币种 | 触发(北京) | 入场 | 止损% | 回撤 | 标注 | 吊灯R | EMA20 R |'); P('|---|---|---|---|---|---|---|---|');
  for (const t of T.slice(-20)) {
    P(`| ${t.sig.symbol} | ${bj(t.sig.kline_time)} | ${t.sig.entry} | ${(t.sig.risk_pct * 100).toFixed(1)}% | ${(t.sig.retrace * 100).toFixed(0)}% | ${t.label} | ${f2(t.r.chand)} | ${f2(t.r.ema20)} |`);
  }

  fs.writeFileSync(path.join(SW_DIR, 'second_wave_backtest.md'), lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
