import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const a = new Date('2026-07-12T00:00:00Z').getTime();
  for (const [label, sql] of [
    ['count only 1h slice', `SELECT /*+ MAX_EXECUTION_TIME(4000) */ COUNT(*) n, SUM(volume) s FROM kline_1h_agg WHERE open_time BETWEEN ? AND ?`],
    ['rows 1h slice', `SELECT /*+ MAX_EXECUTION_TIME(4000) */ symbol, open_time, open, high, low, close, volume FROM kline_1h_agg WHERE open_time BETWEEN ? AND ?`],
  ] as const) {
    for (const off of [0, 1, 2]) {
      const s = a + off * 3600000, t0 = Date.now();
      const [r] = await conn.query(sql, [s, s + 3600000 - 1]);
      console.log(label, off, (r as any[]).length === 1 ? JSON.stringify((r as any[])[0]) : (r as any[]).length + ' rows', Date.now() - t0, 'ms');
      await new Promise(r => setTimeout(r, 300));
    }
  }
  conn.release(); process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
