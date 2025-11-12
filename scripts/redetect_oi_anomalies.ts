/**
 * OI异动重新检测脚本
 * 用于重新检测指定日期的所有OI异动情况
 *
 * 使用方法:
 *   npm run ts-node scripts/redetect_oi_anomalies.ts [日期]
 *   npm run ts-node scripts/redetect_oi_anomalies.ts 2025-11-12
 *   npm run ts-node scripts/redetect_oi_anomalies.ts  # 默认今天
 */

import dotenv from 'dotenv';
import { format } from 'date-fns';
import { DatabaseConfig } from '../src/core/config/database';
import { OIRepository } from '../src/database/oi_repository';
import { daily_table_manager } from '../src/database/daily_table_manager';
import { logger, LogLevel } from '../src/utils/logger';

dotenv.config();

// 检测配置（与oi_polling_service.ts保持一致）
const DETECTION_CONFIG = {
  thresholds: {
    '60': 3,      // 1分钟: 3%
    '120': 3,     // 2分钟: 3%
    '300': 3,     // 5分钟: 3%
    '900': 10     // 15分钟: 10%
  },
  dedup_threshold: 1,  // 去重阈值: 1%
  severity_thresholds: {
    high: 30,    // ≥30%
    medium: 15   // ≥15%
  }
};

interface SnapshotData {
  id: number;
  symbol: string;
  open_interest: number;
  timestamp_ms: number;
  snapshot_time: Date;
  data_source: string;
}

interface AnomalyResult {
  symbol: string;
  period_minutes: number;
  percent_change: number;
  oi_before: number;
  oi_after: number;
  threshold: number;
  severity: 'low' | 'medium' | 'high';
  anomaly_time: Date;
}

class OIAnomalyRedetector {
  private oi_repository: OIRepository;
  private target_date: string;
  private detected_anomalies: AnomalyResult[] = [];

  constructor(target_date?: string) {
    this.oi_repository = OIRepository.get_instance();
    this.target_date = target_date || format(new Date(), 'yyyy-MM-dd');
  }

  async run(): Promise<void> {
    try {
      logger.info(`========================================`);
      logger.info(`🔍 开始重新检测 ${this.target_date} 的OI异动`);
      logger.info(`========================================`);

      // 1. 获取当天所有快照数据
      const snapshots = await this.load_snapshots();
      if (snapshots.length === 0) {
        logger.warn(`⚠️  未找到 ${this.target_date} 的快照数据`);
        return;
      }

      logger.info(`📊 加载了 ${snapshots.length} 条快照记录`);

      // 2. 按币种分组
      const symbols_map = this.group_by_symbol(snapshots);
      logger.info(`💰 共 ${symbols_map.size} 个币种`);

      // 3. 对每个币种进行检测
      let total_detected = 0;
      for (const [symbol, symbol_snapshots] of symbols_map.entries()) {
        const count = await this.detect_symbol_anomalies(symbol, symbol_snapshots);
        if (count > 0) {
          total_detected += count;
          logger.info(`  ✓ ${symbol}: 检测到 ${count} 个异动`);
        }
      }

      // 4. 保存检测结果
      if (this.detected_anomalies.length > 0) {
        await this.save_anomalies();
        logger.info(`\n✅ 检测完成！共检测到 ${this.detected_anomalies.length} 个异动`);
        this.print_summary();
      } else {
        logger.info(`\n✅ 检测完成！未检测到任何异动`);
      }

      logger.info(`========================================`);
    } catch (error) {
      logger.error('❌ 重新检测失败:', error);
      throw error;
    } finally {
      await DatabaseConfig.close_connections();
    }
  }

  /**
   * 加载指定日期的所有快照数据
   */
  private async load_snapshots(): Promise<SnapshotData[]> {
    const table_name = daily_table_manager.get_table_name(this.target_date);
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      // 先尝试从日期表加载
      logger.info(`📥 尝试从日期表加载: ${table_name}`);

      try {
        const [rows] = await conn.execute<any[]>(
          `SELECT * FROM ${table_name}
           ORDER BY symbol, timestamp_ms ASC`
        );

        if (rows.length > 0) {
          logger.info(`✅ 从日期表加载成功: ${rows.length} 条记录`);
          return rows as SnapshotData[];
        }
      } catch (err: any) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          logger.warn(`⚠️  日期表 ${table_name} 不存在`);
        } else {
          throw err;
        }
      }

      // 降级到原始表
      logger.info(`📥 尝试从原始表加载...`);
      const [fallback_rows] = await conn.execute<any[]>(
        `SELECT * FROM open_interest_snapshots
         WHERE DATE(snapshot_time) = ?
         ORDER BY symbol, timestamp_ms ASC`,
        [this.target_date]
      );

      if (fallback_rows.length > 0) {
        logger.info(`✅ 从原始表加载成功: ${fallback_rows.length} 条记录`);
      }

      return fallback_rows as SnapshotData[];
    } catch (error) {
      logger.error(`❌ 加载快照数据失败:`, error);
      return [];
    } finally {
      conn.release();
    }
  }

  /**
   * 按币种分组
   */
  private group_by_symbol(snapshots: SnapshotData[]): Map<string, SnapshotData[]> {
    const map = new Map<string, SnapshotData[]>();

    for (const snapshot of snapshots) {
      if (!map.has(snapshot.symbol)) {
        map.set(snapshot.symbol, []);
      }
      map.get(snapshot.symbol)!.push(snapshot);
    }

    return map;
  }

  /**
   * 检测单个币种的异动
   */
  private async detect_symbol_anomalies(
    symbol: string,
    snapshots: SnapshotData[]
  ): Promise<number> {
    let detected_count = 0;

    // 按时间排序
    snapshots.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

    // 对每个快照进行检测
    for (let i = 0; i < snapshots.length; i++) {
      const current = snapshots[i];

      // 检测每个时间周期
      for (const [period_str, threshold] of Object.entries(DETECTION_CONFIG.thresholds)) {
        const period_seconds = parseInt(period_str);
        const period_minutes = period_seconds / 60;

        // 查找period_seconds秒前的快照
        const target_timestamp = current.timestamp_ms - (period_seconds * 1000);
        const historical = this.find_closest_snapshot(snapshots, target_timestamp, i);

        if (!historical || historical.open_interest <= 0) continue;

        // 计算变化率
        const oi_before = historical.open_interest;
        const oi_after = current.open_interest;
        const percent_change = ((oi_after - oi_before) / oi_before) * 100;

        // 检查是否超过阈值
        if (Math.abs(percent_change) >= threshold) {
          // 检查是否需要去重
          if (this.should_skip_duplicate(symbol, period_seconds, percent_change)) {
            continue;
          }

          const severity = this.calculate_severity(percent_change);

          this.detected_anomalies.push({
            symbol,
            period_minutes,
            percent_change,
            oi_before,
            oi_after,
            threshold,
            severity,
            anomaly_time: current.snapshot_time
          });

          detected_count++;
        }
      }
    }

    return detected_count;
  }

  /**
   * 查找最接近目标时间的快照（只在当前快照之前查找）
   */
  private find_closest_snapshot(
    snapshots: SnapshotData[],
    target_timestamp: number,
    current_index: number
  ): SnapshotData | null {
    let closest: SnapshotData | null = null;
    let min_diff = Infinity;

    // 只在当前快照之前查找
    for (let i = 0; i < current_index; i++) {
      const snapshot = snapshots[i];
      const diff = Math.abs(snapshot.timestamp_ms - target_timestamp);

      if (diff < min_diff) {
        min_diff = diff;
        closest = snapshot;
      }
    }

    return closest;
  }

  /**
   * 检查是否需要跳过（去重）
   */
  private should_skip_duplicate(
    symbol: string,
    period_seconds: number,
    percent_change: number
  ): boolean {
    // 查找相同币种、相同周期的最近一次异动
    const recent_anomalies = this.detected_anomalies.filter(
      a => a.symbol === symbol && (a.period_minutes * 60) === period_seconds
    );

    if (recent_anomalies.length === 0) return false;

    // 获取最近一次的变化率
    const last_anomaly = recent_anomalies[recent_anomalies.length - 1];
    const change_diff = Math.abs(percent_change - last_anomaly.percent_change);

    // 如果变化率差异小于去重阈值，跳过
    return change_diff < DETECTION_CONFIG.dedup_threshold;
  }

  /**
   * 计算严重程度
   */
  private calculate_severity(percent_change: number): 'low' | 'medium' | 'high' {
    const abs_change = Math.abs(percent_change);

    if (abs_change >= DETECTION_CONFIG.severity_thresholds.high) {
      return 'high';
    } else if (abs_change >= DETECTION_CONFIG.severity_thresholds.medium) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * 保存异动记录到数据库
   */
  private async save_anomalies(): Promise<void> {
    logger.info(`\n💾 开始保存 ${this.detected_anomalies.length} 条异动记录...`);

    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      await conn.beginTransaction();

      for (const anomaly of this.detected_anomalies) {
        await conn.execute(
          `INSERT IGNORE INTO oi_anomaly_records
           (symbol, period_seconds, percent_change, oi_before, oi_after, severity, anomaly_time, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            anomaly.symbol,
            anomaly.period_minutes * 60,
            anomaly.percent_change,
            anomaly.oi_before,
            anomaly.oi_after,
            anomaly.severity,
            anomaly.anomaly_time
          ]
        );
      }

      await conn.commit();
      logger.info(`✅ 保存完成`);
    } catch (error) {
      await conn.rollback();
      logger.error('保存失败，已回滚:', error);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * 打印检测摘要
   */
  private print_summary(): void {
    logger.info(`\n📊 检测摘要:`);

    // 按严重程度统计
    const by_severity = {
      high: this.detected_anomalies.filter(a => a.severity === 'high').length,
      medium: this.detected_anomalies.filter(a => a.severity === 'medium').length,
      low: this.detected_anomalies.filter(a => a.severity === 'low').length
    };

    logger.info(`  严重级别分布:`);
    logger.info(`    🔴 高 (≥30%):    ${by_severity.high} 个`);
    logger.info(`    🟡 中 (≥15%):    ${by_severity.medium} 个`);
    logger.info(`    🟢 低 (<15%):    ${by_severity.low} 个`);

    // 按周期统计
    const by_period = new Map<number, number>();
    for (const anomaly of this.detected_anomalies) {
      const count = by_period.get(anomaly.period_minutes) || 0;
      by_period.set(anomaly.period_minutes, count + 1);
    }

    logger.info(`\n  周期分布:`);
    for (const [period, count] of Array.from(by_period.entries()).sort((a, b) => a[0] - b[0])) {
      logger.info(`    ${period}分钟: ${count} 个`);
    }

    // 前10个变化最大的
    const top_changes = [...this.detected_anomalies]
      .sort((a, b) => Math.abs(b.percent_change) - Math.abs(a.percent_change))
      .slice(0, 10);

    logger.info(`\n  TOP 10 变化最大的异动:`);
    for (let i = 0; i < top_changes.length; i++) {
      const a = top_changes[i];
      const time = format(new Date(a.anomaly_time), 'HH:mm:ss');
      logger.info(`    ${i + 1}. ${a.symbol.padEnd(12)} ${a.period_minutes}m ${a.percent_change.toFixed(2)}% (${time})`);
    }
  }
}

// 主函数
async function main() {
  // 设置日志级别
  logger.set_log_level(LogLevel.INFO);

  // 获取命令行参数
  const args = process.argv.slice(2);
  const target_date = args[0]; // 可选，默认今天

  if (target_date && !/^\d{4}-\d{2}-\d{2}$/.test(target_date)) {
    logger.error('❌ 日期格式错误，请使用 YYYY-MM-DD 格式');
    process.exit(1);
  }

  const redetector = new OIAnomalyRedetector(target_date);
  await redetector.run();
}

// 执行
main().catch(error => {
  logger.error('脚本执行失败:', error);
  process.exit(1);
});
