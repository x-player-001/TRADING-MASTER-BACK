/**
 * 分析最新500根K线
 * 重点关注: 2025-10-07 20:15 ~ 2025-10-09 15:15
 */

const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./bnb-15-utc8.json', 'utf8'));

// 取最新500根K线（反转后取最后500根）
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

console.log('========================================');
console.log('最新500根K线分析');
console.log('========================================');
console.log('时间范围:', klines_500[0].open_time, '~', klines_500[klines_500.length - 1].open_time);
console.log('');

// 去包含处理
function remove_include(klines) {
  if (klines.length === 0) return [];

  const processed = [];
  let current = { ...klines[0], merged_count: 1, direction: undefined };

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
      current = { ...next, merged_count: 1, direction: undefined };
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
          direction
        };
      } else {
        current = {
          ...current,
          high: Math.min(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: next.close,
          open_time: current.open_time,
          merged_count: current.merged_count + 1,
          direction
        };
      }
    }
  }
  processed.push(current);
  return processed;
}

const processed = remove_include(klines_500);
console.log('去包含处理: 500根 → ' + processed.length + '根');
console.log('');

// 分型检测
function detect_fractals(klines) {
  if (klines.length < 3) return [];

  const fractals = [];
  for (let i = 1; i < klines.length - 1; i++) {
    const k1 = klines[i - 1];
    const k2 = klines[i];
    const k3 = klines[i + 1];

    const is_top = k1.high < k2.high && k2.high > k3.high &&
                   k1.low < k2.low && k2.low > k3.low;
    const is_bottom = k1.high > k2.high && k2.high < k3.high &&
                      k1.low > k2.low && k2.low < k3.low;

    let type = null, price = null;
    if (is_top) { type = 'TOP'; price = k2.high; }
    else if (is_bottom) { type = 'BOTTOM'; price = k2.low; }

    if (type) {
      if (fractals.length > 0 && fractals[fractals.length - 1].type === type) continue;
      fractals.push({
        type,
        index: i,
        price,
        time: k2.open_time,
        high: k2.high,
        low: k2.low
      });
    }
  }
  return fractals;
}

const all_fractals = detect_fractals(processed);

console.log('全部分型数: ' + all_fractals.length);
console.log('');

// 筛选目标时间段的分型
const target_start = '2025-10-07 20:15:00';
const target_end = '2025-10-09 15:15:00';

const target_fractals = all_fractals.filter(f => f.time >= target_start && f.time <= target_end);

console.log('========================================');
console.log('目标时间段: ' + target_start + ' ~ ' + target_end);
console.log('========================================');

const tops = target_fractals.filter(f => f.type === 'TOP');
const bottoms = target_fractals.filter(f => f.type === 'BOTTOM');

console.log('总分型数: ' + target_fractals.length);
console.log('顶分型: ' + tops.length + ' 个');
console.log('底分型: ' + bottoms.length + ' 个');
console.log('');

console.log('========== 所有顶分型 ==========');
tops.forEach((f, i) => {
  console.log(`${String(i + 1).padStart(2, ' ')}. ${f.time} | 价格=${f.price.toFixed(2)}`);
});
console.log('');

console.log('========== 所有底分型 ==========');
bottoms.forEach((f, i) => {
  console.log(`${String(i + 1).padStart(2, ' ')}. ${f.time} | 价格=${f.price.toFixed(2)}`);
});
console.log('');

console.log('========== 按时间顺序所有分型 ==========');
target_fractals.forEach((f, i) => {
  const icon = f.type === 'TOP' ? '🔴顶分' : '🔵底分';
  console.log(`${String(i + 1).padStart(2, ' ')}. ${icon} | ${f.time} | ${f.price.toFixed(2)}`);
});
console.log('');

// 统计该时间段K线
const target_klines = klines_500.filter(k => k.open_time >= target_start && k.open_time <= target_end);
console.log('========== 该时间段统计 ==========');
console.log('K线数量: ' + target_klines.length + ' 根');
if (target_klines.length > 0) {
  const highs = target_klines.map(k => k.high);
  const lows = target_klines.map(k => k.low);
  const max_high = Math.max(...highs);
  const min_low = Math.min(...lows);
  console.log('最高价: ' + max_high.toFixed(2));
  console.log('最低价: ' + min_low.toFixed(2));
  console.log('振幅: ' + (max_high - min_low).toFixed(2) + ' (' + ((max_high - min_low) / min_low * 100).toFixed(2) + '%)');
}
