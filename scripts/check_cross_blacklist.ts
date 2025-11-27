/**
 * 检查CROSS是否在黑名单中
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../src/database/oi_repository';
import { ConfigManager } from '../src/core/config/config_manager';

async function check_blacklist() {
  console.log('🔍 检查CROSS是否在黑名单中...\n');

  try {
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    const oi_repo = new OIRepository();

    // 获取黑名单配置
    const configs = await oi_repo.get_monitoring_config('symbol_blacklist');

    if (configs.length === 0) {
      console.log('✅ 没有黑名单配置，CROSS不受影响\n');
      process.exit(0);
    }

    const config_value = configs[0].config_value;
    const blacklist = JSON.parse(config_value) as string[];

    console.log(`📋 当前黑名单: ${blacklist.join(', ')}\n`);

    // 检查CROSS或CROSSUSDT是否在黑名单中
    const is_cross_blocked = blacklist.some(blocked =>
      'CROSSUSDT'.includes(blocked) || blocked.includes('CROSS')
    );

    if (is_cross_blocked) {
      console.log('❌ CROSSUSDT 被黑名单过滤！');
      console.log(`   原因: 黑名单包含关键词，导致 CROSSUSDT.includes(blocked) = true\n`);

      // 找出具体是哪个关键词
      const matched_keywords = blacklist.filter(blocked =>
        'CROSSUSDT'.includes(blocked) || blocked.includes('CROSS')
      );
      console.log(`   匹配的关键词: ${matched_keywords.join(', ')}\n`);
      console.log(`⚠️  这就是为什么CROSSUSDT在回测中没有交易！`);
    } else {
      console.log('✅ CROSSUSDT 没有被黑名单过滤\n');
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ 检查失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
    }
    process.exit(1);
  }
}

check_blacklist();
