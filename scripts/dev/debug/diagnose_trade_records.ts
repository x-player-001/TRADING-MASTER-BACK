/**
 * 诊断脚本：调查 7 笔 PnL 记录 vs 6 笔交易记录的差异
 *
 * 这个脚本会：
 * 1. 查询币安账户的 PnL 记录（过去 7 天）
 * 2. 查询数据库中的交易记录
 * 3. 对比找出缺失的记录
 *
 * 运行命令（在服务器上）:
 * npx ts-node -r tsconfig-paths/register scripts/dev/debug/diagnose_trade_records.ts
 */

import dotenv from 'dotenv';
import path from 'path';

// 确保从项目根目录加载 .env
const env_path = path.resolve(__dirname, '../../../.env');
console.log(`📁 加载环境变量: ${env_path}`);
const result = dotenv.config({ path: env_path });
if (result.error) {
  console.error('❌ 加载 .env 失败:', result.error.message);
} else {
  console.log('✅ .env 加载成功');
}

// 检查关键环境变量（支持两种命名方式）
const api_key = process.env.BINANCE_TRADE_API_KEY || process.env.BINANCE_API_KEY;
const api_secret = process.env.BINANCE_TRADE_SECRET || process.env.BINANCE_API_SECRET;

console.log(`🔑 API_KEY: ${api_key ? '已设置 (' + api_key.substring(0, 8) + '...)' : '❌ 未设置'}`);
console.log(`🔑 API_SECRET: ${api_secret ? '已设置 (长度:' + api_secret.length + ')' : '❌ 未设置'}`);

if (!api_key || !api_secret) {
  console.error('\n❌ 缺少API密钥配置！请检查.env文件中的 BINANCE_TRADE_API_KEY 和 BINANCE_TRADE_SECRET');
  process.exit(1);
}

import { ConfigManager } from '../../../src/core/config/config_manager';
import { DatabaseConfig } from '../../../src/core/config/database';
import { BinanceFuturesTradingAPI } from '../../../src/api/binance_futures_trading_api';

async function main() {
  console.log('\n🔧 诊断脚本启动...');

  console.log('═'.repeat(80));
  console.log('📊 交易记录诊断工具');
  console.log('═'.repeat(80));

  // 初始化配置
  console.log('⏳ 初始化配置...');
  ConfigManager.getInstance().initialize();
  console.log('✅ 配置初始化完成');

  // 使用正确的API密钥创建客户端
  console.log('⏳ 创建API客户端...');
  const api = new BinanceFuturesTradingAPI(api_key, api_secret);
  console.log('✅ API客户端创建完成');

  console.log('⏳ 获取数据库连接...');
  const conn = await DatabaseConfig.get_mysql_connection();
  console.log('✅ 数据库连接成功');

  try {
    // 1. 获取币安 PnL 记录（过去 7 天）
    console.log('\n📈 步骤 1: 获取币安 PnL 记录...');
    const endTime = Date.now();
    const startTime = endTime - 7 * 24 * 60 * 60 * 1000;
    const raw_pnl_records = await api.get_income({
      incomeType: 'REALIZED_PNL',
      startTime,
      endTime,
      limit: 1000
    });
    // 转换格式
    const pnl_records = raw_pnl_records.map(r => ({
      symbol: r.symbol,
      income: parseFloat(r.income),
      time: r.time,
      tradeId: r.tradeId
    }));
    console.log(`找到 ${pnl_records.length} 条 PnL 记录:\n`);

    // 按 symbol 分组显示
    const pnl_by_symbol: Record<string, typeof pnl_records> = {};
    for (const pnl of pnl_records) {
      if (!pnl_by_symbol[pnl.symbol]) {
        pnl_by_symbol[pnl.symbol] = [];
      }
      pnl_by_symbol[pnl.symbol].push(pnl);
    }

    console.log('按币种分组:');
    for (const [symbol, records] of Object.entries(pnl_by_symbol)) {
      console.log(`\n  ${symbol} (${records.length} 条):`);
      for (const pnl of records) {
        const time = new Date(pnl.time).toLocaleString('zh-CN');
        const sign = pnl.income >= 0 ? '+' : '';
        console.log(`    - ${time}: ${sign}${pnl.income.toFixed(4)} USDT (tradeId: ${pnl.tradeId})`);
      }
    }

    // 2. 获取数据库中的交易记录
    console.log('\n\n📊 步骤 2: 获取数据库交易记录...');
    const [db_records] = await conn.query<any[]>(`
      SELECT id, symbol, side, entry_order_id, exit_order_id,
             entry_price, exit_price, realized_pnl, total_commission,
             opened_at, closed_at, status, close_reason
      FROM trade_records
      WHERE opened_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY opened_at DESC
    `);

    console.log(`数据库中找到 ${db_records.length} 条交易记录:\n`);

    for (const record of db_records) {
      const status_icon = record.status === 'CLOSED' ? '✅' : '🟡';
      const pnl_value = parseFloat(record.realized_pnl) || 0;
      const commission_value = parseFloat(record.total_commission) || 0;
      const pnl_sign = pnl_value >= 0 ? '+' : '';
      console.log(`  ${status_icon} ${record.symbol} ${record.side}`);
      console.log(`     ID: ${record.id}`);
      console.log(`     entry_order_id: ${record.entry_order_id || 'N/A'}`);
      console.log(`     exit_order_id: ${record.exit_order_id || 'N/A'}`);
      console.log(`     开仓: ${record.opened_at?.toLocaleString('zh-CN') || 'N/A'} @ ${record.entry_price}`);
      console.log(`     平仓: ${record.closed_at?.toLocaleString('zh-CN') || '未平仓'} @ ${record.exit_price || 'N/A'}`);
      console.log(`     盈亏: ${pnl_sign}${pnl_value.toFixed(4)} USDT`);
      console.log(`     手续费: ${commission_value.toFixed(4)} USDT`);
      console.log(`     状态: ${record.status} (${record.close_reason || 'N/A'})`);
      console.log('');
    }

    // 3. 对比分析
    console.log('\n📋 步骤 3: 对比分析...');
    console.log('-'.repeat(80));

    // 获取数据库中所有的 exit_order_id
    const db_exit_order_ids = new Set(
      db_records
        .filter(r => r.exit_order_id)
        .map(r => String(r.exit_order_id))
    );

    // 获取数据库中所有的 entry_order_id
    const db_entry_order_ids = new Set(
      db_records
        .filter(r => r.entry_order_id)
        .map(r => String(r.entry_order_id))
    );

    console.log(`\n数据库 exit_order_id 集合 (${db_exit_order_ids.size} 个):`);
    for (const id of db_exit_order_ids) {
      console.log(`  - ${id}`);
    }

    console.log(`\n数据库 entry_order_id 集合 (${db_entry_order_ids.size} 个):`);
    for (const id of db_entry_order_ids) {
      console.log(`  - ${id}`);
    }

    // ⚠️ 注意：PnL 记录的 tradeId 是成交ID，不是订单ID
    // 需要通过成交记录来获取 orderId，再与数据库匹配
    console.log('\n\n🔍 分析 PnL 记录与数据库记录的对应关系:');
    console.log('  ⚠️ 注意: PnL的tradeId是成交ID，需要通过成交记录获取orderId');

    // 统计数据库中已平仓的交易
    const closed_trades = db_records.filter(r => r.status === 'CLOSED');
    const open_trades = db_records.filter(r => r.status === 'OPEN');

    console.log(`\n  数据库已平仓: ${closed_trades.length} 笔`);
    console.log(`  数据库未平仓: ${open_trades.length} 笔`);

    // 按币种统计 PnL
    const pnl_summary: Record<string, { count: number; total: number }> = {};
    for (const pnl of pnl_records) {
      if (!pnl_summary[pnl.symbol]) {
        pnl_summary[pnl.symbol] = { count: 0, total: 0 };
      }
      pnl_summary[pnl.symbol].count++;
      pnl_summary[pnl.symbol].total += pnl.income;
    }

    console.log('\n  币安 PnL 汇总 (按币种):');
    for (const [symbol, data] of Object.entries(pnl_summary)) {
      const sign = data.total >= 0 ? '+' : '';
      console.log(`    ${symbol}: ${data.count} 条, 合计 ${sign}${data.total.toFixed(4)} USDT`);
    }

    // 检查数据库中的平仓记录是否有对应的 exit_order_id
    console.log('\n  数据库平仓记录的 exit_order_id 状态:');
    for (const record of closed_trades) {
      const has_exit_id = record.exit_order_id ? '✅' : '❌';
      const pnl_value = parseFloat(record.realized_pnl) || 0;
      console.log(`    ${has_exit_id} ${record.symbol}: exit_order_id=${record.exit_order_id || 'N/A'}, pnl=${pnl_value.toFixed(4)}`);
    }

    // 4. 检查币安近期所有交易（用于更详细的分析）
    console.log('\n\n📜 步骤 4: 查询币安近期所有成交记录...');

    // 获取所有币种的交易记录
    const unique_symbols = [...new Set(pnl_records.map(p => p.symbol))];

    for (const symbol of unique_symbols) {
      console.log(`\n  ${symbol} 的成交记录:`);
      try {
        const trades = await api.get_user_trades(symbol, { limit: 20 });
        for (const trade of trades.slice(0, 10)) {  // 只显示最近 10 条
          const time = new Date(trade.time).toLocaleString('zh-CN');
          const side_icon = trade.side === 'BUY' ? '🟢' : '🔴';
          const pnl = parseFloat(trade.realizedPnl);
          const pnl_str = pnl !== 0 ? ` | PnL: ${pnl.toFixed(4)}` : '';
          console.log(`    ${side_icon} ${time} | ${trade.side} ${trade.qty} @ ${trade.price} | orderId: ${trade.orderId}${pnl_str}`);
        }
      } catch (err) {
        console.log(`    获取失败: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 5. 汇总
    console.log('\n\n' + '═'.repeat(80));
    console.log('📊 诊断汇总');
    console.log('═'.repeat(80));
    console.log(`  币安 PnL 记录: ${pnl_records.length} 条 (注意: 一笔交易可能有多条PnL记录)`);
    console.log(`  数据库交易记录: ${db_records.length} 条 (已平仓: ${closed_trades.length}, 未平仓: ${open_trades.length})`);

    console.log('\n  💡 说明:');
    console.log('     - PnL记录的tradeId是成交ID，不是订单ID');
    console.log('     - 一个订单可能有多笔成交（分批成交）');
    console.log('     - 部分止盈会产生多条PnL记录，但对应同一持仓');
    console.log('     - 通过步骤4的成交记录的orderId来匹配数据库的exit_order_id');

    console.log('\n');

  } catch (error) {
    console.error('诊断失败:', error);
  } finally {
    conn.release();
    process.exit(0);
  }
}

main();
