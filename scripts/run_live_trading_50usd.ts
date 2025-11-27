/**
 * $50 实盘交易启动脚本 - 小资金测试配置
 *
 * 配置说明:
 * - 初始资金: $50
 * - 单笔仓位: 10% = $5保证金
 * - 杠杆倍数: 6倍
 * - 单笔仓位价值: $5 × 6倍 = $30
 * - 最大同时持仓: 5个
 * - 只做多 (做空盈利能力差)
 * - 分批止盈: 30%@+8%, 30%@+12%, 40%跟踪止盈(15%回调)
 * - 无固定止损 (逐仓自动限损，最大亏损$5/笔)
 * - 180分钟超时平仓
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_live_trading_50usd.ts
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
  console.log('🚀 启动 $50 小资金测试交易引擎...\n');
  console.log('═'.repeat(80));

  // ⚠️ 安全警告
  console.log('\n⚠️  $50 小资金配置说明:');
  console.log('   - 默认模式: TESTNET (测试网，使用测试币)');
  console.log('   - 单笔仓位: $30 (10%保证金 × 6倍杠杆)');
  console.log('   - 单笔最大亏损: $5 (逐仓模式自动限损)');
  console.log('   - 最多5个仓位同时持有');
  console.log('\n   ⚠️  实盘前必读:');
  console.log('   1. 先在TESTNET完成至少3笔完整交易');
  console.log('   2. 验证止盈订单正确下单');
  console.log('   3. 确认所有功能正常后再切换到LIVE');
  console.log('   4. 只用完全能承受亏损的资金!\n');
  console.log('═'.repeat(80));

  // ⚠️ 用户确认
  const trading_mode = TradingMode.TESTNET;  // 🔒 默认测试网模式

  if (trading_mode === TradingMode.LIVE) {
    console.log('\n🔴 警告: 即将使用真实资金交易!');
    console.log('   请确认已经过充分测试!');
    console.log('   5秒后继续...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 📊 $50 小资金优化配置
    const trading_config: LiveTradingConfig = {
      // 交易模式
      mode: trading_mode,

      // 初始资金 $50
      initial_balance: 50,

      // 策略配置 - 高质量信号优先
      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 8,                    // 提高到8分（质量优先）
        min_confidence: 0.6,                    // 提高到60%
        min_oi_change_percent: 5,               // 提高到5%（更强信号）
        require_price_oi_alignment: true,       // 必须价格OI同向
        price_oi_divergence_threshold: 5,
        use_sentiment_filter: false,
        min_trader_ratio: 0.8,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      },

      // 风险配置 - 逐仓模式
      risk_config: {
        max_position_size_percent: 10,          // 10%保证金 = $5
        max_total_positions: 5,                 // 最多5个仓位
        max_positions_per_symbol: 1,            // 单币种最多1个
        default_stop_loss_percent: 100,         // 无固定止损（逐仓自动限损）
        default_take_profit_percent: 8,         // 第一批止盈8%
        use_trailing_stop: true,                // 启用跟踪止盈
        trailing_stop_callback_rate: 15,        // 回调15%触发（比回测保守）
        daily_loss_limit_percent: 20,           // 每日亏损20%暂停
        consecutive_loss_limit: 3,              // 连续3次亏损暂停
        pause_after_loss_limit: true,           // 触发熔断后暂停
        max_leverage: 6,                        // 6倍杠杆
        leverage_by_signal_strength: {
          weak: 6,
          medium: 6,
          strong: 6
        }
      },

      // 分批止盈配置 ✨ 调整为适合小资金
      dynamic_take_profit: {
        targets: [
          {
            percentage: 30,                     // 第1批: 30%仓位
            price: 0,
            target_profit_pct: 8,               // +8%止盈（降低难度）
            is_trailing: false
          },
          {
            percentage: 30,                     // 第2批: 30%仓位
            price: 0,
            target_profit_pct: 12,              // +12%止盈
            is_trailing: false
          },
          {
            percentage: 40,                     // 第3批: 40%仓位
            price: 0,
            target_profit_pct: 0,
            is_trailing: true,                  // 跟踪止盈
            trailing_callback_pct: 15           // 回调15%触发
          }
        ],
        enable_trailing: true,
        trailing_start_profit_pct: 8            // 盈利8%后启动跟踪
      },

      // 方向过滤 - 只做多 ✨
      allowed_directions: ['LONG'],

      // 持仓时间限制 - 3小时超时平仓
      max_holding_time_minutes: 180
    };

    // 📋 显示配置
    console.log('\n📋 $50 交易配置:');
    console.log('═'.repeat(80));
    console.log(`  模式: ${trading_config.mode} ${trading_mode === TradingMode.PAPER ? '(纸面交易)' : trading_mode === TradingMode.TESTNET ? '(测试网)' : '⚠️ (实盘)'}`)
    console.log(`  初始资金: $${trading_config.initial_balance}`);
    console.log(`  单笔保证金: $${trading_config.initial_balance * (trading_config.risk_config.max_position_size_percent / 100)} (10%)`);
    console.log(`  单笔仓位值: $${trading_config.initial_balance * (trading_config.risk_config.max_position_size_percent / 100) * trading_config.risk_config.max_leverage} (10% × 6倍)`);
    console.log(`  杠杆: ${trading_config.risk_config.max_leverage}x (逐仓)`);
    console.log(`  最多持仓: ${trading_config.risk_config.max_total_positions}个`);
    console.log(`  单笔最大亏损: $${trading_config.initial_balance * (trading_config.risk_config.max_position_size_percent / 100)} (逐仓保证金)`);
    console.log(`  策略: 只做多突破策略 (评分≥8分)`);
    console.log(`  止盈: 30%@+8%, 30%@+12%, 40%跟踪@15%回调`);
    console.log(`  止损: 无 (逐仓模式自动限损)`);
    console.log(`  超时平仓: ${trading_config.max_holding_time_minutes}分钟`);
    console.log(`  熔断机制: 每日亏损20%或连续3次亏损暂停`);
    console.log('═'.repeat(80));

    // 风险提示
    console.log('\n⚠️  风险提示:');
    console.log('  - 最坏情况: 5个仓位同时爆仓 = -$25 (账户剩$25, -50%)');
    console.log('  - 触发每日熔断: 亏损 -$10 (账户剩$40, -20%)');
    console.log('  - 建议币种: DOGE、SHIB等低价币（避免BTCUSDT最小订单限制）');
    console.log('  - 心理准备: $50可能很快亏完，把它当学费');
    console.log('═'.repeat(80));

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

    console.log('\n✅ 交易引擎已启动');
    console.log('📡 OI监控已启动 (每分钟检测持仓量异动)');
    console.log('⏳ 等待高质量交易信号...\n');

    // 状态显示间隔（30秒）
    setInterval(() => {
      const status = trading_engine.get_status();

      console.log('\n' + '='.repeat(80));
      console.log(`📊 实时状态 [${new Date().toLocaleString('zh-CN')}]`);
      console.log('='.repeat(80));
      console.log(`运行状态: ${status.is_running ? '✅ 运行中' : '❌ 已停止'}`);
      console.log(`模式: ${trading_mode === TradingMode.PAPER ? '📝 纸面交易' : trading_mode === TradingMode.TESTNET ? '🧪 测试网' : '💰 实盘'}`);
      console.log(`当前持仓: ${status.current_positions.length}个 / ${trading_config.risk_config.max_total_positions}个`);
      console.log(`总交易次数: ${status.statistics.total_trades}`);
      console.log(`胜率: ${status.statistics.total_trades > 0 ? (status.statistics.win_rate * 100).toFixed(1) : '0.0'}% (${status.statistics.winning_trades}胜/${status.statistics.losing_trades}负)`);
      console.log(`总盈亏: ${status.statistics.total_pnl >= 0 ? '+' : ''}$${status.statistics.total_pnl.toFixed(2)}`);
      console.log(`收益率: ${status.statistics.total_trades > 0 ? (status.statistics.total_pnl / trading_config.initial_balance * 100).toFixed(2) : '0.00'}%`);
      console.log(`当前余额: $${status.statistics.current_balance.toFixed(2)}`);

      if (status.current_positions.length > 0) {
        console.log('\n📍 当前持仓:');
        status.current_positions.forEach((pos, idx) => {
          const holding_time = Math.floor((Date.now() - pos.entry_time.getTime()) / 60000);
          const pnl_pct = ((pos.current_price - pos.entry_price) / pos.entry_price * 100).toFixed(2);
          console.log(`  ${idx + 1}. ${pos.symbol} ${pos.side} @ $${pos.entry_price.toFixed(6)}`);
          console.log(`     持仓: ${holding_time}min | 盈亏: ${pnl_pct}% | 当前价: $${pos.current_price.toFixed(6)}`);
          console.log(`     止盈: $${pos.take_profit_price?.toFixed(6)} | 跟踪止盈: ${pos.trailing_stop_active ? '✅' : '❌'}`);
        });
      }
      console.log('='.repeat(80) + '\n');
    }, 30000);

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 正在关闭交易引擎...');

      // 停止OI监控
      oi_service.stop();
      console.log('✅ OI监控已停止');

      // 停止交易引擎
      trading_engine.stop();
      console.log('✅ 交易引擎已停止');

      // 打印最终统计
      const final_status = trading_engine.get_status();
      console.log('\n' + '='.repeat(80));
      console.log('📊 最终统计');
      console.log('='.repeat(80));
      console.log(`模式: ${trading_mode === TradingMode.PAPER ? '纸面交易' : trading_mode === TradingMode.TESTNET ? '测试网' : '实盘'}`);
      console.log(`初始资金: $${trading_config.initial_balance.toFixed(2)}`);
      console.log(`总交易次数: ${final_status.statistics.total_trades}`);
      console.log(`胜率: ${(final_status.statistics.win_rate * 100).toFixed(1)}%`);
      console.log(`总盈亏: ${final_status.statistics.total_pnl >= 0 ? '+' : ''}$${final_status.statistics.total_pnl.toFixed(2)}`);
      console.log(`收益率: ${(final_status.statistics.total_pnl / trading_config.initial_balance * 100).toFixed(2)}%`);
      console.log(`最终余额: $${final_status.statistics.current_balance.toFixed(2)}`);
      console.log(`剩余持仓: ${final_status.current_positions.length}个`);
      console.log('='.repeat(80));

      if (final_status.current_positions.length > 0) {
        console.log('\n⚠️  注意: 还有持仓未平仓');
        console.log('   如需平仓，请手动操作或重启引擎');
      }

      console.log('\n👋 交易引擎已关闭');
      process.exit(0);
    });

  } catch (error) {
    console.error('\n❌ 启动失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
    }
    process.exit(1);
  }
}

main();
