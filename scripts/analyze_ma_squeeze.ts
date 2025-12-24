/**
 * 分析均线粘合形态
 * 专门分析 12月21日 04:00-05:00 的均线情况
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline15mRepository } from '../src/database/kline_15m_repository';
import { ConfigManager } from '../src/core/config/config_manager';

const SYMBOL = 'DFUSDT';

function format_time(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

function calc_ma(klines: any[], period: number): number {
  if (klines.length < period) return 0;
  const recent = klines.slice(-period);
  return recent.reduce((sum: number, k: any) => sum + k.close, 0) / period;
}

function calc_ema(klines: any[], period: number): number {
  if (klines.length < period) return 0;
  const multiplier = 2 / (period + 1);
  let ema = klines[0].close;
  for (let i = 1; i < klines.length; i++) {
    ema = (klines[i].close - ema) * multiplier + ema;
  }
  return ema;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('          DFUSDT 均线粘合形态分析');
  console.log('═'.repeat(80));

  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline15mRepository();

  // 获取12月20日-21日的数据
  const start_time = new Date('2025-12-20T00:00:00Z').getTime();
  const end_time = new Date('2025-12-21T23:59:59Z').getTime();

  const raw_klines = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, end_time);

  // 转换数值
  const klines = raw_klines.map(k => ({
    ...k,
    open: parseFloat(k.open as any),
    high: parseFloat(k.high as any),
    low: parseFloat(k.low as any),
    close: parseFloat(k.close as any),
    volume: parseFloat(k.volume as any)
  }));

  console.log(`\n获取 ${klines.length} 根K线`);

  // 分析每个时间点的均线情况
  console.log('\n📊 均线分析 (只显示均线粘合度 < 1% 的时间点)');
  console.log('时间                  | 收盘价     | MA5        | MA10       | MA20       | 粘合度%  | 振幅%');
  console.log('-'.repeat(100));

  const squeeze_points: any[] = [];

  for (let i = 20; i < klines.length; i++) {
    const slice = klines.slice(0, i + 1);
    const k = klines[i];

    const ma5 = calc_ma(slice, 5);
    const ma10 = calc_ma(slice, 10);
    const ma20 = calc_ma(slice, 20);

    const price = k.close;
    const max_ma = Math.max(ma5, ma10, ma20);
    const min_ma = Math.min(ma5, ma10, ma20);
    const squeeze_pct = (max_ma - min_ma) / price * 100;

    const range_pct = (k.high - k.low) / k.low * 100;

    // 只显示粘合度 < 1% 的
    if (squeeze_pct < 1.0) {
      squeeze_points.push({
        time: k.open_time,
        close: price,
        ma5, ma10, ma20,
        squeeze_pct,
        range_pct
      });

      const highlight = squeeze_pct < 0.3 ? '🔥' : squeeze_pct < 0.5 ? '⚡' : '';
      console.log(`${format_time(k.open_time)} | ${price.toFixed(6).padStart(10)} | ${ma5.toFixed(6).padStart(10)} | ${ma10.toFixed(6).padStart(10)} | ${ma20.toFixed(6).padStart(10)} | ${squeeze_pct.toFixed(3).padStart(7)} | ${range_pct.toFixed(2).padStart(5)} ${highlight}`);
    }
  }

  // 找出12月21日 04:00-05:00 的数据
  console.log('\n' + '═'.repeat(80));
  console.log('📍 12月21日 03:00-06:00 详细分析');
  console.log('═'.repeat(80));

  const target_start = new Date('2025-12-21T03:00:00Z').getTime();
  const target_end = new Date('2025-12-21T06:00:00Z').getTime();

  console.log('\n时间                  | 收盘价     | MA5        | MA10       | MA20       | MA5-10   | MA10-20  | 粘合度%');
  console.log('-'.repeat(110));

  for (let i = 20; i < klines.length; i++) {
    const k = klines[i];
    if (k.open_time < target_start || k.open_time > target_end) continue;

    const slice = klines.slice(0, i + 1);
    const ma5 = calc_ma(slice, 5);
    const ma10 = calc_ma(slice, 10);
    const ma20 = calc_ma(slice, 20);

    const price = k.close;
    const max_ma = Math.max(ma5, ma10, ma20);
    const min_ma = Math.min(ma5, ma10, ma20);
    const squeeze_pct = (max_ma - min_ma) / price * 100;

    const diff_5_10 = ((ma5 - ma10) / price * 100).toFixed(3);
    const diff_10_20 = ((ma10 - ma20) / price * 100).toFixed(3);

    console.log(`${format_time(k.open_time)} | ${price.toFixed(6).padStart(10)} | ${ma5.toFixed(6).padStart(10)} | ${ma10.toFixed(6).padStart(10)} | ${ma20.toFixed(6).padStart(10)} | ${diff_5_10.padStart(7)}% | ${diff_10_20.padStart(7)}% | ${squeeze_pct.toFixed(3).padStart(7)}`);
  }

  // 找出粘合度最低的时间点
  console.log('\n' + '═'.repeat(80));
  console.log('📊 粘合度最低的 TOP 10 时间点');
  console.log('═'.repeat(80));

  squeeze_points.sort((a, b) => a.squeeze_pct - b.squeeze_pct);

  console.log('\n排名 | 时间                  | 粘合度%  | 后续变化');
  console.log('-'.repeat(70));

  for (let i = 0; i < Math.min(10, squeeze_points.length); i++) {
    const p = squeeze_points[i];

    // 找这个时间点后10根K线的最大变化
    const idx = klines.findIndex(k => k.open_time === p.time);
    let max_change = 0;
    let change_dir = '';
    if (idx >= 0 && idx + 10 < klines.length) {
      for (let j = 1; j <= 10; j++) {
        const change = (klines[idx + j].close - p.close) / p.close * 100;
        if (Math.abs(change) > Math.abs(max_change)) {
          max_change = change;
          change_dir = change > 0 ? '↑' : '↓';
        }
      }
    }

    console.log(`  ${(i + 1).toString().padStart(2)} | ${format_time(p.time)} | ${p.squeeze_pct.toFixed(3).padStart(7)} | ${change_dir} ${max_change.toFixed(2)}%`);
  }

  // 对比最新数据
  console.log('\n' + '═'.repeat(80));
  console.log('📊 最新数据均线情况');
  console.log('═'.repeat(80));

  const now = Date.now();
  const recent_start = now - 50 * 15 * 60 * 1000;
  const recent_raw = await kline_repo.get_klines_by_time_range(SYMBOL, recent_start, now);

  const recent_klines = recent_raw.map(k => ({
    ...k,
    open: parseFloat(k.open as any),
    high: parseFloat(k.high as any),
    low: parseFloat(k.low as any),
    close: parseFloat(k.close as any),
    volume: parseFloat(k.volume as any)
  }));

  console.log('\n最近10根K线的均线情况:');
  console.log('时间                  | 收盘价     | MA5        | MA10       | MA20       | 粘合度%');
  console.log('-'.repeat(90));

  for (let i = Math.max(0, recent_klines.length - 10); i < recent_klines.length; i++) {
    const slice = recent_klines.slice(0, i + 1);
    const k = recent_klines[i];

    if (slice.length < 20) continue;

    const ma5 = calc_ma(slice, 5);
    const ma10 = calc_ma(slice, 10);
    const ma20 = calc_ma(slice, 20);

    const price = k.close;
    const max_ma = Math.max(ma5, ma10, ma20);
    const min_ma = Math.min(ma5, ma10, ma20);
    const squeeze_pct = (max_ma - min_ma) / price * 100;

    console.log(`${format_time(k.open_time)} | ${price.toFixed(6).padStart(10)} | ${ma5.toFixed(6).padStart(10)} | ${ma10.toFixed(6).padStart(10)} | ${ma20.toFixed(6).padStart(10)} | ${squeeze_pct.toFixed(3).padStart(7)}`);
  }

  console.log('\n✅ 分析完成');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
