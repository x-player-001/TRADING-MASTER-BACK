/**
 * 缠论区间检测回测验证脚本
 * 用途: 验证基于缠论的区间检测策略有效性
 */

import { config as load_env } from 'dotenv';
load_env();

import { KlineMultiTableRepository } from '../src/database/kline_multi_table_repository';
import { RangeDetector } from '../src/analysis/range_detector';
import { ChanAnalyzerV2 } from '../src/analysis/chan_theory';
import { logger } from '../src/utils/logger';
import { ConfigManager } from '../src/core/config/config_manager';

/**
 * 主测试函数
 */
async function main() {
  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new KlineMultiTableRepository();
  const range_detector = new RangeDetector();
  const chan_analyzer = new ChanAnalyzerV2();

  console.log('\n========================================');
  console.log('缠论区间检测回测验证');
  console.log('========================================\n');

  // 测试配置
  const test_cases = [
    { symbol: 'BTCUSDT', interval: '15m', lookback: 500 },
    { symbol: 'ETHUSDT', interval: '15m', lookback: 500 },
    { symbol: 'BTCUSDT', interval: '1h', lookback: 500 }
  ];

  for (const test_case of test_cases) {
    await test_range_detection(kline_repo, range_detector, chan_analyzer, test_case);
  }

  console.log('\n========================================');
  console.log('测试完成');
  console.log('========================================\n');

  process.exit(0);
}

/**
 * 测试区间检测
 */
async function test_range_detection(
  kline_repo: KlineMultiTableRepository,
  range_detector: RangeDetector,
  chan_analyzer: ChanAnalyzerV2,
  config: { symbol: string; interval: string; lookback: number }
) {
  console.log(`\n>>> 测试: ${config.symbol} ${config.interval} (回溯${config.lookback}根K线)`);
  console.log('---');

  try {
    // 1. 获取K线数据
    const klines = await kline_repo.find_latest(
      config.symbol,
      config.interval,
      config.lookback
    );

    if (klines.length < 50) {
      console.log(`❌ K线数据不足: ${klines.length}根 (至少需要50根)\n`);
      return;
    }

    console.log(`✅ 已加载 ${klines.length} 根K线数据`);

    // 2. 缠论分析
    console.log('\n【缠论分析阶段】');
    const start_time = Date.now();

    // 注意: 数据库返回降序，需要反转
    const ordered_klines = [...klines].reverse();
    const chan_result = chan_analyzer.analyze(ordered_klines);

    const analysis_time = Date.now() - start_time;
    console.log(`分析耗时: ${analysis_time}ms`);

    // 打印缠论摘要
    chan_analyzer.print_summary(chan_result);

    // 3. 区间检测
    console.log('\n【区间检测阶段】');
    const ranges = range_detector.detect_ranges(klines, config.lookback);

    console.log(`\n检测到 ${ranges.length} 个有效区间:\n`);

    // 4. 详细输出区间信息
    ranges.forEach((range, index) => {
      console.log(`区间 #${index + 1}:`);
      console.log(`  时间范围: ${format_time(range.start_time)} ~ ${format_time(range.end_time)}`);
      console.log(`  支撑位: ${range.support.toFixed(2)}`);
      console.log(`  阻力位: ${range.resistance.toFixed(2)}`);
      console.log(`  中轴: ${range.middle.toFixed(2)}`);
      console.log(`  区间宽度: ${range.range_percent.toFixed(2)}%`);
      console.log(`  触碰次数: ${range.touch_count} (支撑: ${range.support_touches}, 阻力: ${range.resistance_touches})`);
      console.log(`  持续时间: ${range.duration_bars} 根K线`);
      console.log(`  置信度: ${(range.confidence * 100).toFixed(1)}%`);
      console.log(`  强度: ${range.strength}/100`);
      console.log(`  成交量趋势: ${range.volume_trend}`);

      if (range.pattern_data) {
        console.log(`  缠论数据:`);
        console.log(`    - 中枢ID: ${range.pattern_data.chan_center_id}`);
        console.log(`    - 笔数量: ${range.pattern_data.stroke_count}`);
        console.log(`    - 中枢强度: ${range.pattern_data.center_strength}/100`);
        console.log(`    - 扩展次数: ${range.pattern_data.extension_count}`);
      }

      console.log('');
    });

    // 5. 分析统计
    if (ranges.length > 0) {
      const stats = {
        avg_confidence: (ranges.reduce((sum, r) => sum + r.confidence, 0) / ranges.length * 100).toFixed(1),
        avg_strength: (ranges.reduce((sum, r) => sum + r.strength, 0) / ranges.length).toFixed(1),
        avg_duration: (ranges.reduce((sum, r) => sum + r.duration_bars, 0) / ranges.length).toFixed(1),
        avg_range_percent: (ranges.reduce((sum, r) => sum + r.range_percent, 0) / ranges.length).toFixed(2)
      };

      console.log('【统计信息】');
      console.log(`平均置信度: ${stats.avg_confidence}%`);
      console.log(`平均强度: ${stats.avg_strength}/100`);
      console.log(`平均持续时间: ${stats.avg_duration} 根K线`);
      console.log(`平均区间宽度: ${stats.avg_range_percent}%`);
    }

    console.log('\n---');

  } catch (error) {
    console.error(`❌ 测试失败:`, error);
  }
}

/**
 * 格式化时间
 */
function format_time(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
}

// 运行测试
main().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});
