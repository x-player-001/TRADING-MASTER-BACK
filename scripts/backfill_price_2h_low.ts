/**
 * 回填历史异动记录的 price_2h_low 和 price_from_2h_low_pct 字段
 *
 * 运行: npx ts-node -r tsconfig-paths/register scripts/backfill_price_2h_low.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';
import { DailyTableManager } from '../src/database/daily_table_manager';
import { format, subHours } from 'date-fns';

// 初始化配置
ConfigManager.getInstance().initialize();

interface AnomalyRecord {
  id: number;
  symbol: string;
  anomaly_time: Date;
  mark_price: number;
  price_2h_low: number | null;
}

async function get_price_2h_low(
  conn: any,
  symbol: string,
  anomaly_time: Date,
  daily_table_manager: DailyTableManager
): Promise<number | null> {
  // 计算2小时前的时间
  const start_time = subHours(anomaly_time, 2);

  // 获取需要查询的表（可能跨天）
  const tables = await daily_table_manager.get_tables_in_range(start_time, anomaly_time);

  if (tables.length === 0) {
    return null;
  }

  // 构建 UNION ALL 查询
  const union_queries = tables.map(table => `
    SELECT mark_price
    FROM ${table}
    WHERE symbol = ?
      AND snapshot_time >= ?
      AND snapshot_time <= ?
      AND mark_price IS NOT NULL
  `).join(' UNION ALL ');

  const sql = `
    SELECT MIN(mark_price) as price_2h_low
    FROM (${union_queries}) as combined
  `;

  // 参数：每个子查询都需要 symbol, start_time, end_time
  const params: any[] = [];
  for (let i = 0; i < tables.length; i++) {
    params.push(symbol, start_time, anomaly_time);
  }

  try {
    const [rows] = await conn.query(sql, params);
    const result = (rows as any[])[0];
    return result?.price_2h_low ? parseFloat(result.price_2h_low) : null;
  } catch (error: any) {
    console.error(`查询失败 ${symbol} @ ${anomaly_time}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('开始回填 price_2h_low 数据（最近8天）...\n');

  console.log('正在连接数据库...');
  const conn = await DatabaseConfig.get_mysql_connection();
  console.log('数据库连接成功');

  const daily_table_manager = DailyTableManager.get_instance();

  try {
    // 查询最近8天待填充的记录
    console.log('查询最近8天待填充的记录...');
    const [anomalies] = await conn.query(`
      SELECT id, symbol, anomaly_time, mark_price, price_2h_low
      FROM oi_anomaly_records
      WHERE anomaly_time >= DATE_SUB(NOW(), INTERVAL 8 DAY)
        AND price_2h_low IS NULL
      ORDER BY id ASC
    `);
    console.log('查询完成');

    const records = anomalies as AnomalyRecord[];
    console.log(`找到 ${records.length} 条待更新记录\n`);

    if (records.length === 0) {
      console.log('没有需要更新的记录');
      return;
    }

    console.log(`开始处理，预计耗时 ${Math.ceil(records.length / 60)} 分钟...\n`);

    let updated = 0;
    let skipped = 0;
    const total = records.length;
    const start_time = Date.now();

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const { id, symbol, anomaly_time, mark_price } = record;

      // 获取2小时内最低价
      const price_2h_low = await get_price_2h_low(conn, symbol, anomaly_time, daily_table_manager);

      if (price_2h_low === null) {
        skipped++;
        // 只在调试时打印跳过信息
        // console.log(`[跳过] ID=${id} ${symbol} @ ${format(anomaly_time, 'MM-dd HH:mm')} - 无历史数据`);
      } else {
        // 计算涨幅
        const price_from_2h_low_pct = ((mark_price - price_2h_low) / price_2h_low) * 100;

        // 更新数据库
        await conn.query(`
          UPDATE oi_anomaly_records
          SET price_2h_low = ?, price_from_2h_low_pct = ?
          WHERE id = ?
        `, [price_2h_low, price_from_2h_low_pct, id]);

        updated++;
      }

      // 每100条打印进度
      if ((i + 1) % 100 === 0 || i === records.length - 1) {
        const elapsed = (Date.now() - start_time) / 1000;
        const speed = (i + 1) / elapsed;
        const eta = Math.ceil((total - i - 1) / speed);
        console.log(`进度: ${i + 1}/${total} (${((i + 1) / total * 100).toFixed(1)}%) | 更新: ${updated} | 跳过: ${skipped} | 速度: ${speed.toFixed(1)}/s | 剩余: ${eta}s`);
      }
    }

    console.log(`\n✅ 完成！更新: ${updated} 条, 跳过: ${skipped} 条`);

  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
