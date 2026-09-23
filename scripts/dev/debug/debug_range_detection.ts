/**
 * 区间检测调试脚本
 *
 * 用于快速检查当前区间检测算法的效果
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register dev/debug/debug_range_detection.ts [symbol]
 *
 * 示例:
 * npx ts-node -r tsconfig-paths/register dev/debug/debug_range_detection.ts BTCUSDT
 * npx ts-node -r tsconfig-paths/register dev/debug/debug_range_detection.ts  # 检测所有币种
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import {
  OverlapRangeDetector,
  KlineData,
  OverlapRangeConfig
} from '../../../src/analysis/overlap_range_detector';

// 配置
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

async function fetch_klines(symbol: string, limit: number = 100): Promise<KlineData[]> {
  const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '5m', limit }
  });

  return response.data.map((k: any[]) => ({
    open_time: k[0],
    close_time: k[6],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

async function analyze_symbol(symbol: string, detector: OverlapRangeDetector): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`分析 ${symbol}`);
  console.log('═'.repeat(60));

  try {
    const klines = await fetch_klines(symbol);
    console.log(`获取到 ${klines.length} 根 5m K线`);

    const start = Date.now();
    const ranges = detector.detect_ranges(klines.slice(0, -1)); // 排除最新一根
    const elapsed = Date.now() - start;

    console.log(`检测耗时: ${elapsed}ms`);
    console.log(`检测到 ${ranges.length} 个区间\n`);

    if (ranges.length === 0) {
      console.log('未检测到有效区间');

      // 分析原因
      const trend = detector.analyze_trend(klines.slice(-30));
      console.log('\n趋势分析 (最近30根K线):');
      console.log(`  方向: ${trend.trend_direction}`);
      console.log(`  R²: ${trend.r_squared.toFixed(3)}`);
      console.log(`  价格变化: ${trend.price_change_pct.toFixed(2)}%`);
      console.log(`  是否趋势: ${trend.is_trending ? '是 (被过滤)' : '否'}`);
      return;
    }

    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      console.log(`[区间 ${i + 1}]`);
      console.log(detector.format_range(range));
      console.log('');
    }

    // 检查突破
    const current_kline = klines[klines.length - 1];
    const prev_klines = klines.slice(-20, -1);

    console.log('当前K线状态:');
    console.log(`  价格: ${current_kline.close.toFixed(6)}`);

    for (let i = 0; i < Math.min(ranges.length, 3); i++) {
      const range = ranges[i];
      const breakout = detector.detect_breakout(range, current_kline, prev_klines);

      if (breakout) {
        console.log(`\n🔔 区间${i + 1} 突破检测:`);
        console.log(`  方向: ${breakout.direction}`);
        console.log(`  突破幅度: ${breakout.breakout_pct.toFixed(2)}%`);
        console.log(`  成交量倍数: ${breakout.volume_ratio.toFixed(2)}x`);
        console.log(`  是否确认: ${breakout.is_confirmed ? '✓ 是' : '✗ 否'}`);

        if (breakout.confirmation) {
          console.log(`  确认详情:`);
          console.log(`    - 幅度确认: ${breakout.confirmation.amplitude_confirmed ? '✓' : '✗'}`);
          console.log(`    - 成交量确认: ${breakout.confirmation.volume_confirmed ? '✓' : '✗'}`);
          console.log(`    - K线确认: ${breakout.confirmation.bars_confirmed ? '✓' : '✗'}`);
          console.log(`    - 确认得分: ${breakout.confirmation.confirmation_score}`);
        }
      } else {
        const dist_up = ((range.extended_high - current_kline.close) / current_kline.close * 100).toFixed(2);
        const dist_down = ((current_kline.close - range.extended_low) / current_kline.close * 100).toFixed(2);
        console.log(`\n区间${i + 1}: 未突破 (距上沿 ${dist_up}%, 距下沿 ${dist_down}%)`);
      }
    }

  } catch (error) {
    console.error(`分析 ${symbol} 失败:`, error);
  }
}

async function analyze_top_symbols(detector: OverlapRangeDetector, limit: number = 20): Promise<void> {
  console.log(`\n正在分析 TOP ${limit} 交易量币种...\n`);

  // 获取交易量排名
  const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const tickers = response.data
    .filter((t: any) => t.symbol.endsWith('USDT'))
    .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit);

  const results: { symbol: string; ranges: number; best_score: number }[] = [];

  for (const ticker of tickers) {
    const symbol = ticker.symbol;
    try {
      const klines = await fetch_klines(symbol);
      const ranges = detector.detect_ranges(klines.slice(0, -1));

      if (ranges.length > 0) {
        const best_score = Math.max(...ranges.map(r => r.score.total_score));
        results.push({ symbol, ranges: ranges.length, best_score });
      }

      // 避免速率限制
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      // 忽略单个币种错误
    }
  }

  // 按最高分排序
  results.sort((a, b) => b.best_score - a.best_score);

  console.log('═'.repeat(60));
  console.log('区间检测结果汇总');
  console.log('═'.repeat(60));
  console.log(`检测币种: ${limit}`);
  console.log(`有区间的币种: ${results.length}`);
  console.log('');

  if (results.length > 0) {
    console.log('排名 | 币种           | 区间数 | 最高分');
    console.log('-'.repeat(50));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`${(i + 1).toString().padStart(4)} | ${r.symbol.padEnd(14)} | ${r.ranges.toString().padStart(6)} | ${r.best_score}`);
    }
  } else {
    console.log('未检测到任何区间！请检查算法配置。');
  }
}

async function main() {
  const detector = new OverlapRangeDetector(CONFIG);
  const args = process.argv.slice(2);

  console.log('═'.repeat(60));
  console.log('          区间检测调试工具');
  console.log('═'.repeat(60));
  console.log('\n当前配置:');
  console.log(`  窗口范围: ${CONFIG.min_window_size}-${CONFIG.max_window_size} 根K线`);
  console.log(`  最低分数: ${CONFIG.min_total_score}`);
  console.log(`  趋势过滤: R² >= ${CONFIG.trend_filter?.min_r_squared}`);

  if (args.length > 0) {
    // 分析指定币种
    const symbol = args[0].toUpperCase();
    await analyze_symbol(symbol, detector);
  } else {
    // 分析 TOP 交易量币种
    await analyze_top_symbols(detector, 30);
  }
}

main().catch(console.error);
