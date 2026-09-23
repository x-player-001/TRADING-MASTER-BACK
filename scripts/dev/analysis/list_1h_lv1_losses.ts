/**
 * 列出 1h Lv1 (low 口径) 所有亏损单 —— 币种 + 信号时间 + 价格 + 亏损幅度
 *
 * 运行: npx ts-node -r tsconfig-paths/register dev/analysis/list_1h_lv1_losses.ts [low|wave]
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql, { RowDataPacket } from 'mysql2/promise';

const STOP = (process.argv[2] === 'wave' ? 'wave' : 'low') as 'low' | 'wave';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 4,
});

function bj(ts: number): string {
  // 输出 北京时间 MM-DD HH:mm
  const d = new Date(ts);
  const s = d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return s.replace(/\//g, '-');
}

async function main() {
  const oc = `outcome_${STOP}`;
  const stop_col = STOP === 'low' ? 'stop_low_price' : 'stop_wave_price';

  // JOIN 回 alerts 拿 kline_time(报警信号时间) 和 信号特征
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      a.symbol, a.kline_time, a.created_at,
      o.entry_price, o.target_price, o.${stop_col} AS stop_price,
      o.mfe_pct, o.mae_pct, o.bars_to_exit_${STOP} AS bars_to_exit, o.eval_bars,
      a.volume_shrink, a.reversal_signal, a.ema20_support,
      a.wave_amplitude_pct, a.pullback_ratio, a.fib_zone
    FROM trend_follow_alert_outcomes o
    JOIN trend_follow_alerts a ON a.id = o.alert_id
    WHERE o.timeframe='1h' AND o.alert_level=1 AND o.${oc}='loss'
    ORDER BY a.kline_time ASC`);

  console.log('═'.repeat(108));
  console.log(`  1h Lv1 亏损单清单 — 止损口径: ${STOP === 'low' ? '回调最低点(-0.3%)' : '第一波起涨价'}   共 ${rows.length} 笔`);
  console.log('═'.repeat(108));
  console.log(
    '  #  信号时间(北京)   币种'.padEnd(34) +
    '入场价'.padStart(13) + '止损价'.padStart(13) + '止盈价'.padStart(13) +
    '亏损%'.padStart(9) + '退出根'.padStart(7) + '  缩量 止跌 EMA  回调%'
  );
  console.log('─'.repeat(108));

  let sum_loss = 0;
  let i = 0;
  for (const r of rows) {
    i++;
    const entry = parseFloat(r.entry_price);
    const stop = parseFloat(r.stop_price);
    const loss_pct = (entry - stop) / entry * 100;
    sum_loss += loss_pct;

    console.log(
      `  ${String(i).padStart(2)}  ${bj(Number(r.kline_time)).padEnd(15)} ${String(r.symbol).padEnd(13)}` +
      `${entry.toPrecision(6).padStart(13)}${stop.toPrecision(6).padStart(13)}${parseFloat(r.target_price).toPrecision(6).padStart(13)}` +
      `${('-' + loss_pct.toFixed(2)).padStart(9)}${String(r.bars_to_exit ?? '-').padStart(7)}` +
      `   ${r.volume_shrink ? '✅' : '· '}   ${r.reversal_signal ? '✅' : '· '}  ${r.ema20_support ? '✅' : '· '}` +
      `  ${(parseFloat(r.pullback_ratio) * 100).toFixed(0)}%`
    );
  }

  console.log('─'.repeat(108));
  console.log(`  亏损单合计亏损幅度: -${sum_loss.toFixed(1)}%   平均每笔: -${(sum_loss / Math.max(rows.length,1)).toFixed(2)}%`);

  // 按币种聚合亏损分布
  const by_symbol: Record<string, { n: number; loss: number }> = {};
  for (const r of rows) {
    const entry = parseFloat(r.entry_price);
    const stop = parseFloat(r.stop_price);
    const loss_pct = (entry - stop) / entry * 100;
    by_symbol[r.symbol] = by_symbol[r.symbol] || { n: 0, loss: 0 };
    by_symbol[r.symbol].n++;
    by_symbol[r.symbol].loss += loss_pct;
  }
  const multi = Object.entries(by_symbol).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n);
  if (multi.length) {
    console.log(`\n  【重复亏损币种 (≥2次)】`);
    for (const [sym, v] of multi) {
      console.log(`    ${sym.padEnd(14)} ${v.n}次  累计 -${v.loss.toFixed(1)}%`);
    }
  }

  await pool.end();
  console.log('═'.repeat(108));
}

main().catch(async (e) => { console.error(e.message); await pool.end().catch(() => {}); process.exit(1); });
