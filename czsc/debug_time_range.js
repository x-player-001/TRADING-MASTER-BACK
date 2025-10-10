/**
 * 精确分析指定时间段的分型分布
 * 时间段: 2025-10-07 20:15 至 2025-10-09 15:15
 */

const fs = require('fs');
const path = require('path');

// 读取K线数据
const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, 'bnb-15.json'), 'utf8'));
const klines = rawData.RECORDS.map(record => ({
  symbol: record.symbol,
  interval: '15m',
  open_time: new Date(record.open_time).getTime(),
  close_time: new Date(record.close_time).getTime(),
  open: record.open,
  high: record.high,
  low: record.low,
  close: record.close,
  volume: record.volume,
  trade_count: record.trade_count,
  is_final: true,
  open_time_str: record.open_time
})).reverse();

console.log(`总共加载了${klines.length}根K线数据`);
console.log('');

// 目标时间段
const target_start = new Date('2025-10-07 20:15:00').getTime();
const target_end = new Date('2025-10-09 15:15:00').getTime();

console.log('目标时间段:');
console.log(`  起始: ${new Date(target_start).toLocaleString()}`);
console.log(`  结束: ${new Date(target_end).toLocaleString()}`);
console.log('');

// 找到时间段内的K线
const target_klines = klines.filter(k => k.open_time >= target_start && k.open_time <= target_end);
console.log(`该时间段内的K线数量: ${target_klines.length}根`);
if (target_klines.length > 0) {
  console.log(`  实际范围: ${target_klines[0].open_time_str} ~ ${target_klines[target_klines.length - 1].open_time_str}`);
}
console.log('');

// ============= 去包含处理 =============
function remove_include(klines) {
  if (klines.length === 0) return [];

  const processed = [];
  let current = {
    ...klines[0],
    merged_count: 1,
    direction: undefined,
    original_indices: [0]
  };

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

      current = {
        ...next,
        merged_count: 1,
        direction: undefined,
        original_indices: [i]
      };
    } else {
      const direction = current.direction || (next.high > current.high ? 'up' : 'down');

      if (direction === 'up') {
        current = {
          ...current,
          high: Math.max(current.high, next.high),
          low: Math.max(current.low, next.low),
          close: next.close,
          close_time: next.close_time,
          volume: current.volume + next.volume,
          merged_count: current.merged_count + 1,
          direction,
          original_indices: [...current.original_indices, i]
        };
      } else {
        current = {
          ...current,
          high: Math.min(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: next.close,
          close_time: next.close_time,
          volume: current.volume + next.volume,
          merged_count: current.merged_count + 1,
          direction,
          original_indices: [...current.original_indices, i]
        };
      }
    }
  }

  processed.push(current);
  return processed;
}

// 对所有K线做去包含
const all_processed = remove_include(klines);
console.log(`全部K线去包含: ${klines.length}根 → ${all_processed.length}根`);
console.log('');

// ============= 分型识别 =============
function detect_fractals(processed_klines, original_klines) {
  if (processed_klines.length < 3) return [];

  const fractals = [];

  for (let i = 1; i < processed_klines.length - 1; i++) {
    const k1 = processed_klines[i - 1];
    const k2 = processed_klines[i];
    const k3 = processed_klines[i + 1];

    const is_top = k1.high < k2.high && k2.high > k3.high &&
                   k1.low < k2.low && k2.low > k3.low;
    const is_bottom = k1.high > k2.high && k2.high < k3.high &&
                      k1.low > k2.low && k2.low < k3.low;

    let fractal_type = null;
    let price = null;

    if (is_top) {
      fractal_type = 'TOP';
      price = k2.high;
    } else if (is_bottom) {
      fractal_type = 'BOTTOM';
      price = k2.low;
    }

    if (fractal_type) {
      if (fractals.length > 0 && fractals[fractals.length - 1].type === fractal_type) {
        continue;
      }

      fractals.push({
        type: fractal_type,
        processed_index: i,
        price,
        time: k2.open_time,
        time_str: k2.open_time_str,
        high: k2.high,
        low: k2.low
      });
    }
  }

  return fractals;
}

const all_fractals = detect_fractals(all_processed, klines);
console.log(`全部分型数量: ${all_fractals.length}个`);
console.log('');

// ============= 筛选目标时间段的分型 =============
const target_fractals = all_fractals.filter(f => f.time >= target_start && f.time <= target_end);

console.log('========================================');
console.log(`目标时间段 (${new Date(target_start).toLocaleString()} ~ ${new Date(target_end).toLocaleString()}) 的分型:`);
console.log('========================================');
console.log(`总计: ${target_fractals.length}个分型`);
console.log('');

const target_tops = target_fractals.filter(f => f.type === 'TOP');
const target_bottoms = target_fractals.filter(f => f.type === 'BOTTOM');

console.log(`顶分型: ${target_tops.length}个`);
console.log(`底分型: ${target_bottoms.length}个`);
console.log('');

console.log('========== 所有顶分型详情 ==========');
target_tops.forEach((f, idx) => {
  console.log(`顶分${idx + 1}: ${f.time_str}, 价格=${f.price.toFixed(2)}, 处理后索引=${f.processed_index}`);
});
console.log('');

console.log('========== 所有底分型详情 ==========');
target_bottoms.forEach((f, idx) => {
  console.log(`底分${idx + 1}: ${f.time_str}, 价格=${f.price.toFixed(2)}, 处理后索引=${f.processed_index}`);
});
console.log('');

// ============= 打印该时间段的所有分型（按时间顺序） =============
console.log('========== 按时间顺序的所有分型 ==========');
target_fractals.forEach((f, idx) => {
  const type_icon = f.type === 'TOP' ? '🔴' : '🔵';
  console.log(`${idx + 1}. ${type_icon} ${f.type.padEnd(6)} | ${f.time_str} | 价格=${f.price.toFixed(2)}`);
});
console.log('');

// ============= 检查该区间原始K线的高低点分布 =============
console.log('========== 该时间段K线价格分布 ==========');
if (target_klines.length > 0) {
  const highs = target_klines.map(k => k.high);
  const lows = target_klines.map(k => k.low);
  const max_high = Math.max(...highs);
  const min_low = Math.min(...lows);
  const range = max_high - min_low;
  const range_pct = (range / min_low * 100).toFixed(2);

  console.log(`最高价: ${max_high.toFixed(2)}`);
  console.log(`最低价: ${min_low.toFixed(2)}`);
  console.log(`振幅: ${range.toFixed(2)} (${range_pct}%)`);
}
