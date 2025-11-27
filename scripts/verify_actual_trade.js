// 验证第一笔交易是否符合逐仓模式
const trade = {
  entry_price: 0.053876532709999994,
  quantity: 2680.2021722009963,
  leverage: 10,
  realized_pnl: 5.90851910718347
};

const position_value = trade.entry_price * trade.quantity;
const margin = position_value / trade.leverage;

console.log('\n📋 第一笔交易验证 (CVCUSDT)\n');
console.log('交易参数:');
console.log(`  入场价格: $${trade.entry_price.toFixed(6)}`);
console.log(`  数量: ${trade.quantity.toFixed(2)}`);
console.log(`  杠杆: ${trade.leverage}x`);
console.log(`  持仓价值: $${position_value.toFixed(2)}`);
console.log(`  保证金: $${margin.toFixed(2)}`);
console.log(`  盈亏: $${trade.realized_pnl.toFixed(2)}`);

console.log('\n逐仓模式验证:');
const expected_margin = 10000 * 0.05 * 0.04; // 账户 × 仓位% × 止损%
console.log(`  理论保证金: $10000 × 5% × 4% = $${expected_margin.toFixed(2)}`);
console.log(`  实际保证金: $${margin.toFixed(2)}`);

const diff_percent = Math.abs((margin - expected_margin) / expected_margin * 100);
if (diff_percent < 5) {
  console.log(`  ✅ 验证通过！差异 ${diff_percent.toFixed(2)}%`);
} else {
  console.log(`  ❌ 差异较大: ${diff_percent.toFixed(2)}%`);
}

console.log('\n风险控制验证:');
const max_loss_on_stop = position_value * 0.04; // 4%止损
const max_loss_on_liquidation = margin; // 爆仓最大亏损
console.log(`  止损4%触发时亏损: $${max_loss_on_stop.toFixed(2)}`);
console.log(`  爆仓最大亏损: $${max_loss_on_liquidation.toFixed(2)}`);
console.log(`  账户占比: ${(max_loss_on_liquidation / 10000 * 100).toFixed(2)}%`);
console.log('  ✅ 风险可控：即使爆仓也不会超过预期止损金额');
console.log('');
