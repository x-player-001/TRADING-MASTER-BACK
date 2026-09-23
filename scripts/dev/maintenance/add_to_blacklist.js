/**
 * 添加币种到黑名单
 */
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function add_to_blacklist(symbol) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '45.249.246.109',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'navicatuser',
    password: process.env.DB_PASSWORD || 'navicatuser',
    database: process.env.DB_NAME || 'trading_master'
  });

  try {
    console.log(`\n🚫 添加 ${symbol} 到黑名单\n`);

    // 查询当前黑名单
    const [rows] = await connection.execute(`
      SELECT config_value FROM oi_monitoring_config
      WHERE config_key = 'symbol_blacklist'
    `);

    if (rows.length === 0) {
      console.log('❌ 未找到黑名单配置');
      return;
    }

    const current_config = rows[0];
    const blacklist = JSON.parse(current_config.config_value);

    console.log('当前黑名单:', blacklist);

    // 检查是否已存在
    if (blacklist.includes(symbol)) {
      console.log(`⚠️  ${symbol} 已在黑名单中`);
      return;
    }

    // 添加新币种
    blacklist.push(symbol);
    const new_value = JSON.stringify(blacklist);

    // 更新数据库
    await connection.execute(`
      UPDATE oi_monitoring_config
      SET config_value = ?, updated_at = CURRENT_TIMESTAMP
      WHERE config_key = 'symbol_blacklist'
    `, [new_value]);

    console.log(`✅ 成功添加 ${symbol} 到黑名单`);
    console.log('更新后的黑名单:', blacklist);

  } finally {
    await connection.end();
  }
}

// 从命令行参数获取币种，默认为 USTCUSDT
const symbol = process.argv[2] || 'USTCUSDT';
add_to_blacklist(symbol).catch(console.error);
