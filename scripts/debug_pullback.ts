/**
 * 诊断回调企稳检测逻辑
 * 分析 12.24 20:00 - 12.25 03:30 为什么没有报警
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';

interface KlineData {
  open_time: number;
  close_time: number;
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
  console.log('     诊断 BANANAUSDT 12.24 20:00 - 12.25 03:30 回调');
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
    close_time: parseInt(r.open_time) + 15 * 60 * 1000 - 1,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume)
  }));

  console.log(`\n总共加载 ${all_klines.length} 根K线`);

  // 打印 12.24 18:00 - 12.25 04:00 的K线
  console.log('\n=== 12.24 18:00 - 12.25 04:00 K线走势 ===\n');

  // 12.24 18:00 北京时间 (2025年!)
  const start_bj = new Date('2025-12-24T18:00:00+08:00').getTime();
  const end_bj = new Date('2025-12-25T04:00:00+08:00').getTime();

  // 12.24 18:00 UTC = 12.25 02:00 北京时间的数据
  // 我们实际要看的是 12.24 北京时间 19:00 - 12.25 北京时间 04:00
  // 转换为 UTC: 12.24 11:00 UTC - 12.24 20:00 UTC
  const start_utc = new Date('2025-12-24T11:00:00Z').getTime();
  const end_utc = new Date('2025-12-24T20:00:00Z').getTime();

  for (const k of all_klines) {
    if (k.open_time >= start_utc && k.open_time <= end_utc) {
      const bj_date = new Date(k.open_time + 8 * 3600 * 1000);
      const timeStr = bj_date.toISOString().slice(5, 16).replace('T', ' ');
      const pct = ((k.close - k.open) / k.open * 100).toFixed(2);
      const bar = k.close > k.open ? '▲' : '▼';
      console.log(`${timeStr}  O:${k.open.toFixed(4)} H:${k.high.toFixed(4)} L:${k.low.toFixed(4)} C:${k.close.toFixed(4)}  ${bar}${pct}%`);
    }
  }

  // 计算均线函数
  const calc_ema = (data: number[], period: number): number[] => {
    const k = 2 / (period + 1);
    const ema: number[] = [];
    let current_ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = 0; i < data.length; i++) {
      if (i < period) {
        ema.push(data.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1));
      } else {
        current_ema = (data[i] - current_ema) * k + current_ema;
        ema.push(current_ema);
      }
    }
    return ema;
  };

  // 找到波段高低点
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

  // 分析关键时间点
  console.log('\n=== 逐根K线分析 (12.24 20:00 - 12.25 04:00 北京时间) ===\n');

  // 12.24 20:00 北京 = 12.24 12:00 UTC
  // 12.25 04:00 北京 = 12.24 20:00 UTC
  const analysis_start_utc = new Date('2025-12-24T12:00:00Z').getTime();
  const analysis_end_utc = new Date('2025-12-24T20:00:00Z').getTime();

  for (let i = 200; i < all_klines.length; i++) {
    const k = all_klines[i];

    if (k.open_time < analysis_start_utc || k.open_time > analysis_end_utc) continue;

    const klines_so_far = all_klines.slice(0, i + 1);
    const closes = klines_so_far.map(k => k.close);

    // 计算EMA
    const ema30 = calc_ema(closes, 30);
    const ema60 = calc_ema(closes, 60);
    const ema120 = calc_ema(closes, 120);
    const ema200 = calc_ema(closes, 200);

    const e30 = ema30[ema30.length - 1];
    const e60 = ema60[ema60.length - 1];
    const e120 = ema120[ema120.length - 1];
    const e200 = ema200[ema200.length - 1];

    const is_bullish = e30 > e60 && e60 > e120 && e120 > e200;

    // 找波段点
    const swing_points = find_swing_points(klines_so_far);
    const recent_highs = swing_points.filter(p => p.type === 'HIGH').slice(-3);
    const recent_lows = swing_points.filter(p => p.type === 'LOW').slice(-3);

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

    // 计算回撤
    let current_retrace = 0;
    let in_pullback_zone = false;
    let retrace_status = '';

    if (valid_low && valid_high) {
      const range = valid_high.price - valid_low.price;
      const pullback = valid_high.price - k.close;
      current_retrace = pullback / range;

      if (k.close >= valid_high.price) {
        retrace_status = '未回调(在高点上方)';
      } else if (k.low <= valid_low.price) {
        retrace_status = '跌破低点';
      } else if (current_retrace < 0.236) {
        retrace_status = `回撤${(current_retrace * 100).toFixed(1)}% < 23.6%`;
      } else if (current_retrace > 0.618) {
        retrace_status = `回撤${(current_retrace * 100).toFixed(1)}% > 61.8%`;
      } else {
        in_pullback_zone = true;
        retrace_status = `✓ 回撤${(current_retrace * 100).toFixed(1)}%`;
      }
    }

    // 检查企稳信号
    let stabilize_signal = '';
    if (i >= 3) {
      const last3 = klines_so_far.slice(-3);
      // 低点抬升
      if (last3[2].low > last3[1].low && last3[1].low > last3[0].low) {
        const any_bullish = last3.some(k => k.close > k.open);
        if (any_bullish) {
          stabilize_signal = '低点抬升';
        }
      }
      // 连续阳线
      if (last3.every(k => k.close > k.open)) {
        let lows_rising = true;
        for (let j = 1; j < 3; j++) {
          if (last3[j].low < last3[j - 1].low) lows_rising = false;
        }
        if (lows_rising) stabilize_signal = '连续阳线';
      }
    }

    const bj_time = k.open_time + 8 * 3600 * 1000;
    const date = new Date(bj_time);
    const timeStr = date.toISOString().slice(5, 16).replace('T', ' ');

    console.log(`\n--- ${timeStr} @ ${k.close.toFixed(4)} ---`);
    console.log(`  均线: EMA30=${e30.toFixed(4)} EMA60=${e60.toFixed(4)} EMA120=${e120.toFixed(4)} EMA200=${e200.toFixed(4)}`);
    console.log(`  多头排列: ${is_bullish ? '✓ YES' : '✗ NO'}`);
    if (!is_bullish) {
      if (e30 <= e60) console.log(`    - EMA30 <= EMA60`);
      if (e60 <= e120) console.log(`    - EMA60 <= EMA120`);
      if (e120 <= e200) console.log(`    - EMA120 <= EMA200`);
    }

    if (valid_low && valid_high) {
      const low_time = new Date(valid_low.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      const high_time = new Date(valid_high.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      console.log(`  波段: 低点=${valid_low.price.toFixed(4)}(${low_time}) 高点=${valid_high.price.toFixed(4)}(${high_time}) 涨${surge_pct.toFixed(1)}%`);
      console.log(`  回撤: ${retrace_status}`);
    } else {
      console.log(`  波段: 未找到有效波段(涨幅>=5%)`);
    }

    console.log(`  企稳信号: ${stabilize_signal || '无'}`);

    // 判断是否会触发报警
    if (is_bullish && in_pullback_zone && stabilize_signal) {
      console.log(`  >>> 满足所有条件，应该触发报警! <<<`);
    }
  }

  await conn.end();
  console.log('\n✅ 诊断完成');
}

main().catch(console.error);
