/**
 * 检查所有K线表的数据情况
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';

async function main() {
  // 初始化配置
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const conn = await DatabaseConfig.get_mysql_connection();

  try {
    console.log('═'.repeat(60));
    console.log('  K线数据表检查');
    console.log('═'.repeat(60));

    // 1. 查看所有 kline_15m 表
    console.log('\n📁 kline_15m 分表列表:');
    const [tables] = await conn.execute("SHOW TABLES LIKE 'kline_15m_%'");
    const table_list = (tables as any[]).map(t => Object.values(t)[0] as string);

    if (table_list.length === 0) {
      console.log('   ❌ 没有找到 kline_15m 分表');
    } else {
      console.log(`   共 ${table_list.length} 个表`);

      // 对每个表检查数据量
      for (const table of table_list.slice(-10)) {  // 只检查最近10个表
        const [count_result] = await conn.execute(`SELECT COUNT(*) as cnt FROM ${table}`);
        const cnt = (count_result as any[])[0].cnt;

        const [symbols_result] = await conn.execute(`SELECT COUNT(DISTINCT symbol) as sym_cnt FROM ${table}`);
        const sym_cnt = (symbols_result as any[])[0].sym_cnt;

        console.log(`   ${table}: ${cnt} 条记录, ${sym_cnt} 个币种`);
      }
    }

    // 2. 检查最近的数据时间
    console.log('\n📅 最近数据时间 (BTCUSDT):');

    // 找到最近有数据的表
    for (let i = table_list.length - 1; i >= Math.max(0, table_list.length - 5); i--) {
      const table = table_list[i];
      try {
        const [rows] = await conn.execute(`
          SELECT open_time, close,
            FROM_UNIXTIME(open_time/1000) as time_str
          FROM ${table}
          WHERE symbol = 'BTCUSDT'
          ORDER BY open_time DESC
          LIMIT 3
        `);

        if ((rows as any[]).length > 0) {
          console.log(`\n   ${table}:`);
          for (const row of rows as any[]) {
            console.log(`     ${row.time_str} - 收盘价: ${row.close}`);
          }
        }
      } catch (e) {
        // 忽略错误
      }
    }

    // 3. 检查今天的数据
    const today = new Date();
    const today_str = today.toISOString().slice(0, 10).replace(/-/g, '');
    const today_table = `kline_15m_${today_str}`;

    console.log(`\n📊 今日表 (${today_table}):`);

    if (table_list.includes(today_table)) {
      const [count_result] = await conn.execute(`SELECT COUNT(*) as cnt FROM ${today_table}`);
      const cnt = (count_result as any[])[0].cnt;

      const [latest] = await conn.execute(`
        SELECT symbol, open_time, close,
          FROM_UNIXTIME(open_time/1000) as time_str
        FROM ${today_table}
        ORDER BY open_time DESC
        LIMIT 5
      `);

      console.log(`   总记录: ${cnt}`);
      console.log('   最新数据:');
      for (const row of latest as any[]) {
        console.log(`     ${row.symbol} @ ${row.time_str} - ${row.close}`);
      }
    } else {
      console.log('   ❌ 今日表不存在');
    }

    // 4. 检查是否有重复数据（在任意一个表中）
    console.log('\n🔍 重复数据检查:');
    let has_duplicates = false;

    for (const table of table_list.slice(-3)) {  // 检查最近3个表
      const [dups] = await conn.execute(`
        SELECT symbol, open_time, COUNT(*) as cnt
        FROM ${table}
        GROUP BY symbol, open_time
        HAVING COUNT(*) > 1
        LIMIT 5
      `);

      if ((dups as any[]).length > 0) {
        has_duplicates = true;
        console.log(`   ⚠️ ${table} 有重复数据:`);
        for (const dup of dups as any[]) {
          console.log(`      ${dup.symbol} @ ${dup.open_time}: ${dup.cnt}条`);
        }
      }
    }

    if (!has_duplicates) {
      console.log('   ✅ 最近的表中没有重复数据');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    conn.release();
  }

  console.log('\n✅ 检查完成');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
