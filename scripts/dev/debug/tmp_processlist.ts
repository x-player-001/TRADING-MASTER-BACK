import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const [r] = await conn.query(`SELECT id, user, command, time, state, LEFT(info,80) info FROM information_schema.processlist WHERE command <> 'Sleep' ORDER BY time DESC`);
  for (const p of r as any[]) if (String(p.info ?? '').includes('kline_5m_2') && String(p.info).includes('SUM(volume*close)')) { await conn.query(`KILL QUERY ${p.id}`); console.log('killed', p.id); }
  console.table(r);
  const [s] = await conn.query(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections')`);
  console.table(s);
  conn.release(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
