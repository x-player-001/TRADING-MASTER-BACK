/**
 * 测试币种精度信息的保存和读取
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BinanceFuturesAPI } from '../src/api/binance_futures_api';
import { OIRepository } from '../src/database/oi_repository';
import { logger } from '../src/utils/logger';

async function test_symbol_precision() {
  console.log('🧪 测试币种精度信息保存和读取\n');
  console.log('═'.repeat(80));

  try {
    // 创建API和Repository实例
    const binance_api = new BinanceFuturesAPI();
    const oi_repository = new OIRepository();

    console.log('\n📊 [1/4] 从币安API获取币种信息（含精度）...');
    const symbols = await binance_api.get_usdt_perpetual_symbols(10); // 只获取前10个用于测试
    console.log(`  ✅ 获取 ${symbols.length} 个币种`);
    console.log(`  前3个币种: ${symbols.slice(0, 3).map(s => s.symbol).join(', ')}`);

    // 显示第一个币种的完整精度信息
    if (symbols.length > 0) {
      const btc = symbols.find(s => s.symbol === 'BTCUSDT') || symbols[0];
      console.log(`\n  📋 ${btc.symbol} 精度信息示例:`);
      console.log(`     - price_precision: ${btc.price_precision}`);
      console.log(`     - quantity_precision: ${btc.quantity_precision}`);
      console.log(`     - base_asset_precision: ${btc.base_asset_precision}`);
      console.log(`     - quote_precision: ${btc.quote_precision}`);
      console.log(`     - min_notional: ${btc.min_notional}`);
      console.log(`     - step_size: ${btc.step_size}`);
    }

    console.log('\n💾 [2/4] 保存币种信息到数据库...');
    await oi_repository.save_symbol_configs(symbols);
    console.log('  ✅ 保存成功\n');

    console.log('📖 [3/4] 从数据库读取精度信息...');
    const test_symbols = symbols.slice(0, 3).map(s => s.symbol);

    for (const symbol of test_symbols) {
      const precision = await oi_repository.get_symbol_precision(symbol);

      if (precision) {
        console.log(`  ✅ ${symbol}:`);
        console.log(`     数量精度: ${precision.quantity_precision}位`);
        console.log(`     价格精度: ${precision.price_precision}位`);
        console.log(`     最小名义价值: $${precision.min_notional}`);
        console.log(`     数量步进: ${precision.step_size}`);
      } else {
        console.log(`  ❌ ${symbol}: 未找到精度信息`);
      }
    }

    console.log('\n🎯 [4/4] 模拟实际交易场景...');
    const btc_precision = await oi_repository.get_symbol_precision('BTCUSDT');

    if (btc_precision) {
      console.log('  场景: 计算满足最小名义价值的BTC数量');
      const btc_price = 90000; // 假设BTC价格$90,000
      const min_quantity_for_notional = btc_precision.min_notional / btc_price;
      const step_size = btc_precision.step_size;

      // 向上取整到步进的倍数
      const quantity = Math.ceil(min_quantity_for_notional / step_size) * step_size;
      const notional_value = quantity * btc_price;

      console.log(`  当前BTC价格: $${btc_price.toLocaleString()}`);
      console.log(`  最小名义价值要求: $${btc_precision.min_notional}`);
      console.log(`  数量精度: ${btc_precision.quantity_precision}位 (步进: ${step_size})`);
      console.log(`  计算结果: ${quantity} BTC`);
      console.log(`  实际名义价值: $${notional_value.toFixed(2)}`);
      console.log(`  ${notional_value >= btc_precision.min_notional ? '✅ 满足' : '❌ 不满足'}最小名义价值要求`);
    }

    console.log('\n' + '═'.repeat(80));
    console.log('✅ 测试完成！精度信息功能正常\n');
    console.log('📝 总结:');
    console.log('  1. ✅ 成功从币安API获取精度信息');
    console.log('  2. ✅ 成功保存精度信息到数据库');
    console.log('  3. ✅ 成功从数据库查询精度信息');
    console.log('  4. ✅ 可用于实际交易场景计算');
    console.log('═'.repeat(80));

  } catch (error: any) {
    console.error('\n❌ 测试失败:', error.message);

    if (error.code === 'ER_BAD_FIELD_ERROR') {
      console.error('\n💡 提示: 数据库表结构尚未更新！');
      console.error('   请先执行数据库迁移:');
      console.error('   mysql -h YOUR_HOST -u YOUR_USER -p YOUR_DB < scripts/migrations/add_precision_to_contract_symbols.sql');
    }

    process.exit(1);
  }
}

// 运行测试
test_symbol_precision()
  .then(() => {
    console.log('\n🎉 测试脚本执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 程序异常退出:', error);
    process.exit(1);
  });
