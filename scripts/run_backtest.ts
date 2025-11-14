/**
 * 回测测试脚本
 * 运行命令: npx ts-node scripts/run_backtest.ts
 */

// 加载环境变量 (override=true 强制覆盖系统环境变量)
import dotenv from 'dotenv';
const result = dotenv.config({ override: true });
if (result.error) {
  console.error('加载.env文件失败:', result.error);
  process.exit(1);
}
console.log('✅ 环境变量加载成功');
console.log('📡 MySQL配置:', process.env.MYSQL_HOST, process.env.MYSQL_USER);

import { BacktestEngine } from '../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../src/types/trading_types';
import { logger } from '../src/utils/logger';
import { ConfigManager } from '../src/core/config/config_manager';
import * as fs from 'fs';
import * as path from 'path';

async function run_backtest_test() {
  console.log('🚀 开始回测测试...\n');

  try {
    // 初始化配置管理器
    console.log('🔧 初始化配置管理器...');
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 调试：打印数据库配置
    const db_config = config_manager.get_database_config();
    console.log('数据库配置:', {
      host: db_config.mysql.host,
      port: db_config.mysql.port,
      user: db_config.mysql.user,
      database: db_config.mysql.database
    });

    console.log('✅ 配置管理器初始化完成\n');
    // 创建回测引擎
    const backtest_engine = new BacktestEngine();

    // 配置回测参数 - 小市值币快进快出策略
    const config: BacktestConfig = {
      // 回测时间范围（最近7天）
      start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      end_date: new Date(),

      // 初始资金
      initial_balance: 10000,

      // 策略配置 - 早期启动信号捕捉
      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,        // 突破策略
        enabled: true,
        min_signal_score: 7,                          // 6 → 7 (只做高质量信号)
        min_confidence: 0.7,                          // 0.6 → 0.7 (提高置信度)
        min_oi_change_percent: 3,                     // 最小3%（基础条件）
        require_price_oi_alignment: true,             // 必须价格配合
        price_oi_divergence_threshold: 3,             // 2 → 3 (允许适度背离)
        use_sentiment_filter: true,                   // 使用情绪过滤
        min_trader_ratio: 1.2,                        // 0.8 → 1.2 (大户必须做多)
        max_funding_rate: 0.01,                       // 0.001 → 0.01 (资金费率<1%避免过热)
        min_funding_rate: -0.01
      },

      // 风险配置 - 高盈亏比策略（5:1）
      risk_config: {
        max_position_size_percent: 5,                 // 单笔5%
        max_total_positions: 3,                       // 最多3个仓位
        max_positions_per_symbol: 1,
        default_stop_loss_percent: 4,                 // 止损4%
        default_take_profit_percent: 20,              // 8% → 20% (5:1盈亏比)
        use_trailing_stop: true,                      // 启用移动止损
        trailing_stop_callback_rate: 3,               // 2.5 → 3 (更激进保护利润)
        daily_loss_limit_percent: 100,                // 不限制
        consecutive_loss_limit: 999,                  // 不限制
        pause_after_loss_limit: false,
        max_leverage: 3,
        leverage_by_signal_strength: {
          weak: 1,
          medium: 2,
          strong: 3
        }
      },

      // 持仓时间限制 - 快进快出
      max_holding_time_minutes: 30,                   // 60 → 30 (抓启动阶段)

      // 滑点和手续费
      use_slippage: true,
      slippage_percent: 0.1,
      commission_percent: 0.05
    };

    console.log('📋 回测配置:');
    console.log(`  时间范围: ${config.start_date.toISOString()} - ${config.end_date.toISOString()}`);
    console.log(`  初始资金: $${config.initial_balance}`);
    console.log(`  策略类型: ${config.strategy_config.strategy_type}`);
    console.log(`  最小信号分数: ${config.strategy_config.min_signal_score}`);
    console.log(`  最大仓位比例: ${config.risk_config.max_position_size_percent}%`);
    console.log(`  最大杠杆: ${config.risk_config.max_leverage}x`);
    console.log(`  止损: ${config.risk_config.default_stop_loss_percent}% | 止盈: ${config.risk_config.default_take_profit_percent}%`);
    console.log(`  理论盈亏比: ${(config.risk_config.default_take_profit_percent / config.risk_config.default_stop_loss_percent).toFixed(2)}:1`);
    console.log(`  滑点: ${config.slippage_percent}% | 手续费: ${config.commission_percent}%\n`);

    // 运行回测
    console.log('⏳ 正在运行回测...\n');
    const start_time = Date.now();

    const result = await backtest_engine.run_backtest(config);

    const execution_time = Date.now() - start_time;

    // 输出结果
    console.log('✅ 回测完成!\n');
    console.log('=' .repeat(60));
    console.log('📊 回测统计结果');
    console.log('=' .repeat(60));

    const stats = result.statistics;

    console.log('\n📈 交易概况:');
    console.log(`  总交易次数: ${stats.total_trades}`);
    console.log(`  盈利交易: ${stats.winning_trades} (${((stats.winning_trades / stats.total_trades) * 100).toFixed(2)}%)`);
    console.log(`  亏损交易: ${stats.losing_trades} (${((stats.losing_trades / stats.total_trades) * 100).toFixed(2)}%)`);
    console.log(`  胜率: ${stats.win_rate.toFixed(2)}%`);

    console.log('\n💰 盈亏分析:');
    console.log(`  总盈亏: $${stats.total_pnl.toFixed(2)}`);
    console.log(`  平均盈利: $${stats.average_win.toFixed(2)}`);
    console.log(`  平均亏损: $${stats.average_loss.toFixed(2)}`);
    console.log(`  盈亏比: ${stats.profit_factor.toFixed(2)}`);

    console.log('\n⚠️  风险指标:');
    console.log(`  最大回撤: $${stats.max_drawdown.toFixed(2)} (${stats.max_drawdown_percent.toFixed(2)}%)`);
    console.log(`  平均持仓时间: ${stats.average_hold_time.toFixed(2)} 分钟`);

    console.log('\n🎯 信号统计:');
    console.log(`  生成信号数: ${result.signals.length}`);
    console.log(`  拒绝信号数: ${result.rejected_signals.length}`);
    console.log(`  信号转化率: ${((result.trades.length / result.signals.length) * 100).toFixed(2)}%`);

    console.log('\n⏱️  执行时间:');
    console.log(`  回测引擎: ${result.execution_time_ms}ms`);
    console.log(`  总耗时: ${execution_time}ms`);

    // 准备统计数据（用于后续保存）
    const close_reasons = result.trades.reduce((acc, trade) => {
      const reason = trade.close_reason || 'UNKNOWN';
      acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const symbol_stats = result.trades.reduce((acc, trade) => {
      if (!acc[trade.symbol]) {
        acc[trade.symbol] = { total: 0, wins: 0, total_pnl: 0 };
      }
      acc[trade.symbol].total++;
      if ((trade.realized_pnl || 0) > 0) acc[trade.symbol].wins++;
      acc[trade.symbol].total_pnl += (trade.realized_pnl || 0);
      return acc;
    }, {} as Record<string, { total: number; wins: number; total_pnl: number }>);

    // ======================= 详细交易记录 =======================
    if (result.trades.length > 0) {
      console.log('\n' + '='.repeat(100));
      console.log('📋 详细交易记录');
      console.log('='.repeat(100));
      console.log(`总交易次数: ${result.trades.length}笔\n`);

      result.trades.forEach((trade, index) => {
        const pnl = trade.realized_pnl || 0;
        const position_value = trade.entry_price * trade.quantity;
        const pnl_percent = ((pnl / position_value) * 100).toFixed(2);
        const is_win = pnl > 0;
        const holding_time = trade.closed_at && trade.opened_at
          ? Math.round((trade.closed_at.getTime() - trade.opened_at.getTime()) / 60000)
          : 0;

        const price_change = trade.current_price - trade.entry_price;
        const price_change_percent = ((price_change / trade.entry_price) * 100).toFixed(2);

        console.log(`${is_win ? '✅ 盈利' : '❌ 亏损'} 交易 #${index + 1} - ${trade.symbol} ${trade.side}`);
        console.log(`   开仓时间: ${trade.opened_at?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        console.log(`   平仓时间: ${trade.closed_at?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        console.log(`   持仓时长: ${holding_time}分钟`);
        console.log(`   入场价格: $${trade.entry_price.toFixed(6)}`);
        console.log(`   出场价格: $${trade.current_price.toFixed(6)} (${price_change_percent}%)`);
        console.log(`   止损价格: $${trade.stop_loss_price?.toFixed(6) || 'N/A'}`);
        console.log(`   止盈价格: $${trade.take_profit_price?.toFixed(6) || 'N/A'}`);
        console.log(`   交易数量: ${trade.quantity.toFixed(6)}`);
        console.log(`   仓位价值: $${position_value.toFixed(2)}`);
        console.log(`   杠杆倍数: ${trade.leverage}x`);
        console.log(`   盈亏金额: ${is_win ? '+' : ''}$${pnl.toFixed(2)} (${pnl_percent}%)`);
        console.log(`   平仓原因: ${trade.close_reason || 'N/A'}`);
        console.log('');
      });

      // 显示平仓原因统计
      console.log('📊 平仓原因统计:');
      Object.entries(close_reasons).forEach(([reason, count]) => {
        const percent = ((count / result.trades.length) * 100).toFixed(1);
        console.log(`   ${reason}: ${count}笔 (${percent}%)`);
      });
      console.log('');

      // 显示币种统计
      console.log('📊 币种交易统计:');
      Object.entries(symbol_stats)
        .sort((a, b) => b[1].total - a[1].total)
        .forEach(([symbol, stats]) => {
          const win_rate = ((stats.wins / stats.total) * 100).toFixed(1);
          const pnl_symbol = stats.total_pnl > 0 ? '+' : '';
          console.log(`   ${symbol}: ${stats.total}笔 (胜率${win_rate}%, 盈亏${pnl_symbol}$${stats.total_pnl.toFixed(2)})`);
        });
      console.log('');
    }

    // 显示部分拒绝信号原因
    if (result.rejected_signals.length > 0) {
      console.log('\n🚫 拒绝信号原因 (前5个):');
      console.log('-' .repeat(60));
      const reason_counts: Record<string, number> = {};
      result.rejected_signals.forEach(rs => {
        reason_counts[rs.reason] = (reason_counts[rs.reason] || 0) + 1;
      });

      Object.entries(reason_counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([reason, count]) => {
          console.log(`  ${reason}: ${count} 次`);
        });
    }

    console.log('\n' + '=' .repeat(60));

    // 策略评估
    console.log('\n🎓 策略评估:');
    if (stats.win_rate >= 60) {
      console.log('  ✅ 胜率优秀 (≥60%)');
    } else if (stats.win_rate >= 50) {
      console.log('  ⚠️  胜率一般 (50-60%)');
    } else {
      console.log('  ❌ 胜率较低 (<50%)');
    }

    if (stats.profit_factor >= 2) {
      console.log('  ✅ 盈亏比优秀 (≥2.0)');
    } else if (stats.profit_factor >= 1.5) {
      console.log('  ⚠️  盈亏比一般 (1.5-2.0)');
    } else {
      console.log('  ❌ 盈亏比较低 (<1.5)');
    }

    if (stats.max_drawdown_percent <= 10) {
      console.log('  ✅ 回撤控制良好 (≤10%)');
    } else if (stats.max_drawdown_percent <= 20) {
      console.log('  ⚠️  回撤适中 (10-20%)');
    } else {
      console.log('  ❌ 回撤较大 (>20%)');
    }

    if (stats.total_pnl > 0) {
      const roi = (stats.total_pnl / config.initial_balance) * 100;
      console.log(`\n💎 总收益率: ${roi.toFixed(2)}%`);
    } else {
      console.log(`\n⚠️  策略亏损，建议调整参数`);
    }

    console.log('\n✨ 回测完成！\n');

    // ======================= 保存交易记录到文件 =======================
    try {
      // 创建backtest_results目录
      const results_dir = path.join(__dirname, '..', 'backtest_results');
      if (!fs.existsSync(results_dir)) {
        fs.mkdirSync(results_dir, { recursive: true });
      }

      // 生成文件名（带时间戳）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const json_file = path.join(results_dir, `backtest_${timestamp}.json`);
      const txt_file = path.join(results_dir, `backtest_${timestamp}.txt`);

      // 创建signal_id到anomaly的映射
      const signal_to_anomaly_map = new Map<number, any>();
      result.signals.forEach(signal => {
        if (signal.source_anomaly_id && signal.anomaly_data) {
          signal_to_anomaly_map.set(signal.source_anomaly_id, signal.anomaly_data);
        }
      });

      // 准备JSON数据
      const export_data = {
        metadata: {
          timestamp: new Date().toISOString(),
          config: {
            start_date: config.start_date,
            end_date: config.end_date,
            initial_balance: config.initial_balance,
            strategy_type: config.strategy_config.strategy_type,
            min_signal_score: config.strategy_config.min_signal_score,
            stop_loss_percent: config.risk_config.default_stop_loss_percent,
            take_profit_percent: config.risk_config.default_take_profit_percent,
            max_holding_time_minutes: config.max_holding_time_minutes
          }
        },
        summary: {
          total_trades: stats.total_trades,
          winning_trades: stats.winning_trades,
          losing_trades: stats.losing_trades,
          win_rate: stats.win_rate,
          total_pnl: stats.total_pnl,
          roi_percent: (stats.total_pnl / config.initial_balance) * 100,
          average_win: stats.average_win,
          average_loss: stats.average_loss,
          profit_factor: stats.profit_factor,
          max_drawdown: stats.max_drawdown,
          max_drawdown_percent: stats.max_drawdown_percent,
          average_hold_time: stats.average_hold_time
        },
        trades: result.trades.map((trade, index) => {
          // 获取该交易对应的异动数据
          const anomaly = trade.signal_id ? signal_to_anomaly_map.get(trade.signal_id) : null;

          return {
            trade_number: index + 1,
            symbol: trade.symbol,
            side: trade.side,
            entry_time: trade.opened_at,
            exit_time: trade.closed_at,
            entry_price: trade.entry_price,
            exit_price: trade.current_price,
            quantity: trade.quantity,
            leverage: trade.leverage,
            stop_loss_price: trade.stop_loss_price,
            take_profit_price: trade.take_profit_price,
            realized_pnl: trade.realized_pnl,
            holding_time_minutes: trade.closed_at && trade.opened_at
              ? Math.round((trade.closed_at.getTime() - trade.opened_at.getTime()) / 60000)
              : 0,
            close_reason: trade.close_reason,
            // 新增：每日价格极值数据
            daily_price_low: anomaly?.daily_price_low,
            daily_price_high: anomaly?.daily_price_high,
            price_from_low_pct: anomaly?.price_from_low_pct,
            price_from_high_pct: anomaly?.price_from_high_pct
          };
        }),
        symbol_statistics: Object.entries(symbol_stats || {}).map(([symbol, stats]) => ({
          symbol,
          total_trades: stats.total,
          winning_trades: stats.wins,
          win_rate: (stats.wins / stats.total) * 100,
          total_pnl: stats.total_pnl
        })).sort((a, b) => b.total_trades - a.total_trades),
        close_reasons: close_reasons || {}
      };

      // 保存JSON文件
      fs.writeFileSync(json_file, JSON.stringify(export_data, null, 2), 'utf-8');
      console.log(`💾 JSON数据已保存: ${json_file}`);

      // 生成文本报告
      let txt_content = '';
      txt_content += '='.repeat(100) + '\n';
      txt_content += '回测报告\n';
      txt_content += '='.repeat(100) + '\n\n';
      txt_content += `生成时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
      txt_content += `回测周期: ${config.start_date.toLocaleDateString()} - ${config.end_date.toLocaleDateString()}\n`;
      txt_content += `初始资金: $${config.initial_balance}\n`;
      txt_content += `策略类型: ${config.strategy_config.strategy_type}\n`;
      txt_content += `止损/止盈: ${config.risk_config.default_stop_loss_percent}% / ${config.risk_config.default_take_profit_percent}%\n\n`;

      txt_content += '总结统计\n';
      txt_content += '-'.repeat(100) + '\n';
      txt_content += `总交易次数: ${stats.total_trades}\n`;
      txt_content += `盈利交易: ${stats.winning_trades} (${stats.win_rate.toFixed(2)}%)\n`;
      txt_content += `亏损交易: ${stats.losing_trades}\n`;
      txt_content += `总盈亏: $${stats.total_pnl.toFixed(2)}\n`;
      txt_content += `收益率: ${((stats.total_pnl / config.initial_balance) * 100).toFixed(2)}%\n`;
      txt_content += `平均盈利: $${stats.average_win.toFixed(2)}\n`;
      txt_content += `平均亏损: $${stats.average_loss.toFixed(2)}\n`;
      txt_content += `盈亏比: ${stats.profit_factor.toFixed(2)}\n`;
      txt_content += `最大回撤: $${stats.max_drawdown.toFixed(2)} (${stats.max_drawdown_percent.toFixed(2)}%)\n`;
      txt_content += `平均持仓: ${stats.average_hold_time.toFixed(2)}分钟\n\n`;

      txt_content += '详细交易记录\n';
      txt_content += '-'.repeat(100) + '\n';
      result.trades.forEach((trade, index) => {
        const pnl = trade.realized_pnl || 0;
        const is_win = pnl > 0;
        txt_content += `\n#${index + 1} ${is_win ? '[盈利]' : '[亏损]'} ${trade.symbol} ${trade.side}\n`;
        txt_content += `  开仓: ${trade.opened_at?.toLocaleString('zh-CN')} @ $${trade.entry_price.toFixed(6)}\n`;
        txt_content += `  平仓: ${trade.closed_at?.toLocaleString('zh-CN')} @ $${trade.current_price.toFixed(6)}\n`;
        txt_content += `  盈亏: ${is_win ? '+' : ''}$${pnl.toFixed(2)}\n`;
        txt_content += `  原因: ${trade.close_reason}\n`;
      });

      // 保存文本文件
      fs.writeFileSync(txt_file, txt_content, 'utf-8');
      console.log(`📄 文本报告已保存: ${txt_file}\n`);

    } catch (save_error) {
      console.error('⚠️  保存文件失败:', save_error);
    }

  } catch (error) {
    console.error('❌ 回测失败:', error);
    logger.error('[BacktestScript] Backtest failed:', error);
    process.exit(1);
  }
}

// 运行脚本
run_backtest_test()
  .then(() => {
    console.log('👋 脚本执行完毕');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 脚本执行失败:', error);
    process.exit(1);
  });
