-- TOP币种配置表
CREATE TABLE top_symbols_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL UNIQUE COMMENT '交易对符号',
  display_name VARCHAR(50) NOT NULL COMMENT '显示名称',
  rank_order INT NOT NULL COMMENT '排序权重 1-10',
  enabled BOOLEAN DEFAULT true COMMENT '是否启用订阅',
  subscription_intervals JSON COMMENT '订阅的时间周期',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_rank_enabled (rank_order, enabled),
  INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TOP币种配置表';

-- 初始化默认TOP10币种
INSERT INTO top_symbols_config (symbol, display_name, rank_order, subscription_intervals) VALUES
('BTCUSDT', 'Bitcoin', 1, '["1m","5m","15m","1h"]'),
('ETHUSDT', 'Ethereum', 2, '["1m","5m","15m","1h"]'),
('BNBUSDT', 'BNB', 3, '["1m","5m","15m","1h"]'),
('XRPUSDT', 'XRP', 4, '["5m","15m","1h"]'),
('SOLUSDT', 'Solana', 5, '["5m","15m","1h"]'),
('ADAUSDT', 'Cardano', 6, '["5m","15m","1h"]'),
('DOGEUSDT', 'Dogecoin', 7, '["15m","1h"]'),
('DOTUSDT', 'Polkadot', 8, '["15m","1h"]'),
('MATICUSDT', 'Polygon', 9, '["15m","1h"]'),
('AVAXUSDT', 'Avalanche', 10, '["15m","1h"]');