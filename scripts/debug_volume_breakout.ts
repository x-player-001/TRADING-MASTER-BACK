/**
 * 诊断 12.25 04:00 为什么没有触发 "放量突破" 信号
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';

interface KlineData {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  console.log('═'.repeat(70));
  console.log('     诊断 12.25 04:00 为什么没有触发 "放量突破" 信号');
  console.log('═'.repeat(70));

  // 获取K线数据
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
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume)
  }));

  console.log(`\n总共加载 ${all_klines.length} 根K线`);

  // 12.25 04:00 北京时间 = 12.24 20:00 UTC
  const target_time_utc = new Date('2025-12-24T20:00:00Z').getTime();

  // 找到目标K线的索引
  const target_idx = all_klines.findIndex(k => k.open_time === target_time_utc);

  if (target_idx === -1) {
    console.log('\n❌ 未找到 12.25 04:00 (北京时间) 这根K线');
    console.log('尝试查找附近的K线...');

    for (const k of all_klines.slice(-20)) {
      const bj_time = k.open_time + 8 * 3600 * 1000;
      const date = new Date(bj_time);
      console.log(`  ${date.toISOString().slice(5, 16).replace('T', ' ')}  UTC=${new Date(k.open_time).toISOString()}`);
    }
    await conn.end();
    return;
  }

  console.log(`\n找到目标K线，索引: ${target_idx}`);

  // 模拟当这根K线收盘时的状态
  const klines_at_target = all_klines.slice(0, target_idx + 1);
  const last = klines_at_target[klines_at_target.length - 1];

  const bj_time = last.open_time + 8 * 3600 * 1000;
  console.log(`\n目标K线信息 (${new Date(bj_time).toISOString().slice(5, 16).replace('T', ' ')} 北京时间):`);
  console.log(`  开: ${last.open.toFixed(4)}`);
  console.log(`  高: ${last.high.toFixed(4)}`);
  console.log(`  低: ${last.low.toFixed(4)}`);
  console.log(`  收: ${last.close.toFixed(4)}`);
  console.log(`  量: ${last.volume.toFixed(2)}`);
  console.log(`  涨跌: ${((last.close - last.open) / last.open * 100).toFixed(2)}%`);

  // =====================================================
  // 检查条件1: 是否阳线
  // =====================================================
  const is_bullish = last.close > last.open;
  console.log(`\n=== 条件检查 ===`);
  console.log(`\n1. 是否阳线: ${is_bullish ? '✓ 是' : '✗ 否'} (close=${last.close} > open=${last.open})`);

  // =====================================================
  // 检查条件2: 成交量 > 前9根均量 × 1.5
  // =====================================================
  const prev_9 = klines_at_target.slice(-10, -1);
  console.log(`\n2. 成交量检查:`);
  console.log(`   前9根K线成交量:`);
  for (let i = 0; i < prev_9.length; i++) {
    const k = prev_9[i];
    const t = new Date(k.open_time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`   [${i+1}] ${t}  量=${k.volume.toFixed(2)}`);
  }
  const prev_avg_volume = prev_9.reduce((sum, k) => sum + k.volume, 0) / 9;
  const volume_threshold = prev_avg_volume * 1.5;
  const is_volume_up = last.volume > volume_threshold;

  console.log(`   ---`);
  console.log(`   前9根均量: ${prev_avg_volume.toFixed(2)}`);
  console.log(`   阈值(×1.5): ${volume_threshold.toFixed(2)}`);
  console.log(`   当前成交量: ${last.volume.toFixed(2)}`);
  console.log(`   成交量达标: ${is_volume_up ? '✓ 是' : '✗ 否'} (需>${volume_threshold.toFixed(2)})`);

  // =====================================================
  // 检查条件3: 收盘价突破近5根最高价
  // =====================================================
  const prev_5 = klines_at_target.slice(-6, -1);
  console.log(`\n3. 突破近5根高点检查:`);
  console.log(`   近5根K线高点:`);
  for (let i = 0; i < prev_5.length; i++) {
    const k = prev_5[i];
    const t = new Date(k.open_time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`   [${i+1}] ${t}  高=${k.high.toFixed(4)}`);
  }
  const recent_high = Math.max(...prev_5.map(k => k.high));
  const is_breakout = last.close > recent_high;

  console.log(`   ---`);
  console.log(`   近5根最高价: ${recent_high.toFixed(4)}`);
  console.log(`   当前收盘价: ${last.close.toFixed(4)}`);
  console.log(`   是否突破: ${is_breakout ? '✓ 是' : '✗ 否'} (需>${recent_high.toFixed(4)})`);

  // =====================================================
  // 检查前置条件: 是否在有效回调区间
  // =====================================================
  console.log(`\n=== 前置条件检查 ===`);

  // 计算EMA
  const calc_ema = (data: number[], period: number): number => {
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * k + ema;
    }
    return ema;
  };

  const closes = klines_at_target.map(k => k.close);
  const ema30 = calc_ema(closes, 30);
  const ema60 = calc_ema(closes, 60);

  console.log(`\n4. 均线多头排列:`);
  console.log(`   EMA30: ${ema30.toFixed(4)}`);
  console.log(`   EMA60: ${ema60.toFixed(4)}`);
  console.log(`   EMA30 > EMA60: ${ema30 > ema60 ? '✓ 是' : '✗ 否'}`);

  // 识别波段点
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

      if (is_swing_high) {
        points.push({ index: i, price: current.high, time: current.open_time, type: 'HIGH' });
      }
      if (is_swing_low) {
        points.push({ index: i, price: current.low, time: current.open_time, type: 'LOW' });
      }
    }

    return points.sort((a, b) => a.index - b.index);
  };

  const swing_points = find_swing_points(klines_at_target);
  const recent_highs = swing_points.filter(p => p.type === 'HIGH').slice(-3);
  const recent_lows = swing_points.filter(p => p.type === 'LOW').slice(-3);

  console.log(`\n5. 波段点识别:`);
  console.log(`   最近的波段高点:`);
  for (const h of recent_highs) {
    const t = new Date(h.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`     ${t}  价=${h.price.toFixed(4)}`);
  }
  console.log(`   最近的波段低点:`);
  for (const l of recent_lows) {
    const t = new Date(l.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`     ${t}  价=${l.price.toFixed(4)}`);
  }

  // 找有效上涨波段
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

  console.log(`\n6. 有效上涨波段 (涨幅>=5%):`);
  if (valid_low && valid_high) {
    const low_t = new Date(valid_low.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const high_t = new Date(valid_high.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`   ✓ 找到有效波段`);
    console.log(`   低点: ${low_t}  价=${valid_low.price.toFixed(4)}`);
    console.log(`   高点: ${high_t}  价=${valid_high.price.toFixed(4)}`);
    console.log(`   涨幅: ${surge_pct.toFixed(2)}%`);

    // 检查回撤位置
    const current_price = last.close;
    const swing_range = valid_high.price - valid_low.price;
    const pullback_amount = valid_high.price - current_price;
    const current_retrace = pullback_amount / swing_range;

    console.log(`\n7. 回撤位置检查:`);
    console.log(`   当前价: ${current_price.toFixed(4)}`);
    console.log(`   波段范围: ${swing_range.toFixed(4)}`);
    console.log(`   回撤幅度: ${pullback_amount.toFixed(4)}`);
    console.log(`   回撤比例: ${(current_retrace * 100).toFixed(1)}%`);

    if (current_price >= valid_high.price) {
      console.log(`   状态: ✗ 价格在高点上方，不在回调区间`);
    } else if (current_price <= valid_low.price) {
      console.log(`   状态: ✗ 价格跌破低点`);
    } else if (current_retrace < 0.236) {
      console.log(`   状态: ✗ 回撤不足 (< 23.6%)`);
    } else if (current_retrace > 0.618) {
      console.log(`   状态: ✗ 回撤过深 (> 61.8%)`);
    } else {
      console.log(`   状态: ✓ 在有效回调区间 (23.6% - 61.8%)`);
    }
  } else {
    console.log(`   ✗ 未找到有效的上涨波段`);
  }

  // =====================================================
  // 总结
  // =====================================================
  console.log(`\n${'═'.repeat(70)}`);
  console.log('                    总结');
  console.log('═'.repeat(70));

  console.log(`\n放量突破触发条件:`);
  console.log(`  1. 阳线: ${is_bullish ? '✓' : '✗'}`);
  console.log(`  2. 成交量>均量×1.5: ${is_volume_up ? '✓' : '✗'} (${last.volume.toFixed(2)} vs ${volume_threshold.toFixed(2)})`);
  console.log(`  3. 收盘突破近5根高点: ${is_breakout ? '✓' : '✗'} (${last.close.toFixed(4)} vs ${recent_high.toFixed(4)})`);

  if (is_bullish && is_volume_up && is_breakout) {
    console.log(`\n✓ 放量突破条件满足！`);
    console.log(`  但需要检查是否在有效回调区间内...`);
  } else {
    console.log(`\n✗ 放量突破条件未满足！`);
    if (!is_bullish) console.log(`  - 不是阳线`);
    if (!is_volume_up) console.log(`  - 成交量不足 (需>${volume_threshold.toFixed(2)}, 实际=${last.volume.toFixed(2)})`);
    if (!is_breakout) console.log(`  - 收盘未突破近5根高点 (需>${recent_high.toFixed(4)}, 实际=${last.close.toFixed(4)})`);
  }

  await conn.end();
  console.log('\n✅ 诊断完成');
}

main().catch(console.error);
