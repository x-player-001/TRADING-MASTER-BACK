/**
 * 分析 $50 配置回测中的信号拒绝原因
 *
 * 目的：理解为什么579个信号只产生9笔交易
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BacktestEngine } from '../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../src/types/trading_types';
import { ConfigManager } from '../src/core/config/config_manager';

async function analyze_rejections() {
  console.log('🔍 分析 $50 配置的信号拒绝原因\n');
  console.log('═'.repeat(80));

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 创建回测引擎
    const backtest_engine = new BacktestEngine();

    // 计算7天前的日期
    const end_date = new Date();
    const start_date = new Date(end_date.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 回测配置（与backtest_50usd_config.ts完全一致）
    const config: BacktestConfig = {
      start_date,
      end_date,
      initial_balance: 50,

      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 7,
        min_confidence: 0.5,
        min_oi_change_percent: 3,
        require_price_oi_alignment: true,
        price_oi_divergence_threshold: 5,
        use_sentiment_filter: false,
        min_trader_ratio: 0.8,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      },

      risk_config: {
        max_position_size_percent: 10,
        max_total_positions: 5,
        max_positions_per_symbol: 1,
        default_stop_loss_percent: 100,
        default_take_profit_percent: 8,
        use_trailing_stop: true,
        trailing_stop_callback_rate: 15,
        daily_loss_limit_percent: 20,
        consecutive_loss_limit: 3,
        pause_after_loss_limit: true,
        max_leverage: 6,
        leverage_by_signal_strength: {
          weak: 6,
          medium: 6,
          strong: 6
        }
      },

      dynamic_take_profit: {
        targets: [
          {
            percentage: 30,
            price: 0,
            target_profit_pct: 8,
            is_trailing: false
          },
          {
            percentage: 30,
            price: 0,
            target_profit_pct: 12,
            is_trailing: false
          },
          {
            percentage: 40,
            price: 0,
            target_profit_pct: 0,
            is_trailing: true,
            trailing_callback_pct: 15
          }
        ],
        enable_trailing: true,
        trailing_start_profit_pct: 8
      },

      max_holding_time_minutes: 180,
      use_slippage: true,
      slippage_percent: 0.1,
      commission_percent: 0.05,
      allowed_directions: ['LONG']
    };

    console.log('⏳ 执行回测以收集拒绝数据...\n');
    const result = await backtest_engine.run_backtest(config);

    console.log('✅ 回测完成\n');
    console.log('═'.repeat(80));
    console.log('📊 拒绝原因分析\n');

    // 统计拒绝原因
    const rejection_reasons = new Map<string, number>();
    const rejection_details = new Map<string, Array<{symbol: string, score: number, time: string}>>();

    for (const rejected of result.rejected_signals) {
      const reason = rejected.reason || 'Unknown';
      rejection_reasons.set(reason, (rejection_reasons.get(reason) || 0) + 1);

      if (!rejection_details.has(reason)) {
        rejection_details.set(reason, []);
      }

      rejection_details.get(reason)!.push({
        symbol: rejected.signal.symbol,
        score: rejected.signal.score || 0,
        time: rejected.signal.triggered_at?.toISOString() || 'N/A'
      });
    }

    console.log('📋 拒绝原因统计:\n');

    // 按数量排序
    const sorted_reasons = Array.from(rejection_reasons.entries())
      .sort((a, b) => b[1] - a[1]);

    for (const [reason, count] of sorted_reasons) {
      const percentage = (count / result.rejected_signals.length * 100).toFixed(2);
      console.log(`  ${reason}`);
      console.log(`    数量: ${count} (${percentage}%)`);

      // 显示前3个示例
      const examples = rejection_details.get(reason)!.slice(0, 3);
      console.log(`    示例:`);
      for (const ex of examples) {
        console.log(`      - ${ex.symbol} (评分:${ex.score.toFixed(2)}) ${ex.time.split('T')[1].slice(0, 8)}`);
      }
      console.log('');
    }

    console.log('═'.repeat(80));
    console.log('📈 执行情况概览:\n');
    console.log(`  总信号数: ${result.signals.length}`);
    console.log(`  被拒绝: ${result.rejected_signals.length} (${(result.rejected_signals.length / result.signals.length * 100).toFixed(2)}%)`);
    console.log(`  执行交易: ${result.trades.length} (${(result.trades.length / result.signals.length * 100).toFixed(2)}%)`);
    console.log(`  胜率: ${(result.statistics.win_rate * 100).toFixed(2)}%`);
    console.log(`  总盈亏: ${result.statistics.total_pnl >= 0 ? '+' : ''}$${result.statistics.total_pnl.toFixed(2)}`);
    console.log('═'.repeat(80));

    // 分析拒绝的时间分布
    console.log('\n⏰ 拒绝信号的时间分布:\n');
    const rejections_by_hour = new Map<number, number>();

    for (const rejected of result.rejected_signals) {
      const hour = rejected.signal.triggered_at ? rejected.signal.triggered_at.getHours() : 0;
      rejections_by_hour.set(hour, (rejections_by_hour.get(hour) || 0) + 1);
    }

    const sorted_hours = Array.from(rejections_by_hour.entries()).sort((a, b) => a[0] - b[0]);
    for (const [hour, count] of sorted_hours) {
      const bar = '█'.repeat(Math.floor(count / 10));
      console.log(`  ${hour.toString().padStart(2, '0')}:00 - ${count.toString().padStart(3)} ${bar}`);
    }

    // 分析拒绝信号的评分分布
    console.log('\n📊 被拒绝信号的评分分布:\n');
    const score_buckets = new Map<string, number>();

    for (const rejected of result.rejected_signals) {
      const score = rejected.signal.score || 0;
      const bucket = Math.floor(score);
      const key = `${bucket}-${bucket + 1}`;
      score_buckets.set(key, (score_buckets.get(key) || 0) + 1);
    }

    const sorted_buckets = Array.from(score_buckets.entries())
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

    for (const [bucket, count] of sorted_buckets) {
      const bar = '█'.repeat(Math.floor(count / 20));
      console.log(`  评分 ${bucket}: ${count.toString().padStart(3)} ${bar}`);
    }

    console.log('\n✅ 分析完成');

  } catch (error) {
    console.error('\n❌ 分析失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('堆栈:', error.stack);
    }
    process.exit(1);
  }
}

analyze_rejections()
  .then(() => {
    console.log('\n🎉 程序执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 程序异常退出:', error);
    process.exit(1);
  });
