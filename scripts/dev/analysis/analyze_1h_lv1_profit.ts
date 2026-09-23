/**
 * 1h Lv1 能否盈利 —— 逐笔期望值(EV)分析
 *
 * 口径与 evaluate_alert_outcomes 完全一致：
 *   win  → 触及 target_price(第一波高点)，单笔收益 = (target-entry)/entry
 *   loss → 触及 stop(回调低点下方0.3%)，单笔亏损 = (entry-stop)/entry  (负)
 *   open → 封顶未触及，按「评估窗结束时市价」近似平仓：用 mfe/mae 无法直接得收盘，
 *          保守起见 open 单按 0 计(不赚不赔)，并单列出来看占比影响。
 *
 * 手续费：币安 U 本位 taker 单边 0.05%，进出共 0.10%（VIP0 无 BNB 抵扣最保守口径）。
 *
 * 运行: npx ts-node -r tsconfig-paths/register dev/analysis/analyze_1h_lv1_profit.ts [low|wave]
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql, { RowDataPacket } from 'mysql2/promise';

const STOP = (process.argv[2] === 'wave' ? 'wave' : 'low') as 'low' | 'wave';
const FEE_ROUNDTRIP = 0.10;  // % 双边手续费

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 4,
});

async function main() {
  const oc = `outcome_${STOP}`;
  const stop_col = STOP === 'low' ? 'stop_low_price' : 'stop_wave_price';

  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT symbol, entry_price, target_price, ${stop_col} AS stop_price,
           ${oc} AS outcome, mfe_pct, mae_pct, eval_bars
    FROM trend_follow_alert_outcomes
    WHERE timeframe='1h' AND alert_level=1`);

  console.log('═'.repeat(64));
  console.log(`  1h Lv1 逐笔盈利分析 — 止损口径: ${STOP === 'low' ? '回调最低点(-0.3%)' : '第一波起涨价'}`);
  console.log(`  手续费(双边): ${FEE_ROUNDTRIP}%   样本: ${rows.length} 笔`);
  console.log('═'.repeat(64));

  let wins = 0, losses = 0, opens = 0;
  let sum_win_pct = 0, sum_loss_pct = 0;
  // 资金曲线：每笔等额下注(本金的1个单位)，累加单笔收益%
  let equity_closed = 0;   // 只统计已了结(win/loss)的累计收益%
  let equity_all = 0;      // open 按0计入的累计收益%
  const win_pcts: number[] = [];
  const loss_pcts: number[] = [];

  for (const r of rows) {
    const entry = parseFloat(r.entry_price);
    const target = parseFloat(r.target_price);
    const stop = parseFloat(r.stop_price);
    const gain_pct = (target - entry) / entry * 100;   // 正
    const lose_pct = (entry - stop) / entry * 100;     // 正(亏损绝对值)

    if (r.outcome === 'win') {
      wins++;
      const net = gain_pct - FEE_ROUNDTRIP;
      sum_win_pct += net;
      equity_closed += net;
      equity_all += net;
      win_pcts.push(gain_pct);
    } else if (r.outcome === 'loss') {
      losses++;
      const net = -lose_pct - FEE_ROUNDTRIP;
      sum_loss_pct += net;
      equity_closed += net;
      equity_all += net;
      loss_pcts.push(lose_pct);
    } else {
      opens++;
      // open 保守按 0 收益（仅扣手续费，因为实际会有进出场成本）
      equity_all += -FEE_ROUNDTRIP;
    }
  }

  const closed = wins + losses;
  const win_rate = closed ? wins / closed * 100 : 0;
  const avg_win = win_pcts.length ? win_pcts.reduce((a, b) => a + b, 0) / win_pcts.length : 0;
  const avg_loss = loss_pcts.length ? loss_pcts.reduce((a, b) => a + b, 0) / loss_pcts.length : 0;

  // 期望值(每笔，已扣手续费) —— 只对已了结样本
  const p = win_rate / 100;
  const ev_gross = p * avg_win - (1 - p) * avg_loss;
  const ev_net = ev_gross - FEE_ROUNDTRIP;

  console.log(`\n【了结样本】win=${wins}  loss=${losses}  open=${opens}`);
  console.log(`  胜率(已了结): ${win_rate.toFixed(1)}%`);
  console.log(`  平均盈利单: +${avg_win.toFixed(2)}%   平均亏损单: -${avg_loss.toFixed(2)}%`);
  console.log(`  盈亏比(payoff): ${(avg_win / avg_loss).toFixed(2)} : 1`);
  console.log(`  盈亏平衡胜率: ${(avg_loss / (avg_win + avg_loss) * 100).toFixed(1)}%  ` +
    `(实际胜率${win_rate >= avg_loss / (avg_win + avg_loss) * 100 ? '✅高于' : '❌低于'}盈亏平衡线)`);

  console.log(`\n【单笔期望值 EV（仅已了结样本）】`);
  console.log(`  毛EV: ${ev_gross >= 0 ? '+' : ''}${ev_gross.toFixed(3)}% / 笔`);
  console.log(`  扣手续费净EV: ${ev_net >= 0 ? '+' : ''}${ev_net.toFixed(3)}% / 笔  ` +
    `${ev_net > 0 ? '✅ 正期望(可盈利)' : '❌ 负期望(长期亏损)'}`);

  console.log(`\n【累计资金曲线（每笔等额，单位=本金%）】`);
  console.log(`  仅了结单累计: ${equity_closed >= 0 ? '+' : ''}${equity_closed.toFixed(1)}%  (${closed}笔)`);
  console.log(`  含open按0计累计: ${equity_all >= 0 ? '+' : ''}${equity_all.toFixed(1)}%  (${rows.length}笔)`);

  // 敏感性：不同手续费 / 不同止盈目标缩水
  console.log(`\n【敏感性测试（净EV/笔）】`);
  for (const fee of [0, 0.05, 0.10, 0.14]) {
    const ev = p * avg_win - (1 - p) * avg_loss - fee;
    console.log(`  手续费${fee.toFixed(2)}%: ${ev >= 0 ? '+' : ''}${ev.toFixed(3)}%  ${ev > 0 ? '✅' : '❌'}`);
  }
  // 若止盈只吃到目标的 80%/60%（现实里很难精确摸到第一波高点）
  console.log(`\n【若实际止盈只吃到目标的一部分（手续费0.10%）】`);
  for (const cap of [1.0, 0.8, 0.6, 0.5]) {
    const ev = p * (avg_win * cap) - (1 - p) * avg_loss - FEE_ROUNDTRIP;
    console.log(`  吃到${(cap * 100).toFixed(0)}%目标: 均盈+${(avg_win * cap).toFixed(2)}%  净EV ${ev >= 0 ? '+' : ''}${ev.toFixed(3)}%  ${ev > 0 ? '✅' : '❌'}`);
  }

  await pool.end();
  console.log('\n' + '═'.repeat(64));
}

main().catch(async (e) => { console.error(e.message); await pool.end().catch(() => {}); process.exit(1); });
