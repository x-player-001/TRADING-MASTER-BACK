/**
 * 模拟盘 ↔ 回测 对拍（需在服务器运行，读取 /tmp/macd_div 下的回测缓存与事件）
 *
 * 把缓存的全市场 5m 按时间顺序喂给 PaperTradingService（live 模式、关闭单币单仓），
 * 与回测 rev_{5m,15m}.csv 中满足同样过滤条件且成交的事件逐笔比对：
 *   · 信号键 (symbol, 反转K线时间) 的重合率
 *   · 共同交易的成交价、止损距离、R 结果差异
 *   · 两边总体 EV（模拟盘 15m 用 5m 撮合，结果允许小幅差异）
 *
 * 运行:
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node -r tsconfig-paths/register scripts/dev/verify/verify_paper_trading_parity.ts [/tmp/macd_div]
 */

import * as fs from 'fs';
import * as zlib from 'zlib';
import { PaperEngine } from '@/services/paper_trading/paper_engine';
import { PaperTradingService } from '@/services/paper_trading/paper_trading_service';
import { PAPER_ACCOUNT, PAPER_STRATEGIES, TIMEFRAME_MS } from '@/services/paper_trading/paper_strategies';
import { PaperBar, PaperTrade } from '@/services/paper_trading/paper_types';

const DIR = process.argv[2] || '/tmp/macd_div';

/** 回测事件（只取需要的列） */
interface BacktestEvent { sym: string; setup_time: number; fill_time: number; risk: number; r: number }

/** 读取回测事件并按策略过滤（与研究结论一致）；extra 为策略附加条件 */
function load_backtest(tf: '5m' | '15m', r_col: string, extra: (g: (k: string) => number) => boolean): Map<string, BacktestEvent> {
  const lines = fs.readFileSync(`${DIR}/rev_${tf}.csv`, 'utf8').split('\n');
  const hd = lines.shift()!.split(',');
  const ix = (k: string) => hd.indexOf(k);
  const out = new Map<string, BacktestEvent>();
  for (const ln of lines) {
    const p = ln.split(',');
    if (p.length < hd.length) continue;
    const g = (k: string) => +p[ix(k)];
    if (g('dir') !== 1) continue;
    if (!(g('gap') >= 3 && g('gdep') >= 0.2 && g('dif_ratio') < 0.6 && g('hist_ratio') < 0.3
      && g('imp_pct') >= 20 && g('leg_pct') >= 10 && g('qv24') >= 10 && g('risk') >= 0.3 && g('risk') <= 10 && extra(g))) continue;
    const fill_time = g('t');
    const setup_time = fill_time - g('delay') * TIMEFRAME_MS[tf];
    out.set(`${p[0]}|${setup_time}`, { sym: p[0], setup_time, fill_time, risk: g('risk'), r: g(r_col) });
  }
  return out;
}

async function main(): Promise<void> {
  const engine = new PaperEngine({ ...PAPER_ACCOUNT, one_position_per_symbol: false }, PAPER_STRATEGIES);
  const service = new PaperTradingService(engine, PAPER_STRATEGIES);
  const trades: PaperTrade[] = [];

  const files = fs.readdirSync(`${DIR}/cache`).filter(f => f.endsWith('.csv.gz')).sort();
  console.log(`读取 ${files.length} 个日缓存...`);
  for (const f of files) {
    const by_symbol = new Map<string, PaperBar[]>();
    for (const ln of zlib.gunzipSync(fs.readFileSync(`${DIR}/cache/${f}`)).toString().split('\n')) {
      const p = ln.split(',');
      if (p.length < 7) continue;
      const close = +p[5], volume = +p[6], t = +p[1];
      const arr = by_symbol.get(p[0]) ?? [];
      arr.push({ open_time: t, close_time: t + 299_999, open: +p[2], high: +p[3], low: +p[4], close, volume, quote_volume: close * volume });
      by_symbol.set(p[0], arr);
    }
    for (const [sym, bars] of by_symbol) {
      bars.sort((a, b) => a.open_time - b.open_time);
      for (const b of bars) {
        const res = service.process_5m(sym, b, true);
        trades.push(...res.submitted);
      }
    }
  }

  for (const st of PAPER_STRATEGIES) {
    const f = st.filters;
    const bt = load_backtest(st.timeframe, st.timeframe === '15m' ? 'm_r2' : 'm_sb2',
      g => g('imp_pct') >= f.min_imp_pct && (f.min_qv_surge === undefined || g('qv_surge') >= f.min_qv_surge));
    const filled = trades.filter(t => t.strategy_id === st.id && t.fill_price !== null);
    const closed = filled.filter(t => t.status === 'closed');
    const paper = new Map(filled.map(t => [`${t.symbol}|${t.setup_time}`, t]));
    const common = [...paper.keys()].filter(k => bt.has(k));
    const only_paper = [...paper.keys()].filter(k => !bt.has(k));
    const only_bt = [...bt.keys()].filter(k => !paper.has(k));

    const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    const paper_r = closed.map(t => t.r_multiple!);
    // 基础止损距离（极值相对成交价）两边口径相同，一致即说明成交价与极值都对上
    const base_risk = (t: PaperTrade) => (t.base_stop - t.fill_price!) / t.fill_price! * 100;
    const same_fill = common.filter(k => Math.abs(base_risk(paper.get(k)!) - bt.get(k)!.risk) < 0.01).length;
    const r_diff = common.filter(k => paper.get(k)!.status === 'closed').map(k => Math.abs(paper.get(k)!.r_multiple! - bt.get(k)!.r));

    console.log(`\n===== ${st.id} =====`);
    console.log(`  回测成交 ${bt.size} 笔，模拟盘成交 ${filled.length} 笔（已平 ${closed.length}），共同 ${common.length}`);
    console.log(`  仅模拟盘 ${only_paper.length}：${only_paper.slice(0, 5).join('  ')}`);
    console.log(`  仅回测   ${only_bt.length}：${only_bt.slice(0, 5).join('  ')}`);
    console.log(`  共同交易中成交价/止损距离一致 ${same_fill}/${common.length}`);
    console.log(`  共同交易 R 差异：中位 ${r_diff.sort((a, b) => a - b)[r_diff.length >> 1]?.toFixed(3)}，>0.5R 的 ${r_diff.filter(d => d > 0.5).length} 笔`);
    console.log(`  EV：模拟盘 ${avg(paper_r).toFixed(3)}R（n=${paper_r.length}） vs 回测 ${avg([...bt.values()].map(e => e.r)).toFixed(3)}R（n=${bt.size}）`);
    const reasons: Record<string, number> = {};
    for (const t of trades.filter(x => x.strategy_id === st.id)) {
      const k = t.status === 'closed' ? `closed:${t.exit_reason}` : `${t.status}${t.cancel_reason ? ':' + t.cancel_reason : ''}`;
      reasons[k] = (reasons[k] ?? 0) + 1;
    }
    console.log(`  状态分布：${JSON.stringify(reasons)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
