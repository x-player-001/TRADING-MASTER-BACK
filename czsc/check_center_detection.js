/**
 * 检查中枢检测过程
 */

const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./bnb-15-utc8.json', 'utf8'));

const all_klines = rawData.RECORDS.map(record => ({
  open_time: record.open_time,
  high: record.high,
  low: record.low,
  open: record.open,
  close: record.close
})).reverse();

const klines_500 = all_klines.slice(-500);

// 去包含
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
      fractals.push({ type, index: i, price, time: k2.open_time, high: k2.high, low: k2.low });
    }
  }
  return fractals;
}

// 笔构建
function build_strokes(fractals, min_bi_len = 5) {
  if (fractals.length < 2) return [];
  const strokes = [];
  let current_fx = fractals[0];

  for (let i = 1; i < fractals.length; i++) {
    const next_fx = fractals[i];
    const direction = current_fx.type === 'TOP' ? 'down' : 'up';
    const price_break = direction === 'up'
      ? next_fx.price > current_fx.price
      : next_fx.price < current_fx.price;

    if (!price_break) continue;

    const fx_a_high = Math.max(current_fx.high, current_fx.low);
    const fx_a_low = Math.min(current_fx.high, current_fx.low);
    const fx_b_high = Math.max(next_fx.high, next_fx.low);
    const fx_b_low = Math.min(next_fx.high, next_fx.low);

    const has_include =
      (fx_a_high >= fx_b_high && fx_a_low <= fx_b_low) ||
      (fx_b_high >= fx_a_high && fx_b_low <= fx_a_low);

    if (has_include) continue;

    const bi_length = next_fx.index - current_fx.index + 1;
    if (bi_length < min_bi_len) continue;

    strokes.push({
      start_fx: current_fx,
      end_fx: next_fx,
      direction,
      length: bi_length
    });

    current_fx = next_fx;
  }
  return strokes;
}

// 中枢检测
function detect_centers(strokes) {
  if (strokes.length < 3) {
    console.log('笔数不足3，无法形成中枢');
    return [];
  }

  const centers = [];
  let i = 0;

  console.log('\n========== 开始检测中枢 ==========');
  console.log(`共${strokes.length}条笔\n`);

  while (i <= strokes.length - 3) {
    const bi1 = strokes[i];
    const bi2 = strokes[i + 1];
    const bi3 = strokes[i + 2];

    // 计算每笔的high和low
    const bi1_high = Math.max(bi1.start_fx.price, bi1.end_fx.price);
    const bi1_low = Math.min(bi1.start_fx.price, bi1.end_fx.price);
    const bi2_high = Math.max(bi2.start_fx.price, bi2.end_fx.price);
    const bi2_low = Math.min(bi2.start_fx.price, bi2.end_fx.price);
    const bi3_high = Math.max(bi3.start_fx.price, bi3.end_fx.price);
    const bi3_low = Math.min(bi3.start_fx.price, bi3.end_fx.price);

    // 计算中枢边界
    const ZG = Math.min(bi1_high, bi2_high, bi3_high);
    const ZD = Math.max(bi1_low, bi2_low, bi3_low);

    console.log(`尝试从笔${i}开始构建中枢:`);
    console.log(`  笔${i}: ${bi1.start_fx.time} → ${bi1.end_fx.time} (${bi1.direction}), 区间[${bi1_low.toFixed(2)}, ${bi1_high.toFixed(2)}]`);
    console.log(`  笔${i+1}: ${bi2.start_fx.time} → ${bi2.end_fx.time} (${bi2.direction}), 区间[${bi2_low.toFixed(2)}, ${bi2_high.toFixed(2)}]`);
    console.log(`  笔${i+2}: ${bi3.start_fx.time} → ${bi3.end_fx.time} (${bi3.direction}), 区间[${bi3_low.toFixed(2)}, ${bi3_high.toFixed(2)}]`);
    console.log(`  计算中枢: ZG=${ZG.toFixed(2)}, ZD=${ZD.toFixed(2)}`);

    if (ZG <= ZD) {
      console.log(`  ❌ ZG <= ZD，无法形成中枢\n`);
      i++;
      continue;
    }

    // 验证前3笔是否都与中枢有交集
    const is_intersect = (bi_high, bi_low, ZG, ZD) => {
      const high_in = ZG >= bi_high && bi_high >= ZD;
      const low_in = ZG >= bi_low && bi_low >= ZD;
      const cross = bi_high >= ZG && ZD >= bi_low;
      return high_in || low_in || cross;
    };

    if (!is_intersect(bi1_high, bi1_low, ZG, ZD) ||
        !is_intersect(bi2_high, bi2_low, ZG, ZD) ||
        !is_intersect(bi3_high, bi3_low, ZG, ZD)) {
      console.log(`  ❌ 前3笔不都与中枢交集\n`);
      i++;
      continue;
    }

    // 尝试扩展中枢
    const center_strokes = [bi1, bi2, bi3];
    let next_idx = i + 3;

    while (next_idx < strokes.length) {
      const next_bi = strokes[next_idx];
      const next_high = Math.max(next_bi.start_fx.price, next_bi.end_fx.price);
      const next_low = Math.min(next_bi.start_fx.price, next_bi.end_fx.price);

      if (is_intersect(next_high, next_low, ZG, ZD)) {
        center_strokes.push(next_bi);
        console.log(`  ✓ 笔${next_idx}可以加入中枢`);
        next_idx++;
      } else {
        console.log(`  ✗ 笔${next_idx}不与中枢交集，中枢结束`);
        break;
      }
    }

    const height = ZG - ZD;
    const height_pct = (height / ((ZG + ZD) / 2)) * 100;

    console.log(`  ✅ 形成中枢: 笔${i}-${i + center_strokes.length - 1}, 区间[${ZD.toFixed(2)}, ${ZG.toFixed(2)}], 高度=${height_pct.toFixed(2)}%\n`);

    centers.push({
      start_bi: i,
      end_bi: i + center_strokes.length - 1,
      stroke_count: center_strokes.length,
      ZG,
      ZD,
      height_pct
    });

    i += center_strokes.length;
  }

  return centers;
}

const processed = remove_include(klines_500);
const fractals = detect_fractals(processed);
const target_fractals = fractals.filter(f =>
  f.time >= '2025-10-07 20:15:00' && f.time <= '2025-10-09 15:15:00'
);
const strokes = build_strokes(target_fractals, 5);

console.log('========================================');
console.log('目标时间段: 2025-10-07 20:15 ~ 2025-10-09 15:15');
console.log('========================================');
console.log(`分型数: ${target_fractals.length}`);
console.log(`笔数: ${strokes.length}`);

console.log('\n========== 所有笔 ==========');
strokes.forEach((s, i) => {
  console.log(`笔${i}: ${s.start_fx.time} → ${s.end_fx.time} (${s.direction}, 长度=${s.length})`);
});

const centers = detect_centers(strokes);

console.log('\n========================================');
console.log('中枢检测结果');
console.log('========================================');
console.log(`找到${centers.length}个中枢`);
