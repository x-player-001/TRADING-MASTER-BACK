-- =====================================================
-- 数据库迁移脚本：为异动记录表添加价格变化字段
-- 日期：2025-11-12
-- 说明：在 oi_anomaly_records 表中添加价格变化相关字段
-- =====================================================

-- 添加价格变化相关字段
ALTER TABLE oi_anomaly_records
ADD COLUMN price_before DECIMAL(20,8) NULL COMMENT '变化前价格' AFTER threshold_value,
ADD COLUMN price_after DECIMAL(20,8) NULL COMMENT '变化后价格' AFTER price_before,
ADD COLUMN price_change DECIMAL(20,8) NULL COMMENT '价格绝对变化量' AFTER price_after,
ADD COLUMN price_change_percent DECIMAL(10,4) NULL COMMENT '价格变化百分比' AFTER price_change;

-- =====================================================
-- 验证字段是否添加成功
-- =====================================================

-- 查看表结构
-- DESCRIBE oi_anomaly_records;

-- 查看新添加的字段
-- SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_COMMENT
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE()
-- AND TABLE_NAME = 'oi_anomaly_records'
-- AND COLUMN_NAME IN ('price_before', 'price_after', 'price_change', 'price_change_percent');

-- =====================================================
-- 回滚方案（如需回滚）
-- =====================================================

-- ALTER TABLE oi_anomaly_records
-- DROP COLUMN price_before,
-- DROP COLUMN price_after,
-- DROP COLUMN price_change,
-- DROP COLUMN price_change_percent;

-- =====================================================
-- 注意事项
-- =====================================================

-- 1. 新字段允许NULL，向后兼容旧数据
-- 2. 未来的异动检测会自动填充这些字段
-- 3. 建议在业务低峰期执行
-- 4. 执行前建议备份数据库
