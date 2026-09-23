/**
 * 查询OI监控黑名单配置
 */
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function check_blacklist() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '45.249.246.109',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'navicatuser',
    password: process.env.DB_PASSWORD || 'navicatuser',
    database: process.env.DB_NAME || 'trading_master'
  });

  try {
    console.log('\n🚫 OI监控黑名单配置\n');

    // 查询黑名单配置
    const [rows] = await connection.execute(`
      SELECT
        config_key,
        config_value,
        description,
        is_active,
        updated_at
      FROM oi_monitoring_config
      WHERE config_key = 'symbol_blacklist'
    `);

    if (rows.length === 0) {
      console.log('❌ 未找到黑名单配置');
      return;
    }

    const config = rows[0];
    console.log(`配置项: ${config.config_key}`);
    console.log(`描述: ${config.description || '无'}`);
    console.log(`状态: ${config.is_active ? '✅ 启用' : '❌ 禁用'}`);
    console.log(`更新时间: ${config.updated_at}`);
    console.log(`\n黑名单内容:`);

    try {
      const blacklist = JSON.parse(config.config_value);
      if (Array.isArray(blacklist)) {
        if (blacklist.length === 0) {
          console.log('  (空 - 无黑名单币种)');
        } else {
          console.log(`  共 ${blacklist.length} 个币种/关键词:\n`);
          blacklist.forEach((item, index) => {
            console.log(`  ${index + 1}. ${item}`);
          });
        }
      } else {
        console.log('  ⚠️  配置格式错误: 不是数组格式');
        console.log('  原始值:', config.config_value);
      }
    } catch (error) {
      console.log('  ⚠️  JSON解析失败');
      console.log('  原始值:', config.config_value);
    }

    // 查询当前启用的币种总数
    const [symbol_rows] = await connection.execute(`
      SELECT COUNT(*) as total
      FROM contract_symbols_config
      WHERE enabled = 1 AND status = 'TRADING'
    `);

    const total_enabled = symbol_rows[0].total;
    console.log(`\n📊 当前启用币种总数: ${total_enabled}`);

  } finally {
    await connection.end();
  }
}

check_blacklist().catch(console.error);
