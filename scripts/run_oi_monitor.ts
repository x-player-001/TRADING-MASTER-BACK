/**
 * 纯 OI 监控脚本
 * 只运行 OI 异动监控，不进行交易
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_oi_monitor.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIPollingService } from '../src/services/oi_polling_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { OICacheManager } from '../src/core/cache/oi_cache_manager';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('🚀 启动 OI 监控服务（仅监控，不交易）...\n');
  console.log('═'.repeat(60));

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();
    console.log('✅ 配置已加载');

    // 创建 OI 监控服务
    const oi_service = new OIPollingService();

    // 初始化缓存管理器
    const cache_manager = new OICacheManager();
    oi_service.set_cache_manager(cache_manager);
    console.log('✅ 缓存管理器已初始化');

    // 初始化情绪管理器（用于信号评分）
    oi_service.initialize_sentiment_manager(cache_manager);
    console.log('✅ 情绪管理器已初始化');

    // 不初始化交易系统，只监控

    // 启动 OI 监控
    await oi_service.start();
    console.log('✅ OI 监控已启动');

    console.log('═'.repeat(60));
    console.log('\n📡 正在监控 OI 异动...\n');
    console.log('提示: 按 Ctrl+C 停止监控\n');

    // 状态显示
    const print_status = () => {
      const status = oi_service.get_status();
      const interval_sec = Math.round((status.config?.polling_interval_ms || 60000) / 1000);
      console.log(`[${new Date().toLocaleString('zh-CN')}] OI监控: ${status.is_running ? '✅ 运行中' : '❌ 已停止'} | 监控币种: ${status.active_symbols_count}个 | 轮询间隔: ${interval_sec}秒`);
    };

    // 立即打印状态
    print_status();

    // 每5分钟打印一次状态
    setInterval(print_status, 300000);

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 正在关闭 OI 监控...');
      await oi_service.stop();
      console.log('✅ OI 监控已停止');
      console.log('\n👋 再见');
      process.exit(0);
    });

  } catch (error) {
    console.error('\n❌ 启动失败:', error);
    process.exit(1);
  }
}

main();
