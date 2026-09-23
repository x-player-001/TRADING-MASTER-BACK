/**
 * 添加OI监控新配置项
 */
const mysql = require('mysql2/promise');

async function addOIConfig() {
  const connection = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'root',
    database: 'trading_master'
  });

  try {
    console.log('Adding OI monitoring config items...');

    const sql = `
      INSERT INTO oi_monitoring_config (config_key, config_value, description)
      VALUES
        ('dedup_change_diff_threshold', '1', '去重阈值: 变化率增量<N%跳过插入'),
        ('severity_thresholds', '{"high":30,"medium":15}', '严重程度阈值: high>=30%, medium>=15%')
      ON DUPLICATE KEY UPDATE
        config_value=VALUES(config_value),
        description=VALUES(description);
    `;

    const [result] = await connection.execute(sql);
    console.log('✅ Config items added successfully:', result);

    // 验证插入
    const [rows] = await connection.execute(
      'SELECT * FROM oi_monitoring_config WHERE config_key IN (?, ?)',
      ['dedup_change_diff_threshold', 'severity_thresholds']
    );

    console.log('\n📋 Current config:');
    rows.forEach(row => {
      console.log(`  - ${row.config_key}: ${row.config_value} (${row.description})`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

addOIConfig().catch(console.error);
