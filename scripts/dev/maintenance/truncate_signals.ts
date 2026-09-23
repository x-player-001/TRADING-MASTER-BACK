import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'trading_master'
  });

  try {
    await connection.execute('TRUNCATE TABLE kline_breakout_signals');
    console.log('✅ kline_breakout_signals 表已清空');

    await connection.execute('TRUNCATE TABLE boundary_alerts');
    console.log('✅ boundary_alerts 表已清空');
  } finally {
    await connection.end();
  }
}

main().catch(console.error);
