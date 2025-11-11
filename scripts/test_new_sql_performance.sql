-- =============================================
-- 测试新SQL性能（移除窗口函数版本）
-- 使用方法: mysql -u root -pmonitordb trading_master < test_new_sql_performance.sql
-- =============================================

USE trading_master;

SET @start_time = DATE_SUB(NOW(), INTERVAL 1 DAY);
SET @end_time = NOW();

SELECT '========== 性能对比测试 ==========' as '';
SELECT CONCAT('时间范围: ', CAST(@start_time AS CHAR), ' ~ ', CAST(@end_time AS CHAR)) as '';

-- =============================================
-- 测试1: 旧SQL（使用窗口函数）
-- =============================================
SELECT '\n========== 测试1: 旧SQL（窗口函数） ==========' as '';
SELECT '开始时间:', NOW() as '';

SELECT COUNT(*) as '结果行数'
FROM (
  WITH anomaly_symbols AS (
    SELECT DISTINCT symbol
    FROM oi_anomaly_records
    WHERE anomaly_time >= @start_time AND anomaly_time <= @end_time
  ),
  latest_snapshots AS (
    SELECT
      s.symbol,
      s.open_interest,
      s.snapshot_time,
      ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY s.timestamp_ms DESC) as rn_latest,
      ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY s.timestamp_ms ASC) as rn_earliest
    FROM open_interest_snapshots s
    INNER JOIN anomaly_symbols a ON s.symbol = a.symbol
    WHERE s.snapshot_time >= @start_time AND s.snapshot_time <= @end_time
  ),
  period_stats AS (
    SELECT
      symbol,
      MAX(CASE WHEN rn_latest = 1 THEN open_interest END) as latest_oi,
      MAX(CASE WHEN rn_earliest = 1 THEN open_interest END) as start_oi,
      AVG(open_interest) as avg_oi_24h
    FROM latest_snapshots
    GROUP BY symbol
  ),
  anomaly_stats AS (
    SELECT
      symbol,
      COUNT(*) as anomaly_count,
      MAX(anomaly_time) as last_anomaly_time,
      MIN(anomaly_time) as first_anomaly_time
    FROM oi_anomaly_records
    WHERE anomaly_time >= @start_time AND anomaly_time <= @end_time
    GROUP BY symbol
  )
  SELECT
    ps.symbol,
    ps.latest_oi,
    COALESCE(((ps.latest_oi - ps.start_oi) / NULLIF(ps.start_oi, 0) * 100), 0) as daily_change_pct,
    a.anomaly_count as anomaly_count_24h,
    a.last_anomaly_time,
    a.first_anomaly_time,
    COALESCE(ps.avg_oi_24h, ps.latest_oi) as avg_oi_24h
  FROM period_stats ps
  INNER JOIN anomaly_stats a ON ps.symbol = a.symbol
  WHERE ps.latest_oi IS NOT NULL
  ORDER BY COALESCE(a.anomaly_count, 0) DESC, ps.symbol ASC
) result;

SELECT '结束时间:', NOW() as '';

-- =============================================
-- 测试2: 新SQL（移除窗口函数）
-- =============================================
SELECT '\n========== 测试2: 新SQL（无窗口函数） ==========' as '';
SELECT '开始时间:', NOW() as '';

SELECT COUNT(*) as '结果行数'
FROM (
  WITH anomaly_symbols AS (
    SELECT DISTINCT symbol
    FROM oi_anomaly_records
    WHERE anomaly_time >= @start_time AND anomaly_time <= @end_time
  ),
  latest_oi AS (
    SELECT
      s.symbol,
      s.open_interest as latest_oi,
      s.snapshot_time
    FROM open_interest_snapshots s
    INNER JOIN anomaly_symbols a ON s.symbol = a.symbol
    INNER JOIN (
      SELECT symbol, MAX(timestamp_ms) as max_ts
      FROM open_interest_snapshots
      WHERE snapshot_time >= @start_time AND snapshot_time <= @end_time
      GROUP BY symbol
    ) latest ON s.symbol = latest.symbol AND s.timestamp_ms = latest.max_ts
    WHERE s.snapshot_time >= @start_time AND s.snapshot_time <= @end_time
  ),
  earliest_oi AS (
    SELECT
      s.symbol,
      s.open_interest as start_oi
    FROM open_interest_snapshots s
    INNER JOIN anomaly_symbols a ON s.symbol = a.symbol
    INNER JOIN (
      SELECT symbol, MIN(timestamp_ms) as min_ts
      FROM open_interest_snapshots
      WHERE snapshot_time >= @start_time AND snapshot_time <= @end_time
      GROUP BY symbol
    ) earliest ON s.symbol = earliest.symbol AND s.timestamp_ms = earliest.min_ts
    WHERE s.snapshot_time >= @start_time AND s.snapshot_time <= @end_time
  ),
  avg_oi AS (
    SELECT
      s.symbol,
      AVG(s.open_interest) as avg_oi_24h
    FROM open_interest_snapshots s
    INNER JOIN anomaly_symbols a ON s.symbol = a.symbol
    WHERE s.snapshot_time >= @start_time AND s.snapshot_time <= @end_time
    GROUP BY s.symbol
  ),
  period_stats AS (
    SELECT
      l.symbol,
      l.latest_oi,
      e.start_oi,
      a.avg_oi_24h
    FROM latest_oi l
    INNER JOIN earliest_oi e ON l.symbol = e.symbol
    INNER JOIN avg_oi a ON l.symbol = a.symbol
  ),
  anomaly_stats AS (
    SELECT
      symbol,
      COUNT(*) as anomaly_count,
      MAX(anomaly_time) as last_anomaly_time,
      MIN(anomaly_time) as first_anomaly_time
    FROM oi_anomaly_records
    WHERE anomaly_time >= @start_time AND anomaly_time <= @end_time
    GROUP BY symbol
  )
  SELECT
    ps.symbol,
    ps.latest_oi,
    COALESCE(((ps.latest_oi - ps.start_oi) / NULLIF(ps.start_oi, 0) * 100), 0) as daily_change_pct,
    a.anomaly_count as anomaly_count_24h,
    a.last_anomaly_time,
    a.first_anomaly_time,
    COALESCE(ps.avg_oi_24h, ps.latest_oi) as avg_oi_24h
  FROM period_stats ps
  INNER JOIN anomaly_stats a ON ps.symbol = a.symbol
  WHERE ps.latest_oi IS NOT NULL
  ORDER BY COALESCE(a.anomaly_count, 0) DESC, ps.symbol ASC
) result;

SELECT '结束时间:', NOW() as '';

-- =============================================
-- 测试3: EXPLAIN分析新SQL
-- =============================================
SELECT '\n========== 测试3: EXPLAIN分析（新SQL） ==========' as '';

EXPLAIN
WITH anomaly_symbols AS (
  SELECT DISTINCT symbol
  FROM oi_anomaly_records
  WHERE anomaly_time >= @start_time AND anomaly_time <= @end_time
),
latest_oi AS (
  SELECT
    s.symbol,
    s.open_interest as latest_oi,
    s.snapshot_time
  FROM open_interest_snapshots s
  INNER JOIN anomaly_symbols a ON s.symbol = a.symbol
  INNER JOIN (
    SELECT symbol, MAX(timestamp_ms) as max_ts
    FROM open_interest_snapshots
    WHERE snapshot_time >= @start_time AND snapshot_time <= @end_time
    GROUP BY symbol
  ) latest ON s.symbol = latest.symbol AND s.timestamp_ms = latest.max_ts
  WHERE s.snapshot_time >= @start_time AND s.snapshot_time <= @end_time
)
SELECT * FROM latest_oi LIMIT 1;

-- =============================================
-- 说明
-- =============================================
SELECT '\n========== 测试说明 ==========' as '';
SELECT '对比两个SQL的执行时间差异' as '目的';
SELECT '旧SQL使用窗口函数ROW_NUMBER()' as '测试1';
SELECT '新SQL使用MAX/MIN聚合+JOIN' as '测试2';
SELECT '新SQL应该比旧SQL快5-10倍' as '预期';
SELECT '如果新SQL更快，说明优化成功' as '结论';
