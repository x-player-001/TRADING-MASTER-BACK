/**
 * 一键回测脚本 - JavaScript版本
 * 运行命令: node dev/backtest/backtest.js
 */

require('dotenv').config({ override: true });

// ============================================================================
// 📋 可修改配置区
// ============================================================================
const BACKTEST_CONFIG = {
  // 回测时间范围
  days_back: 5,                          // 回测最近N天

  // 初始资金
  initial_balance: 100,                   // 初始资金 $100
  margin_percent: 10,                     // 每次开仓使用总资金的10%

  // 策略配置
  strategy: {
    min_signal_score: 7,                  // 最小信号分数 (1-10)
    min_confidence: 0.7,                  // 最小置信度 (0-1)
    min_oi_change_percent: 3,             // 最小OI变化百分比
    require_price_oi_alignment: true,     // 是否要求价格OI对齐
    price_oi_divergence_threshold: 3,     // 价格OI背离阈值
    use_sentiment_filter: true,           // 使用情绪过滤
    min_trader_ratio: 1.2,                // 最小交易者比率
    max_funding_rate: 0.01,               // 最大资金费率
    min_funding_rate: -0.01               // 最小资金费率
  },

  // 风险配置
  risk: {
    max_position_size_percent: 5,         // 单笔最大仓位百分比
    max_total_positions: 8,               // 最多同时持仓数
    max_positions_per_symbol: 1,          // 每个币种最多持仓数
    stop_loss_percent: 5,                 // 止损百分比
    take_profit_percent: 15,              // 止盈百分比
    use_trailing_stop: true,              // 启用移动止损
    trailing_stop_callback_rate: 3,       // 移动止损回调率
    max_leverage: 10,                     // 最大杠杆
    leverage_by_signal: {
      weak: 5,                            // 弱信号杠杆
      medium: 8,                          // 中信号杠杆
      strong: 10                          // 强信号杠杆
    }
  },

  // 持仓时间限制
  max_holding_time_minutes: 60,           // 最大持仓时间(分钟)

  // 交易成本
  slippage_percent: 0.1,                  // 滑点百分比
  commission_percent: 0.05                // 手续费百分比
};

// ============================================================================
// 📊 主程序
// ============================================================================

async function run_backtest() {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 一键回测脚本');
  console.log('='.repeat(80));
  console.log('');

  // 动态加载 TypeScript 模块
  console.log('⏳ 加载回测引擎...');

  // 使用 ts-node 注册来支持 TypeScript
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
      module: 'commonjs'
    }
  });

  // 注册 tsconfig-paths 支持路径别名
  require('tsconfig-paths').register({
    baseUrl: './src',
    paths: {
      '@/*': ['*'],
      '@/types/*': ['types/*'],
      '@/core/*': ['core/*'],
      '@/utils/*': ['utils/*']
    }
  });

  const { BacktestEngine } = require('../../../src/trading/backtest_engine');
  const { StrategyType } = require('../../../src/types/trading_types');
  const { ConfigManager } = require('../../../src/core/config/config_manager');
  const fs = require('fs');
  const path = require('path');

  try {
    // 初始化配置管理器
    console.log('🔧 初始化配置管理器...');
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    const db_config = config_manager.get_database_config();
    console.log(`📡 MySQL: ${db_config.mysql.host}:${db_config.mysql.port}`);
    console.log('✅ 配置管理器初始化完成\n');

    // 创建回测引擎
    const backtest_engine = new BacktestEngine();

    // 计算时间范围
    const end_date = new Date();
    const start_date = new Date(Date.now() - BACKTEST_CONFIG.days_back * 24 * 60 * 60 * 1000);

    // 构建回测配置
    const config = {
      start_date,
      end_date,
      initial_balance: BACKTEST_CONFIG.initial_balance,

      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: BACKTEST_CONFIG.strategy.min_signal_score,
        min_confidence: BACKTEST_CONFIG.strategy.min_confidence,
        min_oi_change_percent: BACKTEST_CONFIG.strategy.min_oi_change_percent,
        require_price_oi_alignment: BACKTEST_CONFIG.strategy.require_price_oi_alignment,
        price_oi_divergence_threshold: BACKTEST_CONFIG.strategy.price_oi_divergence_threshold,
        use_sentiment_filter: BACKTEST_CONFIG.strategy.use_sentiment_filter,
        min_trader_ratio: BACKTEST_CONFIG.strategy.min_trader_ratio,
        max_funding_rate: BACKTEST_CONFIG.strategy.max_funding_rate,
        min_funding_rate: BACKTEST_CONFIG.strategy.min_funding_rate
      },

      risk_config: {
        max_position_size_percent: BACKTEST_CONFIG.risk.max_position_size_percent,
        max_total_positions: BACKTEST_CONFIG.risk.max_total_positions,
        max_positions_per_symbol: BACKTEST_CONFIG.risk.max_positions_per_symbol,
        default_stop_loss_percent: BACKTEST_CONFIG.risk.stop_loss_percent,
        default_take_profit_percent: BACKTEST_CONFIG.risk.take_profit_percent,
        use_trailing_stop: BACKTEST_CONFIG.risk.use_trailing_stop,
        trailing_stop_callback_rate: BACKTEST_CONFIG.risk.trailing_stop_callback_rate,
        daily_loss_limit_percent: 100,
        consecutive_loss_limit: 999,
        pause_after_loss_limit: false,
        max_leverage: BACKTEST_CONFIG.risk.max_leverage,
        leverage_by_signal_strength: BACKTEST_CONFIG.risk.leverage_by_signal
      },

      max_holding_time_minutes: BACKTEST_CONFIG.max_holding_time_minutes,
      use_slippage: true,
      slippage_percent: BACKTEST_CONFIG.slippage_percent,
      commission_percent: BACKTEST_CONFIG.commission_percent
    };

    // 打印配置
    console.log('📋 回测配置:');
    console.log(`  时间范围: ${start_date.toISOString().split('T')[0]} ~ ${end_date.toISOString().split('T')[0]} (${BACKTEST_CONFIG.days_back}天)`);
    console.log(`  初始资金: $${BACKTEST_CONFIG.initial_balance}`);
    console.log(`  每次开仓: 总资金的${BACKTEST_CONFIG.margin_percent}% (固定$${BACKTEST_CONFIG.initial_balance * BACKTEST_CONFIG.margin_percent / 100}保证金)`);
    console.log(`  最小信号分数: ${BACKTEST_CONFIG.strategy.min_signal_score}`);
    console.log(`  最大杠杆: ${BACKTEST_CONFIG.risk.max_leverage}x`);
    console.log(`  止损: ${BACKTEST_CONFIG.risk.stop_loss_percent}% | 止盈: ${BACKTEST_CONFIG.risk.take_profit_percent}%`);
    console.log(`  理论盈亏比: ${(BACKTEST_CONFIG.risk.take_profit_percent / BACKTEST_CONFIG.risk.stop_loss_percent).toFixed(2)}:1`);
    console.log(`  最大持仓时间: ${BACKTEST_CONFIG.max_holding_time_minutes}分钟`);
    console.log(`  滑点: ${BACKTEST_CONFIG.slippage_percent}% | 手续费: ${BACKTEST_CONFIG.commission_percent}%\n`);

    // 运行回测
    console.log('⏳ 正在运行回测...\n');
    const start_time = Date.now();

    const result = await backtest_engine.run_backtest(config);

    const execution_time = Date.now() - start_time;

    // 输出结果
    console.log('✅ 回测完成!\n');
    console.log('='.repeat(80));
    console.log('📊 回测统计结果');
    console.log('='.repeat(80));

    const stats = result.statistics;

    // 计算 ROI
    const roi_percent = (stats.total_pnl / config.initial_balance) * 100;

    // 计算最大单笔盈亏
    const winning_trades = result.trades.filter(t => t.realized_pnl > 0);
    const losing_trades = result.trades.filter(t => t.realized_pnl < 0);
    const largest_win = winning_trades.length > 0
      ? Math.max(...winning_trades.map(t => t.realized_pnl))
      : 0;
    const largest_loss = losing_trades.length > 0
      ? Math.min(...losing_trades.map(t => t.realized_pnl))
      : 0;

    console.log('\n📈 交易概况:');
    console.log(`  总交易次数: ${stats.total_trades}`);
    console.log(`  盈利交易: ${stats.winning_trades} (${stats.win_rate.toFixed(2)}%)`);
    console.log(`  亏损交易: ${stats.losing_trades} (${(100 - stats.win_rate).toFixed(2)}%)`);
    console.log(`  胜率: ${stats.win_rate.toFixed(2)}%`);

    console.log('\n💰 盈亏分析:');
    console.log(`  总盈亏: ${stats.total_pnl >= 0 ? '+' : ''}$${stats.total_pnl.toFixed(2)}`);
    console.log(`  ROI: ${roi_percent >= 0 ? '+' : ''}${roi_percent.toFixed(2)}%`);
    console.log(`  平均盈利: $${stats.average_win.toFixed(2)}`);
    console.log(`  平均亏损: $${stats.average_loss.toFixed(2)}`);
    console.log(`  盈亏比: ${stats.profit_factor.toFixed(2)}`);

    console.log('\n⚠️  风险指标:');
    console.log(`  最大回撤: $${stats.max_drawdown.toFixed(2)} (${stats.max_drawdown_percent.toFixed(2)}%)`);
    console.log(`  最大单笔盈利: $${largest_win.toFixed(2)}`);
    console.log(`  最大单笔亏损: $${largest_loss.toFixed(2)}`);
    console.log(`  平均持仓时间: ${stats.average_hold_time.toFixed(2)} 分钟`);

    console.log('\n🎯 信号统计:');
    console.log(`  生成信号数: ${result.signals.length}`);
    console.log(`  拒绝信号数: ${result.rejected_signals.length}`);
    console.log(`  信号转化率: ${((result.trades.length / result.signals.length) * 100).toFixed(2)}%`);

    console.log('\n⏱️  执行时间:');
    console.log(`  回测引擎: ${result.execution_time_ms}ms`);
    console.log(`  总耗时: ${execution_time}ms`);

    // 保存结果到 JSON
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const results_dir = path.join(process.cwd(), 'backtest_results');

    if (!fs.existsSync(results_dir)) {
      fs.mkdirSync(results_dir, { recursive: true });
    }

    const json_file = path.join(results_dir, `backtest_${timestamp}.json`);

    const output_data = {
      metadata: {
        timestamp: new Date().toISOString(),
        config: BACKTEST_CONFIG,
        execution_time_ms: execution_time
      },
      summary: {
        total_trades: stats.total_trades,
        winning_trades: stats.winning_trades,
        losing_trades: stats.losing_trades,
        win_rate: parseFloat(stats.win_rate.toFixed(2)),
        total_pnl: parseFloat(stats.total_pnl.toFixed(2)),
        roi_percent: parseFloat(roi_percent.toFixed(2)),
        average_win: parseFloat(stats.average_win.toFixed(2)),
        average_loss: parseFloat(stats.average_loss.toFixed(2)),
        profit_factor: parseFloat(stats.profit_factor.toFixed(2)),
        max_drawdown: parseFloat(stats.max_drawdown.toFixed(2)),
        max_drawdown_percent: parseFloat(stats.max_drawdown_percent.toFixed(2)),
        largest_win: parseFloat(largest_win.toFixed(2)),
        largest_loss: parseFloat(largest_loss.toFixed(2)),
        average_hold_time: parseFloat(stats.average_hold_time.toFixed(2))
      },
      all_trades: result.trades.map(t => ({
        symbol: t.symbol,
        side: t.side,
        entry_time: t.opened_at.toISOString(),
        entry_price: t.entry_price,
        exit_time: t.closed_at?.toISOString(),
        exit_price: t.exit_price,
        quantity: t.quantity,
        leverage: t.leverage,
        realized_pnl: parseFloat(t.realized_pnl?.toFixed(2) || '0'),
        close_reason: t.close_reason,
        hold_time_minutes: t.closed_at
          ? ((t.closed_at.getTime() - t.opened_at.getTime()) / 60000).toFixed(2)
          : null
      })),
      signals: result.signals.length,
      rejected_signals: result.rejected_signals.length
    };

    fs.writeFileSync(json_file, JSON.stringify(output_data, null, 2));

    console.log('\n📁 结果已保存:');
    console.log(`  JSON: ${json_file}`);

    console.log('\n💡 提示:');
    console.log('  - 查看详细结果: cat ' + json_file + ' | jq \'.summary\'');
    console.log('  - 验证保证金: node scripts/dev/verify/verify_fixed_margin.js');
    console.log('  - 修改配置: 编辑 dev/backtest/backtest.js 顶部的 BACKTEST_CONFIG');
    console.log('');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ 回测失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行主程序
run_backtest();
