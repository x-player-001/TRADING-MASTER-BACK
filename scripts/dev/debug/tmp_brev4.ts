import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { ConfigManager } from '@/core/config/config_manager';
import { KlineAggregator } from '@/core/data/kline_aggregator';

const bj = (ts:number)=>{const d=new Date(ts+8*3600000);return `${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:00`;};
const CFG={min_consecutive_bull:4,allow_small_bear_gap:2,min_body_ratio:0.30,min_body_ratio_bars:0.60,amplitude_multiplier:1.1,min_wave_amplitude_pct:0.05,min_bar_range_pct:0.005,amplitude_lookback:25,max_pullback_bars_before_detect:10,wave_high_lookback:150};

function trace(cache:any[], label:string){
  console.log(`\n════════ 扫描时刻: ${label} (缓存${cache.length}根, 末根=${bj(cache[cache.length-1].open_time)}) ════════`);
  const len=cache.length;
  const base_end=Math.max(0,len-CFG.min_consecutive_bull);
  const base_klines=cache.slice(Math.max(0,base_end-CFG.amplitude_lookback),base_end);
  const base_avg_body=base_klines.reduce((s,k)=>s+Math.abs(k.close-k.open),0)/base_klines.length;
  let wei=len-1,sk=0;
  while(wei>=0&&sk<CFG.max_pullback_bars_before_detect&&cache[wei].close<=cache[wei].open){wei--;sk++;}
  console.log(`跳过末尾阴线 ${sk}根 → 波末端 ${wei>=0?bj(cache[wei].open_time):'无'}`);
  if(wei<0||cache[wei].close<=cache[wei].open){console.log('❌ 末端非阳线');return;}
  const scan=Math.min(wei+1,20); let seq:any[]=[],sbc=0;
  for(let i=wei;i>=wei-scan+1;i--){const k=cache[i];const bull=k.close>k.open;const body=Math.abs(k.close-k.open);const range=k.high-k.low;const sb=!bull&&range>0&&body/range<0.3&&body<base_avg_body*0.3;
    if(k.open>0&&range/k.open<CFG.min_bar_range_pct)break;
    if(bull)seq.unshift(k); else if(sb&&sbc<CFG.allow_small_bear_gap&&seq.length>0){seq.unshift(k);sbc++;} else break;}
  while(seq.length>0&&seq[0].close<=seq[0].open)seq.shift();
  while(seq.length>0&&seq[seq.length-1].close<=seq[seq.length-1].open)seq.pop();
  console.log(`连续阳线段 ${seq.length}根 ${seq.length>0?`[${bj(seq[0].open_time)}→${bj(seq[seq.length-1].open_time)}]`:''} (需≥4)`);
  if(seq.length<CFG.min_consecutive_bull){console.log('❌ 连续阳线不足');return;}
  const bb=seq.filter(k=>k.close>k.open);
  const good=bb.filter(k=>{const r=k.high-k.low;return r>0&&Math.abs(k.close-k.open)/r>=CFG.min_body_ratio;}).length;
  console.log(`实体占比达标 ${good}/${bb.length}=${(good/bb.length*100).toFixed(0)}% (需≥60%)`);
  if(good/bb.length<CFG.min_body_ratio_bars){console.log('❌ 实体占比不足');return;}
  const sp=seq[0].open, lb=[...seq].reverse().find(k=>k.close>k.open)!, ep=lb.close, amp=ep-sp;
  console.log(`波 ${sp}→${ep} 幅度${(amp/sp*100).toFixed(2)}% (需≥5%)`);
  if(amp/sp<CFG.min_wave_amplitude_pct){console.log('❌ 涨幅不足');return;}
  const wabp=bb.reduce((s,k)=>s+Math.abs(k.close-k.open)/k.open,0)/bb.length;
  const bp=base_klines.map(k=>Math.abs(k.close-k.open)/k.open).sort((a,b)=>a-b);const mid=Math.floor(bp.length/2);
  const bm=bp.length%2===0?(bp[mid-1]+bp[mid])/2:bp[mid];
  console.log(`波内平均实体% ${(wabp*100).toFixed(3)}% vs 基准中位×1.1 ${(bm*CFG.amplitude_multiplier*100).toFixed(3)}%`);
  if(wabp<bm*CFG.amplitude_multiplier){console.log('❌ 实体强度不足(基准中位数偏高)');return;}
  const wh=Math.max(...seq.map(k=>k.high));const lbs=Math.max(0,len-CFG.wave_high_lookback);const lh=Math.max(...cache.slice(lbs,len).map(k=>k.high));
  console.log(`波高 ${wh} vs 近${CFG.wave_high_lookback}根最高 ${lh}`);
  if(wh<lh){console.log('❌ 非近期最高点');return;}
  console.log('✅ 全部通过!');
}

async function main(){
  ConfigManager.getInstance().initialize();
  const agg=new KlineAggregator();
  const all=await agg.get_klines_from_db('BREVUSDT','1h',
    new Date('2026-06-25T00:00:00+08:00').getTime(), new Date('2026-07-02T12:00:00+08:00').getTime());
  const idx=(label:string)=>all.findIndex(k=>bj(k.open_time)===label);
  for(const t of ['07-02 01:00','07-02 02:00','07-02 03:00']){
    const i=idx(t); if(i<0){console.log('未找到',t);continue;}
    trace(all.slice(0,i+1), t);
  }
  process.exit(0);
}
main().catch(e=>{console.error('ERR:',e.message);process.exit(1);});
