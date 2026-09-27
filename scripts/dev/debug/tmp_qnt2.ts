import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';
const bj = (ts: number) => new Date(Number(ts) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
async function main() {
  ConfigManager.getInstance().initialize();
  const agg = new KlineAggregator();
  const tf = process.argv[2] || '4h'; const days = +(process.argv[3] || 40);
  const kl = await agg.get_klines_from_db('QNTUSDT', tf, Date.now() - days * 86400000, Date.now());
  console.log(tf, kl.length);
  for (const k of kl) console.log(bj(k.open_time), k.open, k.high, k.low, k.close, Math.round(k.volume), ((k.close / k.open - 1) * 100).toFixed(2) + '%', (((k.high - k.low) / k.open) * 100).toFixed(2));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
