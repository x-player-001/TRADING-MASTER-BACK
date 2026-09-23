/**
 * 分析信号评分分布
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BacktestEngine } from '../../../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../../../src/types/trading_types';
import { ConfigManager } from '../../../src/core/config/config_manager';

async function analyze_distribution() {
  console.log('🔍 分析信号评分分布...\n');

  try {
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    const backtest_engine = new BacktestEngine();
    const end_date = new Date();
    const start_date = new Date(end_date.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 使用最低门槛运行回测,获取所有信号
    const config: BacktestConfig = {
      start_date,
      end_date,
      initial_balance: 1000,
      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 0,  // 最低门槛,获取所有信号
        min_confidence: 0,
        min_oi_change_percent: 3,
        require_price_oi_alignment: true,
        price_oi_divergence_threshold: 5,
        use_sentiment_filter: false,
        min_trader_ratio: 0.8,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      },
      risk_config: {
        max_position_size_percent: 5,
        max_total_positions: 10,
        max_positions_per_symbol: 2,
        default_stop_loss_percent: 100,
        default_take_profit_percent: 8,
        use_trailing_stop: true,
        trailing_stop_callback_rate: 30,
        daily_loss_limit_percent: 100,
        consecutive_loss_limit: 999,
        pause_after_loss_limit: false,
        max_leverage: 1,
        leverage_by_signal_strength: { weak: 1, medium: 1, strong: 1 }
      },
      max_holding_time_minutes: 12 * 60,
      use_slippage: true,
      slippage_percent: 0.1,
      commission_percent: 0.05
    };

    console.log('⏳ 运行回测获取所有信号...');
    const result = await backtest_engine.run_backtest(config);
    console.log('✅ 回测完成\n');

    // 统计信号评分分布
    const score_distribution = new Map<number, number>();
    const score_ranges = new Map<string, number>();

    for (const signal of result.signals) {
      const score = Math.floor(signal.score);
      score_distribution.set(score, (score_distribution.get(score) || 0) + 1);

      // 按区间统计
      let range = '';
      if (score >= 9) range = '9-10分 (优秀)';
      else if (score >= 8) range = '8-9分 (很好)';
      else if (score >= 7) range = '7-8分 (良好)';
      else if (score >= 6) range = '6-7分 (中等)';
      else if (score >= 5) range = '5-6分 (及格)';
      else range = '0-5分 (较差)';

      score_ranges.set(range, (score_ranges.get(range) || 0) + 1);
    }

    console.log('═'.repeat(80));
    console.log('📊 信号评分详细分布');
    console.log('═'.repeat(80));
    console.log('');
    console.log('评分'.padEnd(10) + '数量'.padEnd(15) + '占比'.padEnd(15) + '条形图');
    console.log('─'.repeat(80));

    const sorted_scores = Array.from(score_distribution.keys()).sort((a, b) => a - b);
    const total = result.signals.length;

    for (const score of sorted_scores) {
      const count = score_distribution.get(score)!;
      const percent = ((count / total) * 100).toFixed(2);
      const bar_length = Math.floor((count / total) * 50);
      const bar = '█'.repeat(bar_length);

      console.log(
        `${score}分`.padEnd(10) +
        `${count}`.padEnd(15) +
        `${percent}%`.padEnd(15) +
        bar
      );
    }

    console.log('─'.repeat(80));
    console.log(`总信号数: ${total}\n`);

    console.log('═'.repeat(80));
    console.log('📊 信号评分区间分布');
    console.log('═'.repeat(80));
    console.log('');
    console.log('区间'.padEnd(20) + '数量'.padEnd(15) + '占比'.padEnd(15) + '累计占比');
    console.log('─'.repeat(80));

    const range_order = [
      '9-10分 (优秀)',
      '8-9分 (很好)',
      '7-8分 (良好)',
      '6-7分 (中等)',
      '5-6分 (及格)',
      '0-5分 (较差)'
    ];

    let cumulative = 0;
    for (const range of range_order) {
      const count = score_ranges.get(range) || 0;
      const percent = ((count / total) * 100).toFixed(2);
      cumulative += count;
      const cumulative_percent = ((cumulative / total) * 100).toFixed(2);

      console.log(
        range.padEnd(20) +
        `${count}`.padEnd(15) +
        `${percent}%`.padEnd(15) +
        `${cumulative_percent}%`
      );
    }

    console.log('─'.repeat(80));
    console.log('');

    // 统计各阈值下的信号数量
    console.log('═'.repeat(80));
    console.log('📊 不同评分阈值下的信号数量');
    console.log('═'.repeat(80));
    console.log('');
    console.log('阈值'.padEnd(15) + '信号数量'.padEnd(15) + '占比'.padEnd(15) + '减少数量');
    console.log('─'.repeat(80));

    const thresholds = [0, 4, 5, 6, 7, 8, 9, 10];
    let prev_count = total;

    for (const threshold of thresholds) {
      const count = result.signals.filter(s => s.score >= threshold).length;
      const percent = ((count / total) * 100).toFixed(2);
      const reduction = prev_count - count;
      const reduction_str = reduction > 0 ? `-${reduction}` : '-';

      console.log(
        `>=${threshold}分`.padEnd(15) +
        `${count}`.padEnd(15) +
        `${percent}%`.padEnd(15) +
        reduction_str
      );

      prev_count = count;
    }

    console.log('─'.repeat(80));
    console.log('');

    console.log('═'.repeat(80));
    console.log('💡 关键发现');
    console.log('═'.repeat(80));

    const score5_count = result.signals.filter(s => s.score >= 5).length;
    const score6_count = result.signals.filter(s => s.score >= 6).length;
    const score7_count = result.signals.filter(s => s.score >= 7).length;
    const score8_count = result.signals.filter(s => s.score >= 8).length;

    const reduce_5to6 = score5_count - score6_count;
    const reduce_6to7 = score6_count - score7_count;
    const reduce_7to8 = score7_count - score8_count;

    console.log(`\n从5分提高到6分: 减少 ${reduce_5to6} 个信号 (减少${((reduce_5to6 / score5_count) * 100).toFixed(2)}%)`);
    console.log(`从6分提高到7分: 减少 ${reduce_6to7} 个信号 (减少${((reduce_6to7 / score6_count) * 100).toFixed(2)}%)`);
    console.log(`从7分提高到8分: 减少 ${reduce_7to8} 个信号 (减少${((reduce_7to8 / score7_count) * 100).toFixed(2)}%)`);

    const high_score_percent = ((score7_count / total) * 100).toFixed(2);
    console.log(`\n⚠️  ${high_score_percent}% 的信号评分 >= 7分,说明评分系统可能过于宽松!\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ 分析失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('堆栈:', error.stack);
    }
    process.exit(1);
  }
}

analyze_distribution();
