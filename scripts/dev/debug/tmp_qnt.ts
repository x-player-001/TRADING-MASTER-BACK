import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';

const bj = (ts: number) => new Date(Number(ts) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
async function main() {
  ConfigManager.getInstance().initialize();
  const conn = await DatabaseConfig.get_mysql_connection();
  const q = async (sql: string, p: any[] = []) => (await conn.execute(sql, p))[0] as any[];
  console.log('ctx:', await q(`SELECT id,timeframe,state,wave_start_price,wave_end_price,wave_bar_count,wave_end_time,pullback_lowest_price,pullback_bar_count,last_alert_level,watch_start_time,abandoned_reason,updated_at FROM trend_follow_watch_contexts WHERE symbol='QNTUSDT' ORDER BY id DESC LIMIT 20`)
    .then(r => r.map(x => ({ ...x, wave_end_time: bj(x.wave_end_time), watch_start_time: bj(x.watch_start_time) }))));
  console.log('alerts:', await q(`SELECT * FROM trend_follow_alerts WHERE symbol='QNTUSDT' ORDER BY id DESC LIMIT 20`));
  const k4 = await q(`SELECT open_time,open,high,low,close,volume FROM kline_4h WHERE symbol='QNTUSDT' ORDER BY open_time DESC LIMIT 60`);
  console.log('4h rows', k4.length);
  for (const k of k4.reverse()) console.log(bj(k.open_time), k.open, k.high, k.low, k.close, Math.round(k.volume), ((k.close / k.open - 1) * 100).toFixed(2) + '%');
  conn.release();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
