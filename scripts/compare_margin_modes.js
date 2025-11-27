/**
 * 对比不同保证金模式的回测结果
 */
const fs = require('fs');
const path = require('path');

console.log('\n' + '='.repeat(80));
console.log('【保证金模式对比分析】');
console.log('='.repeat(80));

// 读取最新的回测结果
const results_dir = path.join(__dirname, '../backtest_results');
const files = fs.readdirSync(results_dir)
  .filter(f => f.startsWith('backtest_') && f.endsWith('.json'))
  .sort()
  .reverse();

if (files.length < 2) {
  console.log('❌ 需要至少2个回测结果才能对比');
  process.exit(1);
}

// 读取最新的两个结果
const latest = JSON.parse(fs.readFileSync(path.join(results_dir, files[0]), 'utf-8'));
const previous = JSON.parse(fs.readFileSync(path.join(results_dir, files[1]), 'utf-8'));

console.log(`\n对比文件:`);
console.log(`  新版本: ${files[0]}`);
console.log(`  旧版本: ${files[1]}`);

// 检查保证金模式
const latest_trades = latest.all_trades || [];
const previous_trades = previous.all_trades || [];

const latest_margin = latest_trades.length > 0 ?
  (latest_trades[0].entry_price * latest_trades[0].quantity / latest_trades[0].leverage) : 0;
const previous_margin = previous_trades.length > 0 ?
  (previous_trades[0].entry_price * previous_trades[0].quantity / previous_trades[0].leverage) : 0;

console.log(`\n保证金模式:`);
console.log(`  新版本: 固定保证金 $${latest_margin.toFixed(2)}`);
console.log(`  旧版本: 固定保证金 $${previous_margin.toFixed(2)}`);

console.log('\n' + '='.repeat(80));
console.log('【交易统计对比】');
console.log('='.repeat(80));

console.log(`\n交易数量:`);
console.log(`  新版本: ${latest.summary.total_trades}笔`);
console.log(`  旧版本: ${previous.summary.total_trades}笔`);

console.log(`\n胜率:`);
console.log(`  新版本: ${latest.summary.win_rate.toFixed(2)}% (${latest.summary.winning_trades}胜/${latest.summary.losing_trades}负)`);
console.log(`  旧版本: ${previous.summary.win_rate.toFixed(2)}% (${previous.summary.winning_trades}胜/${previous.summary.losing_trades}负)`);

console.log('\n' + '='.repeat(80));
console.log('【收益对比】');
console.log('='.repeat(80));

console.log(`\n总盈亏:`);
console.log(`  新版本: $${latest.summary.total_pnl.toFixed(2)}`);
console.log(`  旧版本: $${previous.summary.total_pnl.toFixed(2)}`);
console.log(`  差异: ${(latest.summary.total_pnl - previous.summary.total_pnl).toFixed(2)}`);

console.log(`\nROI (投资回报率):`);
console.log(`  新版本: ${latest.summary.roi_percent.toFixed(2)}%`);
console.log(`  旧版本: ${previous.summary.roi_percent.toFixed(2)}%`);
console.log(`  差异: ${(latest.summary.roi_percent - previous.summary.roi_percent).toFixed(2)}%`);

console.log(`\n平均盈利:`);
console.log(`  新版本: $${latest.summary.average_win.toFixed(2)}`);
console.log(`  旧版本: $${previous.summary.average_win.toFixed(2)}`);

console.log(`\n平均亏损:`);
console.log(`  新版本: $${latest.summary.average_loss.toFixed(2)}`);
console.log(`  旧版本: $${previous.summary.average_loss.toFixed(2)}`);

console.log(`\n盈亏比:`);
console.log(`  新版本: ${latest.summary.profit_factor.toFixed(2)}`);
console.log(`  旧版本: ${previous.summary.profit_factor.toFixed(2)}`);

console.log('\n' + '='.repeat(80));
console.log('【风险对比】');
console.log('='.repeat(80));

console.log(`\n最大回撤:`);
console.log(`  新版本: $${latest.summary.max_drawdown.toFixed(2)} (${latest.summary.max_drawdown_percent.toFixed(2)}%)`);
console.log(`  旧版本: $${previous.summary.max_drawdown.toFixed(2)} (${previous.summary.max_drawdown_percent.toFixed(2)}%)`);

// 计算单笔最大亏损
const latest_losses = latest_trades.filter(t => t.realized_pnl < 0).map(t => t.realized_pnl);
const previous_losses = previous_trades.filter(t => t.realized_pnl < 0).map(t => t.realized_pnl);

const latest_max_loss = latest_losses.length > 0 ? Math.min(...latest_losses) : 0;
const previous_max_loss = previous_losses.length > 0 ? Math.min(...previous_losses) : 0;

console.log(`\n单笔最大亏损:`);
console.log(`  新版本: $${latest_max_loss.toFixed(2)}`);
console.log(`  旧版本: $${previous_max_loss.toFixed(2)}`);

console.log('\n' + '='.repeat(80));
console.log('【持仓规模对比】');
console.log('='.repeat(80));

// 计算平均持仓价值
const latest_positions = latest_trades.map(t => t.entry_price * t.quantity);
const previous_positions = previous_trades.map(t => t.entry_price * t.quantity);

const latest_avg_position = latest_positions.reduce((a, b) => a + b, 0) / latest_positions.length;
const previous_avg_position = previous_positions.reduce((a, b) => a + b, 0) / previous_positions.length;

console.log(`\n平均持仓价值:`);
console.log(`  新版本: $${latest_avg_position.toFixed(2)}`);
console.log(`  旧版本: $${previous_avg_position.toFixed(2)}`);

console.log(`\n平均保证金:`);
console.log(`  新版本: $${latest_margin.toFixed(2)}`);
console.log(`  旧版本: $${previous_margin.toFixed(2)}`);

console.log('\n' + '='.repeat(80));
console.log('【总结】');
console.log('='.repeat(80));

console.log(`\n💡 关键发现:`);
console.log(`  1. 保证金模式: 固定$${latest_margin.toFixed(0)} (新) vs 固定$${previous_margin.toFixed(0)} (旧)`);
console.log(`  2. ROI变化: ${latest.summary.roi_percent.toFixed(2)}% (新) vs ${previous.summary.roi_percent.toFixed(2)}% (旧)`);
console.log(`  3. 最大回撤: ${latest.summary.max_drawdown_percent.toFixed(2)}% (新) vs ${previous.summary.max_drawdown_percent.toFixed(2)}% (旧)`);
console.log(`  4. 胜率: ${latest.summary.win_rate.toFixed(2)}% (新) vs ${previous.summary.win_rate.toFixed(2)}% (旧)`);

if (latest_margin > previous_margin) {
  console.log(`\n✅ 新版本提高了单笔保证金(${latest_margin.toFixed(0)}$ vs ${previous_margin.toFixed(0)}$)，风险暴露增加`);
  console.log(`   持仓规模更大，盈亏波动也更大`);
} else if (latest_margin < previous_margin) {
  console.log(`\n✅ 新版本降低了单笔保证金(${latest_margin.toFixed(0)}$ vs ${previous_margin.toFixed(0)}$)，风险更加保守`);
  console.log(`   持仓规模更小，但风险控制更严格`);
} else {
  console.log(`\n✅ 两个版本使用相同的保证金(${latest_margin.toFixed(0)}$)`);
}

console.log('');
