/**
 * 诊断 12.25 00:30 为什么没有报警
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';
import { SRAlertService } from '../src/services/sr_alert_service';
import { KlineData } from '../src/analysis/support_resistance_detector';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  console.log('═'.repeat(70));
  console.log('     诊断 12.25 00:30 为什么没有报警');
  console.log('═'.repeat(70));

  const [rows] = await conn.execute<any[]>(`
    SELECT open_time, open, high, low, close, volume FROM (
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251220 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251221 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251222 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251223 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251224 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251225 WHERE symbol = 'BANANAUSDT'
    ) t
    ORDER BY open_time ASC
  `);

  const all_klines: KlineData[] = rows.map(r => ({
    open_time: parseInt(r.open_time),
    close_time: parseInt(r.open_time) + 15 * 60 * 1000 - 1,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume)
  }));

  console.log(`\n总共加载 ${all_klines.length} 根K线`);

  // 12.25 00:30 北京 = 12.24 16:30 UTC
  const target_utc = new Date('2025-12-24T16:30:00Z').getTime();
  const target_idx = all_klines.findIndex(k => k.open_time === target_utc);

  if (target_idx === -1) {
    console.log('未找到目标K线');
    await conn.end();
    return;
  }

  console.log(`\n目标K线索引: ${target_idx}`);

  // 只取到目标K线为止的数据
  const klines_at_target = all_klines.slice(0, target_idx + 1);
  const current = klines_at_target[klines_at_target.length - 1];

  const bj_time = current.open_time + 8 * 3600 * 1000;
  console.log(`\n目标K线: ${new Date(bj_time).toISOString().slice(5, 16).replace('T', ' ')} 北京时间`);
  console.log(`  O=${current.open} H=${current.high} L=${current.low} C=${current.close}`);
  console.log(`  涨跌: ${((current.close - current.open) / current.open * 100).toFixed(2)}%`);

  // 初始化报警服务，禁用冷却 (设置为0)
  const alert_service = new SRAlertService({
    enable_squeeze_alert: false,
    enable_bullish_streak_alert: false,
    enable_pullback_alert: true,
    enable_approaching_alert: false,
    pullback_min_surge_pct: 5.0,
    pullback_max_retrace: 0.618,
    pullback_min_retrace: 0,  // 取消最小回撤限制
    pullback_stabilize_bars: 3,
    cooldown_ms: 0  // 禁用冷却
  });

  // 更新支撑阻力位
  alert_service.update_levels('BANANAUSDT', '15m', klines_at_target);

  // 检查报警
  const alerts = alert_service.check_alerts_with_prediction(
    'BANANAUSDT',
    '15m',
    klines_at_target,
    current.close,
    current.open_time
  );

  console.log(`\n报警检查结果: ${alerts.length} 个`);
  for (const a of alerts) {
    console.log(`  ${a.alert_type}: ${a.description}`);
  }

  if (alerts.length === 0) {
    console.log('\n没有报警，让我手动检查各个条件...');

    // 手动计算EMA
    const closes = klines_at_target.map(k => k.close);
    const calc_ema = (data: number[], period: number): number => {
      const k = 2 / (period + 1);
      let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * k + ema;
      }
      return ema;
    };

    const ema30 = calc_ema(closes, 30);
    const ema60 = calc_ema(closes, 60);

    console.log(`\n1. 均线检查:`);
    console.log(`   EMA30: ${ema30.toFixed(4)}`);
    console.log(`   EMA60: ${ema60.toFixed(4)}`);
    console.log(`   EMA30 > EMA60: ${ema30 > ema60 ? '✓' : '✗'}`);

    // 波段点检测
    const find_swing_points = (klines: KlineData[]) => {
      const points: { index: number; price: number; time: number; type: 'HIGH' | 'LOW' }[] = [];
      const lookback = 5;
      for (let i = lookback; i < klines.length - lookback; i++) {
        const current = klines[i];
        let is_swing_high = true;
        let is_swing_low = true;
        for (let j = i - lookback; j <= i + lookback; j++) {
          if (j !== i) {
            if (klines[j].high >= current.high) is_swing_high = false;
            if (klines[j].low <= current.low) is_swing_low = false;
          }
        }
        if (is_swing_high) points.push({ index: i, price: current.high, time: current.open_time, type: 'HIGH' });
        if (is_swing_low) points.push({ index: i, price: current.low, time: current.open_time, type: 'LOW' });
      }
      return points.sort((a, b) => a.index - b.index);
    };

    const swing_points = find_swing_points(klines_at_target);
    const recent_highs = swing_points.filter(p => p.type === 'HIGH').slice(-3);
    const recent_lows = swing_points.filter(p => p.type === 'LOW').slice(-3);

    console.log(`\n2. 波段点:`);
    console.log(`   高点: ${recent_highs.map(h => {
      const t = new Date(h.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      return `${t}@${h.price.toFixed(4)}`;
    }).join(', ')}`);
    console.log(`   低点: ${recent_lows.map(l => {
      const t = new Date(l.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      return `${t}@${l.price.toFixed(4)}`;
    }).join(', ')}`);

    // 找有效波段
    let valid_low: typeof swing_points[0] | null = null;
    let valid_high: typeof swing_points[0] | null = null;
    let surge_pct = 0;

    for (const high of recent_highs.slice().reverse()) {
      for (const low of recent_lows.slice().reverse()) {
        if (low.index < high.index) {
          const pct = ((high.price - low.price) / low.price) * 100;
          if (pct >= 5.0) {
            valid_low = low;
            valid_high = high;
            surge_pct = pct;
            break;
          }
        }
      }
      if (valid_low && valid_high) break;
    }

    console.log(`\n3. 有效波段:`);
    if (valid_low && valid_high) {
      const low_t = new Date(valid_low.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      const high_t = new Date(valid_high.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      console.log(`   ✓ 低点=${low_t}@${valid_low.price.toFixed(4)}`);
      console.log(`     高点=${high_t}@${valid_high.price.toFixed(4)}`);
      console.log(`     涨幅=${surge_pct.toFixed(2)}%`);

      // 回撤
      const swing_range = valid_high.price - valid_low.price;
      const pullback_amount = valid_high.price - current.close;
      const current_retrace = pullback_amount / swing_range;
      const distance_to_high = (valid_high.price - current.close) / valid_high.price * 100;

      console.log(`\n4. 回撤检查:`);
      console.log(`   当前价: ${current.close.toFixed(4)}`);
      console.log(`   回撤: ${(current_retrace * 100).toFixed(1)}%`);
      console.log(`   距前高: ${distance_to_high.toFixed(2)}%`);
      console.log(`   在回调区间(0-61.8%): ${current_retrace > 0 && current_retrace <= 0.618 ? '✓' : '✗'}`);

      // 企稳信号
      console.log(`\n5. 企稳信号检查:`);
      const last = klines_at_target[klines_at_target.length - 1];
      const is_bullish = last.close > last.open;
      console.log(`   当前K线是阳线: ${is_bullish ? '✓' : '✗'}`);
      console.log(`   距前高 < 2%: ${distance_to_high > 0 && distance_to_high < 2.0 ? '✓' : '✗'}`);

      // 锤子线检查
      const body = Math.abs(last.close - last.open);
      const lower_shadow = Math.min(last.open, last.close) - last.low;
      const upper_shadow = last.high - Math.max(last.open, last.close);
      const total_range = last.high - last.low;
      if (total_range > 0) {
        const body_ratio = body / total_range;
        const lower_shadow_ratio = lower_shadow / total_range;
        const is_hammer = body_ratio < 0.3 && lower_shadow_ratio > 0.5 && upper_shadow / total_range < 0.2;
        console.log(`   锤子线: ${is_hammer ? '✓' : '✗'} (body=${(body_ratio*100).toFixed(0)}%, lower=${(lower_shadow_ratio*100).toFixed(0)}%)`);
      }
    } else {
      console.log(`   ✗ 未找到有效波段`);
    }
  }

  await conn.end();
  console.log('\n✅ 诊断完成');
}

main().catch(console.error);
