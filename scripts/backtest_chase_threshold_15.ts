/**
 * $50小资金配置回测脚本 - 追高阈值15%
 *
 * 配置说明:
 * - 初始资金: $50
 * - 追高阈值: 15% (price_from_low_pct > 15% 拒绝)
 * - 评分阈值: ≥8分
 * - 其他配置与标准配置相同
 */

// 加载环境变量
import dotenv from 'dotenv';
const result = dotenv.config({ override: true });
if (result.error) {
  console.error('❌ 加载.env文件失败:', result.error);
  process.exit(1);
}

import { BacktestEngine } from '../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../src/types/trading_types';
import { ConfigManager } from '../src/core/config/config_manager';
import * as fs from 'fs';
import * as path from 'path';

async function run_backtest() {
  console.log('🚀 启动 $50 小资金配置回测 - 追高阈值15%\n');
  console.log('═'.repeat(80));

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();
    console.log('✅ 配置管理器初始化完成');

    // 创建回测引擎
    const backtest_engine = new BacktestEngine();

    // 计算7天前的日期
    const end_date = new Date();
    const start_date = new Date(end_date.getTime() - 7 * 24 * 60 * 60 * 1000);

    console.log('\n📊 回测参数:');
    console.log('═'.repeat(80));
    console.log(`  时间范围: ${start_date.toISOString().split('T')[0]} ~ ${end_date.toISOString().split('T')[0]}`);
    console.log(`  初始资金: $50`);
    console.log(`  追高阈值: 15% ⚠️`);
    console.log(`  单笔保证金: $5 (10%)`);
    console.log(`  杠杆倍数: 6倍`);
    console.log(`  最多持仓: 5个`);
    console.log(`  信号过滤: 评分 ≥ 8分`);
    console.log(`  超时平仓: 120分钟`);
    console.log(`  交易方向: 只做多`);
    console.log('═'.repeat(80));

    // 回测配置
    const config: BacktestConfig = {
      start_date,
      end_date,
      initial_balance: 50,

      // 追高阈值设置为15%
      chase_high_threshold: 15,

      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 8,
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
        consecutive_loss_limit: 999,
        pause_after_loss_limit: false,
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

      max_holding_time_minutes: 120,
      use_slippage: true,
      slippage_percent: 0.1,
      commission_percent: 0.05,
      allowed_directions: ['LONG']
    };

    console.log('\n⏳ 正在执行回测...');
    const backtest_result = await backtest_engine.run_backtest(config);
    console.log('✅ 回测完成\n');

    // 显示统计结果
    console.log('═'.repeat(80));
    console.log('📈 回测结果统计 - 追高阈值15%');
    console.log('═'.repeat(80));

    const stats = backtest_result.statistics;
    console.log(`\n💰 资金情况:`);
    console.log(`  初始资金: $${config.initial_balance.toFixed(2)}`);
    console.log(`  最终资金: $${(config.initial_balance + stats.total_pnl).toFixed(2)}`);
    console.log(`  总盈亏: ${stats.total_pnl >= 0 ? '+' : ''}$${stats.total_pnl.toFixed(2)} (${stats.total_pnl >= 0 ? '+' : ''}${((stats.total_pnl / config.initial_balance) * 100).toFixed(2)}%)`);

    console.log(`\n📊 交易统计:`);
    console.log(`  总交易次数: ${stats.total_trades}`);
    console.log(`  盈利次数: ${stats.winning_trades} (${(stats.win_rate * 100).toFixed(2)}%)`);
    console.log(`  亏损次数: ${stats.losing_trades} (${((1 - stats.win_rate) * 100).toFixed(2)}%)`);
    console.log(`  胜率: ${(stats.win_rate * 100).toFixed(2)}%`);

    console.log(`\n💹 盈亏分析:`);
    console.log(`  平均盈利: +$${stats.average_win.toFixed(2)}`);
    console.log(`  平均亏损: -$${Math.abs(stats.average_loss).toFixed(2)}`);
    console.log(`  盈亏比: ${stats.profit_factor.toFixed(2)}`);
    console.log(`  最大回撤: ${stats.max_drawdown_percent.toFixed(2)}%`);

    console.log(`\n⏱️ 时间分析:`);
    console.log(`  平均持仓时间: ${stats.average_hold_time.toFixed(0)} 分钟`);
    console.log(`  最长连胜: ${stats.longest_winning_streak} 次`);
    console.log(`  最长连亏: ${stats.longest_losing_streak} 次`);

    console.log(`\n📋 信号统计:`);
    console.log(`  总信号数: ${backtest_result.signals.length}`);
    console.log(`  被拒绝信号: ${backtest_result.rejected_signals.length}`);
    console.log(`  实际交易信号: ${stats.total_trades}`);

    // 保存结果
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const results_dir = path.join(__dirname, '../backtest_results');

    if (!fs.existsSync(results_dir)) {
      fs.mkdirSync(results_dir, { recursive: true });
    }

    const json_file = path.join(results_dir, `backtest_threshold_15_${timestamp}.json`);
    fs.writeFileSync(json_file, JSON.stringify({
      config: {
        ...config,
        chase_high_threshold: 15
      },
      statistics: stats,
      timestamp: new Date().toISOString()
    }, null, 2));

    console.log(`\n💾 结果已保存: ${json_file}`);
    console.log('═'.repeat(80));

  } catch (error) {
    console.error('\n❌ 回测失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('堆栈:', error.stack);
    }
    process.exit(1);
  }
}

run_backtest()
  .then(() => {
    console.log('\n🎉 程序执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 程序异常退出:', error);
    process.exit(1);
  });
