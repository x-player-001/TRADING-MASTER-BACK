/**
 * 诊断保证金不足问题
 * 运行: npx ts-node -r tsconfig-paths/register scripts/diagnose_margin.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { BinanceFuturesTradingAPI } from '../src/api/binance_futures_trading_api';

// 使用实盘API密钥
const api_key = process.env.BINANCE_TRADE_API_KEY || process.env.BINANCE_API_KEY;
const secret_key = process.env.BINANCE_TRADE_SECRET || process.env.BINANCE_API_SECRET;

const api = new BinanceFuturesTradingAPI(api_key, secret_key, false);

async function diagnose() {
  try {
    // 1. 获取账户信息
    console.log('===== 账户信息 =====');
    const account = await api.get_account_info();
    console.log('总权益 (totalWalletBalance):', account.totalWalletBalance);
    console.log('可用余额 (availableBalance):', account.availableBalance);
    console.log('总未实现盈亏 (totalUnrealizedProfit):', account.totalUnrealizedProfit);
    console.log('总保证金余额 (totalMarginBalance):', account.totalMarginBalance);
    console.log('仓位保证金 (totalPositionInitialMargin):', account.totalPositionInitialMargin);
    console.log('挂单保证金 (totalOpenOrderInitialMargin):', account.totalOpenOrderInitialMargin);

    // 2. 检查当前持仓
    console.log('\n===== 当前持仓 =====');
    const positions = account.positions?.filter((p: any) => parseFloat(p.positionAmt) !== 0);
    if (positions && positions.length > 0) {
      positions.forEach((p: any) => {
        console.log(`${p.symbol}: 数量=${p.positionAmt}, 保证金=${p.isolatedWallet}, 杠杆=${p.leverage}x, 未实现盈亏=${p.unrealizedProfit}`);
      });
    } else {
      console.log('无持仓');
    }

    // 3. 检查挂单
    console.log('\n===== 当前挂单 =====');
    const orders = await api.get_open_orders();
    if (orders && orders.length > 0) {
      orders.forEach((o: any) => {
        console.log(`${o.symbol}: 类型=${o.type}, 方向=${o.side}, 数量=${o.origQty}`);
      });
    } else {
      console.log('无挂单');
    }

    // 4. 模拟计算下单参数
    console.log('\n===== 下单计算模拟 =====');
    const initial_balance = 50;
    const margin_percent = 10;
    const leverage = 6;

    const margin = initial_balance * margin_percent / 100;
    const position_value = margin * leverage;

    // 假设 RECALLUSDT 价格
    const price = 0.03; // 假设价格
    const quantity = position_value / price;

    console.log(`初始资金: $${initial_balance}`);
    console.log(`保证金比例: ${margin_percent}%`);
    console.log(`保证金: $${margin}`);
    console.log(`杠杆: ${leverage}x`);
    console.log(`仓位价值: $${position_value}`);
    console.log(`币价(假设): $${price}`);
    console.log(`下单数量: ${quantity}`);

    console.log('\n===== 可用余额判断 =====');
    const available = parseFloat(account.availableBalance);
    console.log(`可用余额: $${available.toFixed(4)}`);
    console.log(`所需保证金: $${margin}`);
    console.log(`是否足够: ${available >= margin ? '✅ 足够' : '❌ 不足'}`);

  } catch (error) {
    console.error('诊断失败:', error);
  }

  process.exit(0);
}

diagnose();
