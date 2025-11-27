const mysql = require('mysql2/promise');
require('dotenv').config();

async function check() {
  const conn = await mysql.createConnection({
    host: '45.249.246.109',
    port: 3306,
    user: 'navicatuser',
    password: 'navicatuser',
    database: 'trading_master'
  });

  try {
    console.log('\n📊 异动表价格极值字段覆盖率统计\n');

    const [rows] = await conn.execute(`
      SELECT
        DATE(anomaly_time) as date,
        COUNT(*) as total_records,
        COUNT(daily_price_low) as has_price_low,
        CONCAT(ROUND(COUNT(daily_price_low) * 100.0 / COUNT(*), 2), '%') as coverage_rate
      FROM oi_anomaly_records
      GROUP BY DATE(anomaly_time)
      ORDER BY DATE(anomaly_time) DESC
      LIMIT 30
    `);

    console.log('日期\t\t总记录数\t有价格极值\t覆盖率');
    console.log('='.repeat(70));
    for (const row of rows) {
      console.log(`${row.date}\t${row.total_records}\t\t${row.has_price_low}\t\t${row.coverage_rate}`);
    }

    const [first] = await conn.execute(`
      SELECT anomaly_time, symbol, daily_price_low, price_from_low_pct
      FROM oi_anomaly_records
      WHERE daily_price_low IS NOT NULL
      ORDER BY anomaly_time ASC
      LIMIT 1
    `);

    console.log('\n\n🔍 第一条有价格极值数据的记录:');
    if (first.length > 0) {
      console.log(`  时间: ${first[0].anomaly_time}`);
      console.log(`  币种: ${first[0].symbol}`);
      console.log(`  日内低点: ${first[0].daily_price_low}`);
      console.log(`  距低点涨幅: ${first[0].price_from_low_pct}%`);
    }

    const [last] = await conn.execute(`
      SELECT anomaly_time, symbol
      FROM oi_anomaly_records
      WHERE daily_price_low IS NULL
      ORDER BY anomaly_time DESC
      LIMIT 1
    `);

    console.log('\n\n🔍 最后一条没有价格极值数据的记录:');
    if (last.length > 0) {
      console.log(`  时间: ${last[0].anomaly_time}`);
      console.log(`  币种: ${last[0].symbol}`);
    }

    const [summary] = await conn.execute(`
      SELECT
        COUNT(*) as total,
        COUNT(daily_price_low) as has_data,
        COUNT(*) - COUNT(daily_price_low) as missing,
        CONCAT(ROUND(COUNT(daily_price_low) * 100.0 / COUNT(*), 2), '%') as coverage
      FROM oi_anomaly_records
    `);

    console.log('\n\n📈 总体统计:');
    console.log(`  总记录数: ${summary[0].total}`);
    console.log(`  有价格极值: ${summary[0].has_data}`);
    console.log(`  缺失数据: ${summary[0].missing}`);
    console.log(`  覆盖率: ${summary[0].coverage}\n`);

  } finally {
    await conn.end();
  }
}

check().catch(console.error);
