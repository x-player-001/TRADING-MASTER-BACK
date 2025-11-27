-- 为contract_symbols表添加精度字段
-- 执行前请先备份数据库！

-- 添加精度相关字段
ALTER TABLE contract_symbols
ADD COLUMN price_precision INT DEFAULT NULL COMMENT '价格小数位数',
ADD COLUMN quantity_precision INT DEFAULT NULL COMMENT '数量小数位数',
ADD COLUMN base_asset_precision INT DEFAULT NULL COMMENT '标的资产精度',
ADD COLUMN quote_precision INT DEFAULT NULL COMMENT '报价资产精度',
ADD COLUMN min_notional DECIMAL(20,8) DEFAULT NULL COMMENT '最小名义价值',
ADD COLUMN step_size DECIMAL(20,8) DEFAULT NULL COMMENT '数量步进';

-- 添加索引以优化查询
CREATE INDEX idx_symbol_precision ON contract_symbols(symbol, quantity_precision, price_precision);

-- 验证表结构
SHOW COLUMNS FROM contract_symbols;
