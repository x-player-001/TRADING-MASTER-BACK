import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';

const bj = (ts: number) => {
  const d = new Date(ts + 8 * 3600000);
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:00`;
};

// 复刻 _find_bull_wave 的逐步判定，打印每个门槛
const CFG = {
  min_consecutive_bull: 4, allow_small_bear_gap: 2, min_body_ratio: 0.30,
  min_body_ratio_bars: 0.60, amplitude_multiplier: 1.1, min_wave_amplitude_pct: 0.05,
  min_bar_range_pct: 0.005, amplitude_lookback: 25, max_pullback_bars_before_detect: 10,
  wave_high_lookback: 150,
};

async function main() {
  ConfigManager.getInstance().initialize();
  const symbol = 'BREVUSDT';
  // 取更早的历史做基准(amplitude_lookback=25 + wave_high_lookback=150 需要足够前置)
  const start = new Date('2026-06-25T00:00:00+08:00').getTime();
  const end   = new Date('2026-07-02T12:00:00+08:00').getTime();  // 只到突破前
  const agg = new KlineAggregator();
  const all = await agg.get_klines_from_db(symbol, '1h', start, end);
  console.log(`加载 ${all.length} 根 1h K线 (至突破前 07-02 11:00)`);

  // 模拟: 缓存推进到 07-02 11:00 这根收盘时的状态(即刚好收敛结束、突破前一刻)
  // _find_bull_wave 从缓存尾部向前扫
  const cache = all;
  const len = cache.length;
  console.log(`\n尾部10根:`);
  for (const k of cache.slice(-14)) {
    const bull = k.close>k.open?'阳':'阴';
    const bodyPct=((k.close-k.open)/k.open*100).toFixed(2);
    const rangePct=((k.high-k.low)/k.open*100).toFixed(2);
    console.log(`  ${bj(k.open_time)} ${bull} 实体${bodyPct.padStart(6)}% 振幅${rangePct.padStart(5)}%`);
  }

  // ---- 复刻算法 ----
  const base_end = Math.max(0, len - CFG.min_consecutive_bull);
  const base_klines = cache.slice(Math.max(0, base_end - CFG.amplitude_lookback), base_end);
  console.log(`\nbase_klines: ${base_klines.length}根 (需≥5)`);
  const base_avg_body = base_klines.reduce((s,k)=>s+Math.abs(k.close-k.open),0)/base_klines.length;

  // 跳过末尾回调
  let wave_end_idx = len-1, skipped=0;
  while(wave_end_idx>=0 && skipped<CFG.max_pullback_bars_before_detect && cache[wave_end_idx].close<=cache[wave_end_idx].open){wave_end_idx--;skipped++;}
  console.log(`跳过末尾非阳线: ${skipped}根 → 波末端 idx=${wave_end_idx} (${wave_end_idx>=0?bj(cache[wave_end_idx].open_time):'无'})`);
  console.log(`  max_pullback_bars_before_detect=${CFG.max_pullback_bars_before_detect}`);
  if(wave_end_idx<0||cache[wave_end_idx].close<=cache[wave_end_idx].open){console.log('❌ 末端非阳线,直接返回null');process.exit(0);}

  // 向前找连续阳线
  const scan_limit = Math.min(wave_end_idx+1,20);
  let seq:any[]=[]; let sbc=0;
  for(let i=wave_end_idx;i>=wave_end_idx-scan_limit+1;i--){
    const k=cache[i]; const is_bull=k.close>k.open; const body=Math.abs(k.close-k.open); const range=k.high-k.low;
    const is_small_bear=!is_bull&&range>0&&body/range<0.3&&body<base_avg_body*0.3;
    if(k.open>0&&range/k.open<CFG.min_bar_range_pct){console.log(`  [${bj(k.open_time)}] 振幅<0.5% 终止`);break;}
    if(is_bull){seq.unshift(k);}
    else if(is_small_bear&&sbc<CFG.allow_small_bear_gap&&seq.length>0){seq.unshift(k);sbc++;console.log(`  [${bj(k.open_time)}] 夹小阴线(${sbc}/${CFG.allow_small_bear_gap})`);}
    else{console.log(`  [${bj(k.open_time)}] 阴线中断(非小阴或超额) 终止`);break;}
  }
  while(seq.length>0&&seq[0].close<=seq[0].open)seq.shift();
  while(seq.length>0&&seq[seq.length-1].close<=seq[seq.length-1].open)seq.pop();
  console.log(`\n连续阳线段: ${seq.length}根 (需≥${CFG.min_consecutive_bull})`);
  if(seq.length>0)console.log(`  ${bj(seq[0].open_time)} → ${bj(seq[seq.length-1].open_time)}`);
  if(seq.length<CFG.min_consecutive_bull){console.log('❌ 连续阳线不足 → null');process.exit(0);}

  const bull_bars=seq.filter(k=>k.close>k.open);
  const good=bull_bars.filter(k=>{const r=k.high-k.low;return r>0&&Math.abs(k.close-k.open)/r>=CFG.min_body_ratio;}).length;
  console.log(`实体占比达标根数: ${good}/${bull_bars.length} = ${(good/bull_bars.length*100).toFixed(0)}% (需≥60%)`);
  if(good/bull_bars.length<CFG.min_body_ratio_bars){console.log('❌ 实体占比不足 → null');process.exit(0);}

  const start_price=seq[0].open;
  const last_bull=[...seq].reverse().find(k=>k.close>k.open)!;
  const end_price=last_bull.close;
  const amplitude=end_price-start_price;
  console.log(`\n波: ${start_price} → ${end_price}  幅度 ${(amplitude/start_price*100).toFixed(2)}% (需≥5%)`);
  if(amplitude/start_price<CFG.min_wave_amplitude_pct){console.log('❌ 涨幅不足 → null');process.exit(0);}

  const wave_avg_body_pct=bull_bars.reduce((s,k)=>s+Math.abs(k.close-k.open)/k.open,0)/bull_bars.length;
  const base_pcts=base_klines.map(k=>Math.abs(k.close-k.open)/k.open).sort((a,b)=>a-b);
  const mid=Math.floor(base_pcts.length/2);
  const base_median=base_pcts.length%2===0?(base_pcts[mid-1]+base_pcts[mid])/2:base_pcts[mid];
  console.log(`波内平均实体%: ${(wave_avg_body_pct*100).toFixed(3)}% vs 基准中位数×1.1: ${(base_median*CFG.amplitude_multiplier*100).toFixed(3)}%`);
  if(wave_avg_body_pct<base_median*CFG.amplitude_multiplier){console.log('❌ 实体强度不足 → null');process.exit(0);}

  const wave_high=Math.max(...seq.map(k=>k.high));
  const lb_start=Math.max(0,len-CFG.wave_high_lookback);
  const lb_high=Math.max(...cache.slice(lb_start,len).map(k=>k.high));
  console.log(`波高点 ${wave_high} vs 近${CFG.wave_high_lookback}根最高 ${lb_high} (需 波高≥区间高)`);
  if(wave_high<lb_high){console.log('❌ 非近期最高点 → null');process.exit(0);}

  console.log('\n✅✅✅ 全部通过! 应识别为强势波并进观察区');
  process.exit(0);
}
main().catch(e=>{console.error('ERR:',e.message);process.exit(1);});
