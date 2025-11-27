/**
 * 币安实盘API功能测试
 *
 * 测试流程：
 * 1. 检查账户余额
 * 2. 设置逐仓模式和杠杆
 * 3. 开仓 BTC 多单（约$1）
 * 4. 查询持仓
 * 5. 平仓
 * 6. 验证结果
 *
 * ⚠️ 警告: 本脚本使用实盘API，会使用真实资金进行交易！
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BinanceFuturesTradingAPI, OrderSide, PositionSide, PositionInfo } from '../src/api/binance_futures_trading_api';
import { BinanceFuturesAPI } from '../src/api/binance_futures_api';
import { logger } from '../src/utils/logger';

async function test_binance_api() {
  console.log('🔴 币安实盘API功能测试\n');
  console.log('═'.repeat(80));

  try {
    // 检查环境变量 - 使用交易专用API密钥
    const api_key = process.env.BINANCE_TRADE_API_KEY || process.env.BINANCE_API_KEY;
    const secret_key = process.env.BINANCE_TRADE_SECRET || process.env.BINANCE_API_SECRET;

    if (!api_key || !secret_key) {
      throw new Error('缺少API密钥配置，请在.env文件中配置 BINANCE_TRADE_API_KEY 和 BINANCE_TRADE_SECRET');
    }

    console.log('✅ API密钥配置检查通过\n');

    // 创建API客户端（实盘模式）
    const trading_api = new BinanceFuturesTradingAPI(api_key, secret_key, false);
    const binance_api = new BinanceFuturesAPI(50, api_key, secret_key);

    const symbol = 'BTCUSDT';
    const leverage = 10;  // 10倍杠杆
    const margin_amount = 1;  // $1 保证金

    console.log('📋 测试参数:');
    console.log(`  交易对: ${symbol}`);
    console.log(`  保证金: $${margin_amount}`);
    console.log(`  杠杆: ${leverage}x`);
    console.log(`  预计仓位价值: $${margin_amount * leverage}\n`);

    // ========================================
    // 第1步：查询账户余额
    // ========================================
    console.log('📊 [1/6] 查询账户信息...');
    const account = await trading_api.get_account_info();
    const usdt_balance = parseFloat(account.availableBalance);
    console.log(`  可用余额: ${usdt_balance.toFixed(2)} USDT`);

    if (usdt_balance < margin_amount) {
      throw new Error(`余额不足！当前余额: ${usdt_balance.toFixed(2)} USDT，需要至少: ${margin_amount} USDT`);
    }
    console.log('  ✅ 余额充足\n');

    // ========================================
    // 第2步：获取BTC当前价格
    // ========================================
    console.log('💰 [2/6] 获取BTC当前价格...');
    const ticker = await binance_api.get_24hr_ticker(symbol);
    const current_price = parseFloat(ticker.lastPrice);
    console.log(`  当前价格: $${current_price.toFixed(2)}`);

    // 计算购买数量（保留3位小数，BTC最小精度通常是0.001）
    const quantity = parseFloat((margin_amount * leverage / current_price).toFixed(3));
    console.log(`  计算数量: ${quantity} BTC (价值约$${(quantity * current_price).toFixed(2)})\n`);

    // ========================================
    // 第3步：设置逐仓模式和杠杆
    // ========================================
    console.log('⚙️  [3/6] 配置交易参数...');

    try {
      await trading_api.set_margin_type(symbol, 'ISOLATED');
      console.log('  ✅ 已设置为逐仓模式');
    } catch (error: any) {
      if (error.message?.includes('-4046') || error.message?.includes('No need to change')) {
        console.log('  ℹ️  已经是逐仓模式');
      } else {
        throw error;
      }
    }

    await trading_api.set_leverage(symbol, leverage);
    console.log(`  ✅ 杠杆已设置为 ${leverage}x\n`);

    // ========================================
    // 第4步：开仓做多
    // ========================================
    console.log('🚀 [4/6] 开仓做多...');
    console.log(`  下单: BUY ${quantity} BTC @ 市价`);

    const entry_order = await trading_api.place_market_order(
      symbol,
      OrderSide.BUY,
      quantity,
      PositionSide.LONG,
      false  // 不是reduceOnly
    );

    console.log('  ✅ 开仓成功!');
    console.log(`  订单ID: ${entry_order.orderId}`);
    console.log(`  状态: ${entry_order.status}`);
    console.log(`  成交数量: ${entry_order.executedQty} BTC`);
    console.log(`  成交均价: $${parseFloat(entry_order.avgPrice || entry_order.price).toFixed(2)}\n`);

    const entry_price = parseFloat(entry_order.avgPrice || entry_order.price);

    // ========================================
    // 第5步：查询持仓
    // ========================================
    console.log('📍 [5/6] 查询当前持仓...');

    // 等待1秒确保持仓更新
    await new Promise(resolve => setTimeout(resolve, 1000));

    const positions: PositionInfo[] = await trading_api.get_position_info();
    const btc_position = positions.find((p: PositionInfo) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

    if (!btc_position) {
      console.log('  ⚠️  未找到持仓，可能已被强平或订单未成交');
    } else {
      const position_amt = parseFloat(btc_position.positionAmt);
      const unrealized_pnl = parseFloat(btc_position.unRealizedProfit);
      const mark_price = parseFloat(btc_position.markPrice);

      console.log('  ✅ 持仓信息:');
      console.log(`     仓位: ${position_amt} BTC`);
      console.log(`     入场价: $${parseFloat(btc_position.entryPrice).toFixed(2)}`);
      console.log(`     标记价: $${mark_price.toFixed(2)}`);
      console.log(`     未实现盈亏: ${unrealized_pnl >= 0 ? '+' : ''}$${unrealized_pnl.toFixed(2)}`);
      console.log(`     杠杆: ${btc_position.leverage}x\n`);
    }

    // ========================================
    // 第6步：平仓
    // ========================================
    console.log('🔚 [6/6] 平仓...');
    console.log(`  下单: SELL ${quantity} BTC @ 市价`);

    const close_order = await trading_api.place_market_order(
      symbol,
      OrderSide.SELL,
      quantity,
      PositionSide.LONG,
      true  // reduceOnly = true，只平仓不开新仓
    );

    console.log('  ✅ 平仓成功!');
    console.log(`  订单ID: ${close_order.orderId}`);
    console.log(`  状态: ${close_order.status}`);
    console.log(`  成交数量: ${close_order.executedQty} BTC`);
    console.log(`  成交均价: $${parseFloat(close_order.avgPrice || close_order.price).toFixed(2)}\n`);

    const exit_price = parseFloat(close_order.avgPrice || close_order.price);

    // ========================================
    // 第7步：计算盈亏
    // ========================================
    console.log('💹 交易结果:');
    console.log('═'.repeat(80));

    const price_diff = exit_price - entry_price;
    const pnl = price_diff * quantity;
    const pnl_percent = (price_diff / entry_price) * 100;
    const actual_pnl = pnl * leverage;  // 实际盈亏（考虑杠杆）

    console.log(`  入场价格: $${entry_price.toFixed(2)}`);
    console.log(`  出场价格: $${exit_price.toFixed(2)}`);
    console.log(`  价格变化: ${price_diff >= 0 ? '+' : ''}$${price_diff.toFixed(2)} (${pnl_percent >= 0 ? '+' : ''}${pnl_percent.toFixed(4)}%)`);
    console.log(`  实际盈亏: ${actual_pnl >= 0 ? '+' : ''}$${actual_pnl.toFixed(4)}`);

    // 手续费估算（Maker: 0.02%, Taker: 0.04%）
    const fee = (quantity * entry_price + quantity * exit_price) * 0.0004;
    const net_pnl = actual_pnl - fee;
    console.log(`  预估手续费: -$${fee.toFixed(4)}`);
    console.log(`  净盈亏: ${net_pnl >= 0 ? '+' : ''}$${net_pnl.toFixed(4)}`);

    console.log('═'.repeat(80));

    // ========================================
    // 第8步：最终验证
    // ========================================
    console.log('\n🔍 最终验证...');

    await new Promise(resolve => setTimeout(resolve, 1000));

    const final_positions: PositionInfo[] = await trading_api.get_position_info();
    const final_btc_position = final_positions.find((p: PositionInfo) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

    if (final_btc_position) {
      console.log(`  ⚠️  警告: 仍有持仓 ${parseFloat(final_btc_position.positionAmt)} BTC，可能未完全平仓`);
    } else {
      console.log('  ✅ 确认: 持仓已完全平仓');
    }

    const final_account = await trading_api.get_account_info();
    const final_balance = parseFloat(final_account.availableBalance);
    const balance_change = final_balance - usdt_balance;

    console.log(`  初始余额: ${usdt_balance.toFixed(2)} USDT`);
    console.log(`  最终余额: ${final_balance.toFixed(2)} USDT`);
    console.log(`  余额变化: ${balance_change >= 0 ? '+' : ''}${balance_change.toFixed(4)} USDT\n`);

    console.log('═'.repeat(80));
    console.log('✅ 测试完成！API功能正常');
    console.log('═'.repeat(80));

    console.log('\n📝 测试总结:');
    console.log(`  • 开仓订单: ${entry_order.orderId} (${entry_order.status})`);
    console.log(`  • 平仓订单: ${close_order.orderId} (${close_order.status})`);
    console.log(`  • 交易对: ${symbol}`);
    console.log(`  • 数量: ${quantity} BTC`);
    console.log(`  • 杠杆: ${leverage}x (逐仓)`);
    console.log(`  • 净盈亏: ${net_pnl >= 0 ? '+' : ''}$${net_pnl.toFixed(4)}`);
    console.log(`  • 余额变化: ${balance_change >= 0 ? '+' : ''}${balance_change.toFixed(4)} USDT`);

  } catch (error: any) {
    console.error('\n❌ 测试失败:', error.message);

    if (error.response?.data) {
      console.error('API错误详情:', JSON.stringify(error.response.data, null, 2));
    }

    if (error.message?.includes('API key')) {
      console.error('\n💡 提示: 请检查.env文件中的API密钥配置');
      console.error('   BINANCE_TRADE_API_KEY=你的实盘交易API_KEY');
      console.error('   BINANCE_TRADE_SECRET=你的实盘交易SECRET_KEY');
    }

    if (error.message?.includes('Insufficient')) {
      console.error('\n💡 提示: 账户余额不足，请充值后再试');
      console.error('   币安合约账户: https://www.binance.com/zh-CN/futures/BTCUSDT');
    }

    process.exit(1);
  }
}

// 运行测试
console.log('🔴🔴🔴 警告: 本脚本使用币安实盘API，会使用真实资金进行交易！🔴🔴🔴\n');
console.log('⚠️  确保你已经：');
console.log('   1. 配置了正确的实盘API密钥（BINANCE_TRADE_API_KEY）');
console.log('   2. 账户有足够的USDT余额（至少$2）');
console.log('   3. 理解并接受可能的资金损失风险');
console.log('\n如需安全测试，请使用测试网脚本: npm run test:api:testnet\n');

test_binance_api()
  .then(() => {
    console.log('\n🎉 测试脚本执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 程序异常退出:', error);
    process.exit(1);
  });
