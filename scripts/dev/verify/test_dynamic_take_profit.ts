/**
 * 测试动态止盈和分批止盈策略
 */

import { SignalGenerator } from '../../../src/trading/signal_generator';
import { TrailingStopManager } from '../../../src/trading/trailing_stop_manager';
import { OIAnomalyRecord } from '../../../src/types/oi_types';
import { PositionSide } from '../../../src/types/trading_types';

const signal_generator = new SignalGenerator();
const trailing_manager = new TrailingStopManager();

console.log('\n🚀 测试动态止盈 + 分批止盈策略\n');

// ==================== 测试1：信号生成和止盈配置 ====================
console.log('='.repeat(80));
console.log('测试1：信号生成和动态止盈配置');
console.log('='.repeat(80));

const test_anomaly: OIAnomalyRecord = {
  symbol: 'BTCUSDT',
  period_seconds: 300,
  percent_change: 4.5,
  oi_before: 1000000,
  oi_after: 1045000,
  oi_change: 45000,
  threshold_value: 3,
  anomaly_time: new Date(),
  severity: 'low',
  anomaly_type: 'oi',
  price_before: 90000,
  price_after: 91000,  // 入场价格
  price_change_percent: 1.11,
  top_trader_long_short_ratio: 1.4,
  global_long_short_ratio: 1.1,
  taker_buy_sell_ratio: 1.3,
  funding_rate_after: -0.0001
};

const signal = signal_generator.generate_signal(test_anomaly);

if (signal && signal.dynamic_take_profit) {
  console.log(`\n✅ 信号生成成功:`);
  console.log(`  币种: ${signal.symbol}`);
  console.log(`  方向: ${signal.direction}`);
  console.log(`  入场价: ${signal.entry_price}`);
  console.log(`  止损价: ${signal.stop_loss === 0 ? '无 (逐仓模式)' : signal.stop_loss}`);
  console.log(`  主止盈: ${signal.take_profit} (+8.00%)`);

  console.log(`\n📊 分批止盈配置 (逐仓模式):`);
  const config = signal.dynamic_take_profit;
  config.targets.forEach((target, index) => {
    if (target.is_trailing) {
      console.log(`  批次${index + 1}: ${target.percentage}%仓位 - 跟踪止盈 (回调${target.trailing_callback_pct}%)`);
    } else {
      console.log(`  批次${index + 1}: ${target.percentage}%仓位 @ ${target.price.toFixed(2)} (+${target.target_profit_pct}%)`);
    }
  });

  console.log(`\n⚙️ 跟踪配置:`);
  console.log(`  启用跟踪: ${config.enable_trailing ? '是' : '否'}`);
  console.log(`  启动条件: 达到+${config.trailing_start_profit_pct}%后`);
  console.log(`\n💡 风控策略:`);
  console.log(`  模式: 逐仓 (Isolated Margin)`);
  console.log(`  止损: 无止损线，开仓金额即为最大损失`);
  console.log(`  风险: 单笔最大损失 = 开仓本金`);

  // ==================== 测试2：模拟价格变化和止盈触发 ====================
  console.log('\n' + '='.repeat(80));
  console.log('测试2：模拟价格变化和止盈执行');
  console.log('='.repeat(80));

  const position_id = 1;
  const initial_quantity = 1.0; // 1个BTC
  const entry_price = signal.entry_price!;

  // 开始跟踪
  trailing_manager.start_tracking(
    position_id,
    signal.symbol,
    PositionSide.LONG,
    entry_price,
    initial_quantity,
    config
  );

  console.log(`\n📍 开仓信息:`);
  console.log(`  仓位ID: ${position_id}`);
  console.log(`  入场价: ${entry_price}`);
  console.log(`  数量: ${initial_quantity} BTC`);

  // 模拟价格走势（针对新止盈目标 8% 和 14%）
  const price_scenario = [
    { price: 91000, desc: '入场' },
    { price: 92000, desc: '缓慢上涨 +1.1%' },
    { price: 94000, desc: '继续上涨 +3.3%' },
    { price: 96000, desc: '稳步上涨 +5.5%' },
    { price: 98280, desc: '达到第一批止盈目标 +8.0%' },
    { price: 99000, desc: '突破第一批，继续上涨 +8.8%' },
    { price: 102000, desc: '强势上涨 +12.1%' },
    { price: 103740, desc: '达到第二批止盈目标 +14.0%' },
    { price: 105000, desc: '继续突破 +15.4% (跟踪启动)' },
    { price: 110000, desc: '大涨 +20.9% (更新最高点)' },
    { price: 115000, desc: '暴涨 +26.4% (更新最高点)' },
    { price: 120000, desc: '持续暴涨 +31.9% (更新最高点)' },
    { price: 115000, desc: '回调 +26.4% (测试跟踪止损)' },
    { price: 110000, desc: '继续回调 +20.9%' },
    { price: 107300, desc: '回调至跟踪止损价 +17.9%' }
  ];

  console.log(`\n📈 价格走势模拟:\n`);

  for (const scenario of price_scenario) {
    const actions = trailing_manager.update_price(position_id, scenario.price);

    console.log(`💰 价格: ${scenario.price.toFixed(2)} - ${scenario.desc}`);

    if (actions.length > 0) {
      for (const action of actions) {
        console.log(`   🎯 触发: ${action.type}`);
        console.log(`      数量: ${action.quantity.toFixed(4)} BTC`);
        console.log(`      价格: ${action.price.toFixed(2)}`);
        console.log(`      原因: ${action.reason}`);
        console.log(`      盈亏: +${((action.price - entry_price) / entry_price * 100).toFixed(2)}%`);
      }
    }

    const state = trailing_manager.get_tracking_state(position_id);
    if (state) {
      console.log(`   📊 剩余: ${state.remaining_quantity.toFixed(4)} BTC | 已执行: ${state.executed_targets}/3批次`);
      if (state.trailing_active && state.highest_profit_price) {
        console.log(`   📈 跟踪: 最高价 ${state.highest_profit_price.toFixed(2)} | 止损价 ${state.trailing_stop_price?.toFixed(2) || 'N/A'}`);
      }
    }

    console.log('');
  }

  // ==================== 测试3：计算最终收益 ====================
  console.log('='.repeat(80));
  console.log('测试3：最终收益统计');
  console.log('='.repeat(80));

  const final_state = trailing_manager.get_tracking_state(position_id);
  if (final_state) {
    console.log(`\n✅ 仓位平仓完成\n`);

    let total_pnl = 0;
    let total_pnl_pct = 0;

    console.log('各批次收益明细:');
    final_state.targets.forEach((target_state, index) => {
      if (target_state.executed && target_state.executed_quantity && target_state.executed_price) {
        const quantity = target_state.executed_quantity;
        const exit_price = target_state.executed_price;
        const pnl = (exit_price - entry_price) * quantity;
        const pnl_pct = ((exit_price - entry_price) / entry_price) * 100;

        total_pnl += pnl;
        total_pnl_pct += pnl_pct * (quantity / initial_quantity);

        console.log(`  批次${index + 1}: ${quantity.toFixed(4)} BTC @ ${exit_price.toFixed(2)} = $${pnl.toFixed(2)} (+${pnl_pct.toFixed(2)}%)`);
      }
    });

    console.log(`\n总收益:`);
    console.log(`  盈亏金额: $${total_pnl.toFixed(2)}`);
    console.log(`  盈亏百分比: +${total_pnl_pct.toFixed(2)}%`);
    console.log(`  入场价: ${entry_price.toFixed(2)}`);
    console.log(`  加权平均出场价: ${(entry_price * (1 + total_pnl_pct / 100)).toFixed(2)}`);

    console.log(`\n📊 策略效果分析:`);
    console.log(`  - 第一批 (40%) 在 +8% 快速锁定利润`);
    console.log(`  - 第二批 (30%) 在 +14% 获得中期收益`);
    console.log(`  - 第三批 (30%) 通过跟踪止盈捕捉到大行情 (最高点)`);
    console.log(`  - 跟踪止盈在回调30%后触发，保留了大部分利润`);
    console.log(`\n💡 对比单一止盈:`);
    console.log(`  - 如果只在 +8% 全部止盈: $${(7280 * initial_quantity).toFixed(2)} (+8.00%)`);
    console.log(`  - 如果只在 +14% 全部止盈: $${(12740 * initial_quantity).toFixed(2)} (+14.00%)`);
    console.log(`  - 分批+跟踪策略实际收益: $${total_pnl.toFixed(2)} (+${total_pnl_pct.toFixed(2)}%)`);
    console.log(`\n⚠️ 逐仓风控:`);
    console.log(`  - 无止损线：价格可能跌至0，最大损失 = 开仓本金`);
    console.log(`  - 建议：仅用可承受全部损失的资金量开仓`);
    console.log(`  - 优势：不会因短期波动被止损扫出`);
  }

  trailing_manager.stop_tracking(position_id);
} else {
  console.log(`\n❌ 信号生成失败或无动态止盈配置`);
}

console.log('\n' + '='.repeat(80));
console.log('✅ 测试完成');
console.log('='.repeat(80) + '\n');
