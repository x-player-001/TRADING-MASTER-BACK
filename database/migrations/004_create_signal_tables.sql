-- 交易信号表
CREATE TABLE IF NOT EXISTS trading_signals (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(10) NOT NULL,
  signal_type ENUM('BUY','SELL','NEUTRAL') NOT NULL,
  strength INT NOT NULL,                    -- 0-100
  price DECIMAL(20,8) NOT NULL,             -- 触发价格
  indicators JSON NOT NULL,                 -- 触发指标详情
  description VARCHAR(500),                 -- 信号描述
  timestamp BIGINT NOT NULL,                -- 触发时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_symbol_interval (symbol, `interval`),
  INDEX idx_timestamp (timestamp),
  INDEX idx_signal_type (signal_type),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='交易信号表';

-- 技术指标缓存表（可选，提升查询性能）
CREATE TABLE IF NOT EXISTS technical_indicators (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(10) NOT NULL,
  timestamp BIGINT NOT NULL,
  ma5 DECIMAL(20,8),
  ma10 DECIMAL(20,8),
  ma20 DECIMAL(20,8),
  ma60 DECIMAL(20,8),
  rsi14 DECIMAL(10,4),
  macd_value DECIMAL(20,8),
  macd_signal DECIMAL(20,8),
  macd_histogram DECIMAL(20,8),
  boll_upper DECIMAL(20,8),
  boll_middle DECIMAL(20,8),
  boll_lower DECIMAL(20,8),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_interval_time (symbol, `interval`, timestamp),
  INDEX idx_symbol_interval (symbol, `interval`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='技术指标缓存表';

-- 形态识别记录表
CREATE TABLE IF NOT EXISTS pattern_detections (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(10) NOT NULL,
  pattern_type VARCHAR(50) NOT NULL,        -- hammer/engulfing/doji等
  confidence DECIMAL(5,4) NOT NULL,         -- 0-1置信度
  description VARCHAR(200),
  detected_at BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_symbol_interval (symbol, `interval`),
  INDEX idx_detected_at (detected_at),
  INDEX idx_pattern_type (pattern_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='形态识别记录表';
