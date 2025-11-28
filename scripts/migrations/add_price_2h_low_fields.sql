-- 添加2小时价格低点相关字段到 oi_anomaly_records 表
-- 用于更精准的追高判断（相对于日内低点）

ALTER TABLE oi_anomaly_records
ADD COLUMN price_2h_low DECIMAL(20, 8) NULL COMMENT '2小时内最低价' AFTER price_from_high_pct,
ADD COLUMN price_from_2h_low_pct DECIMAL(10, 4) NULL COMMENT '相对2小时低点的涨幅(%)' AFTER price_2h_low;

-- 添加索引以便按2小时涨幅查询
CREATE INDEX idx_price_from_2h_low_pct ON oi_anomaly_records (price_from_2h_low_pct);
