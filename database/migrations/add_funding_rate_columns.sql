-- =====================================================
-- 数据库迁移脚本：添加资金费率相关字段
-- 日期：2025-11-12
-- 说明：为OI快照表添加标记价格、资金费率和下次资金费时间字段
-- =====================================================

-- 1. 修改原始表（兜底表，用于降级查询）
ALTER TABLE open_interest_snapshots
ADD COLUMN mark_price DECIMAL(20,8) NULL COMMENT '标记价格' AFTER data_source,
ADD COLUMN funding_rate DECIMAL(10,8) NULL COMMENT '资金费率' AFTER mark_price,
ADD COLUMN next_funding_time BIGINT NULL COMMENT '下次资金费时间（毫秒时间戳）' AFTER funding_rate;

-- 2. 修改所有已存在的日期分表
-- 注意：需要根据实际情况修改表名列表

-- 查询所有日期分表的SQL（手动执行）
-- SELECT TABLE_NAME
-- FROM information_schema.TABLES
-- WHERE TABLE_SCHEMA = DATABASE()
-- AND TABLE_NAME LIKE 'open_interest_snapshots_%';

-- 示例：修改最近几天的日期表
-- 根据实际存在的表进行修改，如果表不存在会报错，可以忽略

SET @today = DATE_FORMAT(NOW(), '%Y%m%d');
SET @yesterday = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 DAY), '%Y%m%d');
SET @day_before = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 2 DAY), '%Y%m%d');

-- 修改今天的表（如果存在）
SET @sql = CONCAT('ALTER TABLE open_interest_snapshots_', @today,
  ' ADD COLUMN IF NOT EXISTS mark_price DECIMAL(20,8) NULL COMMENT ''标记价格'' AFTER data_source,',
  ' ADD COLUMN IF NOT EXISTS funding_rate DECIMAL(10,8) NULL COMMENT ''资金费率'' AFTER mark_price,',
  ' ADD COLUMN IF NOT EXISTS next_funding_time BIGINT NULL COMMENT ''下次资金费时间'' AFTER funding_rate');

-- 由于MySQL不支持动态SQL中的 IF NOT EXISTS，需要手动执行
-- 或者使用存储过程批量处理

-- 手动修改示例（根据实际表名替换）：
-- ALTER TABLE open_interest_snapshots_20251112
-- ADD COLUMN mark_price DECIMAL(20,8) NULL COMMENT '标记价格',
-- ADD COLUMN funding_rate DECIMAL(10,8) NULL COMMENT '资金费率',
-- ADD COLUMN next_funding_time BIGINT NULL COMMENT '下次资金费时间';

-- ALTER TABLE open_interest_snapshots_20251111
-- ADD COLUMN mark_price DECIMAL(20,8) NULL COMMENT '标记价格',
-- ADD COLUMN funding_rate DECIMAL(10,8) NULL COMMENT '资金费率',
-- ADD COLUMN next_funding_time BIGINT NULL COMMENT '下次资金费时间';

-- =====================================================
-- 验证字段是否添加成功
-- =====================================================

-- 查看原始表结构
-- DESCRIBE open_interest_snapshots;

-- 查看某个日期表结构
-- DESCRIBE open_interest_snapshots_20251112;

-- =====================================================
-- 回滚方案（如需回滚）
-- =====================================================

-- ALTER TABLE open_interest_snapshots
-- DROP COLUMN mark_price,
-- DROP COLUMN funding_rate,
-- DROP COLUMN next_funding_time;

-- 对应删除所有日期表的字段
-- ALTER TABLE open_interest_snapshots_20251112
-- DROP COLUMN mark_price,
-- DROP COLUMN funding_rate,
-- DROP COLUMN next_funding_time;

-- =====================================================
-- 注意事项
-- =====================================================

-- 1. 新字段允许NULL，向后兼容旧数据
-- 2. 未来新创建的日期分表会自动包含这些字段（DailyTableManager已更新）
-- 3. 如果表不存在会报错，可以忽略
-- 4. 建议在业务低峰期执行
-- 5. 执行前建议备份数据库
