/**
 * 第二波「标准答案」构建 + 现有趋势跟随系统召回率/精确率评估
 *
 * 1. 从 kline_1h_agg 读全市场 1h K线（按 6h 时间片串行限流读取）
 * 2. 事后标注「第一波 + 回调」setup：
 *    - 第一波：摆动高点 H（±12 根内最高、近 7 天新高），起点 L = H 前 72 根内最低点；
 *      涨幅 >= 10% 且 >= 6 × ATR14(L 处)，用时 3~72 根
 *    - 回调：H 之后回撤 >= 23.6% 才算形成 setup；先创新高则为「无回调延续」，不计入 setup
 *    - 结局：先触及 H + 38.2% 幅度 → second_wave；先收盘回撤 > 78.6% → failed；240 根内都没有 → timeout
 * 3. 与系统历史观察区 / 报警 / 扳机匹配，统计召回率、区分度、精确率
 *
 * 必须在服务器上跑（本机到库带宽只有几 KB/s）：
 *   nice -n 19 node --max-old-space-size=700 -r ts-node/register -r tsconfig-paths/register \
 *     scripts/dev/analysis/second_wave_ground_truth.ts
 * 结果写到 OUT_DIR/second_wave_result.json 与 second_wave_report.txt
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';

const H1 = 3600_000;
const START = Date.UTC(2026, 4, 20);            // 读 K线起点（留 7 天新高回溯）
const LABEL_FROM = Date.UTC(2026, 5, 1);        // 标注 H 的起点（系统数据 05-27 起）
const SLICE = 6 * H1;
const OUT_DIR = process.env.OUT_DIR || 'exports';

const P = {
  pivot_k: 12, new_high_bars: 168, impulse_max_bars: 72, impulse_min_bars: 3,
  min_gain: 0.10, min_atr_mult: 6, atr_period: 14,
  setup_retrace: 0.236, fail_retrace: 0.786, success_ext: 0.382, max_forward: 240,
};

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Setup = {
  symbol: string; t_L: number; t_H: number; L: number; H: number; gain: number; atr_mult: number;
  qv24_m: number; outcome: 'second_wave' | 'failed' | 'timeout';
  t_setup: number; t_end: number; t_break: number | null; P: number; t_P: number; max_retrace: number;
  ext_after: number;   // 结局判定后 240 根内最高价相对 H 的涨幅（衡量第二波走多远）
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** 限流读取全市场 1h K线：6h 时间片串行，单查询 5s 上限，慢查询退避，连续失败中止 */
async function load_klines(conn: any): Promise<Map<string, Bar[]>> {
  const cache = path.join(OUT_DIR, 'sw_1h_cache.json');
  if (fs.existsSync(cache)) {
    const raw = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, number[][]>;
    const m = new Map<string, Bar[]>();
    for (const [s, arr] of Object.entries(raw)) m.set(s, arr.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })));
    log('loaded cache', m.size, 'symbols');
    return m;
  }
  const by_sym = new Map<string, Bar[]>();
  const end = Date.now();
  let fails = 0, n = 0;
  for (let a = START; a < end; a += SLICE) {
    const t0 = Date.now();
    try {
      const [rows] = await conn.query(
        `SELECT /*+ MAX_EXECUTION_TIME(5000) */ symbol, open_time, open, high, low, close, volume
         FROM kline_1h_agg WHERE open_time BETWEEN ? AND ?`, [a, a + SLICE - 1]);
      for (const r of rows as any[]) {
        let arr = by_sym.get(r.symbol); if (!arr) by_sym.set(r.symbol, arr = []);
        arr.push({ t: +r.open_time, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume });
      }
      fails = 0;
    } catch (e: any) {
      log('query error', new Date(a).toISOString(), e.message);
      if (++fails >= 3) throw new Error('连续 3 次查询失败，中止以保护数据库');
    }
    const cost = Date.now() - t0;
    if (++n % 40 === 0) log(`slices ${n}, at ${new Date(a).toISOString().slice(0, 10)}, last ${cost}ms`);
    await sleep(cost > 2000 ? 5000 : 200);
  }
  for (const arr of by_sym.values()) {
    arr.sort((x, y) => x.t - y.t);
    for (let i = arr.length - 1; i > 0; i--) if (arr[i].t === arr[i - 1].t) arr.splice(i, 1);
  }
  const out: Record<string, number[][]> = {};
  for (const [s, arr] of by_sym) out[s] = arr.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
  fs.writeFileSync(cache, JSON.stringify(out));
  return by_sym;
}

/** Wilder ATR */
function calc_atr(bars: Bar[], period: number): number[] {
  const atr = new Array(bars.length).fill(NaN);
  let prev = NaN;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i < period) { prev = isNaN(prev) ? tr : prev + tr; if (i === period - 1) prev /= period; continue; }
    prev = (prev * (period - 1) + tr) / period;
    atr[i] = prev;
  }
  return atr;
}

/** 事后标注单个币种的 setup */
function label_symbol(symbol: string, bars: Bar[]): Setup[] {
  const out: Setup[] = [];
  const atr = calc_atr(bars, P.atr_period);
  const n = bars.length;
  for (let i = P.new_high_bars; i < n - P.pivot_k; i++) {
    const b = bars[i];
    if (b.t < LABEL_FROM) continue;
    // 数据空洞过大的区段跳过（回溯 168 根应覆盖约 7 天）
    if (b.t - bars[i - P.new_high_bars].t > (P.new_high_bars + 24) * H1) continue;
    let is_pivot = true;
    for (let k = i - P.pivot_k; k <= i + P.pivot_k; k++) if (k !== i && bars[k].h > b.h) { is_pivot = false; break; }
    if (!is_pivot) continue;
    let new_high = true;
    for (let k = i - P.new_high_bars; k < i; k++) if (bars[k].h > b.h) { new_high = false; break; }
    if (!new_high) continue;

    let jL = i;
    for (let k = Math.max(0, i - P.impulse_max_bars); k < i; k++) if (bars[k].l < bars[jL].l) jL = k;
    const L = bars[jL].l, H = b.h, amp = H - L;
    const dur = i - jL;
    if (dur < P.impulse_min_bars || !(atr[jL] > 0)) continue;
    const gain = amp / L, atr_mult = amp / atr[jL];
    if (gain < P.min_gain || atr_mult < P.min_atr_mult) continue;

    let qv = 0; for (let k = Math.max(0, i - 23); k <= i; k++) qv += bars[k].c * bars[k].v;

    // 向前推演结局
    let m = Infinity, t_P = b.t, setup_t = 0, max_r = 0, t_break: number | null = null;
    let outcome: Setup['outcome'] | 'continuation' | null = null, t_end = 0, end_idx = i;
    for (let k = i + 1; k < Math.min(n, i + 1 + P.max_forward); k++) {
      const x = bars[k];
      if (!setup_t) {
        if (x.h > H) { outcome = 'continuation'; break; }
        if (x.l < m) { m = x.l; t_P = x.t; }
        if ((H - m) / amp >= P.setup_retrace) setup_t = x.t;
        continue;
      }
      if (t_break === null && x.h > H) t_break = x.t;
      if (x.h >= H + P.success_ext * amp) { outcome = 'second_wave'; t_end = x.t; end_idx = k; break; }
      if ((H - x.c) / amp > P.fail_retrace) { outcome = 'failed'; t_end = x.t; end_idx = k; break; }
      if (t_break === null && x.l < m) { m = x.l; t_P = x.t; }
      max_r = Math.max(max_r, (H - m) / amp);
    }
    if (!setup_t || outcome === 'continuation') continue;
    if (!outcome) {
      if (i + P.max_forward >= n) continue;   // 数据不够判定，丢弃
      outcome = 'timeout'; end_idx = i + P.max_forward; t_end = bars[end_idx].t;
    }
    let hi_after = H;
    for (let k = end_idx; k < Math.min(n, end_idx + P.max_forward); k++) hi_after = Math.max(hi_after, bars[k].h);
    out.push({
      symbol, t_L: bars[jL].t, t_H: b.t, L, H, gain, atr_mult, qv24_m: qv / 1e6, outcome,
      t_setup: setup_t, t_end, t_break, P: m, t_P, max_retrace: Math.max(max_r, (H - m) / amp),
      ext_after: hi_after / H - 1,
    });
  }
  return out;
}

async function main() {
  ConfigManager.getInstance().initialize();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const conn = await DatabaseConfig.get_mysql_connection();
  const q = async (sql: string) => (await conn.query(sql))[0] as any[];

  const klines = await load_klines(conn);
  log('symbols', klines.size, 'bars', [...klines.values()].reduce((s, a) => s + a.length, 0));

  const ctxs = await q(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ symbol, timeframe tf, state, watch_start_time ws, wave_start_price wsp, wave_end_price wep, wave_end_time wet, last_alert_level lv FROM trend_follow_watch_contexts`);
  await sleep(300);
  const alerts = await q(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ symbol, timeframe tf, alert_level lv, kline_time t FROM trend_follow_alerts`);
  await sleep(300);
  const trigs = await q(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ symbol, parent_timeframe tf, parent_alert_level lv, kline_time t, outcome FROM trend_follow_entry_triggers`);
  conn.release();
  log('ctx', ctxs.length, 'alerts', alerts.length, 'triggers', trigs.length);

  const setups: Setup[] = [];
  for (const [s, bars] of klines) setups.push(...label_symbol(s, bars));
  log('setups', setups.length);

  const group = <T>(arr: T[], key: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of arr) { const k = key(x); let a = m.get(k); if (!a) m.set(k, a = []); a.push(x); } return m; };
  const ctx_by = group(ctxs, (x: any) => x.symbol), al_by = group(alerts, (x: any) => x.symbol), tr_by = group(trigs, (x: any) => x.symbol);
  const TFS = ['5m', '15m', '1h', '4h'];

  // 每个 setup 的系统覆盖情况
  const rows = setups.map(s => {
    const amp = s.H - s.L;
    const cs = (ctx_by.get(s.symbol) ?? []).filter((c: any) =>
      +c.ws >= s.t_L && +c.ws <= s.t_end && +c.wep >= s.L + 0.5 * amp && +c.wep <= s.H * 1.02);
    const entry_until = s.t_break ?? s.t_end;          // 可入场窗口：回调形成 → 突破前高
    const as = (al_by.get(s.symbol) ?? []).filter((a: any) => +a.t >= s.t_setup && +a.t <= entry_until);
    const ts = (tr_by.get(s.symbol) ?? []).filter((a: any) => +a.t >= s.t_setup && +a.t <= entry_until);
    const r: any = { ...s, watched_any: cs.length > 0, alerted_any: as.some((a: any) => +a.lv !== 3), trig_any: ts.some((a: any) => +a.lv !== 3) };
    for (const tf of TFS) {
      r[`w_${tf}`] = cs.some((c: any) => c.tf === tf);
      r[`a_${tf}`] = as.some((a: any) => a.tf === tf && +a.lv !== 3);
    }
    r.t_1h4h = ts.some((a: any) => +a.lv !== 3);
    return r;
  });

  const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
  const lines: string[] = [];
  const P_ = (s = '') => { lines.push(s); console.log(s); };

  const cohort = (name: string, rs: any[]) => {
    const pos = rs.filter(r => r.outcome === 'second_wave'), neg = rs.filter(r => r.outcome === 'failed');
    P_(`\n### ${name}：setup ${rs.length}，第二波 ${pos.length}（基准率 ${pct(pos.length, pos.length + neg.length)}，失败 ${neg.length}，超时 ${rs.length - pos.length - neg.length}）`);
    P_(`| 指标 | 第二波(召回) | 失败 | 区分度(第二波/失败) |`);
    P_(`|---|---|---|---|`);
    const f = (label: string, key: string) => {
      const a = pos.filter(r => r[key]).length / (pos.length || 1), b = neg.filter(r => r[key]).length / (neg.length || 1);
      P_(`| ${label} | ${pct(pos.filter(r => r[key]).length, pos.length)} | ${pct(neg.filter(r => r[key]).length, neg.length)} | ${b ? (a / b).toFixed(2) : '-'} |`);
    };
    f('任一周期进观察区', 'watched_any');
    for (const tf of TFS) f(`　${tf} 进观察区`, `w_${tf}`);
    f('任一周期报警(Lv0-2, 突破前)', 'alerted_any');
    for (const tf of TFS) f(`　${tf} 报警`, `a_${tf}`);
    f('扳机入场确认(父Lv0-2, 突破前)', 't_1h4h');
  };

  P_('# 第二波标准答案 vs 现有系统');
  P_(`参数：${JSON.stringify(P)}`);
  cohort('全部', rows);
  cohort('24h成交额 ≥100M', rows.filter(r => r.qv24_m >= 100));
  cohort('24h成交额 <100M', rows.filter(r => r.qv24_m < 100));
  cohort('第一波涨幅 ≥20%', rows.filter(r => r.gain >= 0.2));

  // 精确率：1h/4h 报警与扳机落在哪类 setup 的入场窗口里
  const setup_by = group(rows, (r: any) => r.symbol);
  const classify = (sym: string, t: number) => {
    const ss = (setup_by.get(sym) ?? []).filter((s: any) => t >= s.t_setup && t <= (s.t_break ?? s.t_end));
    if (!ss.length) return 'no_setup';
    return ss.some((s: any) => s.outcome === 'second_wave') ? 'second_wave' : ss[0].outcome;
  };
  P_('\n### 精确率：信号落在哪类 setup 的入场窗口（setup 形成 → 突破前高）');
  P_('| 信号 | n | 第二波 | 失败 | 超时 | 不属于任何 1h 级 setup |');
  P_('|---|---|---|---|---|---|');
  const prec = (label: string, arr: any[]) => {
    const c: any = { second_wave: 0, failed: 0, timeout: 0, no_setup: 0 };
    for (const a of arr) c[classify(a.symbol, +a.t)]++;
    P_(`| ${label} | ${arr.length} | ${pct(c.second_wave, arr.length)} | ${pct(c.failed, arr.length)} | ${pct(c.timeout, arr.length)} | ${pct(c.no_setup, arr.length)} |`);
  };
  const since = (arr: any[]) => arr.filter((a: any) => +a.t >= LABEL_FROM && +a.t <= Date.now() - P.max_forward * H1);
  for (const tf of ['1h', '4h']) for (const lv of [0, 1, 2]) prec(`报警 ${tf} Lv${lv}`, since(alerts.filter((a: any) => a.tf === tf && +a.lv === lv)));
  for (const tf of ['1h', '4h']) for (const lv of [1, 2, 3]) prec(`扳机 ${tf} Lv${lv}`, since(trigs.filter((a: any) => a.tf === tf && +a.lv === lv)));

  // 第二波的回调特征（给 v2 设计参考）
  const pos = rows.filter(r => r.outcome === 'second_wave'), neg = rows.filter(r => r.outcome === 'failed');
  const q_ = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
  const desc = (label: string, f: (r: any) => number, fmt = (x: number) => x.toFixed(2)) =>
    P_(`| ${label} | ${[0.25, 0.5, 0.75].map(p => fmt(q_(pos.map(f), p))).join(' / ')} | ${[0.25, 0.5, 0.75].map(p => fmt(q_(neg.map(f), p))).join(' / ')} |`);
  P_('\n### 特征分布（p25 / p50 / p75）');
  P_('| 特征 | 第二波 | 失败 |'); P_('|---|---|---|');
  desc('第一波涨幅', r => r.gain * 100, x => x.toFixed(1) + '%');
  desc('第一波 ATR 倍数', r => r.atr_mult, x => x.toFixed(1));
  desc('第一波用时(根)', r => (r.t_H - r.t_L) / H1, x => x.toFixed(0));
  desc('最大回撤比例', r => r.max_retrace * 100, x => x.toFixed(0) + '%');
  desc('24h成交额(M)', r => r.qv24_m, x => x.toFixed(0));
  desc('回调低点到 H 的根数', r => (r.t_P - r.t_H) / H1, x => x.toFixed(0));
  desc('结局后 240 根再涨幅', r => r.ext_after * 100, x => x.toFixed(0) + '%');

  // 漏掉的大第二波（≥100M，按幅度排序）供人工核对
  const missed = pos.filter(r => r.qv24_m >= 100 && !r.alerted_any && !r.t_1h4h).sort((a, b) => b.gain - a.gain).slice(0, 25);
  const bj = (t: number) => new Date(t + 8 * H1).toISOString().slice(5, 16).replace('T', ' ');
  P_('\n### 漏报的第二波样本（≥100M，无 Lv0-2 报警也无扳机，按第一波涨幅排序前 25）');
  P_('| 币种 | 起涨(北京) | 高点 | 涨幅 | 回撤 | 突破前高 | 进过观察区的周期 |'); P_('|---|---|---|---|---|---|---|');
  for (const r of missed) P_(`| ${r.symbol} | ${bj(r.t_L)} | ${bj(r.t_H)} | ${(r.gain * 100).toFixed(0)}% | ${(r.max_retrace * 100).toFixed(0)}% | ${r.t_break ? bj(r.t_break) : '-'} | ${TFS.filter(tf => r[`w_${tf}`]).join(',') || '无'} |`);

  fs.writeFileSync(path.join(OUT_DIR, 'second_wave_report.md'), lines.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'second_wave_setups.json'), JSON.stringify(rows));
  log('done');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
