/**
 * 趋势跟随信号质量分析（一次性脚本）
 *
 * 直接用 .env 的 MySQL 配置连服务器库，统计：
 *   1. 报警总量 / 时间跨度 / 各周期·各等级分布
 *   2. 事后评估覆盖率（多少报警已被 evaluate_alert_outcomes 打标）
 *   3. 按 等级×周期 的胜率 / 盈亏比 / MFE / MAE（low 与 wave 两种止损口径）
 *   4. 信号特征（缩量 / 止跌形态 / EMA20支撑）对胜率的增益
 *   5. 多周期扳机确认入场 vs 裸报警入场 的成绩单对比
 *
 * 运行: npx ts-node -r tsconfig-paths/register dev/analysis/analyze_trend_signal_quality.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql, { RowDataPacket } from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 4,
});

function bj(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

async function q<T extends RowDataPacket>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query<T[]>(sql, params);
  return rows;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  趋势跟随信号质量分析');
  console.log(`  DB: ${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT}/${process.env.MYSQL_DATABASE}`);
  console.log('═'.repeat(70));

  // ---- 0. 总览 ----
  const [overview] = await q<any>(`
    SELECT COUNT(*) AS total,
           MIN(kline_time) AS min_t, MAX(kline_time) AS max_t,
           COUNT(DISTINCT symbol) AS symbols
    FROM trend_follow_alerts`);
  if (!overview || Number(overview.total) === 0) {
    console.log('\n⚠️  trend_follow_alerts 表为空，没有报警数据。');
    await pool.end();
    return;
  }
  const span_h = (Number(overview.max_t) - Number(overview.min_t)) / 3_600_000;
  console.log(`\n【总览】`);
  console.log(`  报警总数: ${overview.total}   覆盖币种: ${overview.symbols}`);
  console.log(`  时间跨度: ${bj(Number(overview.min_t))}  →  ${bj(Number(overview.max_t))}`);
  console.log(`  跨度: ${span_h.toFixed(1)} 小时 (${(span_h / 24).toFixed(1)} 天)`);
  console.log(`  平均频率: ${(Number(overview.total) / Math.max(span_h, 1)).toFixed(1)} 条/小时`);

  // ---- 1. 等级×周期分布 ----
  const dist = await q<any>(`
    SELECT timeframe, alert_level, COUNT(*) AS n
    FROM trend_follow_alerts
    GROUP BY timeframe, alert_level
    ORDER BY FIELD(timeframe,'5m','15m','1h','4h'), alert_level`);
  console.log(`\n【报警分布】(timeframe × level)`);
  console.log('  tf    Lv0   Lv1   Lv2   Lv3');
  const grid: Record<string, number[]> = {};
  for (const r of dist) {
    grid[r.timeframe] = grid[r.timeframe] || [0, 0, 0, 0];
    grid[r.timeframe][r.alert_level] = Number(r.n);
  }
  for (const tf of ['5m', '15m', '1h', '4h']) {
    if (!grid[tf]) continue;
    const g = grid[tf];
    console.log(`  ${tf.padEnd(5)} ${String(g[0]).padStart(5)} ${String(g[1]).padStart(5)} ${String(g[2]).padStart(5)} ${String(g[3]).padStart(5)}`);
  }

  // ---- 2. 评估覆盖率 ----
  const [cov] = await q<any>(`
    SELECT
      (SELECT COUNT(*) FROM trend_follow_alerts) AS alerts,
      (SELECT COUNT(*) FROM trend_follow_alert_outcomes) AS outcomes,
      (SELECT COUNT(*) FROM trend_follow_alert_outcomes WHERE outcome_low='open' OR outcome_wave='open') AS still_open`);
  const cov_pct = (Number(cov.outcomes) / Number(cov.alerts) * 100).toFixed(1);
  console.log(`\n【事后评估覆盖率】`);
  console.log(`  已评估: ${cov.outcomes}/${cov.alerts} (${cov_pct}%)   仍 open(未触及止盈/止损): ${cov.still_open}`);

  // ---- 3. 胜率/盈亏比 (两种止损口径) ----
  for (const stop of ['low', 'wave'] as const) {
    const oc = `outcome_${stop}`;
    const rr = `rr_${stop}`;
    const rows = await q<any>(`
      SELECT alert_level, timeframe,
        COUNT(*) AS samples,
        SUM(${oc}='win')  AS wins,
        SUM(${oc}='loss') AS losses,
        SUM(${oc}='open') AS opens,
        ROUND(SUM(${oc}='win')/NULLIF(SUM(${oc} IN ('win','loss')),0)*100,1) AS win_rate,
        ROUND(AVG(${rr}),2) AS avg_rr,
        ROUND(AVG(mfe_pct),2) AS avg_mfe,
        ROUND(AVG(mae_pct),2) AS avg_mae,
        ROUND(AVG(mfe_pct)/NULLIF(-AVG(mae_pct),0),2) AS mfe_mae
      FROM trend_follow_alert_outcomes
      GROUP BY alert_level, timeframe
      ORDER BY FIELD(timeframe,'5m','15m','1h','4h'), alert_level`);
    console.log(`\n【胜率统计 — 止损口径: ${stop === 'low' ? '回调最低点' : '第一波起涨价'}】`);
    console.log('  tf    Lv  样本  胜  负  open  胜率%   avgRR  MFE%   MAE%   MFE/MAE');
    for (const r of rows) {
      console.log(
        `  ${String(r.timeframe).padEnd(5)} ${String(r.alert_level).padStart(2)} ` +
        `${String(r.samples).padStart(5)} ${String(r.wins).padStart(3)} ${String(r.losses).padStart(3)} ` +
        `${String(r.opens).padStart(5)}  ${String(r.win_rate ?? '-').padStart(5)}  ` +
        `${String(r.avg_rr ?? '-').padStart(5)}  ${String(r.avg_mfe ?? '-').padStart(5)} ` +
        `${String(r.avg_mae ?? '-').padStart(6)}  ${String(r.mfe_mae ?? '-').padStart(6)}`
      );
    }
  }

  // ---- 4. 信号特征增益 (low 口径) ----
  const feat = await q<any>(`
    SELECT volume_shrink, reversal_signal, ema20_support,
      COUNT(*) AS samples,
      ROUND(SUM(outcome_low='win')/NULLIF(SUM(outcome_low IN ('win','loss')),0)*100,1) AS win_rate,
      ROUND(AVG(mfe_pct),2) AS avg_mfe,
      ROUND(AVG(mae_pct),2) AS avg_mae
    FROM trend_follow_alert_outcomes
    GROUP BY volume_shrink, reversal_signal, ema20_support
    HAVING samples >= 10
    ORDER BY win_rate DESC`);
  console.log(`\n【信号特征组合胜率】(low 口径, 样本≥10, 按胜率排序)`);
  console.log('  缩量 止跌 EMA20  样本  胜率%   MFE%   MAE%');
  for (const r of feat) {
    console.log(
      `   ${r.volume_shrink ? '✅' : '  '}  ${r.reversal_signal ? '✅' : '  '}  ${r.ema20_support ? ' ✅ ' : '   '}` +
      `  ${String(r.samples).padStart(5)}  ${String(r.win_rate ?? '-').padStart(5)}  ` +
      `${String(r.avg_mfe ?? '-').padStart(5)} ${String(r.avg_mae ?? '-').padStart(6)}`
    );
  }
  // 单特征边际增益
  for (const col of ['volume_shrink', 'reversal_signal', 'ema20_support']) {
    const m = await q<any>(`
      SELECT ${col} AS f,
        COUNT(*) AS n,
        ROUND(SUM(outcome_low='win')/NULLIF(SUM(outcome_low IN ('win','loss')),0)*100,1) AS wr
      FROM trend_follow_alert_outcomes GROUP BY ${col}`);
    const on = m.find((x: any) => x.f === 1);
    const off = m.find((x: any) => x.f === 0);
    if (on && off) {
      console.log(`  · ${col.padEnd(16)} 有=${String(on.wr ?? '-').padStart(5)}% (n=${on.n})  无=${String(off.wr ?? '-').padStart(5)}% (n=${off.n})`);
    }
  }

  // ---- 5. 多周期扳机 vs 裸报警 ----
  const trig = await q<any>(`
    SELECT parent_timeframe, parent_alert_level,
      COUNT(*) AS samples,
      SUM(outcome='win')  AS wins,
      SUM(outcome='loss') AS losses,
      SUM(outcome='open') AS opens,
      SUM(outcome IS NULL) AS uneval,
      ROUND(SUM(outcome='win')/NULLIF(SUM(outcome IN ('win','loss')),0)*100,1) AS win_rate,
      ROUND(AVG(rr_ratio),2) AS avg_rr,
      ROUND(AVG(mfe_pct),2) AS avg_mfe,
      ROUND(AVG(mae_pct),2) AS avg_mae
    FROM trend_follow_entry_triggers
    GROUP BY parent_timeframe, parent_alert_level
    ORDER BY parent_timeframe, parent_alert_level`);
  console.log(`\n【多周期扳机确认入场 (5m结构确认)】`);
  if (trig.length === 0) {
    console.log('  (无扳机确认记录)');
  } else {
    console.log('  父周期 父Lv  样本  胜  负  open  未评  胜率%  avgRR  MFE%   MAE%');
    for (const r of trig) {
      console.log(
        `  ${String(r.parent_timeframe).padEnd(6)} ${String(r.parent_alert_level).padStart(3)} ` +
        `${String(r.samples).padStart(5)} ${String(r.wins).padStart(3)} ${String(r.losses).padStart(3)} ` +
        `${String(r.opens).padStart(5)} ${String(r.uneval).padStart(5)}  ${String(r.win_rate ?? '-').padStart(5)}  ` +
        `${String(r.avg_rr ?? '-').padStart(5)} ${String(r.avg_mfe ?? '-').padStart(5)} ${String(r.avg_mae ?? '-').padStart(6)}`
      );
    }
  }

  await pool.end();
  console.log('\n' + '═'.repeat(70));
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
