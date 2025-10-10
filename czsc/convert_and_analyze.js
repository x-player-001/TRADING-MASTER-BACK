/**
 * 转换时区并分析指定时间段
 * UTC+0 日/月/年 → UTC+8 年-月-日
 */

const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./bnb-15.json', 'utf8'));

// 转换时区函数: UTC+0 → UTC+8
function convertToUTC8(dateStr) {
  // 输入格式: "9/10/2025 08:30:00" (日/月/年 UTC+0)
  const [datePart, timePart] = dateStr.split(' ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute, second] = timePart.split(':');

  // 创建UTC时间
  const utc0 = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // 加8小时转为UTC+8
  const utc8 = new Date(utc0.getTime() + 8 * 60 * 60 * 1000);

  // 格式化为 YYYY-MM-DD HH:mm:ss
  const yyyy = utc8.getUTCFullYear();
  const mm = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc8.getUTCDate()).padStart(2, '0');
  const hh = String(utc8.getUTCHours()).padStart(2, '0');
  const min = String(utc8.getUTCMinutes()).padStart(2, '0');
  const ss = String(utc8.getUTCSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

// 转换所有K线数据
const all_klines = rawData.RECORDS.map(record => {
  const utc8_time = convertToUTC8(record.open_time);
  return {
    original_time: record.open_time,
    utc8_time: utc8_time,
    timestamp: new Date(utc8_time).getTime(),
    high: record.high,
    low: record.low,
    open: record.open,
    close: record.close,
    volume: record.volume
  };
}).reverse(); // 反转为时间正序

console.log('========== 时区转换示例 ==========');
console.log('原始UTC+0:', rawData.RECORDS[0].open_time);
console.log('转换UTC+8:', all_klines[all_klines.length - 1].utc8_time);
console.log('');
console.log('原始UTC+0:', rawData.RECORDS[rawData.RECORDS.length - 1].open_time);
console.log('转换UTC+8:', all_klines[0].utc8_time);
console.log('');

console.log('全部K线数量:', all_klines.length);
console.log('时间范围(UTC+8):', all_klines[0].utc8_time, '~', all_klines[all_klines.length - 1].utc8_time);
console.log('');

// 筛选目标时间段: 2025-10-08 04:15 ~ 2025-10-09 23:15 (UTC+8)
const target_start = '2025-10-08 04:15:00';
const target_end = '2025-10-09 23:15:00';

const target_klines = all_klines.filter(k => {
  return k.utc8_time >= target_start && k.utc8_time <= target_end;
});

console.log('========================================');
console.log('目标区间 (UTC+8):', target_start, '~', target_end);
console.log('========================================');
console.log('区间K线数:', target_klines.length);
if (target_klines.length > 0) {
  console.log('实际范围:', target_klines[0].utc8_time, '~', target_klines[target_klines.length - 1].utc8_time);
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
          utc8_time: current.utc8_time,
          merged_count: current.merged_count + 1,
          direction
        };
      } else {
        current = {
          ...current,
          high: Math.min(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: next.close,
          utc8_time: current.utc8_time,
          merged_count: current.merged_count + 1,
          direction
        };
      }
    }
  }
  processed.push(current);
  return processed;
}

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
      fractals.push({ type, index: i, price, time: k2.utc8_time, high: k2.high, low: k2.low });
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

console.log('========== 所有顶分型 (UTC+8) ==========');
tops.forEach((f, i) => {
  console.log(`${i + 1}. ${f.time} | 价格=${f.price.toFixed(2)} | 索引=${f.index}`);
});
console.log('');

console.log('========== 所有底分型 (UTC+8) ==========');
bottoms.forEach((f, i) => {
  console.log(`${i + 1}. ${f.time} | 价格=${f.price.toFixed(2)} | 索引=${f.index}`);
});
console.log('');

console.log('========== 按时间顺序所有分型 (UTC+8) ==========');
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
