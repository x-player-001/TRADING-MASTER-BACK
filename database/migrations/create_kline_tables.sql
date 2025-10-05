-- K线数据分表结构 (按时间周期分表)

-- 1分钟K线表
CREATE TABLE kline_1m (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL COMMENT '交易对符号',
  open_time TIMESTAMP(3) NOT NULL COMMENT 'K线开始时间',
  close_time TIMESTAMP(3) NOT NULL COMMENT 'K线结束时间',
  open DECIMAL(20,8) NOT NULL COMMENT '开盘价',
  high DECIMAL(20,8) NOT NULL COMMENT '最高价',
  low DECIMAL(20,8) NOT NULL COMMENT '最低价',
  close DECIMAL(20,8) NOT NULL COMMENT '收盘价',
  volume DECIMAL(30,8) NOT NULL COMMENT '成交量',
  trade_count INT NOT NULL COMMENT '成交笔数',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_time (symbol, open_time),
  INDEX idx_symbol_time_desc (symbol, open_time DESC),
  INDEX idx_time_desc (open_time DESC),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='1分钟K线数据表';

-- 5分钟K线表
CREATE TABLE kline_5m (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL COMMENT '交易对符号',
  open_time TIMESTAMP(3) NOT NULL COMMENT 'K线开始时间',
  close_time TIMESTAMP(3) NOT NULL COMMENT 'K线结束时间',
  open DECIMAL(20,8) NOT NULL COMMENT '开盘价',
  high DECIMAL(20,8) NOT NULL COMMENT '最高价',
  low DECIMAL(20,8) NOT NULL COMMENT '最低价',
  close DECIMAL(20,8) NOT NULL COMMENT '收盘价',
  volume DECIMAL(30,8) NOT NULL COMMENT '成交量',
  trade_count INT NOT NULL COMMENT '成交笔数',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_time (symbol, open_time),
  INDEX idx_symbol_time_desc (symbol, open_time DESC),
  INDEX idx_time_desc (open_time DESC),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='5分钟K线数据表';

-- 15分钟K线表
CREATE TABLE kline_15m (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL COMMENT '交易对符号',
  open_time TIMESTAMP(3) NOT NULL COMMENT 'K线开始时间',
  close_time TIMESTAMP(3) NOT NULL COMMENT 'K线结束时间',
  open DECIMAL(20,8) NOT NULL COMMENT '开盘价',
  high DECIMAL(20,8) NOT NULL COMMENT '最高价',
  low DECIMAL(20,8) NOT NULL COMMENT '最低价',
  close DECIMAL(20,8) NOT NULL COMMENT '收盘价',
  volume DECIMAL(30,8) NOT NULL COMMENT '成交量',
  trade_count INT NOT NULL COMMENT '成交笔数',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_time (symbol, open_time),
  INDEX idx_symbol_time_desc (symbol, open_time DESC),
  INDEX idx_time_desc (open_time DESC),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='15分钟K线数据表';

-- 1小时K线表
CREATE TABLE kline_1h (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL COMMENT '交易对符号',
  open_time TIMESTAMP(3) NOT NULL COMMENT 'K线开始时间',
  close_time TIMESTAMP(3) NOT NULL COMMENT 'K线结束时间',
  open DECIMAL(20,8) NOT NULL COMMENT '开盘价',
  high DECIMAL(20,8) NOT NULL COMMENT '最高价',
  low DECIMAL(20,8) NOT NULL COMMENT '最低价',
  close DECIMAL(20,8) NOT NULL COMMENT '收盘价',
  volume DECIMAL(30,8) NOT NULL COMMENT '成交量',
  trade_count INT NOT NULL COMMENT '成交笔数',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_time (symbol, open_time),
  INDEX idx_symbol_time_desc (symbol, open_time DESC),
  INDEX idx_time_desc (open_time DESC),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='1小时K线数据表';