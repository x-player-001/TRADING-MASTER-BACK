/**
 * 对比三种仓位模式的回测结果
 */

console.log('\n📊 三种仓位模式对比\n');
console.log('='.repeat(80));

// 模式1: 全仓模式（原始逻辑，按账户百分比）
const cross_margin = {
  name: '全仓模式（5%仓位）',
  position_value: 500,  // $10000 * 5%
  margin: 50,           // $500 / 10x
  total_trades: 37,
  roi: 1.85,
  total_pnl: 185,
  win_rate: 43.24,
  max_drawdown_percent: 1.53,
  risk_per_trade: 50,   // 爆仓风险 = 保证金
  extreme_risk: 100     // 跳空-20%风险
};

// 模式2: 逐仓模式（基于最大亏损计算保证金）
const isolated_margin = {
  name: '逐仓模式（风险0.2%）',
  position_value: 200,  // $20 * 10x
  margin: 20,           // $10000 * 5% * 4% = $20
  total_trades: 37,
  roi: 0.80,
  total_pnl: 80,
  win_rate: 43.24,
  max_drawdown_percent: 1.53,
  risk_per_trade: 20,   // 爆仓风险 = 保证金
  extreme_risk: 20      // 跳空风险可控
};

// 模式3: 固定仓位（每笔$100）
const fixed_position = {
  name: '固定仓位（每笔$100）',
  position_value: 100,  // 固定$100
  margin: 10,           // $100 / 10x
  total_trades: 37,
  roi: 0.53,
  total_pnl: 53,
  win_rate: 43.24,
  max_drawdown_percent: 1.53,
  risk_per_trade: 10,   // 爆仓风险 = 保证金
  extreme_risk: 10      // 跳空风险可控
};

const modes = [cross_margin, isolated_margin, fixed_position];

// 打印对比表格
console.log('模式\t\t\t持仓价值\t保证金\t收益率\t总盈亏\t胜率\t最大回撤');
console.log('-'.repeat(80));

modes.forEach(mode => {
  console.log(
    `${mode.name}\t` +
    `$${mode.position_value}\t\t` +
    `$${mode.margin}\t` +
    `${mode.roi.toFixed(2)}%\t` +
    `$${mode.total_pnl}\t` +
    `${mode.win_rate.toFixed(1)}%\t` +
    `${mode.max_drawdown_percent.toFixed(2)}%`
  );
});

console.log('\n' + '='.repeat(80));
console.log('风险对比（单笔交易）\n');

console.log('模式\t\t\t止损4%\t\t爆仓风险\t极端跳空-20%');
console.log('-'.repeat(80));

modes.forEach(mode => {
  const stop_loss = mode.position_value * 0.04;
  console.log(
    `${mode.name}\t` +
    `-$${stop_loss.toFixed(2)}\t\t` +
    `-$${mode.risk_per_trade.toFixed(2)}\t\t` +
    `-$${mode.extreme_risk.toFixed(2)}`
  );
});

console.log('\n' + '='.repeat(80));
console.log('📈 结论分析\n');

console.log('1. 收益率对比:');
console.log('   全仓模式 > 逐仓模式 > 固定仓位');
console.log('   持仓越大，收益越高（同时风险也越大）\n');

console.log('2. 风险控制:');
console.log('   固定仓位 < 逐仓模式 < 全仓模式');
console.log('   固定仓位风险最小且最稳定\n');

console.log('3. 适用场景:');
console.log('   • 全仓模式: 适合低波动市场，不适合加密货币');
console.log('   • 逐仓模式: 风险可控，适合中等规模资金');
console.log('   • 固定仓位: 最适合回测和策略验证 ✅\n');

console.log('4. 推荐策略:');
console.log('   回测阶段: 使用固定仓位$100，便于对比不同策略');
console.log('   实盘交易: 使用逐仓模式，根据账户规模动态调整');
console.log('');
