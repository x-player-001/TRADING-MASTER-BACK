/**
 * 分析为什么逐仓模式下亏损超过保证金
 */

const trade = {
  symbol: "NEIROUSDT",
  entry_price: 0.00014245231,
  exit_price: 0.0001364809824,
  quantity: 7019893.183901335,
  leverage: 10,
  stop_loss_price: 0.0001366176,
  realized_pnl: -420.13890109890195
};

console.log('\n' + '='.repeat(80));
console.log('【逐仓模式亏损异常分析】');
console.log('='.repeat(80));

console.log('\n交易详情:');
console.log(`  币种: ${trade.symbol}`);
console.log(`  入场价格: ${trade.entry_price.toFixed(10)}`);
console.log(`  出场价格: ${trade.exit_price.toFixed(10)}`);
console.log(`  止损价格: ${trade.stop_loss_price.toFixed(10)}`);
console.log(`  数量: ${trade.quantity.toFixed(2)}`);
console.log(`  杠杆: ${trade.leverage}x`);

console.log('\n' + '='.repeat(80));
console.log('【计算分析】');
console.log('='.repeat(80));

// 1. 持仓价值和保证金
const position_value = trade.entry_price * trade.quantity;
const margin = position_value / trade.leverage;

console.log('\n1️⃣ 持仓和保证金:');
console.log(`  持仓价值 = 入场价格 × 数量`);
console.log(`  = ${trade.entry_price.toFixed(10)} × ${trade.quantity.toFixed(2)}`);
console.log(`  = $${position_value.toFixed(2)}`);
console.log(`  `);
console.log(`  保证金 = 持仓价值 / 杠杆`);
console.log(`  = $${position_value.toFixed(2)} / ${trade.leverage}`);
console.log(`  = $${margin.toFixed(2)}`);

// 2. 价格变化
const price_change = trade.exit_price - trade.entry_price;
const price_change_percent = (price_change / trade.entry_price) * 100;

console.log('\n2️⃣ 价格变化:');
console.log(`  价格变化 = 出场价格 - 入场价格`);
console.log(`  = ${trade.exit_price.toFixed(10)} - ${trade.entry_price.toFixed(10)}`);
console.log(`  = ${price_change.toFixed(10)}`);
console.log(`  = ${price_change_percent.toFixed(2)}%`);

// 3. 理论止损
const stop_loss_change = trade.stop_loss_price - trade.entry_price;
const stop_loss_percent = (stop_loss_change / trade.entry_price) * 100;

console.log('\n3️⃣ 止损设置:');
console.log(`  止损价格 = ${trade.stop_loss_price.toFixed(10)}`);
console.log(`  距离入场 = ${stop_loss_change.toFixed(10)}`);
console.log(`  百分比 = ${stop_loss_percent.toFixed(2)}%`);

// 4. 实际亏损
const actual_pnl = trade.realized_pnl;
const theoretical_loss_at_stop = position_value * Math.abs(stop_loss_percent) / 100;

console.log('\n4️⃣ 亏损对比:');
console.log(`  理论止损亏损 (4%): $${(position_value * 0.04).toFixed(2)}`);
console.log(`  止损价格触发亏损: $${theoretical_loss_at_stop.toFixed(2)}`);
console.log(`  实际亏损: $${actual_pnl.toFixed(2)}`);
console.log(`  保证金: $${margin.toFixed(2)}`);

console.log('\n' + '='.repeat(80));
console.log('【问题根源】');
console.log('='.repeat(80));

console.log('\n❌ 发现问题:');
console.log(`  1. 实际亏损 $${Math.abs(actual_pnl).toFixed(2)} > 保证金 $${margin.toFixed(2)}`);
console.log(`  2. 亏损是保证金的 ${(Math.abs(actual_pnl) / margin).toFixed(2)} 倍！`);

console.log('\n🔍 原因分析:');
console.log('  当前回测引擎的问题:');
console.log('  ');
console.log('  ❌ 问题1: 计算亏损时使用的是「持仓价值」而非「保证金」');
console.log('     当前逻辑: PnL = (出场价 - 入场价) × 数量');
console.log('     这个公式计算的是「无杠杆」情况下的盈亏！');
console.log('  ');
console.log('  ❌ 问题2: 逐仓模式的爆仓检测缺失');
console.log('     逐仓模式下，当浮亏达到保证金时应该强制平仓（爆仓）');
console.log('     但当前代码没有这个检测逻辑');

console.log('\n' + '='.repeat(80));
console.log('【正确的逐仓计算】');
console.log('='.repeat(80));

console.log('\n✅ 正确的盈亏计算公式:');
console.log('  ');
console.log('  对于合约交易:');
console.log('  PnL = (出场价 - 入场价) × 数量 × 方向');
console.log('  ');
console.log('  其中:');
console.log('  - 「数量」是合约数量（币的数量）');
console.log('  - 盈亏直接以USDT计算，不需要再乘杠杆');
console.log('  ');
console.log('  当前计算:');
console.log(`  PnL = (${trade.exit_price.toFixed(10)} - ${trade.entry_price.toFixed(10)})`);
console.log(`      × ${trade.quantity.toFixed(2)}`);
console.log(`      = ${actual_pnl.toFixed(2)}`);

console.log('\n✅ 逐仓爆仓逻辑:');
console.log('  ');
console.log('  逐仓模式下，爆仓条件:');
console.log('  当 |浮亏| >= 保证金 时，强制平仓');
console.log('  ');
console.log('  爆仓价格计算:');
console.log('  对于多头: 爆仓价 = 入场价 × (1 - 1/杠杆)');
console.log(`  = ${trade.entry_price.toFixed(10)} × (1 - 1/${trade.leverage})`);
const liquidation_price_long = trade.entry_price * (1 - 1 / trade.leverage);
console.log(`  = ${liquidation_price_long.toFixed(10)}`);
console.log('  ');
console.log('  本例中:');
console.log(`  入场价: ${trade.entry_price.toFixed(10)}`);
console.log(`  爆仓价: ${liquidation_price_long.toFixed(10)}`);
console.log(`  出场价: ${trade.exit_price.toFixed(10)}`);
console.log(`  止损价: ${trade.stop_loss_price.toFixed(10)}`);
console.log('  ');
if (trade.exit_price < liquidation_price_long) {
  console.log(`  ⚠️  出场价 < 爆仓价：应该在爆仓价平仓，最大亏损 = 保证金 $${margin.toFixed(2)}`);
} else {
  console.log(`  ✅ 出场价 > 爆仓价：在止损价平仓`);
}

console.log('\n' + '='.repeat(80));
console.log('【需要修复的代码】');
console.log('='.repeat(80));

console.log('\n需要在 backtest_engine.ts 中添加:');
console.log('  ');
console.log('  1️⃣ 逐仓爆仓检测:');
console.log('     在每次价格更新时，检查是否触达爆仓价');
console.log('     爆仓价 = 入场价 × (1 ± 1/杠杆)');
console.log('  ');
console.log('  2️⃣ 限制最大亏损:');
console.log('     逐仓模式下，最大亏损 = 保证金');
console.log('     realized_pnl = Math.max(calculated_pnl, -margin)');
console.log('  ');
console.log('  3️⃣ 爆仓价格计算:');
console.log('     多头: liquidation_price = entry_price × (1 - 1/leverage)');
console.log('     空头: liquidation_price = entry_price × (1 + 1/leverage)');

console.log('');
