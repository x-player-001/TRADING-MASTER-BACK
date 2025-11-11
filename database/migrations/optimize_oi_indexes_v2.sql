-- =============================================
-- OI数据库索引优化SQL V2（增强版）
-- 解决窗口函数和大数据量查询性能问题
-- =============================================

USE trading_master;

-- =============================================
-- 第一步：删除旧索引（如果存在）
-- =============================================

-- 删除可能存在的旧索引
ALTER TABLE open_interest_snapshots DROP INDEX IF EXISTS idx_time_range_query;
ALTER TABLE open_interest_snapshots DROP INDEX IF EXISTS idx_symbol_time;
ALTER TABLE open_interest_snapshots DROP INDEX IF EXISTS idx_snapshot_time;

ALTER TABLE oi_anomaly_records DROP INDEX IF EXISTS idx_anomaly_time_symbol;
ALTER TABLE oi_anomaly_records DROP INDEX IF EXISTS idx_anomaly_date_query;
ALTER TABLE oi_anomaly_records DROP INDEX IF EXISTS idx_anomaly_time;

-- =============================================
-- 第二步：open_interest_snapshots 表优化
-- =============================================

-- 1. 主要时间范围查询索引（最重要）
-- 优先使用 snapshot_time，因为它是WHERE条件的主要字段
ALTER TABLE open_interest_snapshots
ADD INDEX idx_snapshot_time_symbol (snapshot_time, symbol, timestamp_ms, open_interest)
COMMENT '核心索引：优化时间范围查询和窗口函数';

-- 2. 币种+时间复合索引（用于单币种查询）
ALTER TABLE open_interest_snapshots
ADD INDEX idx_symbol_snapshot_time (symbol, snapshot_time, timestamp_ms, open_interest)
COMMENT '复合索引：优化单币种时间范围查询';

-- 3. 时间戳索引（辅助排序）
ALTER TABLE open_interest_snapshots
ADD INDEX idx_timestamp_ms (timestamp_ms)
COMMENT '时间戳索引：优化ORDER BY timestamp_ms';

-- =============================================
-- 第三步：oi_anomaly_records 表优化
-- =============================================

-- 1. 主要时间查询索引
ALTER TABLE oi_anomaly_records
ADD INDEX idx_anomaly_time_symbol (anomaly_time, symbol, percent_change, severity)
COMMENT '核心索引：优化异动记录时间范围查询';

-- 2. 时间+严重程度复合索引
ALTER TABLE oi_anomaly_records
ADD INDEX idx_anomaly_time_severity (anomaly_time, severity, symbol)
COMMENT '复合索引：优化按严重程度过滤查询';

-- 3. 币种索引（辅助）
ALTER TABLE oi_anomaly_records
ADD INDEX idx_symbol (symbol)
COMMENT '币种索引：优化DISTINCT symbol查询';

-- =============================================
-- 第四步：强制更新表统计信息
-- =============================================

ANALYZE TABLE open_interest_snapshots;
ANALYZE TABLE oi_anomaly_records;

-- =============================================
-- 第五步：验证索引创建结果
-- =============================================

-- 查看 open_interest_snapshots 索引
SELECT
    DISTINCT INDEX_NAME as '索引名称',
    GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as '索引列',
    INDEX_TYPE as '索引类型'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'open_interest_snapshots'
  AND INDEX_NAME != 'PRIMARY'
GROUP BY INDEX_NAME, INDEX_TYPE;

-- 查看 oi_anomaly_records 索引
SELECT
    DISTINCT INDEX_NAME as '索引名称',
    GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as '索引列',
    INDEX_TYPE as '索引类型'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'oi_anomaly_records'
  AND INDEX_NAME != 'PRIMARY'
GROUP BY INDEX_NAME, INDEX_TYPE;

-- =============================================
-- 说明
-- =============================================
-- 本次优化针对以下查询场景：
-- 1. 时间范围内的窗口函数查询（ROW_NUMBER() OVER...）
-- 2. 按时间范围查询异动记录
-- 3. 单币种时间范围查询
-- 4. DISTINCT symbol 统计查询
--
-- 预期效果：
-- - 窗口函数查询：从 1800ms 降至 <500ms
-- - 异动记录查询：从 5ms 降至 <2ms
-- - 统计查询：保持 <5ms
--
-- 注意事项：
-- 1. 索引会占用额外磁盘空间（约1-2GB）
-- 2. 插入数据会稍慢（索引维护成本）
-- 3. 查询性能大幅提升（值得）
-- =============================================
