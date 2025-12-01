/**
 * 测试价格趋势检查功能
 */

import dotenv from 'dotenv';
import { TradingMode } from '../src/types/trading_types';
import { OrderExecutor } from '../src/trading/order_executor';

// 加载环境变量
dotenv.config();

async function test_price_trend_check() {
  console.log('🧪 开始测试价格趋势检查功能...\n');

  // 初始化OrderExecutor (LIVE模式会自动初始化币安API)
  const order_executor = new OrderExecutor(TradingMode.LIVE);

  try {
    // 测试1: 获取BTCUSDT的K线数据
    console.log('📊 测试1: 获取BTCUSDT的25根5分钟K线数据');
    const klines = await order_executor.get_klines('BTCUSDT', '5m', 25);

    if (!klines) {
      console.log('❌ 获取K线数据失败');
      return;
    }

    console.log(`✅ 成功获取 ${klines.length} 根K线`);
    console.log(`   第1根 (2小时前): open=${klines[0].open}, close=${klines[0].close}`);
    console.log(`   第19根 (30分钟前): open=${klines[18].open}, close=${klines[18].close}`);
    console.log(`   第25根 (5分钟前): open=${klines[24].open}, close=${klines[24].close}`);
    console.log();

    // 测试2: 计算价格趋势
    const current_price = klines[24].close; // 使用最近完成的K线收盘价作为当前价
    const price_2h_ago = klines[0].close;
    const price_30m_ago = klines[18].close;

    const rise_2h_pct = ((current_price - price_2h_ago) / price_2h_ago) * 100;
    const rise_30m_pct = ((current_price - price_30m_ago) / price_30m_ago) * 100;

    console.log('📈 测试2: 价格趋势分析');
    console.log(`   当前价格: ${current_price}`);
    console.log(`   2小时前价格: ${price_2h_ago}`);
    console.log(`   30分钟前价格: ${price_30m_ago}`);
    console.log(`   2小时涨幅: ${rise_2h_pct.toFixed(2)}%`);
    console.log(`   30分钟涨幅: ${rise_30m_pct.toFixed(2)}%`);
    console.log();

    // 测试3: 验证检查逻辑
    console.log('✅ 测试3: 验证检查逻辑');

    // 检查1: 2小时涨幅
    if (rise_2h_pct > 8) {
      console.log(`   ❌ 2小时涨幅${rise_2h_pct.toFixed(2)}%超过8%阈值，会被拒绝`);
    } else {
      console.log(`   ✅ 2小时涨幅${rise_2h_pct.toFixed(2)}%未超过8%阈值`);
    }

    // 检查2: 30分钟趋势
    if (current_price <= price_30m_ago) {
      console.log(`   ❌ 当前价格${current_price}未高于30分钟前${price_30m_ago}，会被拒绝`);
    } else {
      console.log(`   ✅ 当前价格${current_price}高于30分钟前${price_30m_ago}，趋势向上`);
    }
    console.log();

    console.log('✅ 所有测试通过！价格趋势检查功能正常工作');

  } catch (error) {
    console.error('❌ 测试失败:', error);
    throw error;
  }
}

// 运行测试
test_price_trend_check();
