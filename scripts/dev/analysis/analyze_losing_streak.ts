/**
 * 分析最长连续亏损的交易详情
 */

import * as fs from 'fs';
import * as path from 'path';

const json_file = path.join(__dirname, '../backtest_results/backtest_50usd_2025-11-27.json');
const data = JSON.parse(fs.readFileSync(json_file, 'utf-8'));

interface Trade {
  symbol: string;
  side: string;
  entry_price: number;
  realized_pnl: number;
  opened_at: string;
  closed_at: string;
  close_reason: string;
}

const trades: Trade[] = data.trade_details;

// 查找所有连续亏损序列
let current_streak = 0;
let max_streak = 0;
let max_streak_start = 0;
let max_streak_end = 0;

console.log('🔍 分析连续亏损情况\n');
console.log('═'.repeat(80));

for (let i = 0; i < trades.length; i++) {
  const trade = trades[i];

  if (trade.realized_pnl < 0) {
    if (current_streak === 0) {
      // 新的连亏序列开始
      current_streak = 1;
    } else {
      current_streak++;
    }

    // 更新最长连亏记录
    if (current_streak > max_streak) {
      max_streak = current_streak;
      max_streak_end = i;
      max_streak_start = i - current_streak + 1;
    }
  } else {
    // 盈利，连亏中断
    if (current_streak >= 5) {
      // 记录连亏≥5的序列
      console.log(`\n📉 发现${current_streak}连亏 (交易 #${i - current_streak + 1} ~ #${i})`);
    }
    current_streak = 0;
  }
}

// 显示最长连亏的详细信息
console.log('\n\n🔴 最长连续亏损详情:\n');
console.log('═'.repeat(80));
console.log(`最长连亏: ${max_streak}次 (交易 #${max_streak_start + 1} ~ #${max_streak_end + 1})\n`);

let total_loss = 0;

for (let i = max_streak_start; i <= max_streak_end; i++) {
  const trade = trades[i];
  const index = i + 1;

  total_loss += trade.realized_pnl;

  const opened = new Date(trade.opened_at);
  const closed = new Date(trade.closed_at);
  const duration = Math.floor((closed.getTime() - opened.getTime()) / 60000);

  console.log(`#${index.toString().padStart(3)} ${trade.symbol.padEnd(15)} ${trade.side}`);
  console.log(`     入场: ${opened.toISOString().slice(11, 19)} @ $${trade.entry_price.toFixed(6)}`);
  console.log(`     平仓: ${closed.toISOString().slice(11, 19)} (${duration}分钟)`);
  console.log(`     盈亏: $${trade.realized_pnl.toFixed(2)} (${trade.close_reason})`);
  console.log('');
}

console.log('═'.repeat(80));
console.log(`连亏总损失: $${total_loss.toFixed(2)}`);
console.log(`平均单笔损失: $${(total_loss / max_streak).toFixed(2)}`);
console.log('═'.repeat(80));

// 统计连亏原因
const reasons = trades.slice(max_streak_start, max_streak_end + 1)
  .map(t => t.close_reason);

const reason_count = new Map<string, number>();
reasons.forEach(r => {
  reason_count.set(r, (reason_count.get(r) || 0) + 1);
});

console.log('\n📊 连亏原因统计:\n');
for (const [reason, count] of reason_count.entries()) {
  const pct = (count / max_streak * 100).toFixed(1);
  console.log(`  ${reason}: ${count}次 (${pct}%)`);
}

// 分析连亏发生的时间段
console.log('\n⏰ 连亏时间段:\n');
const first_trade = trades[max_streak_start];
const last_trade = trades[max_streak_end];
console.log(`  开始时间: ${new Date(first_trade.opened_at).toISOString()}`);
console.log(`  结束时间: ${new Date(last_trade.closed_at).toISOString()}`);

const time_span = new Date(last_trade.closed_at).getTime() - new Date(first_trade.opened_at).getTime();
const hours = (time_span / (1000 * 60 * 60)).toFixed(1);
console.log(`  时间跨度: ${hours}小时`);

console.log('\n✅ 分析完成');
