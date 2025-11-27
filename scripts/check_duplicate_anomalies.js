/**
 * 检查是否有重复的异动记录（同一币种同一时间）
 */
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function check_duplicate_anomalies() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '45.249.246.109',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'navicatuser',
    password: process.env.DB_PASSWORD || 'navicatuser',
    database: process.env.DB_NAME || 'trading_master'
  });

  try {
    console.log('\n🔍 检查METUSDT在2025-11-16 18:12:08的异动记录\n');

    // 查询METUSDT在该时间点的异动记录
    const [rows] = await connection.execute(`
      SELECT
        id,
        symbol,
        anomaly_time,
        period_seconds,
        percent_change,
        oi_before,
        oi_after,
        price_before,
        price_after,
        daily_price_low,
        daily_price_high,
        price_from_low_pct,
        price_from_high_pct
      FROM oi_anomaly_records
      WHERE symbol = 'METUSDT'
        AND anomaly_time = '2025-11-16 18:12:08'
      ORDER BY id
    `);

    console.log(`找到 ${rows.length} 条记录:\n`);

    if (rows.length > 0) {
      rows.forEach((row, index) => {
        console.log(`记录 ${index + 1}:`);
        console.log(`  ID: ${row.id}`);
        console.log(`  币种: ${row.symbol}`);
        console.log(`  时间: ${row.anomaly_time}`);
        console.log(`  周期: ${row.period_seconds}秒`);
        console.log(`  OI变化: ${row.percent_change}%`);
        console.log(`  价格变化: ${row.price_before} → ${row.price_after}`);
        console.log(`  日内低点: ${row.daily_price_low}`);
        console.log(`  日内高点: ${row.daily_price_high}`);
        console.log(`  距低点: ${row.price_from_low_pct}%`);
        console.log(`  距高点: ${row.price_from_high_pct}%`);
        console.log('');
      });
    }

    // 统计整体重复情况
    console.log('\n📊 查找所有在同一时间有多条异动的币种:\n');

    const [duplicate_rows] = await connection.execute(`
      SELECT
        symbol,
        anomaly_time,
        COUNT(*) as count
      FROM oi_anomaly_records
      WHERE anomaly_time >= '2025-11-15'
        AND daily_price_low IS NOT NULL
      GROUP BY symbol, anomaly_time
      HAVING COUNT(*) > 1
      ORDER BY count DESC, anomaly_time DESC
      LIMIT 20
    `);

    if (duplicate_rows.length > 0) {
      console.log('同一时间多条异动的情况:');
      console.log('币种\t\t时间\t\t\t记录数');
      console.log('='.repeat(60));
      duplicate_rows.forEach(row => {
        console.log(`${row.symbol}\t${row.anomaly_time.toISOString()}\t${row.count}`);
      });
    } else {
      console.log('✅ 没有发现重复的异动记录');
    }

  } finally {
    await connection.end();
  }
}

check_duplicate_anomalies().catch(console.error);
