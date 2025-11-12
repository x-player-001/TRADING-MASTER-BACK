-- =====================================================
-- 数据库迁移脚本：为异动记录表添加市场情绪字段
-- 日期：2025-11-12
-- 说明：在 oi_anomaly_records 表中添加4个市场情绪指标字段
-- =====================================================

-- 添加市场情绪相关字段
ALTER TABLE oi_anomaly_records
ADD COLUMN top_trader_long_short_ratio DECIMAL(10,4) NULL COMMENT '大户持仓量多空比' AFTER price_change_percent,
ADD COLUMN top_account_long_short_ratio DECIMAL(10,4) NULL COMMENT '大户账户数多空比' AFTER top_trader_long_short_ratio,
ADD COLUMN global_long_short_ratio DECIMAL(10,4) NULL COMMENT '全市场多空人数比' AFTER top_account_long_short_ratio,
ADD COLUMN taker_buy_sell_ratio DECIMAL(10,4) NULL COMMENT '主动买卖量比' AFTER global_long_short_ratio;

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
-- AND COLUMN_NAME IN ('top_trader_long_short_ratio', 'top_account_long_short_ratio',
--                      'global_long_short_ratio', 'taker_buy_sell_ratio');

-- =====================================================
-- 回滚方案（如需回滚）
-- =====================================================

-- ALTER TABLE oi_anomaly_records
-- DROP COLUMN top_trader_long_short_ratio,
-- DROP COLUMN top_account_long_short_ratio,
-- DROP COLUMN global_long_short_ratio,
-- DROP COLUMN taker_buy_sell_ratio;

-- =====================================================
-- 注意事项
-- =====================================================

-- 1. 新字段允许NULL，向后兼容旧数据
-- 2. 异动检测会自动填充这些字段（带缓存机制）
-- 3. 缓存时间5分钟，避免重复调用API
-- 4. 建议在业务低峰期执行
-- 5. 执行前建议备份数据库
