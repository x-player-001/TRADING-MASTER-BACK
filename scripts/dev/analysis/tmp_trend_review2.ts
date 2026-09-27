import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
const FEE = 0.001; // 往返手续费+滑点 0.1%
type Row = { m: string; entry: number; stop: number; outcome: string; rr: number };
function stats(rows: Row[]) {
  const done = rows.filter(r => r.outcome === 'win' || r.outcome === 'loss');
  if (!done.length) return null;
  const R = done.map(r => {
    const risk = (r.entry - r.stop) / r.entry; const fee_r = risk > 0 ? FEE / risk : 0;
    return (r.outcome === 'win' ? r.rr : -1) - fee_r;
  });
  const risks = done.map(r => (r.entry - r.stop) / r.entry * 100).sort((a, b) => a - b);
  const sorted = [...R].sort((a, b) => b - a);
  const cut = Math.ceil(done.length * 0.05);
  const trimmed = sorted.slice(cut);
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(avg(R.map(x => (x - avg(R)) ** 2)));
  return { n: done.length, win: +(100 * done.filter(r => r.outcome === 'win').length / done.length).toFixed(1),
    med_risk_pct: +risks[Math.floor(risks.length / 2)].toFixed(2),
    ev_fee: +avg(R).toFixed(3), t: +(avg(R) / (sd / Math.sqrt(R.length))).toFixed(2),
    ev_drop_top5pct: +avg(trimmed).toFixed(3) };
}
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const alerts = (await conn.execute(`SELECT DATE_FORMAT(a.created_at,'%Y-%m') m, o.timeframe tf, o.alert_level lv, o.entry_price entry, o.stop_low_price stop, o.outcome_low outcome, o.rr_low rr FROM trend_follow_alert_outcomes o JOIN trend_follow_alerts a ON a.id=o.alert_id`))[0] as any[];
  const trig = (await conn.execute(`SELECT DATE_FORMAT(created_at,'%Y-%m') m, parent_timeframe tf, parent_alert_level lv, confirm_price entry, trigger_stop stop, outcome, rr_ratio rr FROM trend_follow_entry_triggers WHERE outcome IS NOT NULL`))[0] as any[];
  const norm = (r: any): Row & { tf: string; lv: number } => ({ ...r, entry: +r.entry, stop: +r.stop, rr: +r.rr, lv: +r.lv });
  const A = alerts.map(norm), T = trig.map(norm);
  const out: any = {};
  for (const [name, src] of [['alert', A], ['trigger', T]] as const)
    for (const tf of ['5m', '15m', '1h', '4h']) for (const lv of [0, 1, 2, 3]) {
      const s = stats(src.filter(r => r.tf === tf && r.lv === lv)); if (s && s.n >= 20) out[`${name} ${tf} Lv${lv}`] = s;
    }
  console.log('\n## 扣 0.1% 费用后 EV(R)、t 值、去掉前5%最大盈利后 EV'); console.table(out);
  const by_m: any = {};
  for (const [name, src, tf, lv] of [['alert', A, '1h', 1], ['alert', A, '4h', 1], ['trigger', T, '1h', 1], ['trigger', T, '1h', 2], ['trigger', T, '4h', 1]] as const)
    for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      const s = stats(src.filter(r => r.tf === tf && r.lv === lv && r.m === m)); if (s) by_m[`${name} ${tf} Lv${lv} ${m}`] = { n: s.n, win: s.win, ev_fee: s.ev_fee };
    }
  console.log('\n## 候选桶 按月稳定性（扣费）'); console.table(by_m);
  conn.release(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
