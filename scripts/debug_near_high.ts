/**
 * 诊断 12.25 03:00-04:00 期间靠近前高的情况
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
  console.log('     诊断 12.25 00:00-04:15 靠近前高情况');
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

  // 计算EMA
  const calc_ema = (data: number[], period: number): number => {
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * k + ema;
    }
    return ema;
  };

  // 12.25 00:00 北京 = 12.24 16:00 UTC
  // 12.25 04:15 北京 = 12.24 20:15 UTC
  const start_utc = new Date('2025-12-24T16:00:00Z').getTime();
  const end_utc = new Date('2025-12-24T20:15:00Z').getTime();

  console.log('\n=== 逐根K线分析 (12.25 00:00-04:15 北京时间) ===\n');

  for (let i = 200; i < all_klines.length; i++) {
    const k = all_klines[i];
    if (k.open_time < start_utc || k.open_time > end_utc) continue;

    const klines_so_far = all_klines.slice(0, i + 1);
    const closes = klines_so_far.map(k => k.close);

    // EMA检查
    const ema30 = calc_ema(closes, 30);
    const ema60 = calc_ema(closes, 60);
    const is_bullish_ema = ema30 > ema60;

    // 波段点
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

    // 检查回撤和靠近前高
    const bj_time = k.open_time + 8 * 3600 * 1000;
    const timeStr = new Date(bj_time).toISOString().slice(5, 16).replace('T', ' ');
    const pct = ((k.close - k.open) / k.open * 100).toFixed(2);
    const bar = k.close > k.open ? '▲' : '▼';

    console.log(`\n--- ${timeStr} ${bar}${pct}% @ ${k.close.toFixed(4)} ---`);
    console.log(`  EMA多头: ${is_bullish_ema ? '✓' : '✗'} (EMA30=${ema30.toFixed(4)} vs EMA60=${ema60.toFixed(4)})`);

    if (valid_low && valid_high) {
      const swing_range = valid_high.price - valid_low.price;
      const pullback_amount = valid_high.price - k.close;
      const current_retrace = pullback_amount / swing_range;
      const distance_to_high_pct = ((valid_high.price - k.close) / valid_high.price) * 100;

      const high_t = new Date(valid_high.time + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');

      console.log(`  波段: 涨${surge_pct.toFixed(1)}% (高点=${valid_high.price.toFixed(4)} @ ${high_t})`);
      console.log(`  回撤: ${(current_retrace * 100).toFixed(1)}%`);
      console.log(`  距前高: ${distance_to_high_pct.toFixed(2)}%`);

      // 新条件: 只要低于前高且没跌破0.618就算回调区间
      const in_retrace_zone = current_retrace > 0 && current_retrace <= 0.618;
      const is_bullish = k.close > k.open;
      const near_high = distance_to_high_pct > 0 && distance_to_high_pct < 0.5;  // 改为0.5%

      if (is_bullish_ema && in_retrace_zone && is_bullish && near_high) {
        console.log(`  >>> 满足"靠近前高"信号条件! <<<`);
      } else {
        const reasons = [];
        if (!is_bullish_ema) reasons.push('EMA未多头');
        if (!in_retrace_zone) {
          if (current_retrace <= 0) reasons.push('已突破高点');
          else if (current_retrace > 0.618) reasons.push('回撤>61.8%');
        }
        if (!is_bullish) reasons.push('非阳线');
        if (!near_high && distance_to_high_pct <= 0) reasons.push('已突破高点');
        else if (!near_high) reasons.push(`距前高${distance_to_high_pct.toFixed(2)}%>0.5%`);

        if (reasons.length > 0) {
          console.log(`  不满足: ${reasons.join(', ')}`);
        }
      }
    } else {
      console.log(`  波段: 未找到有效波段`);
    }
  }

  await conn.end();
  console.log('\n✅ 诊断完成');
}

main().catch(console.error);
