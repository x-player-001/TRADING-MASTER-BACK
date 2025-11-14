/**
 * 实盘/测试网交易启动脚本
 * 运行命令: npx ts-node scripts/run_live_trading.ts
 */

// 加载环境变量
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { LiveTradingEngine, LiveTradingConfig } from '../src/trading/live_trading_engine';
import { TradingMode, StrategyType } from '../src/types/trading_types';
import { OIPollingService } from '../src/core/oi/oi_polling_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('🚀 启动实盘交易引擎...\n');

  // ⚠️ 警告提示
  console.log('⚠️  警告：这将连接到币安API进行交易！');
  console.log('⚠️  当前模式：PAPER（纸面交易）');
  console.log('⚠️  如需切换到测试网，请修改 TradingMode.TESTNET\n');

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 创建实盘交易配置（使用回测优化后的最佳参数）
    const trading_config: LiveTradingConfig = {
      // 交易模式（PAPER / TESTNET / LIVE）
      mode: TradingMode.PAPER,  // ⚠️ 默认纸面交易，安全模式

      // 初始资金
      initial_balance: 10000,

      // 策略配置 - 小市值币早期启动捕捉
      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 7,
        min_confidence: 0.7,
        min_oi_change_percent: 3,
        require_price_oi_alignment: true,
        price_oi_divergence_threshold: 3,
        use_sentiment_filter: true,
        min_trader_ratio: 1.2,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      },

      // 风险配置 - 5:1高盈亏比策略
      risk_config: {
        max_position_size_percent: 5,
        max_total_positions: 3,
        max_positions_per_symbol: 1,
        default_stop_loss_percent: 4,
        default_take_profit_percent: 20,    // 5:1盈亏比
        use_trailing_stop: true,
        trailing_stop_callback_rate: 3,
        daily_loss_limit_percent: 10,       // 恢复每日亏损限制
        consecutive_loss_limit: 5,          // 恢复连续亏损限制
        pause_after_loss_limit: true,       // 触发限制后暂停
        max_leverage: 3,
        leverage_by_signal_strength: {
          weak: 1,
          medium: 2,
          strong: 3
        }
      },

      // 持仓时间限制 - 快进快出
      max_holding_time_minutes: 30
    };

    console.log('📋 交易配置:');
    console.log(`  模式: ${trading_config.mode}`);
    console.log(`  初始资金: $${trading_config.initial_balance}`);
    console.log(`  策略: ${trading_config.strategy_config.strategy_type}`);
    console.log(`  止损: ${trading_config.risk_config.default_stop_loss_percent}% | 止盈: ${trading_config.risk_config.default_take_profit_percent}%`);
    console.log(`  理论盈亏比: ${(trading_config.risk_config.default_take_profit_percent / trading_config.risk_config.default_stop_loss_percent).toFixed(1)}:1`);
    console.log(`  最大持仓时间: ${trading_config.max_holding_time_minutes}分钟`);
    console.log(`  每日亏损限制: ${trading_config.risk_config.daily_loss_limit_percent}%`);
    console.log(`  连续亏损限制: ${trading_config.risk_config.consecutive_loss_limit}次\n`);

    // 创建交易引擎
    const trading_engine = new LiveTradingEngine(trading_config);

    // 创建OI监控服务
    const oi_service = new OIPollingService();

    // 订阅OI异动事件
    oi_service.on('anomaly', (anomaly) => {
      // 将异动传递给交易引擎处理
      trading_engine.process_anomaly(anomaly);
    });

    // 启动交易引擎
    trading_engine.start();

    // 启动OI监控
    await oi_service.start();

    console.log('✅ 交易引擎已启动');
    console.log('📡 OI监控已启动');
    console.log('⏳ 等待交易信号...\n');

    // 每30秒打印一次状态
    setInterval(() => {
      const status = trading_engine.get_status();
      console.log('\n' + '='.repeat(60));
      console.log('📊 交易引擎状态');
      console.log('='.repeat(60));
      console.log(`运行状态: ${status.is_running ? '✅ 运行中' : '❌ 已停止'}`);
      console.log(`当前持仓: ${status.current_positions.length}个`);
      console.log(`总交易次数: ${status.statistics.total_trades}`);
      console.log(`胜率: ${(status.statistics.win_rate * 100).toFixed(1)}% (${status.statistics.winning_trades}胜/${status.statistics.losing_trades}负)`);
      console.log(`总盈亏: $${status.statistics.total_pnl.toFixed(2)}`);
      console.log(`当前余额: $${status.statistics.current_balance.toFixed(2)}`);

      if (status.current_positions.length > 0) {
        console.log('\n📍 当前持仓:');
        status.current_positions.forEach((pos, idx) => {
          const holding_time = Math.floor((Date.now() - pos.entry_time.getTime()) / 60000);
          console.log(`  ${idx + 1}. ${pos.symbol} ${pos.side} @ $${pos.entry_price.toFixed(4)} (${holding_time}min)`);
          console.log(`     止损: $${pos.stop_loss_price?.toFixed(4)} | 止盈: $${pos.take_profit_price?.toFixed(4)}`);
        });
      }
      console.log('='.repeat(60) + '\n');
    }, 30000);

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 正在关闭交易引擎...');

      // 停止OI监控
      oi_service.stop();

      // 询问是否平仓
      console.log('⚠️  是否需要平掉所有持仓？（3秒后自动跳过）');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 停止交易引擎
      trading_engine.stop();

      // 打印最终统计
      const final_status = trading_engine.get_status();
      console.log('\n' + '='.repeat(60));
      console.log('📊 最终统计');
      console.log('='.repeat(60));
      console.log(`总交易次数: ${final_status.statistics.total_trades}`);
      console.log(`胜率: ${(final_status.statistics.win_rate * 100).toFixed(1)}%`);
      console.log(`总盈亏: $${final_status.statistics.total_pnl.toFixed(2)}`);
      console.log(`收益率: ${(final_status.statistics.total_pnl / trading_config.initial_balance * 100).toFixed(2)}%`);
      console.log('='.repeat(60));

      console.log('\n👋 交易引擎已关闭');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ 启动失败:', error);
    process.exit(1);
  }
}

main();
