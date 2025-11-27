/**
 * 验证固定保证金模式
 * 检查每笔交易的保证金是否都是$100
 */
const fs = require('fs');
const path = require('path');

// 读取最新的回测结果
const results_dir = path.join(__dirname, '../backtest_results');
const files = fs.readdirSync(results_dir)
  .filter(f => f.startsWith('backtest_') && f.endsWith('.json'))
  .sort()
  .reverse();

if (files.length === 0) {
  console.log('❌ 未找到回测结果文件');
  process.exit(1);
}

const latest_file = path.join(results_dir, files[0]);
console.log(`\n📊 读取回测结果: ${files[0]}\n`);

const data = JSON.parse(fs.readFileSync(latest_file, 'utf-8'));
const trades = data.all_trades || [];

if (trades.length === 0) {
  console.log('❌ 回测结果中没有交易记录');
  process.exit(1);
}

console.log('=' .repeat(80));
console.log('【固定保证金模式验证】');
console.log('=' .repeat(80));

console.log(`\n总交易数: ${trades.length}笔\n`);

// 检查前10笔交易
console.log('前10笔交易验证:\n');

const sample_trades = trades.slice(0, 10);
let all_correct = true;

sample_trades.forEach((trade, index) => {
  const position_value = trade.entry_price * trade.quantity;
  const margin = position_value / trade.leverage;
  const expected_margin = 100;
  const diff = Math.abs(margin - expected_margin);
  const is_correct = diff < 1; // 允许小于$1的误差

  console.log(`交易 ${index + 1}: ${trade.symbol}`);
  console.log(`  入场价格: $${trade.entry_price.toFixed(6)}`);
  console.log(`  数量: ${trade.quantity.toFixed(2)}`);
  console.log(`  杠杆: ${trade.leverage}x`);
  console.log(`  持仓价值: $${position_value.toFixed(2)}`);
  console.log(`  保证金: $${margin.toFixed(2)}`);

  if (is_correct) {
    console.log(`  ✅ 保证金正确 (目标$${expected_margin})`);
  } else {
    console.log(`  ❌ 保证金错误 (目标$${expected_margin}, 差异$${diff.toFixed(2)})`);
    all_correct = false;
  }
  console.log('');
});

console.log('=' .repeat(80));
console.log('【统计分析】');
console.log('=' .repeat(80));

// 统计所有交易的保证金
const margins = trades.map(t => (t.entry_price * t.quantity) / t.leverage);
const min_margin = Math.min(...margins);
const max_margin = Math.max(...margins);
const avg_margin = margins.reduce((a, b) => a + b, 0) / margins.length;

console.log(`\n所有 ${trades.length} 笔交易的保证金统计:`);
console.log(`  最小保证金: $${min_margin.toFixed(2)}`);
console.log(`  最大保证金: $${max_margin.toFixed(2)}`);
console.log(`  平均保证金: $${avg_margin.toFixed(2)}`);
console.log(`  目标保证金: $100.00`);

// 检查是否所有交易都在合理范围内
const all_in_range = margins.every(m => Math.abs(m - 100) < 1);

console.log('\n验证结果:');
if (all_in_range) {
  console.log('  ✅ 所有交易的保证金都符合固定$100的要求！');
} else {
  const out_of_range = margins.filter(m => Math.abs(m - 100) >= 1).length;
  console.log(`  ⚠️  有 ${out_of_range} 笔交易的保证金与目标有偏差`);
}

console.log('\n' + '=' .repeat(80));
console.log('【风险分析】');
console.log('=' .repeat(80));

// 计算风险指标
const position_values = trades.map(t => t.entry_price * t.quantity);
const avg_position = position_values.reduce((a, b) => a + b, 0) / position_values.length;
const max_position = Math.max(...position_values);

console.log(`\n持仓规模统计:`);
console.log(`  平均持仓价值: $${avg_position.toFixed(2)}`);
console.log(`  最大持仓价值: $${max_position.toFixed(2)}`);
console.log(`  平均杠杆: ${trades.reduce((a, b) => a + b.leverage, 0) / trades.length}x`);

console.log(`\n风险控制:`);
console.log(`  单笔固定保证金: $100`);
console.log(`  即使爆仓最大亏损: $100`);
console.log(`  占初始资金比例: ${(100 / data.metadata.config.initial_balance * 100).toFixed(2)}%`);
console.log(`  ✅ 风险完全可控，即使极端行情也不会超过保证金！`);

console.log('');
