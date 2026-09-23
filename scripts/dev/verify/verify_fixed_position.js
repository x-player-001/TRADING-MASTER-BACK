// 验证固定仓位$100
const trade = {
  entry_price: 0.053876532709999994,
  quantity: 1856.0956871198034,
  leverage: 10
};

const position_value = trade.entry_price * trade.quantity;
const margin = position_value / trade.leverage;

console.log('\n📋 固定仓位验证\n');
console.log('第一笔交易 (CVCUSDT):');
console.log(`  入场价格: $${trade.entry_price.toFixed(6)}`);
console.log(`  数量: ${trade.quantity.toFixed(2)}`);
console.log(`  杠杆: ${trade.leverage}x`);
console.log(`  持仓价值: $${position_value.toFixed(2)}`);
console.log(`  保证金: $${margin.toFixed(2)}`);

console.log('\n验证结果:');
const expected = 100;
const actual = position_value;
const diff = Math.abs(actual - expected);

if (diff < 1) {
  console.log(`  ✅ 持仓价值 = $${actual.toFixed(2)} (目标$${expected})`);
  console.log(`  ✅ 保证金 = $${margin.toFixed(2)}`);
  console.log(`  ✅ 固定仓位模式生效！`);
} else {
  console.log(`  ❌ 持仓价值 = $${actual.toFixed(2)} (目标$${expected})`);
  console.log(`  ❌ 差异: $${diff.toFixed(2)}`);
}

// 计算风险
const stop_loss_percent = 0.04;
const max_loss_on_stop = position_value * stop_loss_percent;
const max_loss_on_liquidation = margin;

console.log('\n风险分析:');
console.log(`  止损4%触发: -$${max_loss_on_stop.toFixed(2)}`);
console.log(`  爆仓最大亏损: -$${max_loss_on_liquidation.toFixed(2)}`);
console.log(`  账户占比: ${(margin / 10000 * 100).toFixed(2)}%`);
console.log('');
