-- =============================================
-- 验证索引优化效果
-- 使用方法: mysql -u root -pmonitordb trading_master < verify_optimization.sql
-- =============================================

USE trading_master;

-- =============================================
-- 1. 检查索引是否存在
-- =============================================
SELECT '\n========== 索引检查 ==========' as '';

SELECT 'open_interest_snapshots 表索引:' as '';
SHOW INDEX FROM open_interest_snapshots;

SELECT '\noi_anomaly_records 表索引:' as '';
SHOW INDEX FROM oi_anomaly_records;

-- =============================================
-- 2. 测试查询1：窗口函数查询（优化重点）
-- =============================================
SELECT '\n========== 测试1: 窗口函数查询 ==========' as '';

EXPLAIN
SELECT
  symbol,
  open_interest,
  snapshot_time,
  ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY timestamp_ms DESC) as rn_latest
FROM open_interest_snapshots
WHERE snapshot_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
  AND snapshot_time <= NOW()
LIMIT 100;

-- =============================================
-- 3. 测试查询2：异动记录查询
-- =============================================
SELECT '\n========== 测试2: 异动记录查询 ==========' as '';

EXPLAIN
SELECT * FROM oi_anomaly_records
WHERE anomaly_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
  AND anomaly_time <= NOW()
ORDER BY anomaly_time DESC
LIMIT 100;

-- =============================================
-- 4. 测试查询3：统计查询（实际生产SQL）
-- =============================================
SELECT '\n========== 测试3: 生产环境统计查询 ==========' as '';

EXPLAIN
WITH anomaly_symbols AS (
  SELECT DISTINCT symbol
  FROM oi_anomaly_records
  WHERE anomaly_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
    AND anomaly_time <= NOW()
),
latest_snapshots AS (
  SELECT
    s.symbol,
    s.open_interest,
    s.snapshot_time,
    s.timestamp_ms,
    ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY s.timestamp_ms DESC) as rn_latest,
    ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY s.timestamp_ms ASC) as rn_first
  FROM open_interest_snapshots s
  INNER JOIN anomaly_symbols a ON s.symbol = a.symbol
  WHERE s.snapshot_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
    AND s.snapshot_time <= NOW()
)
SELECT COUNT(*) FROM latest_snapshots;

-- =============================================
-- 5. 表统计信息
-- =============================================
SELECT '\n========== 表统计信息 ==========' as '';

SELECT
    TABLE_NAME as '表名',
    TABLE_ROWS as '估计行数',
    ROUND(DATA_LENGTH/1024/1024, 2) as '数据大小(MB)',
    ROUND(INDEX_LENGTH/1024/1024, 2) as '索引大小(MB)',
    ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024, 2) as '总大小(MB)'
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME IN ('open_interest_snapshots', 'oi_anomaly_records');

-- =============================================
-- 6. 索引使用建议
-- =============================================
SELECT '\n========== 优化建议 ==========' as '';

SELECT
    '如果上述EXPLAIN显示key=NULL或type=ALL，说明索引未生效' as '提示1',
    '需要检查索引是否创建成功，或者数据量太小导致优化器选择全表扫描' as '提示2',
    '建议：ANALYZE TABLE 表名; 来更新统计信息' as '提示3',
    '理想状态：key显示索引名，type为ref或range' as '提示4';
