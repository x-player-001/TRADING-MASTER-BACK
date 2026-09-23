/**
 * 验证逐仓模式计算
 */

// 回测配置
const config = {
  initial_balance: 10000,
  max_position_size_percent: 5,  // 5%
  stop_loss_percent: 4,           // 4%
  leverage: 10                    // 10x
};

console.log('\n📊 逐仓模式 vs 全仓模式对比\n');
console.log('配置参数:');
console.log(`  初始资金: $${config.initial_balance}`);
console.log(`  仓位比例: ${config.max_position_size_percent}%`);
console.log(`  止损比例: ${config.stop_loss_percent}%`);
console.log(`  杠杆倍数: ${config.leverage}x\n`);

console.log('='.repeat(80));
console.log('【全仓模式】（旧逻辑）');
console.log('='.repeat(80));

const cross_position_size = config.initial_balance * (config.max_position_size_percent / 100);
const cross_margin = cross_position_size / config.leverage;
const cross_position_value = cross_position_size * config.leverage;
const cross_theoretical_loss = cross_position_size * (config.stop_loss_percent / 100);
const cross_extreme_loss_20 = cross_position_size * 0.20; // 极端情况跳空到-20%

console.log(`持仓价值: $${cross_position_size.toFixed(2)}`);
console.log(`保证金: $${cross_margin.toFixed(2)} (持仓价值 / 杠杆)`);
console.log(`\n风险分析:`);
console.log(`  理论止损4%: -$${cross_theoretical_loss.toFixed(2)} (占账户${(cross_theoretical_loss / config.initial_balance * 100).toFixed(2)}%)`);
console.log(`  ⚠️  极端跳空-20%: -$${cross_extreme_loss_20.toFixed(2)} (占账户${(cross_extreme_loss_20 / config.initial_balance * 100).toFixed(2)}%) ⚠️`);
console.log(`  ⚠️  如果爆仓: 最大亏损 = $${cross_margin.toFixed(2)} (保证金全亏)`);

console.log('\n' + '='.repeat(80));
console.log('【逐仓模式】（新逻辑）');
console.log('='.repeat(80));

// 逐仓模式：保证金 = 最大可承受亏损
const isolated_max_loss = config.initial_balance * (config.max_position_size_percent / 100) * (config.stop_loss_percent / 100);
const isolated_margin = isolated_max_loss;
const isolated_position_value = isolated_margin * config.leverage;
const isolated_quantity_example = isolated_position_value / 0.05; // 假设价格0.05

console.log(`最大可承受亏损: $${isolated_max_loss.toFixed(2)}`);
console.log(`逐仓保证金: $${isolated_margin.toFixed(2)} (= 最大亏损)`);
console.log(`持仓价值: $${isolated_position_value.toFixed(2)} (保证金 × 杠杆)`);
console.log(`\n风险分析:`);
console.log(`  ✅ 即使爆仓: 最大亏损 = $${isolated_margin.toFixed(2)} (占账户${(isolated_margin / config.initial_balance * 100).toFixed(2)}%)`);
console.log(`  ✅ 触发止损4%: 亏损 ≈ $${isolated_max_loss.toFixed(2)}`);
console.log(`  ✅ 极端跳空也不会超过: $${isolated_margin.toFixed(2)}`);

console.log('\n' + '='.repeat(80));
console.log('【对比总结】');
console.log('='.repeat(80));

console.log(`\n持仓规模对比:`);
console.log(`  全仓模式: $${cross_position_size.toFixed(2)}`);
console.log(`  逐仓模式: $${isolated_position_value.toFixed(2)}`);
console.log(`  差异: ${((isolated_position_value / cross_position_size) * 100).toFixed(1)}% (逐仓更小)`);

console.log(`\n保证金对比:`);
console.log(`  全仓模式: $${cross_margin.toFixed(2)}`);
console.log(`  逐仓模式: $${isolated_margin.toFixed(2)}`);
console.log(`  差异: ${((isolated_margin / cross_margin) * 100).toFixed(1)}% (逐仓更小)`);

console.log(`\n极端风险对比 (跳空-20%):`);
console.log(`  全仓模式: -$${cross_extreme_loss_20.toFixed(2)} ⚠️ 风险高`);
console.log(`  逐仓模式: -$${isolated_margin.toFixed(2)} ✅ 风险可控`);
console.log(`  风险降低: ${((1 - isolated_margin / cross_extreme_loss_20) * 100).toFixed(1)}%`);

console.log('\n💡 结论:');
console.log('  逐仓模式虽然持仓规模更小（约4%），但风险完全可控');
console.log('  即使出现极端行情导致爆仓，亏损也不会超过预期的止损金额');
console.log('  这是虚拟货币合约交易中非常重要的风险控制手段！');
console.log('');
