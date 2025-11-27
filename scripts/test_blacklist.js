/**
 * 测试黑名单功能
 * 查询被过滤的币种
 */
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function test_blacklist() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '45.249.246.109',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'navicatuser',
    password: process.env.DB_PASSWORD || 'navicatuser',
    database: process.env.DB_NAME || 'trading_master'
  });

  try {
    console.log('\n🧪 黑名单功能测试\n');

    // 获取黑名单
    const [config_rows] = await connection.execute(`
      SELECT config_value FROM oi_monitoring_config
      WHERE config_key = 'symbol_blacklist'
    `);

    const blacklist = JSON.parse(config_rows[0].config_value);
    console.log(`当前黑名单: ${blacklist.join(', ')}\n`);

    // 查询符合价格极值条件的异动总数
    const [total_rows] = await connection.execute(`
      SELECT COUNT(*) as total
      FROM oi_anomaly_records
      WHERE anomaly_time >= '2025-11-15'
        AND daily_price_low IS NOT NULL
        AND daily_price_high IS NOT NULL
        AND price_from_low_pct IS NOT NULL
        AND price_from_high_pct IS NOT NULL
    `);

    console.log(`📊 价格极值完整的异动总数: ${total_rows[0].total}`);

    // 查询包含黑名单关键词的异动
    const blacklist_conditions = blacklist.map(() => 'symbol LIKE ?').join(' OR ');
    const blacklist_params = blacklist.map(keyword => `%${keyword}%`);

    const [blacklisted_rows] = await connection.execute(`
      SELECT symbol, COUNT(*) as count
      FROM oi_anomaly_records
      WHERE anomaly_time >= '2025-11-15'
        AND daily_price_low IS NOT NULL
        AND (${blacklist_conditions})
      GROUP BY symbol
      ORDER BY count DESC
    `, blacklist_params);

    const total_blacklisted = blacklisted_rows.reduce((sum, row) => sum + row.count, 0);
    console.log(`🚫 被黑名单过滤的异动: ${total_blacklisted} 条\n`);

    if (blacklisted_rows.length > 0) {
      console.log('被过滤的币种详情:');
      console.log('币种\t\t异动数');
      console.log('='.repeat(40));
      blacklisted_rows.forEach(row => {
        console.log(`${row.symbol}\t\t${row.count}`);
      });
    }

    // 计算过滤后的数量
    const after_filter = total_rows[0].total - total_blacklisted;
    console.log(`\n✅ 过滤后剩余异动: ${after_filter} 条`);
    console.log(`📉 过滤率: ${((total_blacklisted / total_rows[0].total) * 100).toFixed(2)}%`);

  } finally {
    await connection.end();
  }
}

test_blacklist().catch(console.error);
