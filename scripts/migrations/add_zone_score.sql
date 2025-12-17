-- 添加 zone_score 字段到 kline_breakout_signals 表
-- 运行命令: mysql -h 45.249.246.109 -u navicatuser -p trading_master < scripts/migrations/add_zone_score.sql

ALTER TABLE kline_breakout_signals
ADD COLUMN zone_score INT DEFAULT NULL COMMENT '区间得分 (0-100)'
AFTER center_price;

-- 验证
SELECT COLUMN_NAME, DATA_TYPE, COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'kline_breakout_signals' AND TABLE_SCHEMA = 'trading_master';
