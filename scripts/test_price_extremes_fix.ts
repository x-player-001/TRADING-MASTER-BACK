/**
 * 测试修复后的价格极值功能
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../src/database/oi_repository';
import { ConfigManager } from '../src/core/config/config_manager';

async function test_price_extremes() {
  console.log('=== 测试修复后的价格极值功能 ===\n');

  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const oi_repo = new OIRepository();

  // 测试查询当天价格极值
  const test_cases = [
    { symbol: 'BTCUSDT', date: '2025-11-14' },
    { symbol: 'ETHUSDT', date: '2025-11-14' },
    { symbol: 'BTCUSDT', date: '2025-11-13' },
  ];

  for (const test of test_cases) {
    console.log(`\n查询 ${test.symbol} 在 ${test.date} 的价格极值...`);
    try {
      const result = await oi_repo.get_daily_price_extremes(test.symbol, test.date);

      if (result.daily_low !== null && result.daily_high !== null) {
        console.log(`  ✅ 查询成功:`);
        console.log(`     日内最低价: $${result.daily_low.toFixed(2)}`);
        console.log(`     日内最高价: $${result.daily_high.toFixed(2)}`);
        console.log(`     波动范围: ${(((result.daily_high - result.daily_low) / result.daily_low) * 100).toFixed(2)}%`);
      } else {
        console.log(`  ⚠️  无数据`);
      }
    } catch (error: any) {
      console.log(`  ❌ 查询失败:`, error.message);
    }
  }

  console.log('\n\n=== 模拟场景：服务中午启动 ===');
  console.log('假设BTCUSDT当天价格变化:');
  console.log('  00:00 - 开盘价: $88,000');
  console.log('  10:00 - 最高价: $92,000');
  console.log('  12:00 - 服务启动，当前价格: $90,000');
  console.log('');
  console.log('✅ 修复后的逻辑:');
  console.log('   1. 查询数据库，获取当天已有的极值');
  console.log('   2. 发现 daily_low=$88,000, daily_high=$92,000');
  console.log('   3. 与当前价格$90,000比较');
  console.log('   4. 初始化缓存: low=$88,000, high=$92,000');
  console.log('   5. 相对低点涨幅: ((90000-88000)/88000)*100 = 2.27%');
  console.log('   6. 相对高点跌幅: ((92000-90000)/92000)*100 = 2.17%');
  console.log('');
  console.log('❌ 修复前的逻辑 (错误):');
  console.log('   1. 直接用当前价格初始化');
  console.log('   2. 初始化缓存: low=$90,000, high=$90,000');
  console.log('   3. 相对低点涨幅: 0%');
  console.log('   4. 相对高点跌幅: 0%');
  console.log('   5. ❌ 完全丢失了上午的价格波动信息！');

  process.exit(0);
}

test_price_extremes();
