/**
 * 迁移脚本：为 sr_alerts 表添加 signal_score 字段
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

  console.log('正在为 sr_alerts 表添加 signal_score 字段...');

  try {
    // 检查字段是否已存在
    const [columns] = await conn.execute<any[]>(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sr_alerts' AND COLUMN_NAME = 'signal_score'
    `, [process.env.MYSQL_DATABASE]);

    if (columns.length > 0) {
      console.log('✅ signal_score 字段已存在，无需迁移');
    } else {
      // 添加字段
      await conn.execute(`
        ALTER TABLE sr_alerts
        ADD COLUMN signal_score INT DEFAULT NULL AFTER description,
        ADD INDEX idx_signal_score (signal_score)
      `);
      console.log('✅ signal_score 字段添加成功');
    }
  } catch (error: any) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('✅ signal_score 字段已存在');
    } else {
      console.error('❌ 迁移失败:', error.message);
      throw error;
    }
  }

  await conn.end();
  console.log('迁移完成');
}

main().catch(console.error);
