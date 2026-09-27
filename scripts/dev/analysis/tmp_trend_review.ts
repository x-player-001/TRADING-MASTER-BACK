import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const q = async (title: string, sql: string) => { const r = (await conn.execute(sql))[0] as any[]; console.log('\n## ' + title); console.table(r); };
  await q('报警时间范围', `SELECT MIN(created_at) a, MAX(created_at) b, COUNT(*) n, COUNT(DISTINCT symbol) syms, COUNT(DISTINCT DATE(created_at)) days FROM trend_follow_alerts`);
  await q('近30天 每日报警量 by 周期', `SELECT timeframe, COUNT(*) n, ROUND(COUNT(*)/30,1) per_day, COUNT(DISTINCT symbol) syms FROM trend_follow_alerts WHERE created_at >= NOW() - INTERVAL 30 DAY GROUP BY timeframe`);
  await q('近30天 by 周期×等级', `SELECT timeframe, alert_level lv, COUNT(*) n FROM trend_follow_alerts WHERE created_at >= NOW() - INTERVAL 30 DAY GROUP BY timeframe, alert_level ORDER BY timeframe, lv`);
  await q('近30天 扳机 by 父周期', `SELECT parent_timeframe, parent_alert_level lv, COUNT(*) n FROM trend_follow_entry_triggers WHERE created_at >= NOW() - INTERVAL 30 DAY GROUP BY 1,2`);
  const ev = (o: string, rr: string) => `COUNT(*) n, SUM(${o}='win') w, SUM(${o}='loss') l, SUM(${o}='open') op,
    ROUND(100*SUM(${o}='win')/NULLIF(SUM(${o} IN ('win','loss')),0),1) winrate,
    ROUND(AVG(CASE WHEN ${o} IN ('win','loss') THEN ${rr} END),2) avg_rr,
    ROUND(AVG(CASE WHEN ${o}='win' THEN ${rr} WHEN ${o}='loss' THEN -1 END),3) ev_R,
    ROUND(SUM(CASE WHEN ${o}='win' THEN ${rr} WHEN ${o}='loss' THEN -1 ELSE 0 END),1) sum_R`;
  await q('报警结果(low口径) by 周期×等级', `SELECT timeframe, alert_level lv, ${ev('outcome_low', 'rr_low')} FROM trend_follow_alert_outcomes GROUP BY 1,2 ORDER BY 1,2`);
  await q('报警结果(wave口径) by 周期×等级', `SELECT timeframe, alert_level lv, ${ev('outcome_wave', 'rr_wave')} FROM trend_follow_alert_outcomes GROUP BY 1,2 ORDER BY 1,2`);
  await q('扳机结果 by 父周期×等级', `SELECT parent_timeframe, parent_alert_level lv, ${ev('outcome', 'rr_ratio')} FROM trend_follow_entry_triggers WHERE outcome IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`);
  await q('报警结果(low) 按月', `SELECT DATE_FORMAT(a.created_at,'%Y-%m') m, o.timeframe, ${ev('o.outcome_low', 'o.rr_low')} FROM trend_follow_alert_outcomes o JOIN trend_follow_alerts a ON a.id=o.alert_id GROUP BY 1,2 ORDER BY 1,2`);
  await q('扳机结果 按月', `SELECT DATE_FORMAT(created_at,'%Y-%m') m, parent_timeframe, ${ev('outcome', 'rr_ratio')} FROM trend_follow_entry_triggers WHERE outcome IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`);
  conn.release(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
