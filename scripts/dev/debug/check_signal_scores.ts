/**
 * 检查各日期的信号评分分布
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../../../src/database/oi_repository';
import { ConfigManager } from '../../../src/core/config/config_manager';

async function check_signal_scores() {
  console.log('🔍 检查信号评分分布...\n');

  // 初始化配置管理器
  await ConfigManager.getInstance().initialize();

  const repository = new OIRepository();

  try {
    // 查询最近7天的异动数据
    const seven_days_ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const all_anomalies = await repository.get_anomaly_records({
      start_time: seven_days_ago,
      end_time: now,
      order: 'ASC'
    });

    console.log(`✅ 查询到 ${all_anomalies.length} 条异动记录\n`);

    // 按日期分组统计
    const stats_by_date = new Map<string, {
      total: number;
      score_gte_5: number;
      scores: number[];
    }>();

    for (const anomaly of all_anomalies) {
      const date = new Date(anomaly.anomaly_time).toISOString().split('T')[0];
      if (!stats_by_date.has(date)) {
        stats_by_date.set(date, { total: 0, score_gte_5: 0, scores: [] });
      }
      const stat = stats_by_date.get(date)!;
      stat.total++;
      if (anomaly.signal_score && anomaly.signal_score >= 5) {
        stat.score_gte_5++;
      }
      if (anomaly.signal_score !== null && anomaly.signal_score !== undefined) {
        stat.scores.push(anomaly.signal_score);
      }
    }

    // 输出统计结果
    console.log('📊 信号评分统计:\n');
    console.log('日期'.padEnd(15) + '总数'.padEnd(10) + '≥5分'.padEnd(10) + '占比'.padEnd(12) + '平均分'.padEnd(12) + '最小分'.padEnd(10) + '最大分');
    console.log('─'.repeat(85));

    const sorted_dates = Array.from(stats_by_date.keys()).sort();

    for (const date of sorted_dates) {
      const stat = stats_by_date.get(date)!;
      const percentage = stat.total > 0 ? ((stat.score_gte_5 / stat.total) * 100).toFixed(1) + '%' : '0.0%';
      const avg_score = stat.scores.length > 0
        ? (stat.scores.reduce((a, b) => a + b, 0) / stat.scores.length).toFixed(2)
        : 'N/A';
      const min_score = stat.scores.length > 0
        ? Math.min(...stat.scores).toFixed(2)
        : 'N/A';
      const max_score = stat.scores.length > 0
        ? Math.max(...stat.scores).toFixed(2)
        : 'N/A';

      console.log(
        date.padEnd(15) +
        stat.total.toString().padEnd(10) +
        stat.score_gte_5.toString().padEnd(10) +
        percentage.padEnd(12) +
        avg_score.padEnd(12) +
        min_score.padEnd(10) +
        max_score
      );
    }

    console.log('─'.repeat(85));

    // 汇总统计
    const total_all = all_anomalies.length;
    const total_gte_5 = all_anomalies.filter(a => a.signal_score && a.signal_score >= 5).length;
    const all_scores = all_anomalies
      .filter(a => a.signal_score !== null && a.signal_score !== undefined)
      .map(a => a.signal_score!);
    const avg_all = all_scores.length > 0
      ? (all_scores.reduce((a, b) => a + b, 0) / all_scores.length).toFixed(2)
      : 'N/A';

    console.log(`\n📈 总计: ${total_all} 条异动，${total_gte_5} 条≥5分 (${(total_gte_5/total_all*100).toFixed(1)}%)，平均分: ${avg_all}\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ 查询失败:', error);
    process.exit(1);
  }
}

check_signal_scores();
