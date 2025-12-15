/**
 * 拉取指定币种的 K 线数据用于分析
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { ConfigManager } from '../src/core/config/config_manager';
import { Kline5mRepository } from '../src/database/kline_5m_repository';
import { logger } from '../src/utils/logger';

// 要拉取的币种
const SYMBOLS = [
  'BRUSDT',
  'RECLAIMUSDT',
  'DOGEUSDT',
  'JELLYJELLYUSDT',
  'TSTUSDT'
];

const KLINE_LIMIT = 500;

async function fetch_klines(symbol: string): Promise<any[]> {
  try {
    const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: {
        symbol,
        interval: '5m',
        limit: KLINE_LIMIT
      }
    });
    return response.data;
  } catch (error: any) {
    console.error(`Failed to fetch ${symbol}:`, error.message);
    return [];
  }
}

async function main() {
  console.log('═'.repeat(80));
  console.log('                    拉取 K 线数据用于区间分析');
  console.log('═'.repeat(80));

  // 初始化配置
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const repository = new Kline5mRepository();

  for (const symbol of SYMBOLS) {
    console.log(`\n📊 正在拉取 ${symbol} 的 ${KLINE_LIMIT} 根 5m K线...`);

    const raw_klines = await fetch_klines(symbol);

    if (raw_klines.length === 0) {
      console.log(`   ❌ ${symbol} 拉取失败或不存在`);
      continue;
    }

    // 转换格式
    const klines = raw_klines.map((k: any[]) => ({
      symbol,
      open_time: k[0],
      close_time: k[6],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));

    // 批量添加到缓冲区
    await repository.add_klines(klines);

    // 计算时间范围
    const start_time = new Date(klines[0].open_time);
    const end_time = new Date(klines[klines.length - 1].close_time);
    const latest_price = klines[klines.length - 1].close;

    console.log(`   ✅ ${symbol}: ${klines.length} 根K线`);
    console.log(`      时间范围: ${start_time.toISOString()} ~ ${end_time.toISOString()}`);
    console.log(`      最新价格: ${latest_price}`);

    // 避免速率限制
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // 强制刷新到数据库
  console.log('\n💾 正在写入数据库...');
  await repository.flush();

  // 获取统计
  const stats = await repository.get_statistics();
  console.log(`\n📈 数据库统计:`);
  console.log(`   今日K线数: ${stats.today_count}`);
  console.log(`   币种数: ${stats.today_symbols}`);

  console.log('\n✅ 完成！');

  // 停止定时器
  repository.stop_flush_timer();
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
