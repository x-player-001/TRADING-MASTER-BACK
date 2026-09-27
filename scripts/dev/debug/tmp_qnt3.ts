import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { TrendFollowService } from '@/services/trend_follow_service';
const bj = (ts: number) => new Date(Number(ts) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
async function main() {
  ConfigManager.getInstance().initialize();
  const kl = await new KlineAggregator().get_klines_from_db('QNTUSDT', '4h', Date.now() - 60 * 86400000, Date.now());
  const svc = new TrendFollowService();
  svc.on_alert(a => console.log('  ALERT', a.alert_level, a.fib_zone));
  svc.on_abandon(e => console.log('  ABANDON', e.reason));
  const from = new Date('2026-09-22T12:00:00+08:00').getTime();
  const to = new Date('2026-09-24T12:00:00+08:00').getTime();
  for (const k of kl) {
    svc.process_aggregated_kline(k as any);
    if (k.open_time >= from && k.open_time <= to) {
      const ctx = (svc as any).watch_contexts.get('QNTUSDT_4h');
      console.log(bj(k.open_time), k.open, k.close, ctx.state, ctx.wave ? `${ctx.wave.start_price}->${ctx.wave.end_price}` : '');
    }
  }
  // 基准实体均值（小阴线判定用）
  const cache = (svc as any).kline_cache.get('QNTUSDT_4h') as any[];
  const i = cache.findIndex(c => bj(c.open_time) === '09-23 00:00');
  const base = cache.slice(i - 25 - 3, i - 3);  // 近似
  const avg = base.reduce((s, k) => s + Math.abs(k.close - k.open), 0) / base.length;
  const b = cache[i];
  console.log('09-23 00:00 body', (b.open - b.close).toFixed(2), 'range', (b.high - b.low).toFixed(2), 'body/range', ((b.open - b.close) / (b.high - b.low)).toFixed(2), 'base_avg_body', avg.toFixed(3), '×0.3=', (avg * 0.3).toFixed(3));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
