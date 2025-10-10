/**
 * 分析 10/7 20:15 ~ 10/9 08:30 的分型分布
 */

const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./bnb-15.json', 'utf8'));

// 转换并反转K线数据
const all_klines = rawData.RECORDS.map(record => ({
  open_time_str: record.open_time,
  open_time: new Date(record.open_time).getTime(),
  high: record.high,
  low: record.low,
  open: record.open,
  close: record.close,
  volume: record.volume
})).reverse();

console.log('全部K线:', all_klines.length);
console.log('');

// 找到目标区间
// 10/7 20:15 ~ 10/9 08:30
const target_klines = all_klines.filter(k => {
  const str = k.open_time_str;
  // 10/7 20:15及之后
  if (str.startsWith('7/10/2025')) {
    const time = str.split(' ')[1];
    const [h, m] = time.split(':').map(Number);
    if (h > 20 || (h === 20 && m >= 15)) return true;
  }
  // 10/8 全天
  if (str.startsWith('8/10/2025')) return true;
  // 10/9 15:15之前（实际数据只到08:30）
  if (str.startsWith('9/10/2025')) {
    const time = str.split(' ')[1];
    const [h, m] = time.split(':').map(Number);
    if (h < 15 || (h === 15 && m <= 15)) return true;
  }
  return false;
});

console.log('========================================');
console.log('目标区间: 10/7 20:15 ~ 10/9 15:15');
console.log('========================================');
console.log('区间K线数:', target_klines.length);
if (target_klines.length > 0) {
  console.log('实际范围:', target_klines[0].open_time_str, '~', target_klines[target_klines.length - 1].open_time_str);
}
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
          open_time_str: current.open_time_str,
          merged_count: current.merged_count + 1,
          direction
        };
      } else {
        current = {
          ...current,
          high: Math.min(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: next.close,
          open_time_str: current.open_time_str,
          merged_count: current.merged_count + 1,
          direction
        };
      }
    }
  }
  processed.push(current);
  return processed;
}

// 只对目标区间做去包含
const processed = remove_include(target_klines);
console.log('去包含处理:', target_klines.length, '→', processed.length);
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
      fractals.push({ type, index: i, price, time: k2.open_time_str, high: k2.high, low: k2.low });
    }
  }
  return fractals;
}

const fractals = detect_fractals(processed);

const tops = fractals.filter(f => f.type === 'TOP');
const bottoms = fractals.filter(f => f.type === 'BOTTOM');

console.log('========== 分型统计 ==========');
console.log('总分型数:', fractals.length);
console.log('顶分型:', tops.length, '个');
console.log('底分型:', bottoms.length, '个');
console.log('');

console.log('========== 所有顶分型 ==========');
tops.forEach((f, i) => {
  console.log(`${i + 1}. ${f.time} | 价格=${f.price.toFixed(2)} | 索引=${f.index}`);
});
console.log('');

console.log('========== 所有底分型 ==========');
bottoms.forEach((f, i) => {
  console.log(`${i + 1}. ${f.time} | 价格=${f.price.toFixed(2)} | 索引=${f.index}`);
});
console.log('');

console.log('========== 按时间顺序所有分型 ==========');
fractals.forEach((f, i) => {
  const icon = f.type === 'TOP' ? '🔴顶分' : '🔵底分';
  console.log(`${i + 1}. ${icon} | ${f.time} | ${f.price.toFixed(2)}`);
});
console.log('');

// 价格统计
const highs = target_klines.map(k => k.high);
const lows = target_klines.map(k => k.low);
const max_high = Math.max(...highs);
const min_low = Math.min(...lows);
console.log('========== 价格分布 ==========');
console.log('最高价:', max_high.toFixed(2));
console.log('最低价:', min_low.toFixed(2));
console.log('振幅:', (max_high - min_low).toFixed(2), `(${((max_high - min_low) / min_low * 100).toFixed(2)}%)`);
