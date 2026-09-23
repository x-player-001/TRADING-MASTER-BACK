/**
 * 导出 1h Lv1 全部单子(盈利/亏损/未了结) 到文件
 *   - CSV:  方便 Excel 打开
 *   - TXT:  带分组汇总的可读清单
 *
 * 运行: npx ts-node -r tsconfig-paths/register dev/analysis/export_1h_lv1_trades.ts [low|wave]
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql, { RowDataPacket } from 'mysql2/promise';
import * as fs from 'fs';
import * as path from 'path';

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
  const s = new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return s.replace(/\//g, '-');
}

async function main() {
  const oc = `outcome_${STOP}`;
  const stop_col = STOP === 'low' ? 'stop_low_price' : 'stop_wave_price';

  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      a.id AS alert_id, a.symbol, a.kline_time, a.created_at,
      o.entry_price, o.target_price, o.${stop_col} AS stop_price,
      o.${oc} AS outcome, o.mfe_pct, o.mae_pct,
      o.bars_to_exit_${STOP} AS bars_to_exit, o.eval_bars,
      a.volume_shrink, a.reversal_signal, a.ema20_support,
      a.wave_amplitude_pct, a.pullback_ratio, a.fib_zone
    FROM trend_follow_alert_outcomes o
    JOIN trend_follow_alerts a ON a.id = o.alert_id
    WHERE o.timeframe='1h' AND o.alert_level=1
    ORDER BY a.kline_time ASC`);

  const FEE = 0.10; // 双边手续费%

  // 计算每笔结果
  const trades = rows.map((r, idx) => {
    const entry = parseFloat(r.entry_price);
    const stop = parseFloat(r.stop_price);
    const target = parseFloat(r.target_price);
    const gain_pct = (target - entry) / entry * 100;
    const loss_pct = (entry - stop) / entry * 100;
    let pnl_pct = 0;
    if (r.outcome === 'win') pnl_pct = gain_pct - FEE;
    else if (r.outcome === 'loss') pnl_pct = -loss_pct - FEE;
    else pnl_pct = 0; // open 按0
    return {
      idx: idx + 1,
      alert_id: r.alert_id,
      time: bj(Number(r.kline_time)),
      symbol: r.symbol,
      outcome: r.outcome,
      entry, stop, target,
      gain_pct, loss_pct, pnl_pct,
      mfe_pct: parseFloat(r.mfe_pct),
      mae_pct: parseFloat(r.mae_pct),
      bars_to_exit: r.bars_to_exit,
      eval_bars: r.eval_bars,
      volume_shrink: r.volume_shrink === 1,
      reversal_signal: r.reversal_signal === 1,
      ema20_support: r.ema20_support === 1,
      wave_amplitude_pct: parseFloat(r.wave_amplitude_pct),
      pullback_ratio: parseFloat(r.pullback_ratio),
      fib_zone: r.fib_zone,
    };
  });

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const opens = trades.filter(t => t.outcome === 'open');

  // ---------- CSV ----------
  const csv_head = [
    'idx', 'alert_id', 'signal_time_bj', 'symbol', 'outcome',
    'entry', 'stop', 'target',
    'gain_pct_if_win', 'loss_pct_if_loss', 'net_pnl_pct',
    'mfe_pct', 'mae_pct', 'bars_to_exit', 'eval_bars',
    'volume_shrink', 'reversal_signal', 'ema20_support',
    'wave_amplitude_pct', 'pullback_ratio', 'fib_zone',
  ].join(',');
  const csv_body = trades.map(t => [
    t.idx, t.alert_id, t.time, t.symbol, t.outcome,
    t.entry, t.stop, t.target,
    t.gain_pct.toFixed(2), t.loss_pct.toFixed(2), t.pnl_pct.toFixed(2),
    t.mfe_pct, t.mae_pct, t.bars_to_exit ?? '', t.eval_bars,
    t.volume_shrink ? 1 : 0, t.reversal_signal ? 1 : 0, t.ema20_support ? 1 : 0,
    t.wave_amplitude_pct, t.pullback_ratio, t.fib_zone,
  ].join(',')).join('\n');

  // ---------- TXT ----------
  const lines: string[] = [];
  const sep = '═'.repeat(100);
  lines.push(sep);
  lines.push(`  1h Lv1 全部单子清单  —  止损口径: ${STOP === 'low' ? '回调最低点(-0.3%)' : '第一波起涨价'}`);
  lines.push(`  导出时间: ${bj(Date.now())}   手续费(双边): ${FEE}%`);
  lines.push(`  总样本: ${trades.length}  (盈利 ${wins.length} / 亏损 ${losses.length} / 未了结 ${opens.length})`);
  lines.push(sep);

  const fmt = (t: typeof trades[number]) =>
    `  ${String(t.idx).padStart(3)}  ${t.time}  ${String(t.symbol).padEnd(14)}` +
    `入场 ${t.entry.toPrecision(6).padStart(12)}  止损 ${t.stop.toPrecision(6).padStart(12)}  止盈 ${t.target.toPrecision(6).padStart(12)}  ` +
    `净盈亏 ${(t.pnl_pct >= 0 ? '+' : '') + t.pnl_pct.toFixed(2)}%`.padEnd(18) +
    `  退出根${String(t.bars_to_exit ?? '-').padStart(3)}  ` +
    `${t.volume_shrink ? '缩' : '·'}${t.reversal_signal ? '止' : '·'}${t.ema20_support ? 'E' : '·'}  回调${(t.pullback_ratio * 100).toFixed(0)}%`;

  lines.push(`\n【盈利单 ${wins.length} 笔】`);
  wins.forEach(t => lines.push(fmt(t)));
  lines.push(`\n【亏损单 ${losses.length} 笔】`);
  losses.forEach(t => lines.push(fmt(t)));
  lines.push(`\n【未了结(open) ${opens.length} 笔】`);
  opens.forEach(t => lines.push(fmt(t)));

  // 汇总
  const sum_pnl = trades.reduce((a, t) => a + t.pnl_pct, 0);
  const sum_win = wins.reduce((a, t) => a + t.pnl_pct, 0);
  const sum_loss = losses.reduce((a, t) => a + t.pnl_pct, 0);
  const closed = wins.length + losses.length;
  lines.push('\n' + sep);
  lines.push(`  盈利单合计:  +${sum_win.toFixed(1)}%   (均 +${(sum_win / Math.max(wins.length, 1)).toFixed(2)}%/笔)`);
  lines.push(`  亏损单合计:  ${sum_loss.toFixed(1)}%   (均 ${(sum_loss / Math.max(losses.length, 1)).toFixed(2)}%/笔)`);
  lines.push(`  胜率(已了结): ${(wins.length / Math.max(closed, 1) * 100).toFixed(1)}%   净累计盈亏(等额, open按0): ${sum_pnl >= 0 ? '+' : ''}${sum_pnl.toFixed(1)}%`);
  lines.push(sep);

  // ---------- 写文件 ----------
  const out_dir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(out_dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const csv_path = path.join(out_dir, `1h_lv1_trades_${STOP}_${stamp}.csv`);
  const txt_path = path.join(out_dir, `1h_lv1_trades_${STOP}_${stamp}.txt`);

  fs.writeFileSync(csv_path, '﻿' + csv_head + '\n' + csv_body, 'utf8'); // BOM 防 Excel 中文乱码
  fs.writeFileSync(txt_path, lines.join('\n'), 'utf8');

  console.log(lines.join('\n'));
  console.log(`\n✅ 已保存:`);
  console.log(`   CSV: ${csv_path}`);
  console.log(`   TXT: ${txt_path}`);

  await pool.end();
}

main().catch(async (e) => { console.error(e.message); await pool.end().catch(() => {}); process.exit(1); });
