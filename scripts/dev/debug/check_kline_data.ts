/**
 * 检查12月19日K线数据的完整性和重复情况
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '../../../src/core/config/config_manager';
import { Kline15mRepository } from '../../../src/database/kline_15m_repository';

async function main() {
  // 初始化配置
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const repo = new Kline15mRepository();

  // 12月19日的时间范围 (UTC)
  const start_of_day = new Date('2024-12-19T00:00:00Z').getTime();
  const end_of_day = new Date('2024-12-19T23:59:59Z').getTime();

  console.log('═'.repeat(60));
  console.log('  12月19日 15分钟K线数据检查');
  console.log('═'.repeat(60));

  // 获取几个主要币种的数据进行检查
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

  for (const symbol of symbols) {
    console.log(`\n📊 ${symbol}:`);

    try {
      const klines = await repo.get_klines_by_time_range(symbol, start_of_day, end_of_day);

      if (klines.length === 0) {
        console.log('   ❌ 没有数据');
        continue;
      }

      // 检查重复
      const time_set = new Set<number>();
      const duplicates: number[] = [];
      for (const k of klines) {
        const t = Number(k.open_time);
        if (time_set.has(t)) {
          duplicates.push(t);
        }
        time_set.add(t);
      }

      // 检查缺失
      // 12月19日 UTC 00:00 到 23:45，每15分钟一根，共96根
      const expected_times: number[] = [];
      for (let i = 0; i < 96; i++) {
        expected_times.push(start_of_day + i * 15 * 60 * 1000);
      }

      const missing: string[] = [];
      for (const t of expected_times) {
        if (!time_set.has(t)) {
          const d = new Date(t);
          missing.push(d.toISOString().slice(11, 16));
        }
      }

      console.log(`   总记录: ${klines.length} 根 (预期 96 根)`);
      console.log(`   唯一时间点: ${time_set.size}`);

      if (duplicates.length > 0) {
        console.log(`   ⚠️ 重复数据: ${duplicates.length} 条`);
        const dup_times = duplicates.slice(0, 3).map(t => new Date(t).toISOString().slice(11, 16));
        console.log(`      示例: ${dup_times.join(', ')}`);
      } else {
        console.log('   ✅ 无重复数据');
      }

      if (missing.length > 0) {
        console.log(`   ⚠️ 缺失数据: ${missing.length} 根`);
        if (missing.length <= 10) {
          console.log(`      缺失时间: ${missing.join(', ')}`);
        } else {
          console.log(`      前10个缺失: ${missing.slice(0, 10).join(', ')}`);
        }
      } else {
        console.log('   ✅ 数据完整');
      }

      // 显示时间范围
      const first = new Date(Number(klines[0].open_time));
      const last = new Date(Number(klines[klines.length - 1].open_time));
      console.log(`   时间范围: ${first.toISOString().slice(11, 16)} - ${last.toISOString().slice(11, 16)}`);

    } catch (error) {
      console.log(`   ❌ 查询失败: ${error}`);
    }
  }

  // 统计所有币种的情况
  console.log('\n' + '═'.repeat(60));
  console.log('  所有币种统计');
  console.log('═'.repeat(60));

  try {
    // 获取所有币种列表（使用一个简单的方法）
    const btc_klines = await repo.get_klines_by_time_range('BTCUSDT', start_of_day, end_of_day);
    console.log(`\nBTCUSDT 在12月19日有 ${btc_klines.length} 根K线`);

    // 检查是否能获取完整的96根
    const expected = 96;
    const actual = btc_klines.length;
    const completeness = (actual / expected * 100).toFixed(1);
    console.log(`完整度: ${completeness}%`);

  } catch (error) {
    console.log(`统计失败: ${error}`);
  }

  console.log('\n✅ 检查完成');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
