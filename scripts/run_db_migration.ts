/**
 * 执行数据库迁移：添加精度字段到contract_symbols_config表
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';

async function run_migration() {
  console.log('🔧 开始数据库迁移：添加精度字段\n');
  console.log('═'.repeat(80));

  let connection: mysql.Connection | null = null;

  try {
    // 创建数据库连接
    connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || '45.249.246.109',
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER || 'navicatuser',
      password: process.env.MYSQL_PASSWORD || 'navicatuser',
      database: process.env.MYSQL_DATABASE || 'trading_master'
    });

    console.log('✅ 数据库连接成功\n');

    // 1. 检查字段是否已存在
    console.log('📋 [1/4] 检查现有表结构...');
    const [columns] = await connection.execute(
      "SHOW COLUMNS FROM contract_symbols_config WHERE Field LIKE '%precision%' OR Field LIKE '%notional%' OR Field LIKE '%step_size%'"
    );

    if (Array.isArray(columns) && columns.length > 0) {
      console.log('  ⚠️  发现已存在的精度字段:');
      (columns as any[]).forEach(col => {
        console.log(`     - ${col.Field} (${col.Type})`);
      });
      console.log('\n  跳过重复添加字段\n');
    } else {
      console.log('  ✅ 未发现精度字段，准备添加\n');

      // 2. 添加字段
      console.log('💾 [2/4] 添加精度字段...');

      const alter_sql = `
        ALTER TABLE contract_symbols_config
        ADD COLUMN price_precision INT DEFAULT NULL COMMENT '价格小数位数',
        ADD COLUMN quantity_precision INT DEFAULT NULL COMMENT '数量小数位数',
        ADD COLUMN base_asset_precision INT DEFAULT NULL COMMENT '标的资产精度',
        ADD COLUMN quote_precision INT DEFAULT NULL COMMENT '报价资产精度',
        ADD COLUMN min_notional DECIMAL(20,8) DEFAULT NULL COMMENT '最小名义价值',
        ADD COLUMN step_size DECIMAL(20,8) DEFAULT NULL COMMENT '数量步进'
      `;

      await connection.execute(alter_sql);
      console.log('  ✅ 精度字段添加成功\n');

      // 3. 创建索引
      console.log('🔍 [3/4] 创建索引...');

      try {
        await connection.execute(
          'CREATE INDEX idx_symbol_precision ON contract_symbols_config(symbol, quantity_precision, price_precision)'
        );
        console.log('  ✅ 索引创建成功\n');
      } catch (error: any) {
        if (error.code === 'ER_DUP_KEYNAME') {
          console.log('  ℹ️  索引已存在，跳过创建\n');
        } else {
          throw error;
        }
      }
    }

    // 4. 验证表结构
    console.log('✅ [4/4] 验证表结构...');
    const [final_columns] = await connection.execute(
      'SHOW COLUMNS FROM contract_symbols_config'
    );

    console.log('\n  最终表结构:');
    (final_columns as any[]).forEach(col => {
      const is_new = ['price_precision', 'quantity_precision', 'base_asset_precision',
                      'quote_precision', 'min_notional', 'step_size'].includes(col.Field);
      const prefix = is_new ? '  🆕 ' : '     ';
      console.log(`${prefix}${col.Field.padEnd(25)} ${col.Type.padEnd(20)} ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    console.log('\n' + '═'.repeat(80));
    console.log('✅ 数据库迁移完成！\n');

    console.log('📝 后续步骤:');
    console.log('  1. 重启OI监控服务，自动刷新币种精度信息');
    console.log('  2. 或手动运行测试脚本验证: npm run test:precision');
    console.log('═'.repeat(80));

  } catch (error: any) {
    console.error('\n❌ 迁移失败:', error.message);

    if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 提示: 无法连接到数据库服务器');
      console.error('   请检查数据库配置和网络连接');
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\n💡 提示: 数据库认证失败');
      console.error('   请检查 .env 文件中的数据库账号密码');
    } else if (error.code === 'ER_DUP_FIELDNAME') {
      console.error('\n💡 提示: 字段已存在');
      console.error('   看起来迁移已经执行过了');
    }

    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n🔌 数据库连接已关闭');
    }
  }
}

// 运行迁移
run_migration()
  .then(() => {
    console.log('\n🎉 迁移脚本执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 程序异常退出:', error);
    process.exit(1);
  });
