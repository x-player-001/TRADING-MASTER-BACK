/**
 * 数据库迁移脚本：为 oi_anomaly_records 表添加每日价格极值字段
 * 运行命令: npx ts-node -r tsconfig-paths/register dev/maintenance/migrate_add_daily_price_extremes.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { DatabaseConfig } from '../../../src/core/config/database';
import { ConfigManager } from '../../../src/core/config/config_manager';
import { logger } from '../../../src/utils/logger';

async function migrate() {
  console.log('🚀 开始数据库迁移：添加每日价格极值字段...\n');

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 获取数据库连接
    const conn = await DatabaseConfig.get_mysql_connection();

    try {
      console.log('📋 检查表结构...');

      // 检查字段是否已存在
      const [existing_columns] = await conn.execute(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'oi_anomaly_records'
          AND COLUMN_NAME IN ('daily_price_low', 'daily_price_high', 'price_from_low_pct', 'price_from_high_pct')
      `);

      const existing_fields = (existing_columns as any[]).map(row => row.COLUMN_NAME);

      if (existing_fields.length > 0) {
        console.log(`⚠️  以下字段已存在: ${existing_fields.join(', ')}`);
        console.log('跳过已存在的字段，只添加缺失的字段...\n');
      }

      // 添加 daily_price_low 字段
      if (!existing_fields.includes('daily_price_low')) {
        console.log('➕ 添加字段: daily_price_low');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN daily_price_low DECIMAL(20,8) NULL COMMENT '触发时的日内最低价' AFTER avoid_chase_reason
        `);
      }

      // 添加 daily_price_high 字段
      if (!existing_fields.includes('daily_price_high')) {
        console.log('➕ 添加字段: daily_price_high');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN daily_price_high DECIMAL(20,8) NULL COMMENT '触发时的日内最高价' AFTER daily_price_low
        `);
      }

      // 添加 price_from_low_pct 字段
      if (!existing_fields.includes('price_from_low_pct')) {
        console.log('➕ 添加字段: price_from_low_pct');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN price_from_low_pct DECIMAL(10,4) NULL COMMENT '相对日内低点的涨幅(%)' AFTER daily_price_high
        `);
      }

      // 添加 price_from_high_pct 字段
      if (!existing_fields.includes('price_from_high_pct')) {
        console.log('➕ 添加字段: price_from_high_pct');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN price_from_high_pct DECIMAL(10,4) NULL COMMENT '相对日内高点的跌幅(%)' AFTER price_from_low_pct
        `);
      }

      console.log('\n📊 添加索引以优化查询...');

      // 检查索引是否已存在
      const [existing_indexes] = await conn.execute(`
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'oi_anomaly_records'
          AND INDEX_NAME IN ('idx_price_from_low', 'idx_price_from_high')
        GROUP BY INDEX_NAME
      `);

      const existing_index_names = (existing_indexes as any[]).map(row => row.INDEX_NAME);

      // 添加 price_from_low_pct 索引
      if (!existing_index_names.includes('idx_price_from_low')) {
        console.log('➕ 添加索引: idx_price_from_low');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD INDEX idx_price_from_low (price_from_low_pct)
        `);
      } else {
        console.log('⚠️  索引已存在: idx_price_from_low');
      }

      // 添加 price_from_high_pct 索引
      if (!existing_index_names.includes('idx_price_from_high')) {
        console.log('➕ 添加索引: idx_price_from_high');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD INDEX idx_price_from_high (price_from_high_pct)
        `);
      } else {
        console.log('⚠️  索引已存在: idx_price_from_high');
      }

      console.log('\n✅ 验证迁移结果...');

      // 验证字段添加成功
      const [columns] = await conn.execute(`
        SELECT
          COLUMN_NAME,
          DATA_TYPE,
          COLUMN_TYPE,
          IS_NULLABLE,
          COLUMN_COMMENT
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'oi_anomaly_records'
          AND COLUMN_NAME IN ('daily_price_low', 'daily_price_high', 'price_from_low_pct', 'price_from_high_pct')
        ORDER BY ORDINAL_POSITION
      `);

      console.log('\n新增字段信息:');
      console.table(columns);

      console.log('\n✅ 数据库迁移完成！');

    } finally {
      conn.release();
    }

    await DatabaseConfig.close_connections();
    process.exit(0);

  } catch (error) {
    console.error('❌ 迁移失败:', error);
    await DatabaseConfig.close_connections();
    process.exit(1);
  }
}

migrate();
