/**
 * 测试新评分规则
 */

import { SignalGenerator } from '../src/trading/signal_generator';
import { OIAnomalyRecord } from '../src/types/oi_types';

const signal_generator = new SignalGenerator();

// 测试用例1：早期启动信号（高分）
const test_case_1: OIAnomalyRecord = {
  symbol: 'BTCUSDT',
  period_seconds: 300,
  percent_change: 4.5,  // OI变化 4.5% (0-5区间，3分)
  oi_before: 1000000,
  oi_after: 1045000,
  oi_change: 45000,
  threshold_value: 3,
  anomaly_time: new Date(),
  severity: 'low',
  anomaly_type: 'oi',
  price_change_percent: 3.2,  // 价格变化 3.2% (0-5区间，3分)
  top_trader_long_short_ratio: 1.6,  // 大户多空比 1.6 (>1.5，1.5分)
  global_long_short_ratio: 1.1,  // 全市场比 1.1 (<1.2，1.2分)
  taker_buy_sell_ratio: 1.4,  // 主动买卖比 1.4 (>1.3，1分)
  funding_rate_after: -0.0001  // 资金费率为负（做多时有利，+1分）
};

// 测试用例2：中等强度信号
const test_case_2: OIAnomalyRecord = {
  symbol: 'ETHUSDT',
  period_seconds: 300,
  percent_change: 8,  // OI变化 8% (5-10区间，2.5分)
  oi_before: 500000,
  oi_after: 540000,
  oi_change: 40000,
  threshold_value: 3,
  anomaly_time: new Date(),
  severity: 'medium',
  anomaly_type: 'oi',
  price_change_percent: 6.5,  // 价格变化 6.5% (5-10区间，2.5分)
  top_trader_long_short_ratio: 1.3,  // 大户多空比 1.3 (1.0-1.5，1分)
  global_long_short_ratio: 1.3,  // 全市场比 1.3 (1.2-1.5，0.8分)
  taker_buy_sell_ratio: 1.2  // 主动买卖比 1.2 (1.1-1.3，0.75分)
};

// 测试用例3：晚期狂欢信号（低分）
const test_case_3: OIAnomalyRecord = {
  symbol: 'SOLUSDT',
  period_seconds: 300,
  percent_change: 25,  // OI变化 25% (>20，1分)
  oi_before: 200000,
  oi_after: 250000,
  oi_change: 50000,
  threshold_value: 3,
  anomaly_time: new Date(),
  severity: 'high',
  anomaly_type: 'oi',
  price_change_percent: 22,  // 价格变化 22% (>20，1分)
  top_trader_long_short_ratio: 1.2,  // 大户多空比 1.2 (1.0-1.5，1分)
  global_long_short_ratio: 1.8,  // 全市场比 1.8 (>1.5，0.3分)
  taker_buy_sell_ratio: 0.95  // 主动买卖比 0.95 (平衡，0.25分)
};

// 测试用例4：背离信号（OI涨价格跌）
const test_case_4: OIAnomalyRecord = {
  symbol: 'BNBUSDT',
  period_seconds: 300,
  percent_change: 5,  // OI变化 5% (0-5区间，3分)
  oi_before: 300000,
  oi_after: 315000,
  oi_change: 15000,
  threshold_value: 3,
  anomaly_time: new Date(),
  severity: 'low',
  anomaly_type: 'oi',
  price_change_percent: -2,  // 价格下跌 -2%（背离，不加同向分）
  top_trader_long_short_ratio: 1.4,
  global_long_short_ratio: 1.1,
  taker_buy_sell_ratio: 1.3
};

function test_scoring(test_case: OIAnomalyRecord, case_name: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`测试用例: ${case_name}`);
  console.log(`${'='.repeat(60)}`);

  const result = signal_generator.calculate_score_only(test_case);
  const signal = signal_generator.generate_signal(test_case);

  console.log(`\n📊 异动数据:`);
  console.log(`  币种: ${test_case.symbol}`);
  console.log(`  OI变化: ${test_case.percent_change.toFixed(2)}%`);
  console.log(`  价格变化: ${test_case.price_change_percent?.toFixed(2)}%`);
  console.log(`  大户多空比: ${test_case.top_trader_long_short_ratio?.toFixed(2)}`);
  console.log(`  全市场比: ${test_case.global_long_short_ratio?.toFixed(2)}`);
  console.log(`  主动买卖比: ${test_case.taker_buy_sell_ratio?.toFixed(2)}`);
  console.log(`  资金费率: ${test_case.funding_rate_after}`);

  console.log(`\n🎯 评分结果:`);
  console.log(`  总分: ${result.signal_score.toFixed(2)}/10`);
  console.log(`  方向: ${result.signal_direction}`);
  console.log(`  置信度: ${(result.signal_confidence * 100).toFixed(1)}%`);

  if (signal && signal.score_breakdown) {
    console.log(`\n✅ 信号生成成功:`);
    console.log(`  强度: ${signal.strength}`);
    console.log(`  入场价: ${signal.entry_price}`);
    console.log(`  止损: ${signal.stop_loss}`);
    console.log(`  止盈: ${signal.take_profit}`);
    console.log(`\n  评分明细:`);
    console.log(`    OI评分: ${signal.score_breakdown.oi_score.toFixed(2)}/3`);
    console.log(`    价格评分: ${signal.score_breakdown.price_score.toFixed(2)}/3`);
    console.log(`    情绪评分: ${signal.score_breakdown.sentiment_score.toFixed(2)}/2`);
    console.log(`    额外加分: ${signal.score_breakdown.funding_rate_score.toFixed(2)}/2`);
  } else {
    console.log(`\n❌ 信号未生成（方向为NEUTRAL或其他原因）`);
  }
}

// 运行测试
console.log('\n🚀 开始测试新评分规则\n');

test_scoring(test_case_1, '早期启动信号（高分预期）');
test_scoring(test_case_2, '中等强度信号');
test_scoring(test_case_3, '晚期狂欢信号（低分预期）');
test_scoring(test_case_4, '背离信号（无同向加分）');

console.log(`\n${'='.repeat(60)}`);
console.log('✅ 测试完成');
console.log(`${'='.repeat(60)}\n`);
