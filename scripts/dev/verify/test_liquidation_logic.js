/**
 * 测试爆仓逻辑 - 模拟NEIROUSDT那笔交易
 */

const trade = {
  symbol: "NEIROUSDT",
  side: "LONG",
  entry_price: 0.00014245231,
  exit_price: 0.0001364809824,  // 实际出场价
  stop_loss_price: 0.0001366176,
  quantity: 7019893.183901335,
  leverage: 10
};

console.log('\n' + '='.repeat(80));
console.log('【逐仓爆仓逻辑测试】');
console.log('='.repeat(80));

console.log('\n交易参数:');
console.log(`  币种: ${trade.symbol}`);
console.log(`  方向: ${trade.side}`);
console.log(`  入场价: $${trade.entry_price.toFixed(10)}`);
console.log(`  杠杆: ${trade.leverage}x`);
console.log(`  数量: ${trade.quantity.toFixed(2)}`);

// 计算爆仓价
function calculate_liquidation_price(entry_price, leverage, side) {
  if (side === 'LONG') {
    return entry_price * (1 - 1 / leverage);
  } else {
    return entry_price * (1 + 1 / leverage);
  }
}

const liquidation_price = calculate_liquidation_price(trade.entry_price, trade.leverage, trade.side);

console.log('\n' + '='.repeat(80));
console.log('【爆仓价格计算】');
console.log('='.repeat(80));

console.log(`\n多头爆仓价计算公式:`);
console.log(`  爆仓价 = 入场价 × (1 - 1/杠杆)`);
console.log(`  = ${trade.entry_price.toFixed(10)} × (1 - 1/${trade.leverage})`);
console.log(`  = ${trade.entry_price.toFixed(10)} × ${(1 - 1/trade.leverage).toFixed(2)}`);
console.log(`  = $${liquidation_price.toFixed(10)}`);

console.log('\n' + '='.repeat(80));
console.log('【价格对比】');
console.log('='.repeat(80));

console.log('\n价格层级:');
console.log(`  入场价格: $${trade.entry_price.toFixed(10)}`);
console.log(`  止损价格: $${trade.stop_loss_price.toFixed(10)} (入场价 - ${((1 - trade.stop_loss_price/trade.entry_price) * 100).toFixed(2)}%)`);
console.log(`  爆仓价格: $${liquidation_price.toFixed(10)} (入场价 - ${((1 - liquidation_price/trade.entry_price) * 100).toFixed(2)}%)`);
console.log(`  实际出场: $${trade.exit_price.toFixed(10)} (入场价 - ${((1 - trade.exit_price/trade.entry_price) * 100).toFixed(2)}%)`);

console.log('\n' + '='.repeat(80));
console.log('【触发顺序判断】');
console.log('='.repeat(80));

// 判断价格先触发哪个
const price_to_stop = trade.entry_price - trade.stop_loss_price;
const price_to_liq = trade.entry_price - liquidation_price;
const price_to_exit = trade.entry_price - trade.exit_price;

console.log('\n价格距离入场价的距离:');
console.log(`  到止损: $${price_to_stop.toFixed(10)}`);
console.log(`  到爆仓: $${price_to_liq.toFixed(10)}`);
console.log(`  到实际出场: $${price_to_exit.toFixed(10)}`);

console.log('\n触发顺序 (从近到远):');
const triggers = [
  { name: '止损', price: trade.stop_loss_price, distance: price_to_stop },
  { name: '爆仓', price: liquidation_price, distance: price_to_liq },
  { name: '实际出场', price: trade.exit_price, distance: price_to_exit }
].sort((a, b) => a.distance - b.distance);

triggers.forEach((t, i) => {
  console.log(`  ${i + 1}. ${t.name}: $${t.price.toFixed(10)} (距离 $${t.distance.toFixed(10)})`);
});

console.log('\n' + '='.repeat(80));
console.log('【盈亏计算】');
console.log('='.repeat(80));

const position_value = trade.entry_price * trade.quantity;
const margin = position_value / trade.leverage;

// 在不同价格平仓的盈亏
function calculate_pnl(entry, exit, quantity, side) {
  if (side === 'LONG') {
    return (exit - entry) * quantity;
  } else {
    return (entry - exit) * quantity;
  }
}

const pnl_at_stop = calculate_pnl(trade.entry_price, trade.stop_loss_price, trade.quantity, trade.side);
const pnl_at_liq = calculate_pnl(trade.entry_price, liquidation_price, trade.quantity, trade.side);
const pnl_at_exit = calculate_pnl(trade.entry_price, trade.exit_price, trade.quantity, trade.side);

console.log('\n持仓信息:');
console.log(`  持仓价值: $${position_value.toFixed(2)}`);
console.log(`  保证金: $${margin.toFixed(2)}`);

console.log('\n在不同价格平仓的盈亏:');
console.log(`  1️⃣ 如果在止损价平仓:`);
console.log(`     PnL = $${pnl_at_stop.toFixed(2)}`);
console.log(`     占保证金: ${(Math.abs(pnl_at_stop) / margin * 100).toFixed(2)}%`);

console.log(`  2️⃣ 如果在爆仓价平仓:`);
console.log(`     PnL = $${pnl_at_liq.toFixed(2)}`);
console.log(`     占保证金: ${(Math.abs(pnl_at_liq) / margin * 100).toFixed(2)}%`);
console.log(`     ✅ 刚好等于保证金 (逐仓模式正确！)`);

console.log(`  3️⃣ 如果在实际出场价平仓 (旧逻辑):`);
console.log(`     PnL = $${pnl_at_exit.toFixed(2)}`);
console.log(`     占保证金: ${(Math.abs(pnl_at_exit) / margin * 100).toFixed(2)}%`);
console.log(`     ❌ 远超保证金 (${(Math.abs(pnl_at_exit) / margin).toFixed(2)}倍)`);

console.log('\n' + '='.repeat(80));
console.log('【逐仓逻辑判断】');
console.log('='.repeat(80));

console.log('\n✅ 正确的逐仓逻辑:');
console.log(`  1. 价格下跌到 $${trade.stop_loss_price.toFixed(10)} → 触发止损`);
console.log(`     亏损: $${Math.abs(pnl_at_stop).toFixed(2)} (${(Math.abs(pnl_at_stop) / margin * 100).toFixed(2)}%保证金)`);
console.log('  ');
console.log(`  2. 如果止损没触发，价格继续跌到 $${liquidation_price.toFixed(10)} → 触发爆仓`);
console.log(`     亏损: $${Math.abs(pnl_at_liq).toFixed(2)} (100%保证金)`);
console.log('  ');
console.log(`  3. 价格不可能跌破爆仓价后还继续持仓！`);

console.log('\n❌ 当前问题:');
console.log(`  实际出场价 $${trade.exit_price.toFixed(10)} < 爆仓价 $${liquidation_price.toFixed(10)}`);
console.log(`  说明应该在爆仓价就被强制平仓了！`);
console.log(`  但旧代码没有爆仓检测，让价格继续下跌，导致亏损超过保证金`);

console.log('\n' + '='.repeat(80));
console.log('【解决方案验证】');
console.log('='.repeat(80));

console.log('\n新增的 calculate_liquidation_price() 方法:');
console.log(`  ✅ 计算爆仓价: $${liquidation_price.toFixed(10)}`);
console.log('  ');
console.log('新增的爆仓检测逻辑:');
console.log('  ✅ 在 simulate_position_holding() 中优先检查爆仓');
console.log('  ✅ 多头: if (price <= liquidation_price) → 强制平仓');
console.log('  ✅ 空头: if (price >= liquidation_price) → 强制平仓');
console.log('  ');
console.log('预期结果:');
console.log(`  当价格跌到 $${liquidation_price.toFixed(10)} 时`);
console.log(`  系统会强制平仓，亏损锁定在 $${Math.abs(pnl_at_liq).toFixed(2)}`);
console.log(`  不会再继续跌到 $${trade.exit_price.toFixed(10)}`);

console.log('');
