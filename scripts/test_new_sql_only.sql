-- =============================================
-- 只测试新SQL性能（跳过慢的窗口函数测试）
-- 使用方法: mysql -u root -pmonitordb trading_master < test_new_sql_only.sql
-- =============================================

USE trading_master;

SET @start_time = DATE_SUB(NOW(), INTERVAL 1 DAY);
SET @end_time = NOW();

SELECT '========== 新SQL性能测试（无窗口函数） ==========' as '';
SELECT CONCAT('时间范围: ', CAST(@start_time AS CHAR), ' ~ ', CAST(@end_time AS CHAR)) as '';

-- =============================================
-- 测试: 新SQL执行时间
-- =============================================
SELECT '\n开始时间:' as '', NOW() as '时间';

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

SELECT '\n结束时间:' as '', NOW() as '时间';

-- =============================================
-- EXPLAIN分析
-- =============================================
SELECT '\n========== EXPLAIN分析 ==========' as '';

EXPLAIN
WITH anomaly_symbols AS (
  SELECT DISTINCT symbol
  FROM oi_anomaly_records
  WHERE anomaly_time >= @start_time AND anomaly_time <= @end_time
),
latest_oi AS (
  SELECT
    s.symbol,
    s.open_interest as latest_oi
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
SELECT '这是优化后的新SQL（无窗口函数）' as '版本';
SELECT '使用MAX/MIN聚合+JOIN代替ROW_NUMBER()' as '优化策略';
SELECT '预期执行时间: <1秒（对比旧版本需要几分钟）' as '性能目标';
