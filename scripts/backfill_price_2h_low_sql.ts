/**
 * 回填历史异动记录的 price_2h_low 和 price_from_2h_low_pct 字段
 *
 * 优化策略：使用单条SQL更新，让数据库服务器执行计算
 *
 * 运行: npx ts-node -r tsconfig-paths/register scripts/backfill_price_2h_low_sql.ts [天数]
 */

import dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';
import { format, subDays } from 'date-fns';

// 初始化配置
ConfigManager.getInstance().initialize();

interface AnomalyRecord {
  id: number;
  symbol: string;
  anomaly_time: Date;
  mark_price: number;
}

/**
 * 获取日期对应的表名
 */
function get_table_name(date: Date): string {
  return `oi_snapshots_${format(date, 'yyyyMMdd')}`;
}

/**
 * 检查表是否存在
 */
async function table_exists(conn: any, table_name: string): Promise<boolean> {
  try {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
      [table_name]
    );
    return (rows as any[]).length > 0;
  } catch {
    return false;
  }
}

/**
 * 处理单条记录（在数据库端计算）
 */
async function process_record(
  conn: any,
  record: AnomalyRecord
): Promise<{ updated: boolean; price_2h_low?: number }> {
  const anomaly_time = new Date(record.anomaly_time);
  const start_time = new Date(anomaly_time.getTime() - 2 * 60 * 60 * 1000); // 2小时前

  // 获取需要查询的表（可能跨天）
  const tables_to_query: string[] = [];
  const start_date = new Date(start_time);
  start_date.setHours(0, 0, 0, 0);
  const end_date = new Date(anomaly_time);
  end_date.setHours(0, 0, 0, 0);

  const current = new Date(start_date);
  while (current <= end_date) {
    const table_name = get_table_name(current);
    if (await table_exists(conn, table_name)) {
      tables_to_query.push(table_name);
    }
    current.setDate(current.getDate() + 1);
  }

  if (tables_to_query.length === 0) {
    return { updated: false };
  }

  // 构建查询获取2小时最低价
  const union_parts = tables_to_query.map(table =>
    `SELECT MIN(mark_price) as min_price FROM ${table} WHERE symbol = ? AND snapshot_time >= ? AND snapshot_time <= ? AND mark_price IS NOT NULL`
  );

  const sql = `SELECT MIN(min_price) as price_2h_low FROM (${union_parts.join(' UNION ALL ')}) t`;
  const params: any[] = [];
  for (let i = 0; i < tables_to_query.length; i++) {
    params.push(record.symbol, start_time, anomaly_time);
  }

  try {
    const [result] = await conn.query(sql, params);
    const price_2h_low = (result as any[])[0]?.price_2h_low;

    if (price_2h_low === null || price_2h_low === undefined) {
      return { updated: false };
    }

    const price_from_2h_low_pct = ((record.mark_price - price_2h_low) / price_2h_low) * 100;

    // 更新记录
    await conn.query(
      `UPDATE oi_anomaly_records SET price_2h_low = ?, price_from_2h_low_pct = ? WHERE id = ?`,
      [price_2h_low, price_from_2h_low_pct, record.id]
    );

    return { updated: true, price_2h_low: parseFloat(price_2h_low) };
  } catch (err: any) {
    console.error(`  ❌ 处理 ID=${record.id} 失败:`, err.message);
    return { updated: false };
  }
}

async function main() {
  const days = parseInt(process.argv[2]) || 1;

  console.log(`开始回填 price_2h_low 数据（最近${days}天）...\n`);
  console.log('策略: 逐条处理，使用SQL子查询获取最低价\n');

  console.log('正在连接数据库...');
  const conn = await DatabaseConfig.get_mysql_connection();
  console.log('数据库连接成功\n');

  try {
    const start_time = Date.now();

    // 获取需要处理的时间范围
    const end_date = new Date();
    const start_date = subDays(end_date, days);

    // 查询需要填充的记录
    console.log('查询待填充记录...');
    const [records] = await conn.query(`
      SELECT id, symbol, anomaly_time, mark_price
      FROM oi_anomaly_records
      WHERE anomaly_time >= ?
        AND price_2h_low IS NULL
      ORDER BY id ASC
      LIMIT 500
    `, [start_date]);

    const anomalies = records as AnomalyRecord[];
    console.log(`找到 ${anomalies.length} 条待填充记录\n`);

    if (anomalies.length === 0) {
      console.log('没有需要处理的记录');
      return;
    }

    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < anomalies.length; i++) {
      const record = anomalies[i];
      const result = await process_record(conn, record);

      if (result.updated) {
        updated++;
        if (updated <= 10 || updated % 50 === 0) {
          console.log(`  ✅ ID=${record.id} ${record.symbol} price_2h_low=${result.price_2h_low?.toFixed(6)}`);
        }
      } else {
        skipped++;
      }

      // 每50条显示进度
      if ((i + 1) % 50 === 0) {
        const elapsed = (Date.now() - start_time) / 1000;
        const speed = (i + 1) / elapsed;
        console.log(`\n进度: ${i + 1}/${anomalies.length} | 更新: ${updated} | 跳过: ${skipped} | 速度: ${speed.toFixed(1)}/s\n`);
      }
    }

    const elapsed = ((Date.now() - start_time) / 1000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ 完成！耗时 ${elapsed} 秒`);
    console.log(`   更新: ${updated} 条`);
    console.log(`   跳过: ${skipped} 条`);
    console.log(`${'='.repeat(60)}`);

  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
