import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const [r] = await conn.query(`SELECT /*+ MAX_EXECUTION_TIME(5000) */ timeframe tf, state, symbol, ROUND(quote_volume_24h/1e6,1) qv_m, last_alert_level lv, updated_at
    FROM trend_follow_watch_contexts WHERE is_deleted=0 AND state IN ('WATCHING','ALERTED') ORDER BY timeframe, qv_m`);
  const rows = r as any[]; const th: any = { '5m': 0, '15m': 50, '1h': 100, '4h': 100 };
  const summary: any = {};
  for (const x of rows) {
    const s = summary[x.tf] ??= { total: 0, below: 0, unknown: 0 };
    s.total++; if (x.qv_m === null) s.unknown++; else if (+x.qv_m < th[x.tf]) s.below++;
  }
  console.table(summary);
  console.log('低于门槛将清理：');
  console.table(rows.filter(x => x.qv_m !== null && +x.qv_m < th[x.tf]).map(x => ({ tf: x.tf, symbol: x.symbol, state: x.state, lv: x.lv, qv_m: +x.qv_m })));
  conn.release(); process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
