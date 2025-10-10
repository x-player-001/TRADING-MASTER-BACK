/**
 * 检查笔的构建过程
 * 为什么这么多分型无法形成笔？
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

// 笔构建 - 详细日志版本
function build_strokes_verbose(fractals, klines, min_bi_len = 5) {
  if (fractals.length < 2) return [];

  const strokes = [];
  let current_fx = fractals[0];
  let rejected_count = 0;

  console.log('========================================');
  console.log('开始构建笔 (min_bi_len = ' + min_bi_len + ')');
  console.log('========================================');
  console.log('起始分型: ' + current_fx.time + ' (' + current_fx.type + ', ' + current_fx.price.toFixed(2) + ')');
  console.log('');

  for (let i = 1; i < fractals.length; i++) {
    const next_fx = fractals[i];

    console.log(`尝试连接: ${current_fx.time} (${current_fx.type}) → ${next_fx.time} (${next_fx.type})`);

    // 条件1: 价格突破
    const direction = current_fx.type === 'TOP' ? 'down' : 'up';
    const price_break = direction === 'up'
      ? next_fx.price > current_fx.price
      : next_fx.price < current_fx.price;

    console.log(`  条件1 - 价格突破: ${current_fx.price.toFixed(2)} → ${next_fx.price.toFixed(2)}, 方向=${direction}, 结果=${price_break ? '✓' : '✗'}`);

    if (!price_break) {
      console.log(`  ✗ 价格未突破，跳过`);
      console.log('');
      rejected_count++;
      continue;
    }

    // 条件2: 无包含关系
    const fx_a_high = Math.max(current_fx.high, current_fx.low);
    const fx_a_low = Math.min(current_fx.high, current_fx.low);
    const fx_b_high = Math.max(next_fx.high, next_fx.low);
    const fx_b_low = Math.min(next_fx.high, next_fx.low);

    const has_include =
      (fx_a_high >= fx_b_high && fx_a_low <= fx_b_low) ||
      (fx_b_high >= fx_a_high && fx_b_low <= fx_a_low);

    console.log(`  条件2 - 无包含: A[${fx_a_low.toFixed(2)}-${fx_a_high.toFixed(2)}], B[${fx_b_low.toFixed(2)}-${fx_b_high.toFixed(2)}], 结果=${has_include ? '✗有包含' : '✓无包含'}`);

    if (has_include) {
      console.log(`  ✗ 有包含关系，跳过`);
      console.log('');
      rejected_count++;
      continue;
    }

    // 条件3: 最小K线数
    const bi_length = next_fx.index - current_fx.index + 1;
    const length_ok = bi_length >= min_bi_len;

    console.log(`  条件3 - 最小长度: K线数=${bi_length}, 要求>=${min_bi_len}, 结果=${length_ok ? '✓' : '✗'}`);

    if (!length_ok) {
      console.log(`  ✗ K线数不足，跳过`);
      console.log('');
      rejected_count++;
      continue;
    }

    // 形成笔
    const amplitude_pct = Math.abs(next_fx.price - current_fx.price) / current_fx.price * 100;
    const stroke = {
      start_time: current_fx.time,
      end_time: next_fx.time,
      start_index: current_fx.index,
      end_index: next_fx.index,
      start_price: current_fx.price,
      end_price: next_fx.price,
      direction,
      length: bi_length,
      amplitude_pct
    };

    strokes.push(stroke);
    console.log(`  ✓✓✓ 形成笔${strokes.length}: ${direction}, 长度=${bi_length}, 振幅=${amplitude_pct.toFixed(2)}%`);
    console.log('');

    current_fx = next_fx;
  }

  console.log('========================================');
  console.log('笔构建完成');
  console.log('========================================');
  console.log('总分型数: ' + fractals.length);
  console.log('成功构建笔数: ' + strokes.length);
  console.log('被拒绝次数: ' + rejected_count);
  console.log('');

  return strokes;
}

// 筛选目标时间段的分型
const target_start = '2025-10-07 20:15:00';
const target_end = '2025-10-09 15:15:00';

const target_fractals = all_fractals.filter(f => f.time >= target_start && f.time <= target_end);

console.log('========================================');
console.log('目标时间段: ' + target_start + ' ~ ' + target_end);
console.log('========================================');
console.log('该时间段分型数: ' + target_fractals.length);
console.log('');

// 构建笔
const strokes = build_strokes_verbose(target_fractals, processed, 5);

console.log('========== 最终形成的笔 ==========');
strokes.forEach((s, i) => {
  console.log(`笔${i + 1}: ${s.start_time} → ${s.end_time} (${s.direction}, 长度=${s.length}, 振幅=${s.amplitude_pct.toFixed(2)}%)`);
});
