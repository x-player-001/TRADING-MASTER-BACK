/**
 * K线密集区突破监控启动脚本
 *
 * 功能说明:
 * - WebSocket 订阅所有合约的 5m K线
 * - K线完结时分析是否突破密集成交区间
 * - 突破信号保存到数据库
 *
 * 密集区算法:
 * - 使用成交量分桶法
 * - 分析最近 50 根 5m K线（约4小时）
 * - 成交量最集中的价格区间 = 密集区
 *
 * 突破条件:
 * - 收盘价突破密集区上/下沿
 * - 阳线/阴线确认方向
 * - 成交量 > 平均成交量 × 1.5（放量）
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_kline_breakout_monitor.ts
 */

// 加载环境变量
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { KlineBreakoutService } from '../src/services/kline_breakout_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { logger } from '../src/utils/logger';

// ==================== 配置 ====================
const CONFIG = {
  // K线缓存数量（用于计算密集区）
  kline_cache_size: 50,

  // 信号冷却时间（分钟）
  signal_cooldown_minutes: 30,

  // 只监控向上突破（做多），还是双向
  // ['UP'] = 只做多
  // ['DOWN'] = 只做空
  // ['UP', 'DOWN'] = 双向
  allowed_directions: ['UP', 'DOWN'] as ('UP' | 'DOWN')[],

  // 状态打印间隔（毫秒）
  status_interval_ms: 60000  // 每分钟打印一次状态
};

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(80));
  console.log('                    K线密集区突破监控系统');
  console.log('═'.repeat(80));

  console.log('\n📋 配置说明:');
  console.log(`   - K线周期: 5m`);
  console.log(`   - 密集区计算: 最近 ${CONFIG.kline_cache_size} 根K线（约${Math.round(CONFIG.kline_cache_size * 5 / 60)}小时）`);
  console.log(`   - 算法: 成交量分桶法（20个价格桶，连续3桶为密集区）`);
  console.log(`   - 放量阈值: 1.5x 平均成交量`);
  console.log(`   - 监控方向: ${CONFIG.allowed_directions.join(', ')}`);
  console.log(`   - 信号冷却: ${CONFIG.signal_cooldown_minutes} 分钟`);
  console.log('═'.repeat(80));

  // 初始化配置管理器（数据库连接必需）
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();
  console.log('\n✅ 配置管理器已初始化');

  // 创建服务
  const service = new KlineBreakoutService({
    kline_cache_size: CONFIG.kline_cache_size,
    signal_cooldown_minutes: CONFIG.signal_cooldown_minutes,
    allowed_directions: CONFIG.allowed_directions
  });

  // 监听突破信号
  service.on('breakout_signal', (signal) => {
    // 信号已在 service 内部打印，这里可以添加额外处理
    // 例如：推送通知、触发交易等
  });

  // 启动服务
  console.log('\n🚀 正在启动服务...\n');

  try {
    await service.start();
    console.log('\n✅ 服务启动成功');
  } catch (error) {
    console.error('❌ 服务启动失败:', error);
    process.exit(1);
  }

  // 定期打印状态
  setInterval(async () => {
    const status = service.get_status();
    const uptime = Math.round((Date.now() - status.stats.start_time) / 60000);

    // 获取数据库统计
    let db_stats = { today_count: 0, today_symbols: 0, buffer_size: 0 };
    try {
      db_stats = await service.get_kline_db_statistics();
    } catch {
      // 忽略错误
    }

    console.log('\n📊 [状态报告]');
    console.log(`   运行时间: ${uptime} 分钟`);
    console.log(`   WebSocket 连接: ${status.connections.filter(c => c.connected).length}/${status.connections.length}`);
    console.log(`   监控币种: ${status.symbols_count}`);
    console.log(`   缓存币种: ${status.cached_symbols}`);
    console.log(`   K线接收: ${status.stats.total_klines_received}`);
    console.log(`   K线入库: ${db_stats.today_count} (${db_stats.today_symbols}币种, 缓冲${db_stats.buffer_size})`);
    console.log(`   突破信号: ${status.stats.total_signals} (UP: ${status.stats.up_signals}, DOWN: ${status.stats.down_signals})`);
  }, CONFIG.status_interval_ms);

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n\n⏹️  收到退出信号，正在停止服务...');
    await service.stop();
    console.log('👋 服务已停止');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n⏹️  收到终止信号，正在停止服务...');
    await service.stop();
    process.exit(0);
  });

  // 保持进程运行
  console.log('\n📡 正在监控所有合约的 5m K线...');
  console.log('   按 Ctrl+C 停止服务\n');
}

// 运行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
