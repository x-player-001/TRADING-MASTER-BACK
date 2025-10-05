-- ======================================
-- OI (Open Interest) 监控相关数据表
-- 从 binance-api 项目迁移并优化
-- ======================================

-- 合约币种配置表
CREATE TABLE contract_symbols_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(30) NOT NULL UNIQUE,              -- BTCUSDT
  base_asset VARCHAR(20) NOT NULL,                 -- BTC
  quote_asset VARCHAR(20) NOT NULL,                -- USDT
  contract_type VARCHAR(20) DEFAULT 'PERPETUAL',   -- 合约类型
  status ENUM('TRADING','BREAK') DEFAULT 'TRADING', -- 交易状态
  enabled TINYINT(1) DEFAULT 1,                    -- 是否启用OI监控
  priority INT DEFAULT 50,                         -- 监控优先级 (1-100)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_symbol (symbol),
  INDEX idx_enabled_priority (enabled, priority),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OI快照数据表 (时序数据核心表)
CREATE TABLE open_interest_snapshots (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(30) NOT NULL,                     -- BTCUSDT
  open_interest DECIMAL(30,8) NOT NULL,            -- 未平仓合约数量
  timestamp_ms BIGINT NOT NULL,                    -- 时间戳(毫秒)
  snapshot_time TIMESTAMP NOT NULL,               -- 快照时间
  data_source VARCHAR(20) DEFAULT 'binance_api',  -- 数据源
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_timestamp (symbol, timestamp_ms),
  INDEX idx_symbol_time (symbol, snapshot_time),
  INDEX idx_timestamp (timestamp_ms),
  FOREIGN KEY (symbol) REFERENCES contract_symbols_config(symbol) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OI异动记录表 (分析和统计用)
CREATE TABLE oi_anomaly_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(30) NOT NULL,                     -- BTCUSDT
  period_seconds INT NOT NULL,                     -- 时间周期(秒) 60,120,300,900
  percent_change DECIMAL(10,4) NOT NULL,           -- 变化百分比
  oi_before DECIMAL(30,8) NOT NULL,                -- 变化前OI
  oi_after DECIMAL(30,8) NOT NULL,                 -- 变化后OI
  oi_change DECIMAL(30,8) NOT NULL,                -- 绝对变化量
  threshold_value DECIMAL(10,4) NOT NULL,          -- 触发阈值
  anomaly_time TIMESTAMP NOT NULL,                -- 异动时间
  severity ENUM('low','medium','high') DEFAULT 'medium', -- 异动严重程度
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_symbol_time (symbol, anomaly_time),
  INDEX idx_period_time (period_seconds, anomaly_time),
  INDEX idx_severity_time (severity, anomaly_time),
  INDEX idx_change_rate (percent_change),
  FOREIGN KEY (symbol) REFERENCES contract_symbols_config(symbol) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OI监控配置表
CREATE TABLE oi_monitoring_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  config_key VARCHAR(50) NOT NULL UNIQUE,          -- 配置键名
  config_value TEXT NOT NULL,                      -- 配置值(JSON格式)
  description VARCHAR(200),                        -- 配置描述
  is_active TINYINT(1) DEFAULT 1,                  -- 是否生效
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_key_active (config_key, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 插入默认配置
INSERT INTO oi_monitoring_config (config_key, config_value, description) VALUES
('polling_interval_ms', '60000', 'OI数据轮询间隔(毫秒)'),
('max_concurrent_requests', '50', '最大并发请求数'),
('thresholds', '{"60":3,"120":3,"300":3,"900":10}', '各时间周期异动阈值(%)'),
('symbol_refresh_interval_ms', '7200000', '币种列表刷新间隔(毫秒)'),
('off_hours_config', '{"start":0,"end":7,"interval_ms":900000}', '非交易时段配置'),
('dedup_change_diff_threshold', '1', '去重阈值: 变化率增量<N%跳过插入'),
('severity_thresholds', '{"high":30,"medium":15}', '严重程度阈值: high>=30%, medium>=15%');