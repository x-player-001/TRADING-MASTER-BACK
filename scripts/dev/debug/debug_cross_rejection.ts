/**
 * 调试CROSSUSDT为什么被拒绝 - 完全模拟回测引擎流程
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BacktestEngine } from '../../../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../../../src/types/trading_types';
import { ConfigManager } from '../../../src/core/config/config_manager';

async function debug_rejection() {
  console.log('🔍 调试CROSSUSDT被拒绝原因（完全模拟回测引擎）...\n');

  try {
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 使用与backtest_7days_score7_v2.ts完全相同的配置
    const end_date = new Date();
    const start_date = new Date(end_date.getTime() - 7 * 24 * 60 * 60 * 1000);

    const config: BacktestConfig = {
      start_date,
      end_date,
      initial_balance: 1000,

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
        max_position_size_percent: 5,
        max_total_positions: 10,
        max_positions_per_symbol: 1,           // ✨ 关键：单币种最多1个仓位
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
      commission_percent: 0.05,

      // ✨ 关键：只回测CROSSUSDT
      symbols: ['CROSSUSDT']
    };

    console.log('📊 回测配置（与backtest_7days_score7_v2.ts完全相同）:');
    console.log(`  时间范围: ${start_date.toISOString().split('T')[0]} ~ ${end_date.toISOString().split('T')[0]}`);
    console.log(`  初始资金: $${config.initial_balance}`);
    console.log(`  单币种最大仓位: ${config.risk_config.max_positions_per_symbol}`);
    console.log(`  信号评分阈值: ${config.strategy_config.min_signal_score}`);
    console.log(`  只回测: CROSSUSDT\n`);

    console.log('⏳ 执行回测...\n');

    const backtest_engine = new BacktestEngine();
    const result = await backtest_engine.run_backtest(config);

    console.log('═'.repeat(80));
    console.log('📈 CROSSUSDT回测结果\n');

    console.log(`总信号数: ${result.signals.length}`);
    console.log(`被拒绝信号数: ${result.rejected_signals.length}`);
    console.log(`成功交易数: ${result.statistics.total_trades}\n`);

    if (result.rejected_signals.length > 0) {
      console.log('❌ 被拒绝的信号详情:');
      console.log('═'.repeat(80));
      result.rejected_signals.forEach((rej, idx) => {
        const anomaly_time = rej.signal.anomaly_data?.anomaly_time;
        const time = anomaly_time ? new Date(anomaly_time).toISOString().substring(0, 19).replace('T', ' ') : 'N/A';
        console.log(`\n[${idx + 1}] 时间: ${time}`);
        console.log(`    评分: ${rej.signal.score.toFixed(2)}`);
        console.log(`    方向: ${rej.signal.direction}`);
        console.log(`    拒绝原因: ${rej.reason}`);
      });
    }

    if (result.statistics.total_trades > 0) {
      console.log('\n✅ 成功的交易详情:');
      console.log('═'.repeat(80));
      result.trades.forEach((trade, idx) => {
        console.log(`\n[${idx + 1}] ${new Date(trade.opened_at).toISOString()}`);
        console.log(`    开仓价: ${trade.entry_price.toFixed(4)}`);
        console.log(`    平仓价: ${trade.current_price.toFixed(4)}`);
        console.log(`    盈亏: $${(trade.realized_pnl || 0).toFixed(2)}`);
        console.log(`    原因: ${trade.close_reason || 'N/A'}`);
      });
    }

    console.log('\n═'.repeat(80));

    if (result.statistics.total_trades === 0 && result.rejected_signals.length > 0) {
      console.log('\n⚠️  所有CROSSUSDT信号都被拒绝！');
      console.log('   请查看上面的拒绝原因来诊断问题。\n');
    } else if (result.statistics.total_trades === 0 && result.signals.length === 0) {
      console.log('\n⚠️  没有找到任何CROSSUSDT信号！');
      console.log('   可能的原因:');
      console.log('   1. CROSSUSDT在黑名单中');
      console.log('   2. 价格极值字段缺失');
      console.log('   3. 时间范围内没有CROSSUSDT异动\n');
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ 调试失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('堆栈:', error.stack);
    }
    process.exit(1);
  }
}

debug_rejection();
