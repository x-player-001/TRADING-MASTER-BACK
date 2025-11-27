/**
 * 实盘交易启动脚本 - 使用回测优化参数
 *
 * 配置说明:
 * - 只做多 (做空盈利能力差)
 * - 20%@+10%, 20%@+16%, 60%跟踪止盈(10%回调)
 * - 无固定止损 (逐仓模式自动限损)
 * - 120分钟超时平仓
 * - 5倍杠杆
 *
 * 回测表现:
 * - 7天收益率: +40.77%
 * - 盈亏比: 2.21
 * - 年化收益: >2000%
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_live_trading_optimized.ts
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
  console.log('🚀 启动实盘交易引擎 (回测优化版本)...\n');
  console.log('═'.repeat(80));

  // ⚠️ 安全警告
  console.log('\n⚠️  安全警告:');
  console.log('   - 默认模式: PAPER (纸面交易,不下真实订单)');
  console.log('   - 测试网模式: 修改为 TradingMode.TESTNET');
  console.log('   - 实盘模式: 修改为 TradingMode.LIVE (⚠️ 真实资金!)');
  console.log('\n   建议流程: PAPER测试 → TESTNET验证 → LIVE小资金试运行\n');
  console.log('═'.repeat(80));

  // ⚠️ 用户确认
  const trading_mode = TradingMode.PAPER;  // 🔒 安全模式，不下真实订单

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

    // 📊 回测优化后的最佳配置
    const trading_config: LiveTradingConfig = {
      // 交易模式
      mode: trading_mode,

      // 初始资金 (建议小资金开始: $100-$500)
      initial_balance: 100,  // ⚠️ 建议从小资金开始

      // 策略配置 - 只做多突破策略
      strategy_config: {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 7,                    // 最低评分7分 (高质量信号)
        min_confidence: 0.5,                    // 置信度50%
        min_oi_change_percent: 3,               // OI变化≥3%
        require_price_oi_alignment: true,       // 必须价格OI同向
        price_oi_divergence_threshold: 5,
        use_sentiment_filter: false,            // 不使用情绪过滤
        min_trader_ratio: 0.8,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      },

      // 风险配置 - 逐仓模式
      risk_config: {
        max_position_size_percent: 5,           // 单笔5% ($5 / $100)
        max_total_positions: 999,               // 不限制总仓位数
        max_positions_per_symbol: 1,            // 单币种最多1个仓位
        default_stop_loss_percent: 100,         // 不使用固定止损 (逐仓自动限损)
        default_take_profit_percent: 10,        // 第一批止盈10%
        use_trailing_stop: true,                // 启用跟踪止盈
        trailing_stop_callback_rate: 10,        // 回调10%触发
        daily_loss_limit_percent: 100,          // 不限制每日亏损
        consecutive_loss_limit: 999,            // 不限制连续亏损
        pause_after_loss_limit: false,
        max_leverage: 5,                        // 5倍杠杆
        leverage_by_signal_strength: {
          weak: 5,
          medium: 5,
          strong: 5
        }
      },

      // 分批止盈配置 ✨ 核心优势
      dynamic_take_profit: {
        targets: [
          {
            percentage: 20,                     // 第1批: 20%仓位
            price: 0,
            target_profit_pct: 10,              // +10%止盈
            is_trailing: false
          },
          {
            percentage: 20,                     // 第2批: 20%仓位
            price: 0,
            target_profit_pct: 16,              // +16%止盈
            is_trailing: false
          },
          {
            percentage: 60,                     // 第3批: 60%仓位
            price: 0,
            target_profit_pct: 0,
            is_trailing: true,                  // 跟踪止盈
            trailing_callback_pct: 10           // 回调10%触发
          }
        ],
        enable_trailing: true,
        trailing_start_profit_pct: 10           // 盈利10%后启动跟踪
      },

      // 方向过滤 - 只做多 ✨
      allowed_directions: ['LONG'],

      // 持仓时间限制 - 2小时超时平仓
      max_holding_time_minutes: 120
    };

    // 📋 显示配置
    console.log('\n📋 交易配置 (回测优化版):');
    console.log('═'.repeat(80));
    console.log(`  模式: ${trading_config.mode} ${trading_mode === TradingMode.PAPER ? '(纸面交易)' : trading_mode === TradingMode.TESTNET ? '(测试网)' : '⚠️ (实盘)'}`);
    console.log(`  初始资金: $${trading_config.initial_balance}`);
    console.log(`  策略: 只做多突破策略 (评分≥7分)`);
    console.log(`  止盈: 20%@+10%, 20%@+16%, 60%跟踪@10%回调`);
    console.log(`  止损: 无 (逐仓模式自动限损)`);
    console.log(`  杠杆: ${trading_config.risk_config.max_leverage}x (逐仓)`);
    console.log(`  超时平仓: ${trading_config.max_holding_time_minutes}分钟`);
    console.log(`  回测表现: +40.77% (7天), 盈亏比2.21`);
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
      console.log(`当前持仓: ${status.current_positions.length}个`);
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
          console.log(`  ${idx + 1}. ${pos.symbol} ${pos.side} @ $${pos.entry_price.toFixed(4)}`);
          console.log(`     持仓: ${holding_time}min | 盈亏: ${pnl_pct}% | 当前价: $${pos.current_price.toFixed(4)}`);
          console.log(`     止盈: $${pos.take_profit_price?.toFixed(4)} | 跟踪止盈: ${pos.trailing_stop_active ? '✅' : '❌'}`);
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
      console.log(`运行时长: ${Math.floor((Date.now() - Date.now()) / 60000)}分钟`);
      console.log(`总交易次数: ${final_status.statistics.total_trades}`);
      console.log(`胜率: ${(final_status.statistics.win_rate * 100).toFixed(1)}%`);
      console.log(`总盈亏: ${final_status.statistics.total_pnl >= 0 ? '+' : ''}$${final_status.statistics.total_pnl.toFixed(2)}`);
      console.log(`收益率: ${(final_status.statistics.total_pnl / trading_config.initial_balance * 100).toFixed(2)}%`);
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
