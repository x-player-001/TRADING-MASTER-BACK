/**
 * 7天回测脚本 - 逐仓模式
 *
 * 配置:
 * - 初始资金: $1000
 * - 回测周期: 最近7天
 * - 信号过滤: 评分 ≥ 7分
 * - 开仓金额: 固定 $50/笔
 * - 超时平仓: 12小时
 * - 止盈策略: 40%@+8%, 30%@+14%, 30%跟踪止盈
 * - 止损策略: 无（逐仓模式）
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
  console.log('🚀 开始7天回测测试 (逐仓模式 - 评分≥7分)\n');
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
    console.log(`  初始资金: $1,000`);
    console.log(`  开仓金额: $50 (固定)`);
    console.log(`  信号过滤: 评分 ≥ 7分 (高标准)`);
    console.log(`  超时平仓: 12小时`);
    console.log(`  止盈策略: 40%@+8%, 30%@+14%, 30%跟踪止盈`);
    console.log(`  止损策略: 无 (逐仓模式)`);
    console.log('═'.repeat(80));

    // 回测配置
    const config: BacktestConfig = {
      // 时间范围
      start_date,
      end_date,

      // 初始资金
      initial_balance: 1000,

      // 策略配置
      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 7,                    // 评分 ≥ 7分 (高标准)
        min_confidence: 0.5,                    // 置信度 ≥ 50%
        min_oi_change_percent: 3,               // OI变化 ≥ 3%
        require_price_oi_alignment: true,       // 必须价格OI同向
        price_oi_divergence_threshold: 5,
        use_sentiment_filter: false,            // 不使用情绪过滤（放宽条件）
        min_trader_ratio: 0.8,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      },

      // 风险配置 - 逐仓模式
      risk_config: {
        max_position_size_percent: 5,           // 单笔5% ($50 / $1000)
        max_total_positions: 10,                // 最多10个仓位
        max_positions_per_symbol: 2,            // 单币种最多2个仓位
        default_stop_loss_percent: 100,         // 止损100% (逐仓模式，实际不使用)
        default_take_profit_percent: 8,         // 第一批止盈8%
        use_trailing_stop: true,                // 启用跟踪止盈
        trailing_stop_callback_rate: 30,        // 回调30%触发
        daily_loss_limit_percent: 100,          // 不限制每日亏损
        consecutive_loss_limit: 999,            // 不限制连续亏损
        pause_after_loss_limit: false,
        max_leverage: 1,                        // 1倍杠杆（逐仓）
        leverage_by_signal_strength: {
          weak: 1,
          medium: 1,
          strong: 1
        }
      },

      // 持仓时间限制 - 12小时
      max_holding_time_minutes: 12 * 60,       // 720分钟 = 12小时

      // 滑点和手续费
      use_slippage: true,
      slippage_percent: 0.1,                   // 0.1% 滑点
      commission_percent: 0.05                 // 0.05% 手续费
    };

    console.log('\n⏳ 正在执行回测...');
    const backtest_result = await backtest_engine.run_backtest(config);
    console.log('✅ 回测完成\n');

    // 显示统计结果
    console.log('═'.repeat(80));
    console.log('📈 回测结果统计');
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

    // 保存结果到JSON文件
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const results_dir = path.join(__dirname, '../backtest_results');

    // 确保目录存在
    if (!fs.existsSync(results_dir)) {
      fs.mkdirSync(results_dir, { recursive: true });
    }

    // 准备详细交易记录
    const trade_details = backtest_result.trades.map(trade => ({
      symbol: trade.symbol,
      side: trade.side,
      entry_price: trade.entry_price,
      current_price: trade.current_price,
      quantity: trade.quantity,
      leverage: trade.leverage,
      unrealized_pnl: trade.unrealized_pnl,
      unrealized_pnl_percent: trade.unrealized_pnl_percent,
      realized_pnl: trade.realized_pnl || 0,
      stop_loss_price: trade.stop_loss_price,
      take_profit_price: trade.take_profit_price,
      is_open: trade.is_open,
      opened_at: trade.opened_at,
      closed_at: trade.closed_at,
      close_reason: trade.close_reason,
      signal_score: trade.signal_id
    }));

    // 按日期分组统计交易
    const trades_by_date = new Map<string, number>();
    trade_details.forEach(trade => {
      const date = trade.opened_at.toString().split('T')[0];
      trades_by_date.set(date, (trades_by_date.get(date) || 0) + 1);
    });

    console.log(`\n📅 交易分布按日期:`);
    Array.from(trades_by_date.keys()).sort().forEach(date => {
      console.log(`  ${date}: ${trades_by_date.get(date)} 笔交易`);
    });

    // 保存完整结果
    const full_result = {
      config: {
        start_date: config.start_date.toISOString(),
        end_date: config.end_date.toISOString(),
        initial_balance: config.initial_balance,
        min_signal_score: config.strategy_config.min_signal_score,
        position_size: 50,
        max_holding_hours: 12
      },
      statistics: {
        initial_balance: config.initial_balance,
        final_balance: config.initial_balance + stats.total_pnl,
        total_pnl: stats.total_pnl,
        total_pnl_percent: (stats.total_pnl / config.initial_balance) * 100,
        total_trades: stats.total_trades,
        winning_trades: stats.winning_trades,
        losing_trades: stats.losing_trades,
        win_rate: stats.win_rate,
        average_win: stats.average_win,
        average_loss: stats.average_loss,
        profit_factor: stats.profit_factor,
        max_drawdown_percent: stats.max_drawdown_percent,
        average_hold_time_minutes: stats.average_hold_time,
        longest_winning_streak: stats.longest_winning_streak,
        longest_losing_streak: stats.longest_losing_streak
      },
      trade_details,
      trades_by_date: Array.from(trades_by_date.entries()).map(([date, count]) => ({
        date,
        count
      })),
      equity_curve: backtest_result.equity_curve.map(point => ({
        timestamp: point.timestamp.toISOString(),
        equity: point.equity,
        drawdown_percent: point.drawdown_percent
      })),
      signals: {
        total_signals: backtest_result.signals.length,
        rejected_signals: backtest_result.rejected_signals.length,
        executed_trades: stats.total_trades
      }
    };

    const json_file = path.join(results_dir, `backtest_7days_score7_${timestamp}.json`);
    fs.writeFileSync(json_file, JSON.stringify(full_result, null, 2));
    console.log(`\n💾 交易明细已保存: ${json_file}`);

    // 保存简化版文本摘要
    const summary_file = path.join(results_dir, `backtest_7days_score7_${timestamp}.txt`);
    const summary_text = `
7天回测结果摘要 (评分≥7分)
═══════════════════════════════════════════════════════════════════════════════

📊 基本信息
时间范围: ${config.start_date.toISOString().split('T')[0]} ~ ${config.end_date.toISOString().split('T')[0]}
初始资金: $${config.initial_balance.toFixed(2)}
开仓金额: $50 (固定)
信号过滤: 评分 ≥ 7分 (高标准)
超时平仓: 12小时

💰 资金情况
初始资金: $${config.initial_balance.toFixed(2)}
最终资金: $${(config.initial_balance + stats.total_pnl).toFixed(2)}
总盈亏: ${stats.total_pnl >= 0 ? '+' : ''}$${stats.total_pnl.toFixed(2)} (${stats.total_pnl >= 0 ? '+' : ''}${((stats.total_pnl / config.initial_balance) * 100).toFixed(2)}%)

📈 交易统计
总交易次数: ${stats.total_trades}
盈利次数: ${stats.winning_trades} (${(stats.win_rate * 100).toFixed(2)}%)
亏损次数: ${stats.losing_trades} (${((1 - stats.win_rate) * 100).toFixed(2)}%)
胜率: ${(stats.win_rate * 100).toFixed(2)}%

💹 盈亏分析
平均盈利: +$${stats.average_win.toFixed(2)}
平均亏损: -$${Math.abs(stats.average_loss).toFixed(2)}
盈亏比: ${stats.profit_factor.toFixed(2)}
最大回撤: ${stats.max_drawdown_percent.toFixed(2)}%

⏱️ 时间分析
平均持仓时间: ${stats.average_hold_time.toFixed(0)} 分钟
最长连胜: ${stats.longest_winning_streak} 次
最长连亏: ${stats.longest_losing_streak} 次

📅 交易分布
${Array.from(trades_by_date.keys()).sort().map(date =>
  `${date}: ${trades_by_date.get(date)} 笔`
).join('\n')}

═══════════════════════════════════════════════════════════════════════════════
`;
    fs.writeFileSync(summary_file, summary_text);
    console.log(`📄 摘要已保存: ${summary_file}`);

    console.log('\n═'.repeat(80));
    console.log('✅ 回测完成！');
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

// 运行回测
run_backtest()
  .then(() => {
    console.log('\n🎉 程序执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 程序异常退出:', error);
    process.exit(1);
  });
