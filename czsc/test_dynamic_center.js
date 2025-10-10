/**
 * 测试动态边界中枢算法
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

// 动态边界中枢检测
function detect_centers_dynamic(strokes, min_bi_count = 3) {
  if (strokes.length < min_bi_count) {
    console.log('笔数不足，无法形成中枢');
    return [];
  }

  const centers = [];
  let i = 0;

  console.log('\n========== 动态边界中枢检测 ==========');
  console.log(`共${strokes.length}条笔\n`);

  while (i <= strokes.length - min_bi_count) {
    let zg = null; // 中枢上沿
    let zd = null; // 中枢下沿
    const zs_bis = [];

    console.log(`\n尝试从笔${i}开始构建中枢:`);

    // 遍历后续笔
    for (let j = i; j < strokes.length; j++) {
      const bi = strokes[j];
      const bi_high = Math.max(bi.start_fx.price, bi.end_fx.price);
      const bi_low = Math.min(bi.start_fx.price, bi.end_fx.price);
      const is_up = bi.direction === 'up';

      if (is_up) {
        // 向上笔：用低点计算ZG
        const new_low = bi_low;

        if (zg === null) {
          zg = new_low;
          zs_bis.push(bi);
          console.log(`  笔${j}(↑): low=${new_low.toFixed(2)}, 初始化 ZG=${zg.toFixed(2)}`);
        } else {
          const temp_zg = Math.max(zg, new_low);

          if (zd === null || temp_zg <= zd) {
            zg = temp_zg;
            zs_bis.push(bi);
            console.log(`  笔${j}(↑): low=${new_low.toFixed(2)}, ZG=${zg.toFixed(2)}, ZD=${zd?.toFixed(2) || 'null'}, 仍有重叠 ✓`);
          } else {
            console.log(`  笔${j}(↑): low=${new_low.toFixed(2)}, temp_ZG=${temp_zg.toFixed(2)} > ZD=${zd.toFixed(2)}, 中枢结束 ✗`);
            break;
          }
        }
      } else {
        // 向下笔：用高点计算ZD
        const new_high = bi_high;

        if (zd === null) {
          zd = new_high;
          zs_bis.push(bi);
          console.log(`  笔${j}(↓): high=${new_high.toFixed(2)}, 初始化 ZD=${zd.toFixed(2)}`);
        } else {
          const temp_zd = Math.min(zd, new_high);

          if (zg === null || temp_zd >= zg) {
            zd = temp_zd;
            zs_bis.push(bi);
            console.log(`  笔${j}(↓): high=${new_high.toFixed(2)}, ZD=${zd.toFixed(2)}, ZG=${zg?.toFixed(2) || 'null'}, 仍有重叠 ✓`);
          } else {
            console.log(`  笔${j}(↓): high=${new_high.toFixed(2)}, temp_ZD=${temp_zd.toFixed(2)} < ZG=${zg.toFixed(2)}, 中枢结束 ✗`);
            break;
          }
        }
      }
    }

    // 验证中枢
    if (
      zs_bis.length >= min_bi_count &&
      zg !== null &&
      zd !== null &&
      zd >= zg
    ) {
      const height = zd - zg;
      const height_pct = (height / ((zd + zg) / 2)) * 100;

      console.log(`  ✅ 形成中枢: 笔${i}-${i + zs_bis.length - 1}, 区间[${zg.toFixed(2)}, ${zd.toFixed(2)}], 笔数=${zs_bis.length}, 高度=${height_pct.toFixed(2)}%`);

      centers.push({
        start_bi: i,
        end_bi: i + zs_bis.length - 1,
        stroke_count: zs_bis.length,
        ZG: zg,
        ZD: zd,
        height_pct
      });

      i += zs_bis.length;
    } else {
      const reason = [];
      if (zs_bis.length < min_bi_count) reason.push(`笔数${zs_bis.length} < ${min_bi_count}`);
      if (zg === null) reason.push('ZG未定义');
      if (zd === null) reason.push('ZD未定义');
      if (zg !== null && zd !== null && zd < zg) reason.push(`ZD(${zd.toFixed(2)}) < ZG(${zg.toFixed(2)})`);
      console.log(`  ❌ 无法形成中枢: ${reason.join(', ')}`);
      i++;
    }
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

const centers = detect_centers_dynamic(strokes, 3);

console.log('\n========================================');
console.log('动态边界算法结果');
console.log('========================================');
console.log(`找到${centers.length}个中枢`);
