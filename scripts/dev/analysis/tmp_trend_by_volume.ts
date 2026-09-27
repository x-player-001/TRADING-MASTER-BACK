/** 按信号触发时刻的 24h 成交额（由信号所在4h之前 6 根 4h 聚合K线 close*volume 近似，点时无前视）分桶评估趋势信号表现 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
const FEE = 0.001, H = 3600000, H4 = 4 * H;
const CACHE = 'exports/tmp_4h_qv.json';
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const q = async (sql: string, p: any[] = []) => (await conn.query(sql, p))[0] as any[];
  const A = (await q(`SELECT o.symbol, o.timeframe tf, o.alert_level lv, a.kline_time t, o.entry_price entry, o.stop_low_price stop, o.outcome_low outcome, o.rr_low rr FROM trend_follow_alert_outcomes o JOIN trend_follow_alerts a ON a.id=o.alert_id`)).map(r => ({ ...r, kind: 'alert' }));
  const T = (await q(`SELECT symbol, parent_timeframe tf, parent_alert_level lv, kline_time t, confirm_price entry, trigger_stop stop, outcome, rr_ratio rr FROM trend_follow_entry_triggers WHERE outcome IS NOT NULL`)).map(r => ({ ...r, kind: 'trigger' }));
  const sigs = [...A, ...T].map(r => ({ ...r, t: +r.t, lv: +r.lv, entry: +r.entry, stop: +r.stop, rr: +r.rr }));
  const syms = [...new Set(sigs.map(s => s.symbol))];

  // 小时成交额: `${symbol}|${hour}` -> quote volume
  let hq: Record<string, number> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  if (!Object.keys(hq).length) {
    // 限流读取 kline_4h_agg：只取每个信号前 24h 的窗口（合并重叠），每查询最多 10 个窗口，
    // 串行 + sleep + 单查询 2s 上限；慢查询退避 10s，连续 3 次超时直接中止，避免压垮线上 MySQL
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const jobs: { sym: string; wins: [number, number][] }[] = [];
    for (const sym of syms) {
      const ws = [...new Set(sigs.filter(s => s.symbol === sym).map(s => Math.floor(s.t / H4) * H4))].sort((a, b) => a - b)
        .map(e => [e - 24 * H, e - 1] as [number, number]);
      const merged: [number, number][] = [];
      for (const w of ws) { const last = merged[merged.length - 1]; if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]); else merged.push([...w]); }
      for (let i = 0; i < merged.length; i += 10) jobs.push({ sym, wins: merged.slice(i, i + 10) });
    }
    console.log(`jobs ${jobs.length}`);
    let fails = 0, done = 0;
    for (const job of jobs) {
      const cond = job.wins.map(() => 'open_time BETWEEN ? AND ?').join(' OR ');
      const t0 = Date.now();
      try {
        const rows = await q(`SELECT /*+ MAX_EXECUTION_TIME(2000) */ open_time, volume*close qv FROM kline_4h_agg WHERE symbol=? AND (${cond})`, [job.sym, ...job.wins.flat()]);
        for (const r of rows) hq[`${job.sym}|${+r.open_time}`] = +r.qv;
        fails = 0;
      } catch (e: any) {
        console.log(`query error ${job.sym}: ${e.message}`);
        if (++fails >= 3) throw new Error('连续 3 次查询失败，中止以保护数据库');
      }
      const cost = Date.now() - t0;
      if (++done % 100 === 0) console.log(`loaded ${done}/${jobs.length} jobs, last query ${cost}ms`);
      await sleep(cost > 1500 ? 10000 : 300);
    }
    fs.writeFileSync(CACHE, JSON.stringify(hq));
  }
  // 信号时刻前 24 小时成交额；缺 >3 小时视为数据不全
  const rows: any[] = [];
  let miss = 0;
  for (const s of sigs) {
    const e = Math.floor(s.t / H4) * H4; let sum = 0, have = 0;
    for (let b = e - 24 * H; b < e; b += H4) { const v = hq[`${s.symbol}|${b}`]; if (v !== undefined) { sum += v; have++; } }
    if (have < 5) { miss++; continue; }
    rows.push({ ...s, qv: sum * 6 / have / 1e6 });
  }
  console.log(`signals ${sigs.length}, with qv ${rows.length}, missing ${miss}`);

  const stat = (rs: any[]) => {
    const d = rs.filter(r => r.outcome === 'win' || r.outcome === 'loss'); if (d.length < 10) return d.length ? `n=${d.length}` : '';
    const R = d.map(r => { const risk = (r.entry - r.stop) / r.entry; return (r.outcome === 'win' ? r.rr : -1) - (risk > 0 ? FEE / risk : 0); });
    const m = R.reduce((a, b) => a + b, 0) / R.length, sd = Math.sqrt(R.reduce((a, b) => a + (b - m) ** 2, 0) / R.length);
    const win = 100 * d.filter(r => r.outcome === 'win').length / d.length;
    return `n=${d.length} 胜${win.toFixed(0)}% EV${m >= 0 ? '+' : ''}${m.toFixed(2)} t${(m / (sd / Math.sqrt(R.length))).toFixed(1)}`;
  };
  const B2 = [['<100M', 0, 100], ['≥100M', 100, 1e12]] as const;
  const B5 = [['<20M', 0, 20], ['20-50M', 20, 50], ['50-100M', 50, 100], ['100-300M', 100, 300], ['≥300M', 300, 1e12]] as const;
  const table = (bks: readonly (readonly [string, number, number])[], title: string) => {
    const out: any = {};
    for (const kind of ['alert', 'trigger']) for (const tf of ['5m', '15m', '1h', '4h']) for (const lv of [0, 1, 2, 3]) {
      const g = rows.filter(r => r.kind === kind && r.tf === tf && r.lv === lv); if (g.length < 20) continue;
      const line: any = { 全部: stat(g) };
      for (const [name, lo, hi] of bks) line[name] = stat(g.filter(r => r.qv >= lo && r.qv < hi));
      out[`${kind} ${tf} Lv${lv}`] = line;
    }
    console.log(`\n## ${title}`); console.table(out);
  };
  table(B2, '100M 分界（扣0.1%费用，R 为单位）');
  table(B5, '细分成交额区间');
  // 合并：所有非 Lv3 信号
  const pool: any = {};
  for (const kind of ['alert', 'trigger']) {
    const g = rows.filter(r => r.kind === kind && r.lv !== 3);
    const line: any = { 全部: stat(g) }; for (const [n, lo, hi] of B5) line[n] = stat(g.filter(r => r.qv >= lo && r.qv < hi));
    pool[`${kind} 合计(Lv0-2)`] = line;
  }
  console.log('\n## 合并'); console.table(pool);
  const qs = rows.map(r => r.qv).sort((a, b) => a - b);
  console.log('成交额分位 p25/p50/p75/p90:', [0.25, 0.5, 0.75, 0.9].map(p => qs[Math.floor(qs.length * p)].toFixed(0) + 'M').join(' / '));
  conn.release(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
