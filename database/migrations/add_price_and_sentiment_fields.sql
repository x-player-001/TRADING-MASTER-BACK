-- =====================================================
-- 数据库迁移脚本：为异动记录表添加价格和市场情绪字段（合并版）
-- 日期：2025-11-12
-- 说明：合并 add_price_to_anomaly_records.sql 和 add_sentiment_to_anomaly_records.sql
-- =====================================================

-- =====================================================
-- 第一步：添加价格变化相关字段（如果不存在）
-- =====================================================

-- 检查并添加价格字段
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'oi_anomaly_records'
  AND COLUMN_NAME = 'price_before';

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE oi_anomaly_records
   ADD COLUMN price_before DECIMAL(20,8) NULL COMMENT ''变化前价格'' AFTER threshold_value,
   ADD COLUMN price_after DECIMAL(20,8) NULL COMMENT ''变化后价格'' AFTER price_before,
   ADD COLUMN price_change DECIMAL(20,8) NULL COMMENT ''价格绝对变化量'' AFTER price_after,
   ADD COLUMN price_change_percent DECIMAL(10,4) NULL COMMENT ''价格变化百分比'' AFTER price_change',
  'SELECT ''价格字段已存在，跳过'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =====================================================
-- 第二步：添加市场情绪相关字段（如果不存在）
-- =====================================================

-- 检查并添加情绪字段
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'oi_anomaly_records'
  AND COLUMN_NAME = 'top_trader_long_short_ratio';

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE oi_anomaly_records
   ADD COLUMN top_trader_long_short_ratio DECIMAL(10,4) NULL COMMENT ''大户持仓量多空比'' AFTER price_change_percent,
   ADD COLUMN top_account_long_short_ratio DECIMAL(10,4) NULL COMMENT ''大户账户数多空比'' AFTER top_trader_long_short_ratio,
   ADD COLUMN global_long_short_ratio DECIMAL(10,4) NULL COMMENT ''全市场多空人数比'' AFTER top_account_long_short_ratio,
   ADD COLUMN taker_buy_sell_ratio DECIMAL(10,4) NULL COMMENT ''主动买卖量比'' AFTER global_long_short_ratio',
  'SELECT ''情绪字段已存在，跳过'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =====================================================
-- 验证字段是否添加成功
-- =====================================================

-- 查看所有新添加的字段
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'oi_anomaly_records'
  AND COLUMN_NAME IN (
    'price_before', 'price_after', 'price_change', 'price_change_percent',
    'top_trader_long_short_ratio', 'top_account_long_short_ratio',
    'global_long_short_ratio', 'taker_buy_sell_ratio'
  )
ORDER BY ORDINAL_POSITION;

-- =====================================================
-- 回滚方案（如需回滚）
-- =====================================================

-- ALTER TABLE oi_anomaly_records
-- DROP COLUMN price_before,
-- DROP COLUMN price_after,
-- DROP COLUMN price_change,
-- DROP COLUMN price_change_percent,
-- DROP COLUMN top_trader_long_short_ratio,
-- DROP COLUMN top_account_long_short_ratio,
-- DROP COLUMN global_long_short_ratio,
-- DROP COLUMN taker_buy_sell_ratio;

-- =====================================================
-- 注意事项
-- =====================================================

-- 1. 新字段允许NULL，向后兼容旧数据
-- 2. 使用动态SQL检查字段是否存在，避免重复执行报错
-- 3. 异动检测会自动填充这些字段
-- 4. 建议在业务低峰期执行
-- 5. 执行前建议备份数据库
