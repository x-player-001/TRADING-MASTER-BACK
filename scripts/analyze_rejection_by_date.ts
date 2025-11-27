/**
 * 分析回测引擎按日期的信号生成和拒绝原因
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BacktestEngine } from '../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../src/types/trading_types';
import { ConfigManager } from '../src/core/config/config_manager';

async function analyze_rejection() {
  console.log('🔍 分析回测信号处理情况...\n');

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 创建回测引擎
    const backtest_engine = new BacktestEngine();

    // 设置时间范围：最近7天
    const end_date = new Date();
    const start_date = new Date(end_date.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 回测配置
    const config: BacktestConfig = {
      start_date,
      end_date,
      initial_balance: 1000,

      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 5,
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
        leverage_by_signal_strength: {
          weak: 1,
          medium: 1,
          strong: 1
        }
      },

      max_holding_time_minutes: 12 * 60,
      use_slippage: true,
      slippage_percent: 0.1,
      commission_percent: 0.05
    };

    console.log('⏳ 运行回测...');
    const result = await backtest_engine.run_backtest(config);
    console.log('✅ 回测完成\n');

    // 按日期分组统计
    const stats_by_date = new Map<string, {
      total_signals: number;
      executed: number;
      rejected: number;
      rejection_reasons: Map<string, number>;
    }>();

    // 统计所有信号
    for (const signal of result.signals) {
      if (!signal.triggered_at) continue;
      const date = new Date(signal.triggered_at).toISOString().split('T')[0];
      if (!stats_by_date.has(date)) {
        stats_by_date.set(date, {
          total_signals: 0,
          executed: 0,
          rejected: 0,
          rejection_reasons: new Map()
        });
      }
      stats_by_date.get(date)!.total_signals++;
    }

    // 统计已执行交易
    for (const trade of result.trades) {
      const date = new Date(trade.opened_at).toISOString().split('T')[0];
      if (stats_by_date.has(date)) {
        stats_by_date.get(date)!.executed++;
      }
    }

    // 统计拒绝信号
    for (const rejection of result.rejected_signals) {
      if (!rejection.signal.triggered_at) continue;
      const date = new Date(rejection.signal.triggered_at).toISOString().split('T')[0];
      if (stats_by_date.has(date)) {
        const stat = stats_by_date.get(date)!;
        stat.rejected++;

        const reason = rejection.reason || 'Unknown';
        stat.rejection_reasons.set(
          reason,
          (stat.rejection_reasons.get(reason) || 0) + 1
        );
      }
    }

    // 输出统计结果
    console.log('═'.repeat(100));
    console.log('📊 每日信号处理统计');
    console.log('═'.repeat(100));
    console.log('');
    console.log('日期'.padEnd(15) + '总信号'.padEnd(12) + '已执行'.padEnd(12) + '已拒绝'.padEnd(12) + '执行率');
    console.log('─'.repeat(65));

    const sorted_dates = Array.from(stats_by_date.keys()).sort();
    for (const date of sorted_dates) {
      const stat = stats_by_date.get(date)!;
      const exec_rate = stat.total_signals > 0
        ? ((stat.executed / stat.total_signals) * 100).toFixed(1) + '%'
        : '0.0%';

      console.log(
        date.padEnd(15) +
        stat.total_signals.toString().padEnd(12) +
        stat.executed.toString().padEnd(12) +
        stat.rejected.toString().padEnd(12) +
        exec_rate
      );

      // 显示拒绝原因（如果有）
      if (stat.rejection_reasons.size > 0) {
        console.log('  拒绝原因:');
        const sorted_reasons = Array.from(stat.rejection_reasons.entries())
          .sort((a, b) => b[1] - a[1]);

        for (const [reason, count] of sorted_reasons) {
          const pct = ((count / stat.rejected) * 100).toFixed(1);
          console.log(`    - ${reason}: ${count} (${pct}%)`);
        }
      }
      console.log('');
    }

    console.log('─'.repeat(65));
    console.log(`\n总计: ${result.signals.length} 个信号, ${result.trades.length} 笔交易, ${result.rejected_signals.length} 个拒绝`);
    console.log('═'.repeat(100));

    // 特别检查11月21日后的情况
    const nov21_after_signals = result.signals.filter(s =>
      s.triggered_at && new Date(s.triggered_at) >= new Date('2025-11-21T00:00:00Z')
    );

    const nov21_after_executed = result.trades.filter(t =>
      new Date(t.opened_at) >= new Date('2025-11-21T00:00:00Z')
    );

    const nov21_after_rejected = result.rejected_signals.filter(r =>
      r.signal.triggered_at && new Date(r.signal.triggered_at) >= new Date('2025-11-21T00:00:00Z')
    );

    console.log('\n⚠️  11月21日后的数据:');
    console.log(`  信号数: ${nov21_after_signals.length}`);
    console.log(`  执行数: ${nov21_after_executed.length}`);
    console.log(`  拒绝数: ${nov21_after_rejected.length}`);

    if (nov21_after_rejected.length > 0) {
      console.log('\n  主要拒绝原因:');
      const reason_counts = new Map<string, number>();
      for (const rejection of nov21_after_rejected) {
        const reason = rejection.reason || 'Unknown';
        reason_counts.set(reason, (reason_counts.get(reason) || 0) + 1);
      }

      const sorted = Array.from(reason_counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      for (const [reason, count] of sorted) {
        const pct = ((count / nov21_after_rejected.length) * 100).toFixed(1);
        console.log(`    - ${reason}: ${count} (${pct}%)`);
      }
    }

    console.log('\n');
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

analyze_rejection();
