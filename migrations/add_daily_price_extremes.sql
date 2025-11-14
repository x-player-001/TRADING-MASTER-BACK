-- 为 oi_anomaly_records 表添加每日价格极值字段
-- 执行命令: mysql -h 45.249.246.109 -P 3306 -u navicatuser -pnavicatuser trading_master < migrations/add_daily_price_extremes.sql

USE trading_master;

-- 添加每日价格极值相关字段
ALTER TABLE oi_anomaly_records
  ADD COLUMN daily_price_low DECIMAL(20,8) NULL COMMENT '触发时的日内最低价' AFTER avoid_chase_reason,
  ADD COLUMN daily_price_high DECIMAL(20,8) NULL COMMENT '触发时的日内最高价' AFTER daily_price_low,
  ADD COLUMN price_from_low_pct DECIMAL(10,4) NULL COMMENT '相对日内低点的涨幅(%)' AFTER daily_price_high,
  ADD COLUMN price_from_high_pct DECIMAL(10,4) NULL COMMENT '相对日内高点的跌幅(%)' AFTER price_from_low_pct;

-- 添加索引优化查询
ALTER TABLE oi_anomaly_records
  ADD INDEX idx_price_from_low (price_from_low_pct),
  ADD INDEX idx_price_from_high (price_from_high_pct);

-- 验证字段添加成功
SELECT
  COLUMN_NAME,
  DATA_TYPE,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'oi_anomaly_records'
  AND COLUMN_NAME IN ('daily_price_low', 'daily_price_high', 'price_from_low_pct', 'price_from_high_pct')
ORDER BY ORDINAL_POSITION;
