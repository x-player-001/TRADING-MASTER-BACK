/**
 * 分析回测结果 - 按盈亏排序，展示分批止盈详情
 */
import * as fs from 'fs';
import * as path from 'path';

interface TakeProfitExecution {
  batch_number: number;
  type: 'BATCH_TAKE_PROFIT' | 'TRAILING_STOP';
  quantity: number;
  exit_price: number;
  pnl: number;
  profit_percent: number;
  executed_at: string;
  reason: string;
}

interface TradeDetail {
  symbol: string;
  side: string;
  entry_price: number;
  current_price: number;
  quantity: number;
  realized_pnl: number;
  opened_at: string;
  closed_at?: string;
  close_reason?: string;
  take_profit_executions?: TakeProfitExecution[];
}

interface BacktestResult {
  statistics: {
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    total_pnl: number;
    win_rate: number;
  };
  trade_details: TradeDetail[];
}

function analyze_results(file_path: string) {
  console.log('📊 分析回测结果...\n');
  console.log(`文件: ${path.basename(file_path)}\n`);

  // 读取JSON文件
  const data: BacktestResult = JSON.parse(fs.readFileSync(file_path, 'utf-8'));

  // 统计
  console.log('=' .repeat(100));
  console.log('📈 总体统计\n');
  console.log(`总交易次数: ${data.statistics.total_trades}`);
  console.log(`盈利次数: ${data.statistics.winning_trades} (${data.statistics.win_rate.toFixed(2)}%)`);
  console.log(`亏损次数: ${data.statistics.losing_trades} (${(100 - data.statistics.win_rate).toFixed(2)}%)`);
  console.log(`总盈亏: ${data.statistics.total_pnl >= 0 ? '+' : ''}$${data.statistics.total_pnl.toFixed(2)}\n`);

  // 分批止盈统计
  const trades_with_tp = data.trade_details.filter(t => t.take_profit_executions && t.take_profit_executions.length > 0);
  const total_tp_executions = trades_with_tp.reduce((sum, t) => sum + (t.take_profit_executions?.length || 0), 0);

  console.log('✨ 分批止盈统计\n');
  console.log(`使用分批止盈的交易: ${trades_with_tp.length} / ${data.statistics.total_trades} (${(trades_with_tp.length / data.statistics.total_trades * 100).toFixed(2)}%)`);
  console.log(`总止盈执行次数: ${total_tp_executions}`);
  console.log(`平均每笔交易止盈次数: ${trades_with_tp.length > 0 ? (total_tp_executions / trades_with_tp.length).toFixed(2) : '0'}\n`);

  // 分离盈利和亏损交易
  const winning_trades = data.trade_details.filter(t => t.realized_pnl > 0).sort((a, b) => b.realized_pnl - a.realized_pnl);
  const losing_trades = data.trade_details.filter(t => t.realized_pnl <= 0).sort((a, b) => a.realized_pnl - b.realized_pnl);

  // 展示TOP 20盈利交易
  console.log('=' .repeat(100));
  console.log('🏆 TOP 20 盈利交易 (按金额排序)\n');

  winning_trades.slice(0, 20).forEach((trade, idx) => {
    const duration = trade.closed_at
      ? Math.round((new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()) / 1000 / 60)
      : 0;

    console.log(`\n[${idx + 1}] ${trade.symbol} ${trade.side} - 盈利: +$${trade.realized_pnl.toFixed(2)}`);
    console.log(`    开仓: ${new Date(trade.opened_at).toISOString().substring(0, 19).replace('T', ' ')} @ $${trade.entry_price.toFixed(6)}`);
    console.log(`    平仓: ${trade.closed_at ? new Date(trade.closed_at).toISOString().substring(0, 19).replace('T', ' ') : 'N/A'} @ $${trade.current_price.toFixed(6)}`);
    console.log(`    持仓: ${duration} 分钟 | 原因: ${trade.close_reason || 'N/A'}`);

    if (trade.take_profit_executions && trade.take_profit_executions.length > 0) {
      console.log(`    📊 分批止盈详情 (${trade.take_profit_executions.length}批):`);
      trade.take_profit_executions.forEach((exec, i) => {
        console.log(`       批次${exec.batch_number}: ${exec.type === 'BATCH_TAKE_PROFIT' ? '固定止盈' : '跟踪止盈'} | 数量: ${exec.quantity.toFixed(4)} | 价格: $${exec.exit_price.toFixed(6)} | 盈利: ${exec.profit_percent >= 0 ? '+' : ''}${exec.profit_percent.toFixed(2)}% | PnL: +$${exec.pnl.toFixed(2)}`);
        console.log(`                ${exec.reason}`);
      });
    }
  });

  // 展示TOP 20亏损交易
  console.log('\n' + '=' .repeat(100));
  console.log('💔 TOP 20 亏损交易 (按金额排序)\n');

  losing_trades.slice(0, 20).forEach((trade, idx) => {
    const duration = trade.closed_at
      ? Math.round((new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()) / 1000 / 60)
      : 0;

    console.log(`\n[${idx + 1}] ${trade.symbol} ${trade.side} - 亏损: -$${Math.abs(trade.realized_pnl).toFixed(2)}`);
    console.log(`    开仓: ${new Date(trade.opened_at).toISOString().substring(0, 19).replace('T', ' ')} @ $${trade.entry_price.toFixed(6)}`);
    console.log(`    平仓: ${trade.closed_at ? new Date(trade.closed_at).toISOString().substring(0, 19).replace('T', ' ') : 'N/A'} @ $${trade.current_price.toFixed(6)}`);
    console.log(`    持仓: ${duration} 分钟 | 原因: ${trade.close_reason || 'N/A'}`);

    if (trade.take_profit_executions && trade.take_profit_executions.length > 0) {
      console.log(`    📊 分批止盈详情 (${trade.take_profit_executions.length}批):`);
      trade.take_profit_executions.forEach((exec) => {
        console.log(`       批次${exec.batch_number}: ${exec.type === 'BATCH_TAKE_PROFIT' ? '固定止盈' : '跟踪止盈'} | 数量: ${exec.quantity.toFixed(4)} | 价格: $${exec.exit_price.toFixed(6)} | 盈利: ${exec.profit_percent >= 0 ? '+' : ''}${exec.profit_percent.toFixed(2)}% | PnL: ${exec.pnl >= 0 ? '+' : ''}$${exec.pnl.toFixed(2)}`);
        console.log(`                ${exec.reason}`);
      });
    }
  });

  console.log('\n' + '=' .repeat(100));
  console.log('✅ 分析完成！\n');
}

// 获取最新的回测结果文件
const results_dir = path.join(__dirname, '../backtest_results');
const files = fs.readdirSync(results_dir)
  .filter(f => f.startsWith('backtest_7days_score7_v2') && f.endsWith('.json'))
  .sort()
  .reverse();

if (files.length === 0) {
  console.error('❌ 没有找到回测结果文件');
  process.exit(1);
}

const latest_file = path.join(results_dir, files[0]);
analyze_results(latest_file);
