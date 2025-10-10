/**
 * 检查具体分型的有效性
 * 重点检查: 2025-10-08 00:00:00 (顶分) 和 2025-10-08 00:15:00 (底分)
 */

const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./bnb-15-utc8.json', 'utf8'));

const all_klines = rawData.RECORDS.map(record => ({
  open_time: record.open_time,
  close_time: record.close_time,
  high: record.high,
  low: record.low,
  open: record.open,
  close: record.close,
  volume: record.volume
})).reverse();

const klines_500 = all_klines.slice(-500);

// 去包含处理
function remove_include(klines) {
  if (klines.length === 0) return [];

  const processed = [];
  let current = { ...klines[0], merged_count: 1, direction: undefined, original_index: 0 };

  for (let i = 1; i < klines.length; i++) {
    const next = klines[i];
    const has_include =
      (current.high >= next.high && current.low <= next.low) ||
      (next.high >= current.high && next.low <= current.low);

    if (!has_include) {
      if (processed.length > 0) {
        const prev = processed[processed.length - 1];
        current.direction = current.high > prev.high ? 'up' : 'down';
      }
      processed.push(current);
      current = { ...next, merged_count: 1, direction: undefined, original_index: i };
    } else {
      const direction = current.direction || (next.high > current.high ? 'up' : 'down');
      if (direction === 'up') {
        current = {
          ...current,
          high: Math.max(current.high, next.high),
          low: Math.max(current.low, next.low),
          close: next.close,
          open_time: current.open_time,
          merged_count: current.merged_count + 1,
          direction,
          original_index: current.original_index
        };
      } else {
        current = {
          ...current,
          high: Math.min(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: next.close,
          open_time: current.open_time,
          merged_count: current.merged_count + 1,
          direction,
          original_index: current.original_index
        };
      }
    }
  }
  processed.push(current);
  return processed;
}

const processed = remove_include(klines_500);

console.log('========================================');
console.log('检查可疑分型的形成过程');
console.log('========================================');
console.log('');

// 找到目标时间附近的处理后K线
const target_area = processed.filter(k =>
  k.open_time >= '2025-10-07 23:00:00' && k.open_time <= '2025-10-08 01:00:00'
);

console.log('2025-10-07 23:00 ~ 2025-10-08 01:00 的处理后K线:');
console.log('');
target_area.forEach((k, idx) => {
  const dir = k.direction ? `(${k.direction})` : '';
  console.log(`${idx}. ${k.open_time} | H=${k.high.toFixed(2)}, L=${k.low.toFixed(2)} ${dir}`);
});
console.log('');

// 手动检查分型
console.log('========== 逐一检查分型条件 ==========');
console.log('');

for (let i = 1; i < target_area.length - 1; i++) {
  const k1 = target_area[i - 1];
  const k2 = target_area[i];
  const k3 = target_area[i + 1];

  console.log(`检查索引${i} (${k2.open_time}):`);
  console.log(`  k1[${k1.open_time}]: H=${k1.high.toFixed(2)}, L=${k1.low.toFixed(2)}`);
  console.log(`  k2[${k2.open_time}]: H=${k2.high.toFixed(2)}, L=${k2.low.toFixed(2)}`);
  console.log(`  k3[${k3.open_time}]: H=${k3.high.toFixed(2)}, L=${k3.low.toFixed(2)}`);

  // 顶分型检查
  const top_high_ok = k1.high < k2.high && k2.high > k3.high;
  const top_low_ok = k1.low < k2.low && k2.low > k3.low;
  const is_top = top_high_ok && top_low_ok;

  // 底分型检查
  const bottom_high_ok = k1.high > k2.high && k2.high < k3.high;
  const bottom_low_ok = k1.low > k2.low && k2.low < k3.low;
  const is_bottom = bottom_high_ok && bottom_low_ok;

  console.log(`  顶分型检查:`);
  console.log(`    high条件: k1.high(${k1.high.toFixed(2)}) < k2.high(${k2.high.toFixed(2)}) > k3.high(${k3.high.toFixed(2)}) = ${top_high_ok}`);
  console.log(`    low条件:  k1.low(${k1.low.toFixed(2)}) < k2.low(${k2.low.toFixed(2)}) > k3.low(${k3.low.toFixed(2)}) = ${top_low_ok}`);
  console.log(`    结果: ${is_top ? '✓ 是顶分型' : '✗ 不是顶分型'}`);

  console.log(`  底分型检查:`);
  console.log(`    high条件: k1.high(${k1.high.toFixed(2)}) > k2.high(${k2.high.toFixed(2)}) < k3.high(${k3.high.toFixed(2)}) = ${bottom_high_ok}`);
  console.log(`    low条件:  k1.low(${k1.low.toFixed(2)}) > k2.low(${k2.low.toFixed(2)}) < k3.low(${k3.low.toFixed(2)}) = ${bottom_low_ok}`);
  console.log(`    结果: ${is_bottom ? '✓ 是底分型' : '✗ 不是底分型'}`);

  if (is_top || is_bottom) {
    console.log(`  *** ${is_top ? '顶分型' : '底分型'} 在价格=${is_top ? k2.high.toFixed(2) : k2.low.toFixed(2)} ***`);
  }

  console.log('');
}

// 检查原始K线
console.log('========================================');
console.log('检查原始K线（未去包含）');
console.log('========================================');
console.log('');

const original_area = klines_500.filter(k =>
  k.open_time >= '2025-10-07 23:00:00' && k.open_time <= '2025-10-08 01:00:00'
);

console.log('原始K线:');
original_area.forEach((k, idx) => {
  console.log(`${idx}. ${k.open_time} | H=${k.high.toFixed(2)}, L=${k.low.toFixed(2)}, O=${k.open.toFixed(2)}, C=${k.close.toFixed(2)}`);
});
