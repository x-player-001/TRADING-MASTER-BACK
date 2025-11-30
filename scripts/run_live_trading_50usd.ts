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

import { TradingMode, StrategyType, StrategyConfig, RiskConfig } from '../src/types/trading_types';
import { OIPollingService } from '../src/services/oi_polling_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { OICacheManager } from '../src/core/cache/oi_cache_manager';

async function main() {
  console.log('🚀 启动 $50 小资金测试交易引擎...\n');
  console.log('═'.repeat(80));

  // ⚠️ 安全警告
  console.log('\n⚠️  $50 小资金配置说明:');
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
  const trading_mode = TradingMode.LIVE;  // 🔴 实盘模式
  const initial_balance = 50;             // $50 初始资金

  console.log('\n🔴 警告: 即将使用真实资金交易!');
  console.log('   请确认已经过充分测试!');
  console.log('   5秒后继续...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 📊 $50 小资金优化配置（基于回测优化）
    const strategy_config: StrategyConfig = {
      strategy_type: StrategyType.BREAKOUT,
      enabled: true,
      min_signal_score: 8,                    // ⭐ 最低评分8分（优化后）
      min_confidence: 0.5,                    // 最低置信度50%
      min_oi_change_percent: 3,               // 最低OI变化3%
      require_price_oi_alignment: true,       // 必须价格OI同向
      price_oi_divergence_threshold: 5,
      use_sentiment_filter: false,
      min_trader_ratio: 0.8,
      max_funding_rate: 0.01,
      min_funding_rate: -0.01
    };

    const risk_config: RiskConfig = {
      max_position_size_percent: 10,          // 10%保证金 = $5
      max_total_positions: 5,                 // 最多5个仓位
      max_positions_per_symbol: 1,            // 单币种最多1个
      default_stop_loss_percent: 100,         // 无固定止损（逐仓自动限损）
      default_take_profit_percent: 8,         // 默认止盈8%（用于回退）
      use_trailing_stop: true,                // 启用跟踪止盈
      trailing_stop_callback_rate: 15,        // 回调15%触发
      // ⭐ 分批止盈配置: 30%@+7%, 30%@+13.8%, 40%跟踪止盈(激活+5%, 回调10%)
      take_profit_targets: [
        { percentage: 30, target_profit_pct: 7 },              // 第1批: 30%仓位 @+7% (PnL≈42%)
        { percentage: 30, target_profit_pct: 13.8 },           // 第2批: 30%仓位 @+13.8% (PnL≈83%)
        { percentage: 40, target_profit_pct: 0, is_trailing: true, trailing_callback_pct: 3, activation_profit_pct: 5 }  // 第3批: 40%仓位 激活+5%后开始跟踪(价格回调3%平仓)
      ],
      daily_loss_limit_percent: 20,           // 每日亏损20%暂停
      consecutive_loss_limit: 999,            // 不限制连续亏损（与回测一致）
      pause_after_loss_limit: false,          // 不暂停（与回测一致）
      max_leverage: 6,                        // 6倍杠杆
      leverage_by_signal_strength: {
        weak: 6,
        medium: 6,
        strong: 6
      }
    };

    // 📋 显示配置
    console.log('\n📋 $50 交易配置 (优化版):');
    console.log('═'.repeat(80));
    console.log(`  模式: ${trading_mode} ⚠️ (实盘)`);
    console.log(`  初始资金: $${initial_balance}`);
    console.log(`  单笔保证金: $${initial_balance * (risk_config.max_position_size_percent / 100)} (10%)`);
    console.log(`  单笔仓位值: $${initial_balance * (risk_config.max_position_size_percent / 100) * risk_config.max_leverage} (10% × 6倍)`);
    console.log(`  杠杆: ${risk_config.max_leverage}x (逐仓)`);
    console.log(`  最多持仓: ${risk_config.max_total_positions}个`);
    console.log(`  单笔最大亏损: $${initial_balance * (risk_config.max_position_size_percent / 100)} (逐仓保证金)`);
    console.log(`  策略: 只做多突破策略 (评分≥8分 ⭐)`);
    console.log(`  追高阈值: 10% ⭐ (price_from_2h_low_pct限制)`);
    console.log(`  最大持仓时间: 120分钟`);
    console.log(`  分批止盈: 30%@+7%, 30%@+13.8%, 40%跟踪止盈(10%回调) ⭐`);
    console.log(`  止损: 无 (逐仓模式自动限损)`);
    console.log(`  熔断机制: 每日亏损20%暂停`);
    console.log(`  通知推送: ✅ 已启用`);
    console.log('═'.repeat(80));

    // 风险提示
    console.log('\n⚠️  风险提示:');
    console.log('  - 最坏情况: 5个仓位同时爆仓 = -$25 (账户剩$25, -50%)');
    console.log('  - 触发每日熔断: 亏损 -$10 (账户剩$40, -20%)');
    console.log('  - 建议币种: DOGE、SHIB等低价币（避免BTCUSDT最小订单限制）');
    console.log('  - 心理准备: $50可能很快亏完，把它当学费');
    console.log('═'.repeat(80));

    // 创建OI监控服务
    const oi_service = new OIPollingService();

    // 初始化缓存管理器
    const cache_manager = new OICacheManager();
    oi_service.set_cache_manager(cache_manager);

    // 初始化情绪管理器（用于获取大户多空比等数据）
    oi_service.initialize_sentiment_manager(cache_manager);

    // 初始化交易系统（传递$50配置）
    oi_service.initialize_trading_system(true, {
      mode: trading_mode,
      initial_balance: initial_balance,  // ⭐ 传递初始资金（用于仓位计算）
      strategies: [strategy_config],
      active_strategy_type: StrategyType.BREAKOUT,
      risk_config: risk_config,
      allowed_directions: ['LONG'],  // ⚠️ 只做多
      max_holding_time_minutes: 120, // ⭐ 最大持仓时间120分钟
      enable_notifications: true     // ⭐ 启用推送通知
    });

    // 获取交易系统实例验证
    const trading_system = oi_service.get_trading_system();
    if (!trading_system) {
      throw new Error('Failed to initialize trading system');
    }

    // ⭐ 设置追高阈值为8%（避免追高）
    trading_system.set_chase_high_threshold(8);

    console.log('\n✅ 交易引擎已启动');
    console.log('✅ 追高阈值已设置为 8%');
    console.log('✅ 通知推送已启用');

    // 启动OI监控
    await oi_service.start();

    console.log('📡 OI监控已启动 (每分钟检测持仓量异动)');

    // ⭐ 启动时立即同步币安持仓
    console.log('🔄 正在同步币安持仓...');
    try {
      const sync_result = await trading_system.sync_positions_from_binance();
      if (sync_result.synced > 0) {
        console.log(`✅ 同步完成: 发现 ${sync_result.synced} 个持仓, 新增 ${sync_result.added} 个`);
      } else {
        console.log('✅ 同步完成: 无持仓');
      }
    } catch (err) {
      console.log('⚠️ 初始同步失败，将在后续定时同步');
    }

    // ⭐ 回填历史交易记录（7天内系统启动前的交易）
    console.log('📜 正在回填历史交易记录...');
    try {
      const backfill_result = await trading_system.backfill_historical_trades(7);
      if (backfill_result.newly_created > 0) {
        console.log(`✅ 回填完成: 发现 ${backfill_result.total_found} 笔, 新增 ${backfill_result.newly_created} 笔, 已存在 ${backfill_result.already_exists} 笔`);
        for (const detail of backfill_result.details) {
          console.log(`   └─ ${detail}`);
        }
      } else if (backfill_result.total_found > 0) {
        console.log(`✅ 回填完成: 发现 ${backfill_result.total_found} 笔历史交易, 全部已存在于数据库`);
      } else {
        console.log('✅ 回填完成: 无需回填的历史交易');
      }
    } catch (err) {
      console.log('⚠️ 历史交易回填失败:', err instanceof Error ? err.message : err);
    }

    // ⭐ 定时同步币安持仓（每30秒）
    setInterval(async () => {
      try {
        await trading_system.sync_positions_from_binance();
      } catch (err) {
        // 静默处理同步错误，避免刷屏
      }
    }, 10000); // 30秒同步一次

    // 状态显示函数
    const print_status = async () => {
      const oi_status = oi_service.get_status();
      const trade_status = trading_system.get_status();
      const statistics = trading_system.get_statistics();
      const open_positions = trading_system.get_open_positions();

      console.log('\n' + '='.repeat(80));
      console.log(`📊 实时状态 [${new Date().toLocaleString('zh-CN')}]`);
      console.log('='.repeat(80));

      // OI监控状态
      console.log(`OI监控: ${oi_status.is_running ? '✅ 运行中' : '❌ 已停止'} | 监控币种: ${oi_status.active_symbols_count}个 | 运行时长: ${Math.floor(oi_status.uptime_ms / 60000)}分钟`);
      console.log('-'.repeat(80));

      // 交易状态
      console.log(`交易模式: 💰 实盘 | 系统状态: ${trade_status.enabled ? '✅ 启用' : '❌ 禁用'}`);

      // 持仓统计
      const max_positions = risk_config.max_total_positions;
      console.log(`当前持仓: ${open_positions.length}/${max_positions}个`);

      // 显示持仓详情（带颜色）
      if (open_positions.length > 0) {
        open_positions.forEach(pos => {
          const pnl_sign = pos.unrealized_pnl >= 0 ? '+' : '';
          const hold_time = Math.floor((Date.now() - pos.opened_at.getTime()) / 60000);
          // ANSI颜色：绿色\x1b[32m 红色\x1b[31m 黄色\x1b[33m 青色\x1b[36m 重置\x1b[0m
          const pnl_color = pos.unrealized_pnl >= 0 ? '\x1b[32m' : '\x1b[31m'; // 盈利绿色，亏损红色
          const reset = '\x1b[0m';
          console.log(`  └─ \x1b[36m${pos.symbol}\x1b[0m: \x1b[33m${pos.side}\x1b[0m @ $${pos.entry_price.toFixed(4)} | PnL: ${pnl_color}${pnl_sign}$${pos.unrealized_pnl.toFixed(2)} (${pnl_sign}${pos.unrealized_pnl_percent.toFixed(2)}%)${reset} | 持仓: ${hold_time}分钟`);
        });
      }

      console.log('-'.repeat(80));

      // 交易统计（从数据库获取，更准确）
      try {
        const db_stats = await trading_system.get_statistics_from_db();
        const win_count = db_stats.winning_trades;
        const lose_count = db_stats.losing_trades;
        const total_trades = db_stats.total_trades;
        const win_rate = total_trades > 0 ? (win_count / total_trades * 100).toFixed(1) : '0.0';
        const pnl_sign = db_stats.total_pnl >= 0 ? '+' : '';
        const return_rate = (db_stats.total_pnl / initial_balance * 100).toFixed(2);
        const commission_sign = db_stats.total_commission > 0 ? '-' : '';
        const net_sign = db_stats.net_pnl >= 0 ? '+' : '';

        console.log(`总交易: ${total_trades}笔 | 胜率: ${win_rate}% (${win_count}胜/${lose_count}负)`);
        console.log(`总盈亏: ${pnl_sign}$${db_stats.total_pnl.toFixed(2)} (${pnl_sign}${return_rate}%) | 最大回撤: ${statistics.max_drawdown_percent.toFixed(2)}%`);
        console.log(`总手续费: ${commission_sign}$${db_stats.total_commission.toFixed(4)} | 净盈亏: ${net_sign}$${db_stats.net_pnl.toFixed(2)}`);
      } catch (err) {
        // 数据库查询失败时使用内存统计
        const win_count = statistics.winning_trades;
        const lose_count = statistics.losing_trades;
        const total_trades = statistics.total_trades;
        const win_rate = total_trades > 0 ? (win_count / total_trades * 100).toFixed(1) : '0.0';
        const pnl_sign = statistics.total_pnl >= 0 ? '+' : '';
        const return_rate = (statistics.total_pnl / initial_balance * 100).toFixed(2);

        console.log(`总交易: ${total_trades}笔 | 胜率: ${win_rate}% (${win_count}胜/${lose_count}负)`);
        console.log(`总盈亏: ${pnl_sign}$${statistics.total_pnl.toFixed(2)} (${pnl_sign}${return_rate}%) | 最大回撤: ${statistics.max_drawdown_percent.toFixed(2)}%`);
      }

      // 今日交易统计
      try {
        const today_stats = await trading_system.get_today_statistics_from_db();
        console.log('-'.repeat(80));
        const today_win_rate = today_stats.total_trades > 0
          ? (today_stats.winning_trades / today_stats.total_trades * 100).toFixed(1)
          : '0.0';
        const today_pnl_sign = today_stats.total_pnl >= 0 ? '+' : '';
        const today_net_sign = today_stats.net_pnl >= 0 ? '+' : '';
        const today_commission_sign = today_stats.total_commission > 0 ? '-' : '';
        console.log(`📅 今日交易: ${today_stats.total_trades}笔 | 胜率: ${today_win_rate}% (${today_stats.winning_trades}胜/${today_stats.losing_trades}负)`);
        console.log(`📅 今日盈亏: ${today_pnl_sign}$${today_stats.total_pnl.toFixed(2)} | 手续费: ${today_commission_sign}$${today_stats.total_commission.toFixed(4)} | 净盈亏: ${today_net_sign}$${today_stats.net_pnl.toFixed(2)}`);
      } catch (err) {
        // 数据库查询失败时静默处理
      }

      console.log('='.repeat(80) + '\n');
    };

    // 启动时立即打印一次状态
    await print_status();

    console.log('⏳ 等待高质量交易信号...\n');

    // 状态显示间隔（2分钟）
    setInterval(print_status, 120000);

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 正在关闭交易引擎...');

      // 停止OI监控
      await oi_service.stop();
      console.log('✅ OI监控已停止');

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
