/**
 * 调试 EMA30/EMA60 计算
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline5mRepository } from '../src/database/kline_5m_repository';
import { ConfigManager } from '../src/core/config/config_manager';

const SYMBOL = 'POLYXUSDT';

function calcEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1];
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

async function main() {
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline5mRepository();

  // 用户指出的时间点 (注意：16:xx 是北京时间，需要转为 UTC)
  // 北京时间 = UTC + 8，所以 16:05 北京 = 08:05 UTC
  const check_times = [
    // 用户说的 22 07:15 (可能是北京时间，即 UTC 前一天 23:15)
    '2025-12-21 23:15:00',  // 22日 07:15 北京时间
    '2025-12-22 07:15:00',  // 如果是 UTC
    // 用户说的 22 16:05-16:55 (北京时间 = 08:05-08:55 UTC)
    '2025-12-22 08:05:00',
    '2025-12-22 08:30:00',
    '2025-12-22 08:55:00',
    // 用户说的 23 02:00 (北京时间 = 22日 18:00 UTC)
    '2025-12-22 18:00:00',
  ];

  console.log('检查 EMA30/EMA60 计算:');
  console.log('时间                  | 价格     | EMA30    | EMA60    | 差距%');
  console.log('-'.repeat(70));

  for (const time_str of check_times) {
    const end_time = new Date(time_str + ' UTC').getTime();
    const start_time = end_time - 200 * 5 * 60 * 1000;

    const klines = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, end_time);

    if (klines.length < 60) {
      console.log(`${time_str} | 数据不足: ${klines.length} 根K线`);
      continue;
    }

    const closes = klines.map(k => parseFloat(k.close as any));
    const price = closes[closes.length - 1];
    const ema30 = calcEMA(closes, 30);
    const ema60 = calcEMA(closes, 60);
    const diff_pct = Math.abs(ema30 - ema60) / price * 100;

    console.log(
      `${time_str} | ` +
      `${price.toFixed(5)} | ` +
      `${ema30.toFixed(5)} | ` +
      `${ema60.toFixed(5)} | ` +
      `${diff_pct.toFixed(4)}%`
    );
  }

  // 再检查数据库里实际有哪些时间段的数据
  console.log('\n\n检查数据库里的K线时间范围:');
  const all_klines = await kline_repo.get_klines_by_time_range(
    SYMBOL,
    new Date('2025-12-22 00:00:00 UTC').getTime(),
    new Date('2025-12-23 12:00:00 UTC').getTime()
  );

  if (all_klines.length > 0) {
    const first = new Date(all_klines[0].open_time).toISOString();
    const last = new Date(all_klines[all_klines.length - 1].open_time).toISOString();
    console.log(`数据范围: ${first} ~ ${last}`);
    console.log(`总K线数: ${all_klines.length}`);
  } else {
    console.log('没有找到K线数据');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
