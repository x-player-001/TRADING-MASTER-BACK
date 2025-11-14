/**
 * 分析回测结果：过滤掉价格极值超过10%的交易
 */
import * as fs from 'fs';
import * as path from 'path';

const json_file = '/Users/mac/Documents/code/TRADING-MASTER-BACK/backtest_results/backtest_2025-11-14T23-23-55.json';

interface Trade {
  trade_number: number;
  symbol: string;
  side: string;
  realized_pnl: number;
  daily_price_low?: number;
  daily_price_high?: number;
  price_from_low_pct?: number;
  price_from_high_pct?: number;
  entry_price: number;
  exit_price: number;
  close_reason: string;
}

interface BacktestResult {
  metadata: any;
  summary: any;
  trades: Trade[];
}

function analyze() {
  console.log('=== 回测结果过滤分析 ===\n');

  // 读取JSON文件
  const data: BacktestResult = JSON.parse(fs.readFileSync(json_file, 'utf-8'));

  console.log('📊 原始回测结果:');
  console.log(`  总交易数: ${data.summary.total_trades}`);
  console.log(`  盈利交易: ${data.summary.winning_trades}`);
  console.log(`  亏损交易: ${data.summary.losing_trades}`);
  console.log(`  胜率: ${data.summary.win_rate.toFixed(2)}%`);
  console.log(`  总盈亏: $${data.summary.total_pnl.toFixed(2)}`);
  console.log(`  ROI: ${data.summary.roi_percent.toFixed(2)}%`);
  console.log(`  平均盈利: $${data.summary.average_win.toFixed(2)}`);
  console.log(`  平均亏损: $${data.summary.average_loss.toFixed(2)}`);
  console.log(`  盈亏比: ${data.summary.profit_factor.toFixed(2)}\n`);

  // 统计有价格极值数据的交易
  const trades_with_extremes = data.trades.filter(t =>
    t.price_from_low_pct !== undefined || t.price_from_high_pct !== undefined
  );
  console.log(`✅ 有价格极值数据的交易: ${trades_with_extremes.length}/${data.trades.length}\n`);

  // 正确的过滤逻辑：
  // - 做多(LONG): 避免追高，过滤 price_from_low_pct > 10%
  // - 做空(SHORT): 避免追跌，过滤 price_from_high_pct > 10%
  const filtered_out = data.trades.filter(t => {
    if (t.side === 'LONG') {
      const from_low = t.price_from_low_pct || 0;
      return from_low > 10;
    } else if (t.side === 'SHORT') {
      const from_high = t.price_from_high_pct || 0;
      return from_high > 10;
    }
    return false;
  });

  const remaining = data.trades.filter(t => {
    if (t.side === 'LONG') {
      const from_low = t.price_from_low_pct || 0;
      return from_low <= 10;
    } else if (t.side === 'SHORT') {
      const from_high = t.price_from_high_pct || 0;
      return from_high <= 10;
    }
    return true;
  });

  console.log(`🚫 被过滤掉的交易（价格极值>10%）: ${filtered_out.length}`);
  console.log(`✅ 保留的交易（价格极值≤10%）: ${remaining.length}\n`);

  // 分析被过滤掉的交易
  const filtered_wins = filtered_out.filter(t => t.realized_pnl > 0).length;
  const filtered_losses = filtered_out.filter(t => t.realized_pnl < 0).length;
  const filtered_pnl = filtered_out.reduce((sum, t) => sum + t.realized_pnl, 0);

  console.log('📉 被过滤掉的交易分析:');
  console.log(`  盈利: ${filtered_wins}, 亏损: ${filtered_losses}`);
  console.log(`  总盈亏: $${filtered_pnl.toFixed(2)}`);
  console.log(`  平均盈亏: $${(filtered_pnl / filtered_out.length).toFixed(2)}\n`);

  // 分析保留的交易
  const remaining_wins = remaining.filter(t => t.realized_pnl > 0).length;
  const remaining_losses = remaining.filter(t => t.realized_pnl < 0).length;
  const remaining_pnl = remaining.reduce((sum, t) => sum + t.realized_pnl, 0);
  const remaining_win_pnl = remaining.filter(t => t.realized_pnl > 0).reduce((sum, t) => sum + t.realized_pnl, 0);
  const remaining_loss_pnl = remaining.filter(t => t.realized_pnl < 0).reduce((sum, t) => sum + t.realized_pnl, 0);

  console.log('✅ 保留交易的新统计:');
  console.log(`  总交易数: ${remaining.length}`);
  console.log(`  盈利交易: ${remaining_wins}`);
  console.log(`  亏损交易: ${remaining_losses}`);
  console.log(`  胜率: ${(remaining_wins / remaining.length * 100).toFixed(2)}%`);
  console.log(`  总盈亏: $${remaining_pnl.toFixed(2)}`);
  console.log(`  ROI: ${(remaining_pnl / 10000 * 100).toFixed(2)}%`);
  console.log(`  平均盈利: $${(remaining_win_pnl / remaining_wins).toFixed(2)}`);
  console.log(`  平均亏损: $${(remaining_loss_pnl / remaining_losses).toFixed(2)}`);
  console.log(`  盈亏比: ${(remaining_win_pnl / Math.abs(remaining_loss_pnl)).toFixed(2)}\n`);

  // 对比改进
  console.log('📊 过滤前后对比:');
  console.log(`  交易数量: ${data.summary.total_trades} → ${remaining.length} (${((1 - remaining.length / data.summary.total_trades) * 100).toFixed(1)}% 减少)`);
  console.log(`  胜率: ${data.summary.win_rate.toFixed(2)}% → ${(remaining_wins / remaining.length * 100).toFixed(2)}% (${((remaining_wins / remaining.length - data.summary.win_rate / 100) * 100).toFixed(2)}% 提升)`);
  console.log(`  总盈亏: $${data.summary.total_pnl.toFixed(2)} → $${remaining_pnl.toFixed(2)} (${(remaining_pnl - data.summary.total_pnl).toFixed(2)})`);
  console.log(`  ROI: ${data.summary.roi_percent.toFixed(2)}% → ${(remaining_pnl / 10000 * 100).toFixed(2)}% (${((remaining_pnl / 10000 - data.summary.roi_percent / 100) * 100).toFixed(2)}% 提升)\n`);

  // 显示部分被过滤的交易样本
  console.log('🔍 被过滤交易样本（前10条）:');
  filtered_out.slice(0, 10).forEach(t => {
    console.log(`  #${t.trade_number} ${t.symbol} ${t.side}: PNL=$${t.realized_pnl.toFixed(2)}, ` +
      `from_low=${t.price_from_low_pct?.toFixed(1)}%, from_high=${t.price_from_high_pct?.toFixed(1)}%`);
  });

  // 保存筛选后的交易到文件
  const output_file = path.join(__dirname, '../backtest_results/filtered_trades_kept.json');
  const export_data = {
    metadata: {
      source_file: json_file,
      filter_date: new Date().toISOString(),
      filter_criteria: {
        long_trades: 'price_from_low_pct <= 10% (避免追高)',
        short_trades: 'price_from_high_pct <= 10% (避免追跌)'
      },
      original_total: data.summary.total_trades,
      total_kept: remaining.length,
      total_filtered_out: filtered_out.length,
      statistics: {
        total_trades: remaining.length,
        winning_trades: remaining_wins,
        losing_trades: remaining_losses,
        win_rate: (remaining_wins / remaining.length * 100).toFixed(2) + '%',
        total_pnl: remaining_pnl.toFixed(2),
        roi_percent: (remaining_pnl / 10000 * 100).toFixed(2) + '%',
        average_win: (remaining_win_pnl / remaining_wins).toFixed(2),
        average_loss: (remaining_loss_pnl / remaining_losses).toFixed(2),
        profit_factor: (remaining_win_pnl / Math.abs(remaining_loss_pnl)).toFixed(2)
      }
    },
    trades: remaining
  };

  fs.writeFileSync(output_file, JSON.stringify(export_data, null, 2), 'utf-8');
  console.log(`\n✅ 已保存 ${remaining.length} 笔筛选后的交易到: ${output_file}`);
}

analyze();
