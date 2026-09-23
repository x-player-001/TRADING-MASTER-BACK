/**
 * 验证去重逻辑：检查METUSDT在同一时间的信号处理
 */
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function verify_dedup() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '45.249.246.109',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'navicatuser',
    password: process.env.DB_PASSWORD || 'navicatuser',
    database: process.env.DB_NAME || 'trading_master'
  });

  try {
    console.log('\n🔍 验证去重逻辑\n');

    // 查询METUSDT在2025-11-16 18:12:08的所有异动记录
    const target_time = '2025-11-16 18:12:08';
    const [rows] = await connection.execute(`
      SELECT
        id,
        symbol,
        anomaly_time,
        period_seconds,
        percent_change,
        price_before,
        price_after,
        daily_price_low,
        daily_price_high,
        price_from_low_pct,
        price_from_high_pct
      FROM oi_anomaly_records
      WHERE symbol = 'METUSDT'
        AND anomaly_time = ?
        AND daily_price_low IS NOT NULL
      ORDER BY period_seconds ASC
    `, [target_time]);

    if (rows.length === 0) {
      console.log('❌ 未找到METUSDT在该时间的异动记录');
      return;
    }

    console.log(`找到 ${rows.length} 条异动记录:\n`);

    rows.forEach((row, index) => {
      console.log(`记录 ${index + 1}:`);
      console.log(`  ID: ${row.id}`);
      console.log(`  周期: ${row.period_seconds}秒`);
      console.log(`  OI变化: ${row.percent_change}%`);
      console.log(`  价格: ${row.price_before} → ${row.price_after}`);
      console.log(`  距低点: ${row.price_from_low_pct}%`);
      console.log(`  距高点: ${row.price_from_high_pct}%`);
      console.log('');
    });

    console.log('📋 预期行为:');
    console.log(`  ✅ 回测引擎会处理所有 ${rows.length} 条异动`);
    console.log(`  ✅ 第一条异动会生成交易信号并开仓`);
    console.log(`  ✅ 后续 ${rows.length - 1} 条异动会被去重逻辑拒绝（10秒内重复）`);
    console.log(`  ✅ 最终只产生 1 笔交易`);

    // 验证数据完整性
    console.log('\n📊 验证数据完整性:');
    const all_have_extremes = rows.every(r =>
      r.daily_price_low !== null &&
      r.daily_price_high !== null &&
      r.price_from_low_pct !== null &&
      r.price_from_high_pct !== null
    );

    if (all_have_extremes) {
      console.log('  ✅ 所有记录都有完整的价格极值字段');
    } else {
      console.log('  ❌ 部分记录缺少价格极值字段');
    }

  } finally {
    await connection.end();
  }
}

verify_dedup().catch(console.error);
