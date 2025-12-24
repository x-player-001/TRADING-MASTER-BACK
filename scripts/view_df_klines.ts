/**
 * 浏览 DFUSDT 12月20日-21日的K线数据
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline15mRepository } from '../src/database/kline_15m_repository';
import { ConfigManager } from '../src/core/config/config_manager';

const SYMBOL = 'DFUSDT';

function format_time(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline15mRepository();

  // 获取 12月20日到21日的数据
  const start_time = new Date('2025-12-20T00:00:00Z').getTime();
  const end_time = new Date('2025-12-21T23:59:59Z').getTime();

  const klines = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, end_time);

  console.log('DFUSDT 12月20日-21日 K线数据');
  console.log('═'.repeat(110));
  console.log('时间                  | 开盘       | 最高       | 最低       | 收盘       | 涨跌%   | 成交量       | 振幅%');
  console.log('-'.repeat(110));

  for (const k of klines) {
    const open = parseFloat(k.open as any);
    const high = parseFloat(k.high as any);
    const low = parseFloat(k.low as any);
    const close = parseFloat(k.close as any);
    const volume = parseFloat(k.volume as any);

    const change = ((close - open) / open * 100).toFixed(2);
    const range = ((high - low) / low * 100).toFixed(2);
    const dir = close >= open ? '🟢' : '🔴';

    console.log(`${format_time(k.open_time)} | ${open.toFixed(6).padStart(10)} | ${high.toFixed(6).padStart(10)} | ${low.toFixed(6).padStart(10)} | ${close.toFixed(6).padStart(10)} | ${change.padStart(6)}% ${dir} | ${volume.toFixed(0).padStart(12)} | ${range.padStart(5)}%`);
  }

  console.log('═'.repeat(110));
  console.log(`共 ${klines.length} 根K线`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
