-- ======================================
-- OI性能优化 - 索引优化脚本
-- ======================================

-- 说明：
-- 这些索引优化旨在提升OI统计查询的性能
-- 执行前请先备份数据库
-- 执行方式: mysql -u root -p trading_master < database/migrations/optimize_oi_indexes.sql

USE trading_master;

-- ======================================
-- 1. 优化 open_interest_snapshots 表索引
-- ======================================

-- 检查并删除可能存在的旧索引（如果存在）
DROP INDEX IF EXISTS idx_snapshot_time_ms ON open_interest_snapshots;
DROP INDEX IF EXISTS idx_time_range_query ON open_interest_snapshots;

-- 添加覆盖索引（包含窗口函数需要的所有字段）
-- 这个索引支持: WHERE snapshot_time + ORDER BY timestamp_ms + SELECT open_interest
ALTER TABLE open_interest_snapshots
ADD INDEX idx_time_range_query (snapshot_time, symbol, timestamp_ms, open_interest)
COMMENT '覆盖索引：优化统计查询中的窗口函数性能';

-- 说明：
-- - snapshot_time: WHERE条件过滤
-- - symbol: PARTITION BY分组
-- - timestamp_ms: ORDER BY排序
-- - open_interest: SELECT字段，避免回表

-- ======================================
-- 2. 优化 oi_anomaly_records 表索引
-- ======================================

-- 检查并删除可能存在的旧索引（如果存在）
DROP INDEX IF EXISTS idx_anomaly_time_symbol ON oi_anomaly_records;

-- 添加复合索引优化异动查询
ALTER TABLE oi_anomaly_records
ADD INDEX idx_anomaly_time_symbol (anomaly_time, symbol)
COMMENT '优化异动记录的时间+币种查询';

-- 添加日期+币种的覆盖索引（支持日期范围查询）
ALTER TABLE oi_anomaly_records
ADD INDEX idx_anomaly_date_query (anomaly_time, symbol, percent_change, severity)
COMMENT '覆盖索引：优化按日期查询异动记录';

-- ======================================
-- 3. 查看索引创建结果
-- ======================================

-- 显示 open_interest_snapshots 表的所有索引
SELECT
    TABLE_NAME,
    INDEX_NAME,
    COLUMN_NAME,
    SEQ_IN_INDEX,
    INDEX_TYPE,
    INDEX_COMMENT
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'open_interest_snapshots'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 显示 oi_anomaly_records 表的所有索引
SELECT
    TABLE_NAME,
    INDEX_NAME,
    COLUMN_NAME,
    SEQ_IN_INDEX,
    INDEX_TYPE,
    INDEX_COMMENT
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'oi_anomaly_records'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- ======================================
-- 4. 分析表以更新索引统计信息
-- ======================================

ANALYZE TABLE open_interest_snapshots;
ANALYZE TABLE oi_anomaly_records;

-- ======================================
-- 5. 验证索引效果（可选）
-- ======================================

-- 查看统计查询的执行计划
EXPLAIN
SELECT
    symbol,
    open_interest,
    snapshot_time,
    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY timestamp_ms DESC) as rn_latest
FROM open_interest_snapshots
WHERE snapshot_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
  AND snapshot_time <= NOW()
LIMIT 10;

-- 期望结果：
-- - type: index 或 range
-- - key: idx_time_range_query
-- - Extra: Using index (说明使用了覆盖索引，无需回表)

SELECT '✅ 索引优化完成！' as status;
SELECT 'open_interest_snapshots 表新增索引: idx_time_range_query' as info;
SELECT 'oi_anomaly_records 表新增索引: idx_anomaly_time_symbol, idx_anomaly_date_query' as info;
