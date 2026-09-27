import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { TrendFollowRepository } from '@/database/trend_follow_repository';

const bj = (ts: number) => {
  const d = new Date(ts + 8 * 3600000);
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
};
async function main() {
  ConfigManager.getInstance().initialize();
  // 找符号
  const conn = await DatabaseConfig.get_mysql_connection();
  const [syms] = await conn.execute(
    `SELECT DISTINCT symbol FROM trend_follow_alerts WHERE symbol LIKE 'BREV%'`);
  conn.release();
  console.log('匹配符号:', (syms as any[]).map(r=>r.symbol).join(', ') || '(报警表无, 试 BREVUSDT)');
  const symbol = (syms as any[])[0]?.symbol || 'BREVUSDT';

  // 时间范围: 7.1 18:00 ~ 7.2 14:00 北京时间, 多取前后
  const start = new Date('2026-07-01T18:00:00+08:00').getTime();
  const end   = new Date('2026-07-02T14:00:00+08:00').getTime();

  const agg = new KlineAggregator();
  const kl = await agg.get_klines_from_db(symbol, '1h', start, end);
  console.log(`\n===== ${symbol} 1h K线 (${kl.length}根) =====`);
  console.log('时间(BJ)      open      high      low       close     vol       涨跌%');
  for (const k of kl) {
    const chg = ((k.close-k.open)/k.open*100).toFixed(2);
    console.log(`${bj(k.open_time)}  ${k.open.toFixed(5).padStart(9)} ${k.high.toFixed(5).padStart(9)} ${k.low.toFixed(5).padStart(9)} ${k.close.toFixed(5).padStart(9)} ${k.volume.toFixed(0).padStart(9)} ${chg.padStart(6)}`);
  }

  const repo = new TrendFollowRepository();
  const alerts = await repo.get_alerts({ symbol, timeframe: '1h',
    start_time: start - 6*3600000, end_time: end + 6*3600000, limit: 50 });
  console.log(`\n===== ${symbol} 1h 报警 (${alerts.length}条) =====`);
  for (const a of alerts.reverse()) {
    console.log(`${bj(a.kline_time)}  Lv${a.alert_level}  回调${(a.pullback_ratio*100).toFixed(1)}%  ${a.fib_zone}  缩量${a.volume_shrink?'✓':'✗'} 止跌${a.reversal_signal?'✓':'✗'}  波:${a.wave_start_price}→${a.wave_end_price}(${a.wave_amplitude_pct.toFixed(1)}%,${a.wave_bar_count}根)`);
  }

  // 观察区(含各状态)
  const conn2 = await DatabaseConfig.get_mysql_connection();
  const [ctxs] = await conn2.execute(
    `SELECT * FROM trend_follow_watch_contexts WHERE symbol=? AND timeframe='1h'
     AND watch_start_time BETWEEN ? AND ? ORDER BY watch_start_time`,
    [symbol, start - 24*3600000, end + 6*3600000]);
  conn2.release();
  console.log(`\n===== ${symbol} 1h 观察区快照 (${(ctxs as any[]).length}条) =====`);
  for (const c of ctxs as any[]) {
    console.log(`起:${bj(Number(c.watch_start_time))} 状态${c.state} 波${Number(c.wave_start_price)}→${Number(c.wave_end_price)}(${Number(c.wave_amplitude_pct).toFixed(1)}%) 回调低${Number(c.pullback_lowest_price)} lastLv${c.last_alert_level} ${c.abandoned_reason?'废弃:'+c.abandoned_reason:''}`);
  }
  process.exit(0);
}
main().catch(e=>{console.error('ERR:',e.message);process.exit(1);});
