/**
 * MACD 背离检测器：与回测脚本（批量数组版）逐信号对拍
 *
 * reference_setups 为回测 gen.js「反转K线口径」的原样移植（去掉结果模拟部分），
 * 增量检测器在同一组随机行情上必须产出完全相同的 setup 与特征。
 */

import { MacdDivergenceDetector } from '@/services/paper_trading/macd_divergence_detector';
import { DivergenceDir, PaperBar } from '@/services/paper_trading/paper_types';

/** 可复现随机数 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** 生成带趋势段与波动爆发的随机 5m 行情 */
function make_bars(n: number, seed: number): PaperBar[] {
  const r = rng(seed);
  const bars: PaperBar[] = [];
  let price = 1, drift = 0, vol = 0.004;
  for (let i = 0; i < n; i++) {
    if (r() < 0.02) drift = (r() - 0.45) * 0.006;
    if (r() < 0.02) vol = 0.002 + r() * 0.012;
    const o = price;
    const c = Math.max(1e-6, o * (1 + drift + (r() - 0.5) * 2 * vol));
    const h = Math.max(o, c) * (1 + r() * vol);
    const l = Math.min(o, c) * (1 - r() * vol);
    const v = 1e6 * (0.5 + r() * 3);
    bars.push({ open_time: i * 300_000, close_time: i * 300_000 + 299_999, open: o, high: h, low: l, close: c, volume: v, quote_volume: c * v });
    price = c;
  }
  return bars;
}

/** 回测脚本 rev 口径原样移植（批量数组） */
function reference_setups(bars: PaperBar[], dir: DivergenceDir, W24 = 288) {
  const n = bars.length, WARM = 150;
  const o = bars.map(b => b.open), h = bars.map(b => b.high), l = bars.map(b => b.low), c = bars.map(b => b.close), q = bars.map(b => b.quote_volume);
  const ema = (x: number[], p: number) => { const k = 2 / (p + 1), out = new Array(x.length); out[0] = x[0]; for (let i = 1; i < x.length; i++) out[i] = x[i] * k + out[i - 1] * (1 - k); return out; };
  const e12 = ema(c, 12), e26 = ema(c, 26), dif = e12.map((v, i) => v - e26[i]), dea = ema(dif, 9), hist = dif.map((v, i) => 2 * (v - dea[i]));
  const atr = new Array(n); atr[0] = h[0] - l[0];
  for (let i = 1; i < n; i++) { const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); atr[i] = (atr[i - 1] * 13 + tr) / 14; }
  const q24 = new Array(n); let acc = 0; for (let i = 0; i < n; i++) { acc += q[i]; if (i >= W24) acc -= q[i - W24]; q24[i] = acc; }
  const ext = (i: number) => dir > 0 ? h[i] : -l[i];
  const humps: any[] = []; let cur: any = null; const out: any[] = [];
  for (let i = WARM; i < n; i++) {
    const hs = dir * hist[i];
    if (hs > 0) {
      if (!cur) {
        cur = { s: i, ext: -Infinity, dif: -Infinity, hist: -Infinity, fired: false };
        const P = humps[humps.length - 1]; cur.P = P;
        if (P && P.dif > 0) { let r = -Infinity; for (let j = P.s; j < i; j++) r = Math.max(r, ext(j)); cur.ref = r; let g = 0; for (let j = P.e + 1; j < i; j++) g = Math.min(g, dir * hist[j]); cur.gdep = -g / P.hist; }
      }
      if (!cur.fired && cur.ref !== undefined && ext(i) > cur.ref) {
        cur.fired = true;
        const P = cur.P; let top = -Infinity; for (let j = cur.s; j < i; j++) top = Math.max(top, ext(j)); let rj = -1;
        for (let j = i; j <= Math.min(i + 3, n - 1); j++) { top = Math.max(top, ext(j)); if (dir * (o[j] - c[j]) > 0 && dir * ((h[j] + l[j]) / 2 - c[j]) >= 0) { rj = j; break; } }
        if (rj >= 0) {
          const stp = dir > 0 ? top : -top;
          let base = dir > 0 ? Infinity : -Infinity, lb = dir > 0 ? Infinity : -Infinity;
          for (let j = Math.max(0, P.s - 60); j <= i; j++) base = dir > 0 ? Math.min(base, l[j]) : Math.max(base, h[j]);
          for (let j = P.e + 1; j <= i; j++) lb = dir > 0 ? Math.min(lb, l[j]) : Math.max(lb, h[j]);
          let rh = -Infinity, rl = Infinity; for (let j = Math.max(0, rj - 47); j <= rj; j++) { rh = Math.max(rh, h[j]); rl = Math.min(rl, l[j]); }
          out.push({
            setup_time: bars[rj].open_time, trigger_time: bars[i].open_time,
            entry_trigger: dir > 0 ? l[rj] : h[rj], extreme: stp,
            dif_ratio: dir * dif[i] / P.dif, hist_ratio: hs / P.hist, gap: cur.s - P.e - 1, gdep: cur.gdep,
            imp_pct: dir * (stp - base) / base * 100, leg_pct: dir * (stp - lb) / lb * 100,
            qv24_m: q24[rj] / 1e6, qv_surge: rj - W24 >= 0 ? q24[rj] / q24[rj - W24] : NaN, range48: (rh - rl) / c[rj] * 100, wait: rj - i,
          });
        }
      }
      if (ext(i) > cur.ext) cur.ext = ext(i);
      cur.dif = Math.max(cur.dif, dir * dif[i]); cur.hist = Math.max(cur.hist, hs); cur.e = i;
      continue;
    }
    if (!cur) continue;
    humps.push(cur); cur = null;
  }
  return out;
}

describe('MacdDivergenceDetector', () => {
  for (const dir of [1, -1] as DivergenceDir[]) {
    for (const seed of [1, 7, 42]) {
      it(`与回测参照实现逐信号一致（dir=${dir}, seed=${seed}）`, () => {
        const bars = make_bars(6000, seed);
        const expected = reference_setups(bars, dir);
        const det = new MacdDivergenceDetector('TESTUSDT', '5m', { directions: [dir], capacity: 1200 });
        const actual = bars.flatMap(b => det.on_bar(b));

        expect(expected.length).toBeGreaterThan(20);
        expect(actual.length).toBe(expected.length);
        actual.forEach((a, idx) => {
          const e = expected[idx];
          expect(a.setup_time).toBe(e.setup_time);
          expect(a.trigger_time).toBe(e.trigger_time);
          expect(a.entry_trigger).toBeCloseTo(e.entry_trigger, 12);
          expect(a.extreme).toBeCloseTo(e.extreme, 12);
          expect(a.features.dif_ratio).toBeCloseTo(e.dif_ratio, 9);
          expect(a.features.hist_ratio).toBeCloseTo(e.hist_ratio, 9);
          expect(a.features.gap).toBe(e.gap);
          expect(a.features.gdep).toBeCloseTo(e.gdep, 9);
          expect(a.features.imp_pct).toBeCloseTo(e.imp_pct, 9);
          expect(a.features.leg_pct).toBeCloseTo(e.leg_pct, 9);
          expect(a.features.qv24_m).toBeCloseTo(e.qv24_m, 6);
          if (Number.isNaN(e.qv_surge)) expect(a.features.qv_surge).toBeNaN();
          else expect(a.features.qv_surge).toBeCloseTo(e.qv_surge, 9);
          expect(a.features.range48).toBeCloseTo(e.range48, 9);
          expect(a.features.wait).toBe(e.wait);
        });
      });
    }
  }

  it('预热期（前 150 根）不产出信号', () => {
    const bars = make_bars(150, 3);
    const det = new MacdDivergenceDetector('TESTUSDT', '5m');
    expect(bars.flatMap(b => det.on_bar(b))).toHaveLength(0);
  });
});
