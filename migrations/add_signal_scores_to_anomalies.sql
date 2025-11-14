-- 为 oi_anomaly_records 表添加信号评分字段
-- 执行命令: mysql -h 45.249.246.109 -P 3306 -u navicatuser -pnavicatuser trading_master < migrations/add_signal_scores_to_anomalies.sql

USE trading_master;

-- 添加信号评分相关字段
ALTER TABLE oi_anomaly_records
  ADD COLUMN signal_score DECIMAL(4,2) NULL COMMENT '信号总分 (0-10)' AFTER taker_buy_sell_ratio,
  ADD COLUMN signal_confidence DECIMAL(4,3) NULL COMMENT '信号置信度 (0-1)' AFTER signal_score,
  ADD COLUMN signal_direction ENUM('LONG','SHORT','NEUTRAL') NULL COMMENT '信号方向' AFTER signal_confidence,
  ADD COLUMN avoid_chase_reason VARCHAR(100) NULL COMMENT '避免追高原因' AFTER signal_direction;

-- 添加索引以优化查询
ALTER TABLE oi_anomaly_records
  ADD INDEX idx_signal_score (signal_score),
  ADD INDEX idx_signal_direction (signal_direction);

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
  AND COLUMN_NAME IN ('signal_score', 'signal_confidence', 'signal_direction', 'avoid_chase_reason')
ORDER BY ORDINAL_POSITION;
