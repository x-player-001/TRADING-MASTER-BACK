/**
 * OI监控最大币种数配置测试
 * 测试环境变量和数据库配置是否正常工作
 */

import { BinanceFuturesAPI } from '../api/binance_futures_api';
import { logger } from '../utils/logger';

async function test_max_symbols_config() {
  logger.info('========================================');
  logger.info('OI监控最大币种数配置测试');
  logger.info('========================================\n');

  const binance_api = new BinanceFuturesAPI();

  // 测试1: 默认参数 (300个)
  logger.info('【测试1】默认参数 (应返回300个币种)');
  try {
    const symbols_default = await binance_api.get_usdt_perpetual_symbols();
    logger.info(`✅ 成功获取 ${symbols_default.length} 个币种`);
    logger.info(`   前5个: ${symbols_default.slice(0, 5).map(s => s.symbol).join(', ')}\n`);
  } catch (error) {
    logger.error('❌ 测试失败:', error);
  }

  // 测试2: 限制10个
  logger.info('【测试2】限制10个币种');
  try {
    const symbols_10 = await binance_api.get_usdt_perpetual_symbols(10);
    logger.info(`✅ 成功获取 ${symbols_10.length} 个币种`);
    logger.info(`   币种列表: ${symbols_10.map(s => s.symbol).join(', ')}\n`);
  } catch (error) {
    logger.error('❌ 测试失败:', error);
  }

  // 测试3: 不限制 ('max')
  logger.info('【测试3】不限制数量 (max)');
  try {
    const symbols_max = await binance_api.get_usdt_perpetual_symbols('max');
    logger.info(`✅ 成功获取 ${symbols_max.length} 个币种 (全部)`);
    logger.info(`   前10个: ${symbols_max.slice(0, 10).map(s => s.symbol).join(', ')}`);
    logger.info(`   后10个: ${symbols_max.slice(-10).map(s => s.symbol).join(', ')}\n`);
  } catch (error) {
    logger.error('❌ 测试失败:', error);
  }

  // 测试4: 环境变量读取
  logger.info('【测试4】环境变量配置');
  const env_value = process.env.OI_MAX_MONITORED_SYMBOLS;
  if (env_value) {
    logger.info(`✅ 环境变量 OI_MAX_MONITORED_SYMBOLS = ${env_value}`);
    if (env_value.toLowerCase() === 'max') {
      logger.info('   配置为不限制 (max)\n');
    } else {
      const parsed = parseInt(env_value);
      if (!isNaN(parsed) && parsed > 0) {
        logger.info(`   配置为限制 ${parsed} 个币种\n`);
      } else {
        logger.warn('   ⚠️  配置值无效\n');
      }
    }
  } else {
    logger.warn('⚠️  环境变量未设置，将使用默认值 (300)\n');
  }

  logger.info('========================================');
  logger.info('测试完成');
  logger.info('========================================');
}

// 运行测试
test_max_symbols_config()
  .then(() => {
    logger.info('\n所有测试执行完毕');
    process.exit(0);
  })
  .catch(error => {
    logger.error('测试执行失败:', error);
    process.exit(1);
  });
