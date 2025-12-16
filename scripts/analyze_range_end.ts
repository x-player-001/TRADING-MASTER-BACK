/**
 * 分析区间为什么在特定时间结束
 *
 * 运行: npx ts-node -r tsconfig-paths/register scripts/analyze_range_end.ts VTHOUSDT
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import {
  OverlapRangeDetector,
  KlineData,
  OverlapRangeConfig
} from '../src/analysis/overlap_range_detector';
import { Kline5mRepository } from '../src/database/kline_5m_repository';
import { ConfigManager } from '../src/core/config/config_manager';

const CONFIG: Partial<OverlapRangeConfig> = {
  min_window_size: 12,
  max_window_size: 60,
  min_total_score: 50,
  trend_filter: {
    enabled: true,
    min_r_squared: 0.45,
    min_price_change_pct: 0.5,
    min_slope_per_bar_pct: 0.01
  },
  segment_split: {
    enabled: true,
    price_gap_pct: 0.5,
    time_gap_bars: 6
  }
};

/**
 * 格式化时间戳为北京时间 (UTC+8)
 */
function format_time(ts: number): string {
  const date = new Date(ts);
  // 转换为北京时间 (UTC+8)
  const beijing_hours = (date.getUTCHours() + 8) % 24;
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${beijing_hours.toString().padStart(2, '0')}:${minutes}`;
}

/**
 * 格式化完整日期时间为北京时间
 */
function format_datetime(ts: number): string {
  const date = new Date(ts);
  const utc_hours = date.getUTCHours();
  const beijing_hours = (utc_hours + 8) % 24;
  const day_offset = utc_hours + 8 >= 24 ? 1 : 0;

  const beijing_date = new Date(ts + day_offset * 24 * 60 * 60 * 1000);
  const month = (beijing_date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = (beijing_date.getUTCDate() + day_offset).toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');

  return `${month}-${day} ${beijing_hours.toString().padStart(2, '0')}:${minutes}`;
}

async function analyze(symbol: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`分析 ${symbol} 区间结束原因`);
  console.log('═'.repeat(70));

  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const detector = new OverlapRangeDetector(CONFIG);
  const repository = new Kline5mRepository();

  // 从数据库读取 K 线
  const db_klines = await repository.get_recent_klines(symbol, 100);

  if (db_klines.length < 20) {
    console.log(`数据库中只有 ${db_klines.length} 条 K 线数据，不足以分析`);
    return;
  }

  // 转换为 KlineData 格式
  const klines: KlineData[] = db_klines.map(k => ({
    open_time: k.open_time,
    close_time: k.close_time,
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    volume: Number(k.volume)
  }));

  console.log(`\n从数据库获取到 ${klines.length} 根 K 线`);
  console.log(`时间范围: ${format_time(klines[0].open_time)} - ${format_time(klines[klines.length - 1].open_time)}`);

  // 1. 检测当前区间
  const ranges = detector.detect_ranges(klines.slice(0, -1));
  console.log(`\n检测到 ${ranges.length} 个区间`);

  if (ranges.length === 0) {
    console.log('未检测到区间');

    // 分析整体趋势
    const trend = detector.analyze_trend(klines.slice(-30));
    console.log('\n整体趋势分析 (最近30根):');
    console.log(`  方向: ${trend.trend_direction}`);
    console.log(`  R²: ${trend.r_squared.toFixed(3)}`);
    console.log(`  是否趋势: ${trend.is_trending ? '是' : '否'}`);
    return;
  }

  // 获取得分最高的区间
  const best_range = ranges.reduce((a, b) =>
    a.score.total_score > b.score.total_score ? a : b
  );

  console.log(`\n最佳区间信息:`);
  console.log(`  时间: ${format_time(best_range.start_time)} - ${format_time(best_range.end_time)}`);
  console.log(`  K线数: ${best_range.kline_count}`);
  console.log(`  区间: ${best_range.lower_bound.toFixed(6)} - ${best_range.upper_bound.toFixed(6)}`);
  console.log(`  扩展边界: ${best_range.extended_low.toFixed(6)} - ${best_range.extended_high.toFixed(6)}`);
  console.log(`  得分: ${best_range.score.total_score}`);

  // 2. 找出区间结束时对应的 K 线索引
  const end_time = best_range.end_time;
  const end_idx = klines.findIndex(k => k.close_time === end_time);

  console.log(`\n区间结束于 K 线索引: ${end_idx}`);

  // 3. 分析后续 K 线
  console.log('\n后续 K 线分析:');
  console.log('-'.repeat(90));
  console.log('索引 | 时间  |    开盘    |    最高    |    最低    |    收盘    | 区间位置');
  console.log('-'.repeat(90));

  for (let i = Math.max(0, end_idx - 3); i < Math.min(klines.length, end_idx + 10); i++) {
    const k = klines[i];
    const time = format_time(k.open_time);

    // 判断位置
    let position = '';
    if (k.close > best_range.extended_high) {
      position = `↑ 突破上沿 +${((k.close - best_range.extended_high) / best_range.extended_high * 100).toFixed(3)}%`;
    } else if (k.close < best_range.extended_low) {
      position = `↓ 突破下沿 -${((best_range.extended_low - k.close) / best_range.extended_low * 100).toFixed(3)}%`;
    } else if (k.high > best_range.upper_bound || k.low < best_range.lower_bound) {
      position = '边缘';
    } else {
      position = '区间内';
    }

    const marker = i === end_idx ? ' ← 区间结束' : (i > end_idx ? ' *' : '');
    console.log(
      `${i.toString().padStart(3)} | ${time} | ${k.open.toFixed(8)} | ${k.high.toFixed(8)} | ${k.low.toFixed(8)} | ${k.close.toFixed(8)} | ${position}${marker}`
    );
  }

  // 4. 分析为什么后续 K 线没有扩展区间
  console.log('\n趋势分析 (解释区间为什么结束):');
  console.log('-'.repeat(70));

  // 分析不同窗口的趋势
  const windows_to_check = [
    { start: end_idx - 11, end: end_idx + 1, label: '区间内 (12根)' },
    { start: end_idx - 11, end: end_idx + 5, label: '扩展5根后 (17根)' },
    { start: end_idx - 11, end: end_idx + 10, label: '扩展10根后 (22根)' },
    { start: end_idx + 1, end: end_idx + 13, label: '后续12根' }
  ];

  for (const w of windows_to_check) {
    if (w.start < 0 || w.end > klines.length) continue;

    const window_klines = klines.slice(w.start, w.end);
    if (window_klines.length < 3) continue;

    const trend = detector.analyze_trend(window_klines);

    console.log(`\n${w.label} (${format_time(window_klines[0].open_time)} - ${format_time(window_klines[window_klines.length - 1].open_time)}):`);
    console.log(`  方向: ${trend.trend_direction}`);
    console.log(`  R²: ${trend.r_squared.toFixed(3)} ${trend.r_squared >= 0.45 ? '≥ 0.45 (有趋势)' : '< 0.45 (无趋势)'}`);
    console.log(`  价格变化: ${trend.price_change_pct.toFixed(3)}% ${trend.price_change_pct >= 0.5 ? '≥ 0.5%' : '< 0.5%'}`);
    console.log(`  趋势强度: ${trend.trend_strength.toFixed(3)}`);
    console.log(`  是否被过滤: ${trend.is_trending ? '✗ 是 (会被趋势过滤跳过)' : '✓ 否 (可以识别为区间)'}`);
  }

  // 5. 价格跳空检测
  console.log('\n价格变化检测:');
  console.log('-'.repeat(70));

  for (let i = Math.max(1, end_idx - 2); i < Math.min(klines.length, end_idx + 8); i++) {
    const prev = klines[i - 1];
    const curr = klines[i];

    const price_change = Math.abs(curr.close - prev.close);
    const change_pct = (price_change / prev.close) * 100;

    const gap_up = curr.low > prev.high;
    const gap_down = curr.high < prev.low;

    if (gap_up || gap_down || change_pct >= 0.3) {
      const marker = i === end_idx + 1 ? ' ← 区间结束后第一根' : '';
      console.log(`K线 ${i} (${format_time(curr.open_time)}): 价格变化 ${change_pct.toFixed(3)}%${gap_up ? ' [向上跳空]' : ''}${gap_down ? ' [向下跳空]' : ''}${marker}`);
    }
  }

  // 6. 模拟不同截止点的区间检测
  console.log('\n模拟不同数据截止点的检测结果:');
  console.log('-'.repeat(70));

  for (let cutoff = end_idx; cutoff < Math.min(klines.length, end_idx + 8); cutoff++) {
    const partial_klines = klines.slice(0, cutoff + 1);
    const partial_ranges = detector.detect_ranges(partial_klines);

    const matching = partial_ranges.filter(r =>
      Math.abs(r.center_price - best_range.center_price) / best_range.center_price < 0.01
    );

    if (matching.length > 0) {
      const m = matching.reduce((a, b) => a.score.total_score > b.score.total_score ? a : b);
      console.log(`截止到 K线 ${cutoff} (${format_time(klines[cutoff].open_time)}): 检测到区间, 结束于 ${format_time(m.end_time)}, 得分 ${m.score.total_score}`);
    } else {
      console.log(`截止到 K线 ${cutoff} (${format_time(klines[cutoff].open_time)}): 未检测到匹配区间`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('\n结论:');
  console.log('区间的 end_time 是由滑动窗口扫描时的最后一根 K 线决定的。');
  console.log('当后续 K 线加入后，如果窗口内出现趋势 (R² >= 0.45 且价格变化 >= 0.5%)，');
  console.log('该窗口会被趋势过滤器跳过，不会识别为区间。');
  console.log('因此，即使后续 K 线价格仍在区间范围内，区间也不会自动扩展。');
}

async function main() {
  const symbol = process.argv[2]?.toUpperCase() || 'VTHOUSDT';

  try {
    await analyze(symbol);
  } catch (error: any) {
    console.error('分析失败:', error.message);
    console.error(error.stack);
  } finally {
    // 退出进程
    process.exit(0);
  }
}

main();
