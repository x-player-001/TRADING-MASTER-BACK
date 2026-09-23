/**
 * 数据库迁移脚本：为 oi_anomaly_records 表添加信号评分字段
 * 运行命令: npx ts-node -r tsconfig-paths/register dev/maintenance/migrate_add_signal_scores.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { DatabaseConfig } from '../../../src/core/config/database';
import { ConfigManager } from '../../../src/core/config/config_manager';
import { logger } from '../../../src/utils/logger';

async function migrate() {
  console.log('🚀 开始数据库迁移：添加信号评分字段...\n');

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
          AND COLUMN_NAME IN ('signal_score', 'signal_confidence', 'signal_direction', 'avoid_chase_reason')
      `);

      const existing_fields = (existing_columns as any[]).map(row => row.COLUMN_NAME);

      if (existing_fields.length > 0) {
        console.log(`⚠️  以下字段已存在: ${existing_fields.join(', ')}`);
        console.log('跳过已存在的字段，只添加缺失的字段...\n');
      }

      // 添加 signal_score 字段
      if (!existing_fields.includes('signal_score')) {
        console.log('➕ 添加字段: signal_score');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN signal_score DECIMAL(4,2) NULL COMMENT '信号总分 (0-10)' AFTER taker_buy_sell_ratio
        `);
      }

      // 添加 signal_confidence 字段
      if (!existing_fields.includes('signal_confidence')) {
        console.log('➕ 添加字段: signal_confidence');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN signal_confidence DECIMAL(4,3) NULL COMMENT '信号置信度 (0-1)' AFTER signal_score
        `);
      }

      // 添加 signal_direction 字段
      if (!existing_fields.includes('signal_direction')) {
        console.log('➕ 添加字段: signal_direction');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN signal_direction ENUM('LONG','SHORT','NEUTRAL') NULL COMMENT '信号方向' AFTER signal_confidence
        `);
      }

      // 添加 avoid_chase_reason 字段
      if (!existing_fields.includes('avoid_chase_reason')) {
        console.log('➕ 添加字段: avoid_chase_reason');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD COLUMN avoid_chase_reason VARCHAR(100) NULL COMMENT '避免追高原因' AFTER signal_direction
        `);
      }

      console.log('\n📊 添加索引以优化查询...');

      // 检查索引是否已存在
      const [existing_indexes] = await conn.execute(`
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'oi_anomaly_records'
          AND INDEX_NAME IN ('idx_signal_score', 'idx_signal_direction')
        GROUP BY INDEX_NAME
      `);

      const existing_index_names = (existing_indexes as any[]).map(row => row.INDEX_NAME);

      // 添加 signal_score 索引
      if (!existing_index_names.includes('idx_signal_score')) {
        console.log('➕ 添加索引: idx_signal_score');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD INDEX idx_signal_score (signal_score)
        `);
      } else {
        console.log('⚠️  索引已存在: idx_signal_score');
      }

      // 添加 signal_direction 索引
      if (!existing_index_names.includes('idx_signal_direction')) {
        console.log('➕ 添加索引: idx_signal_direction');
        await conn.execute(`
          ALTER TABLE oi_anomaly_records
          ADD INDEX idx_signal_direction (signal_direction)
        `);
      } else {
        console.log('⚠️  索引已存在: idx_signal_direction');
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
          AND COLUMN_NAME IN ('signal_score', 'signal_confidence', 'signal_direction', 'avoid_chase_reason')
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
