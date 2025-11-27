/**
 * 检查异动表中价格极值字段的覆盖情况
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { DatabaseManager } from '@/database/database_manager';
import { ConfigManager } from '@/core/config/config_manager';

async function check_price_extremes() {
  // 初始化配置
  ConfigManager.getInstance();

  const db_manager = DatabaseManager.getInstance();
  const connection = await db_manager.get_connection();

  try {
    console.log('\n📊 异动表价格极值字段覆盖率统计\n');

    // 按日期统计覆盖率
    const [rows] = await connection.execute(`
      SELECT
        DATE(anomaly_time) as date,
        COUNT(*) as total_records,
        COUNT(daily_price_low) as has_price_low,
        COUNT(daily_price_high) as has_price_high,
        COUNT(price_from_low_pct) as has_from_low_pct,
        COUNT(price_from_high_pct) as has_from_high_pct,
        CONCAT(ROUND(COUNT(daily_price_low) * 100.0 / COUNT(*), 2), '%') as coverage_rate
      FROM oi_anomaly_records
      GROUP BY DATE(anomaly_time)
      ORDER BY DATE(anomaly_time) DESC
      LIMIT 30
    `);

    console.log('日期\t\t总记录数\t有价格极值\t覆盖率');
    console.log('='.repeat(70));

    for (const row of rows as any[]) {
      console.log(
        `${row.date}\t${row.total_records}\t\t${row.has_price_low}\t\t${row.coverage_rate}`
      );
    }

    // 查找第一条有价格极值的记录
    const [firstRecord] = await connection.execute(`
      SELECT
        anomaly_time,
        symbol,
        daily_price_low,
        daily_price_high,
        price_from_low_pct,
        price_from_high_pct
      FROM oi_anomaly_records
      WHERE daily_price_low IS NOT NULL
      ORDER BY anomaly_time ASC
      LIMIT 1
    `);

    console.log('\n\n🔍 第一条有价格极值数据的记录:');
    if ((firstRecord as any[]).length > 0) {
      const record = (firstRecord as any[])[0];
      console.log(`  时间: ${record.anomaly_time}`);
      console.log(`  币种: ${record.symbol}`);
      console.log(`  日内低点: ${record.daily_price_low}`);
      console.log(`  日内高点: ${record.daily_price_high}`);
      console.log(`  距低点涨幅: ${record.price_from_low_pct}%`);
      console.log(`  距高点跌幅: ${record.price_from_high_pct}%`);
    }

    // 查找最后一条没有价格极值的记录
    const [lastNullRecord] = await connection.execute(`
      SELECT
        anomaly_time,
        symbol
      FROM oi_anomaly_records
      WHERE daily_price_low IS NULL
      ORDER BY anomaly_time DESC
      LIMIT 1
    `);

    console.log('\n\n🔍 最后一条没有价格极值数据的记录:');
    if ((lastNullRecord as any[]).length > 0) {
      const record = (lastNullRecord as any[])[0];
      console.log(`  时间: ${record.anomaly_time}`);
      console.log(`  币种: ${record.symbol}`);
    }

    // 统计总体情况
    const [summary] = await connection.execute(`
      SELECT
        COUNT(*) as total,
        COUNT(daily_price_low) as has_data,
        COUNT(*) - COUNT(daily_price_low) as missing,
        CONCAT(ROUND(COUNT(daily_price_low) * 100.0 / COUNT(*), 2), '%') as coverage
      FROM oi_anomaly_records
    `);

    console.log('\n\n📈 总体统计:');
    const stats = (summary as any[])[0];
    console.log(`  总记录数: ${stats.total}`);
    console.log(`  有价格极值: ${stats.has_data}`);
    console.log(`  缺失数据: ${stats.missing}`);
    console.log(`  覆盖率: ${stats.coverage}`);

  } finally {
    connection.release();
    await db_manager.close_pool();
  }
}

check_price_extremes().catch(console.error);
