/**
 * 本地调试脚本 - 分析BNB 15分钟K线的缠论结构
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
  is_final: true
})).reverse(); // 数据库导出是倒序的，需要反转

console.log(`加载了${klines.length}根K线数据`);
console.log(`时间范围: ${new Date(klines[0].open_time).toLocaleString()} ~ ${new Date(klines[klines.length - 1].open_time).toLocaleString()}`);
console.log('');

// ============= 1. 去包含处理 =============
console.log('========== Step 1: 去包含处理 ==========');

function remove_include(klines) {
  if (klines.length === 0) return [];

  const processed = [];
  let current = {
    ...klines[0],
    merged_count: 1,
    direction: undefined
  };

  for (let i = 1; i < klines.length; i++) {
    const next = klines[i];

    // 判断是否存在包含关系
    const has_include =
      (current.high >= next.high && current.low <= next.low) ||
      (next.high >= current.high && next.low <= current.low);

    if (!has_include) {
      // 无包含，确定当前K线的方向
      if (processed.length > 0) {
        const prev = processed[processed.length - 1];
        current.direction = current.high > prev.high ? 'up' : 'down';
      }
      processed.push(current);

      current = {
        ...next,
        merged_count: 1,
        direction: undefined
      };
    } else {
      // 有包含，根据方向合并
      const direction = current.direction || (next.high > current.high ? 'up' : 'down');

      if (direction === 'up') {
        current = {
          ...current,
          high: Math.max(current.high, next.high),
          low: Math.max(current.low, next.low),
          close: next.close,
          volume: current.volume + next.volume,
          merged_count: current.merged_count + 1,
          direction
        };
      } else {
        current = {
          ...current,
          high: Math.min(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: next.close,
          volume: current.volume + next.volume,
          merged_count: current.merged_count + 1,
          direction
        };
      }
    }
  }

  processed.push(current);
  return processed;
}

const processed_klines = remove_include(klines);
console.log(`原始${klines.length}根K线 → 无包含${processed_klines.length}根K线`);
console.log('');

// ============= 2. 分型识别 =============
console.log('========== Step 2: 分型识别 ==========');

function detect_fractals(klines) {
  if (klines.length < 3) return [];

  const fractals = [];

  for (let i = 1; i < klines.length - 1; i++) {
    const k1 = klines[i - 1];
    const k2 = klines[i];
    const k3 = klines[i + 1];

    // 顶分型: k2的high和low都高于k1和k3
    const is_top = k1.high < k2.high && k2.high > k3.high &&
                   k1.low < k2.low && k2.low > k3.low;

    // 底分型: k2的high和low都低于k1和k3
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
      // 强制顶底交替
      if (fractals.length > 0 && fractals[fractals.length - 1].type === fractal_type) {
        console.log(`警告: 索引${i}出现连续${fractal_type}分型，跳过`);
        continue;
      }

      fractals.push({
        type: fractal_type,
        kline_index: i,
        price,
        time: k2.open_time,
        high: k2.high,
        low: k2.low
      });
    }
  }

  return fractals;
}

const fractals = detect_fractals(processed_klines);
console.log(`检测到${fractals.length}个分型`);

// 统计后50根K线的分型分布
const last_50_fractals = fractals.filter(f => f.kline_index > processed_klines.length - 50);
const top_count = last_50_fractals.filter(f => f.type === 'TOP').length;
const bottom_count = last_50_fractals.filter(f => f.type === 'BOTTOM').length;
console.log(`后50根K线分型分布: 顶分型${top_count}个, 底分型${bottom_count}个`);

// 打印最后20个分型
console.log('\n最后20个分型详情:');
const last_20 = fractals.slice(-20);
last_20.forEach((f, idx) => {
  console.log(`  分型${fractals.length - 20 + idx}: 索引${f.kline_index}, ${f.type}, 价格${f.price.toFixed(2)}`);
});
console.log('');

// ============= 3. 笔构建 =============
console.log('========== Step 3: 笔构建 ==========');

function build_strokes(fractals, klines, min_bi_len = 5) {
  if (fractals.length < 2) return [];

  const strokes = [];
  let current_fx = fractals[0];

  for (let i = 1; i < fractals.length; i++) {
    const next_fx = fractals[i];

    // 检查条件1: 价格突破
    const direction = current_fx.type === 'TOP' ? 'down' : 'up';
    const price_break = direction === 'up'
      ? next_fx.price > current_fx.price
      : next_fx.price < current_fx.price;

    if (!price_break) continue;

    // 检查条件2: 无包含关系
    const fx_a_high = Math.max(current_fx.high, current_fx.low);
    const fx_a_low = Math.min(current_fx.high, current_fx.low);
    const fx_b_high = Math.max(next_fx.high, next_fx.low);
    const fx_b_low = Math.min(next_fx.high, next_fx.low);

    const has_include =
      (fx_a_high >= fx_b_high && fx_a_low <= fx_b_low) ||
      (fx_b_high >= fx_a_high && fx_b_low <= fx_a_low);

    if (has_include) continue;

    // 检查条件3: 最小K线数
    const bi_length = next_fx.kline_index - current_fx.kline_index + 1;
    if (bi_length < min_bi_len) continue;

    // 形成笔
    const amplitude_pct = Math.abs(next_fx.price - current_fx.price) / current_fx.price * 100;
    strokes.push({
      start_index: current_fx.kline_index,
      end_index: next_fx.kline_index,
      start_price: current_fx.price,
      end_price: next_fx.price,
      direction,
      length: bi_length,
      amplitude_pct
    });

    current_fx = next_fx;
  }

  return strokes;
}

const strokes = build_strokes(fractals, processed_klines);
console.log(`构建了${strokes.length}条笔`);

// 打印最后10条笔
console.log('\n最后10条笔详情:');
const last_10_strokes = strokes.slice(-10);
last_10_strokes.forEach((s, idx) => {
  console.log(`  笔${strokes.length - 10 + idx}: K线索引${s.start_index}-${s.end_index} (${s.direction}, 长度${s.length}, 振幅${s.amplitude_pct.toFixed(2)}%)`);
});
console.log('');

// ============= 4. 查找问题区间 =============
console.log('========== Step 4: 查找超长笔 ==========');

const long_strokes = strokes.filter(s => s.length > 50);
console.log(`发现${long_strokes.length}条超过50根K线的笔:`);
long_strokes.forEach(s => {
  console.log(`  笔: 索引${s.start_index}-${s.end_index}, 长度${s.length}, 振幅${s.amplitude_pct.toFixed(2)}%`);
  console.log(`    该区间的分型:`);

  const in_range_fractals = fractals.filter(f => f.kline_index >= s.start_index && f.kline_index <= s.end_index);
  in_range_fractals.forEach(f => {
    console.log(`      索引${f.kline_index}: ${f.type}, 价格${f.price.toFixed(2)}`);
  });
});
console.log('');

// ============= 5. 详细分析最后100根K线 =============
console.log('========== Step 5: 最后100根K线详细分析 ==========');

const start_idx = Math.max(0, processed_klines.length - 100);
const last_100_klines = processed_klines.slice(start_idx);

console.log(`K线索引范围: ${start_idx} - ${processed_klines.length - 1}`);
console.log('\n检查每3根K线是否满足分型条件:');

for (let i = 1; i < last_100_klines.length - 1; i++) {
  const actual_idx = start_idx + i;
  const k1 = last_100_klines[i - 1];
  const k2 = last_100_klines[i];
  const k3 = last_100_klines[i + 1];

  const top_high = k1.high < k2.high && k2.high > k3.high;
  const top_low = k1.low < k2.low && k2.low > k3.low;
  const bottom_high = k1.high > k2.high && k2.high < k3.high;
  const bottom_low = k1.low > k2.low && k2.low < k3.low;

  const is_top = top_high && top_low;
  const is_bottom = bottom_high && bottom_low;
  const almost_top = top_high && !top_low;
  const almost_bottom = bottom_low && !bottom_high;

  if (is_top || is_bottom || almost_top || almost_bottom) {
    let status = '';
    if (is_top) status = '✓顶分型';
    else if (is_bottom) status = '✓底分型';
    else if (almost_top) status = '✗几乎顶分型(high满足,low不满足)';
    else if (almost_bottom) status = '✗几乎底分型(low满足,high不满足)';

    console.log(`索引${actual_idx}: ${status}`);
    console.log(`  k1[${actual_idx-1}]: high=${k1.high.toFixed(2)}, low=${k1.low.toFixed(2)}`);
    console.log(`  k2[${actual_idx}]:   high=${k2.high.toFixed(2)}, low=${k2.low.toFixed(2)}`);
    console.log(`  k3[${actual_idx+1}]: high=${k3.high.toFixed(2)}, low=${k3.low.toFixed(2)}`);
  }
}

console.log('\n========== 分析完成 ==========');
