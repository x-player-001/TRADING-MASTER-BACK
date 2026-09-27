import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { TrendFollowService, UnifiedKline } from '@/services/trend_follow_service';

const bj = (ts: number) => {
  const d = new Date(ts + 8 * 3600000);
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:00`;
};

async function main() {
  ConfigManager.getInstance().initialize();
  const symbol = 'BREVUSDT';
  const start = new Date('2026-06-25T00:00:00+08:00').getTime();
  const end   = new Date('2026-07-02T20:00:00+08:00').getTime();  // 覆盖到突破后
  const agg = new KlineAggregator();
  const all = await agg.get_klines_from_db(symbol, '1h', start, end);

  const unified: UnifiedKline[] = all.map(k => ({
    symbol, timeframe: '1h' as const,
    open_time: k.open_time, close_time: k.close_time,
    open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
  }));

  const svc = new TrendFollowService();
  const events: string[] = [];
  svc.on_alert(a => events.push(`  🔔 [${bj(a.kline_time)}] Lv${a.alert_level} 回调${(a.pullback_ratio*100).toFixed(1)}% 波${a.wave.start_price}→${a.wave.end_price}`));
  svc.on_abandon(e => events.push(`  ⚫ [废弃] ${e.reason}`));
  svc.on_breakthrough(e => events.push(`  🚀 [突破] 高点${e.wave.end_price} 突破价${e.breakthrough_price}`));

  // 预热前150根(不打印), 剩余逐根喂并观察状态转变
  const warm = Math.max(0, unified.length - 30);
  svc.init_cache(symbol, '1h', unified.slice(0, warm));

  console.log(`预热 ${warm} 根, 逐根喂最后 ${unified.length-warm} 根:\n`);
  let prev_state = '';
  for (let i = warm; i < unified.length; i++) {
    const k = unified[i];
    events.length = 0;
    svc.process_aggregated_kline({
      symbol, interval: '1h',
      open_time: k.open_time, close_time: k.close_time,
      open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
    } as any);
    const ctxs = svc.get_watching_contexts();
    const ctx = ctxs.find(c => c.timeframe === '1h');
    // 用内部状态无法直接读, 通过 statistics/watching 推断
    const stat = svc.get_statistics();
    const bull = k.close>k.open?'阳':'阴';
    const bodyPct=((k.close-k.open)/k.open*100).toFixed(2);
    let line = `${bj(k.open_time)} ${bull} ${bodyPct.padStart(6)}%  观察中=${stat.total_watching}`;
    if (ctx && ctx.wave) line += `  波[${ctx.wave.start_price}→${ctx.wave.end_price} ${(ctx.wave.amplitude/ctx.wave.start_price*100).toFixed(1)}%] 回调${ctx.pullback?.bar_count}根 lastLv${ctx.last_alert_level??'-'}`;
    console.log(line);
    for (const e of events) console.log(e);
  }
  process.exit(0);
}
main().catch(e=>{console.error('ERR:',e.message);process.exit(1);});
