/**
 * 检查数据库中异动数据的日期范围
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../src/database/oi_repository';
import { ConfigManager } from '../src/core/config/config_manager';

async function check_data_range() {
  console.log('🔍 检查异动数据日期范围...\n');

  // 初始化配置管理器
  await ConfigManager.getInstance().initialize();

  const repository = new OIRepository();

  try {
    // 使用公开的API查询最近7天的异动数据
    const seven_days_ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const all_anomalies = await repository.get_anomaly_records({
      start_time: seven_days_ago,
      end_time: now,
      order: 'ASC'
    });

    // 按日期分组统计
    const stats_by_date = new Map<string, {
      count: number;
      symbols: Set<string>;
      has_price_extremes: number;
      missing_price_extremes: number;
    }>();

    for (const anomaly of all_anomalies) {
      const date = new Date(anomaly.anomaly_time).toISOString().split('T')[0];
      if (!stats_by_date.has(date)) {
        stats_by_date.set(date, { count: 0, symbols: new Set(), has_price_extremes: 0, missing_price_extremes: 0 });
      }
      const stat = stats_by_date.get(date)!;
      stat.count++;
      stat.symbols.add(anomaly.symbol);

      // 检查价格极值字段（回测引擎需要这些字段）
      const has_extremes =
        anomaly.daily_price_low !== null &&
        anomaly.daily_price_high !== null &&
        anomaly.price_from_low_pct !== null &&
        anomaly.price_from_high_pct !== null;

      if (has_extremes) {
        stat.has_price_extremes++;
      } else {
        stat.missing_price_extremes++;
      }
    }

    // 转换为数组格式
    const results = Array.from(stats_by_date.entries()).map(([date, stat]) => ({
      date,
      count: stat.count,
      symbols: stat.symbols.size,
      has_price_extremes: stat.has_price_extremes,
      missing_price_extremes: stat.missing_price_extremes
    })).sort((a, b) => a.date.localeCompare(b.date));

    console.log('📊 最近7天异动数据统计 (含价格极值字段检查):\n');
    console.log('日期'.padEnd(15) + '异动数量'.padEnd(12) + '币种'.padEnd(10) + '有极值'.padEnd(12) + '缺失'.padEnd(10) + '完整率');
    console.log('─'.repeat(75));

    let total_count = 0;
    let total_has_extremes = 0;
    for (const row of results) {
      const coverage = row.count > 0 ? ((row.has_price_extremes / row.count) * 100).toFixed(1) + '%' : '0.0%';
      console.log(
        `${row.date}`.padEnd(15) +
        `${row.count}`.padEnd(12) +
        `${row.symbols}`.padEnd(10) +
        `${row.has_price_extremes}`.padEnd(12) +
        `${row.missing_price_extremes}`.padEnd(10) +
        coverage
      );
      total_count += row.count;
      total_has_extremes += row.has_price_extremes;
    }

    console.log('─'.repeat(75));
    const overall_coverage = total_count > 0 ? ((total_has_extremes / total_count) * 100).toFixed(1) + '%' : '0.0%';
    console.log(`总计: ${total_count} 条异动，${total_has_extremes} 条有价格极值 (${overall_coverage})\n`);

    // 查询最新和最旧的记录
    if (all_anomalies.length > 0) {
      const earliest = all_anomalies[0].anomaly_time;
      const latest = all_anomalies[all_anomalies.length - 1].anomaly_time;

      console.log('📅 数据时间范围:');
      console.log(`  最早: ${earliest}`);
      console.log(`  最新: ${latest}\n`);
    } else {
      console.log('📅 数据时间范围: 无数据\n');
    }

    // 检查今天是否有数据
    const today_str = new Date().toISOString().split('T')[0];
    const today_count = stats_by_date.get(today_str)?.count || 0;

    console.log(`📆 今天 (${today_str}) 的数据:`);
    console.log(`  异动数量: ${today_count}\n`);

    if (today_count === 0) {
      console.log('⚠️  今天没有异动数据！');
      console.log('可能原因:');
      console.log('  1. OI轮询服务未运行');
      console.log('  2. 今天确实没有触发异动');
      console.log('  3. 数据库连接或写入问题\n');
    }

    // ⚠️ 关键发现提示
    console.log('═'.repeat(75));
    console.log('⚠️  重要: 回测引擎的数据过滤逻辑');
    console.log('═'.repeat(75));
    console.log('回测引擎 (backtest_engine.ts:259-264) 会过滤掉缺少价格极值字段的记录：');
    console.log('  - daily_price_low');
    console.log('  - daily_price_high');
    console.log('  - price_from_low_pct');
    console.log('  - price_from_high_pct');
    console.log('');
    console.log('如果某个日期的数据完整率为 0%，回测将跳过该日期的所有信号！');
    console.log('这就是为什么回测可能在某个日期后停止交易的原因。\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ 查询失败:', error);
    process.exit(1);
  }
}

check_data_range();
