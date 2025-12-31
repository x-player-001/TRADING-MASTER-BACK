/**
 * 迁移脚本: 为 sr_alerts.alert_type 添加新类型
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  console.log('正在修改 sr_alerts.alert_type 字段...');
  
  try {
    await conn.execute(`
      ALTER TABLE sr_alerts 
      MODIFY COLUMN alert_type ENUM('APPROACHING', 'TOUCHED', 'BREAKOUT', 'BOUNCE', 'SQUEEZE', 'BULLISH_STREAK', 'PULLBACK_READY') NOT NULL
    `);
    console.log('✅ 修改成功');
  } catch (error: any) {
    if (error.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
      console.log('表中存在无效数据，先清空表再修改...');
      await conn.execute('TRUNCATE TABLE sr_alerts');
      await conn.execute(`
        ALTER TABLE sr_alerts 
        MODIFY COLUMN alert_type ENUM('APPROACHING', 'TOUCHED', 'BREAKOUT', 'BOUNCE', 'SQUEEZE', 'BULLISH_STREAK', 'PULLBACK_READY') NOT NULL
      `);
      console.log('✅ 修改成功');
    } else {
      throw error;
    }
  }

  await conn.end();
}

main().catch(console.error);
