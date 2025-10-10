-- =====================================================
-- 结构性形态识别表
-- =====================================================

-- 1. 结构性形态主表
CREATE TABLE IF NOT EXISTS structure_patterns (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(10) NOT NULL,

  -- 形态类型
  structure_type ENUM(
    'range',
    'double_bottom',
    'double_top',
    'head_shoulders_top',
    'head_shoulders_bottom',
    'ascending_triangle',
    'descending_triangle',
    'symmetrical_triangle',
    'bull_flag',
    'bear_flag'
  ) NOT NULL,

  -- 关键价位 (JSON存储)
  key_levels JSON NOT NULL COMMENT '{"support": 45000, "resistance": 46000, "middle": 45500}',

  -- 形态详细数据 (JSON存储完整信息)
  pattern_data JSON NOT NULL,

  -- 突破状态
  breakout_status ENUM('forming', 'broken_up', 'broken_down', 'failed') DEFAULT 'forming',
  breakout_time BIGINT NULL,
  breakout_price DECIMAL(20,8) NULL,

  -- 置信度和强度
  confidence DECIMAL(5,4) NOT NULL COMMENT '0-1置信度',
  strength INT NOT NULL COMMENT '0-100强度值',

  -- 时间范围
  start_time BIGINT NOT NULL COMMENT '形态开始时间(毫秒)',
  end_time BIGINT NOT NULL COMMENT '形态结束时间(毫秒)',
  duration_bars INT NOT NULL COMMENT '持续K线数',

  -- 目标位和止损
  target_price DECIMAL(20,8) NULL,
  stop_loss DECIMAL(20,8) NULL,
  risk_reward_ratio DECIMAL(10,2) NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- 索引
  INDEX idx_symbol_interval (symbol, `interval`),
  INDEX idx_structure_type (structure_type),
  INDEX idx_breakout_status (breakout_status),
  INDEX idx_confidence (confidence DESC),
  INDEX idx_start_time (start_time),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结构性形态识别表';

-- 2. 区间突破信号表
CREATE TABLE IF NOT EXISTS breakout_signals (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  structure_id BIGINT NULL COMMENT '关联的结构形态ID',
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(10) NOT NULL,

  -- 突破信息
  breakout_direction ENUM('up', 'down') NOT NULL,
  breakout_price DECIMAL(20,8) NOT NULL,
  previous_range_high DECIMAL(20,8) NOT NULL,
  previous_range_low DECIMAL(20,8) NOT NULL,
  breakout_strength INT NOT NULL COMMENT '0-100突破强度',

  -- 成交量确认
  breakout_volume DECIMAL(30,8) NOT NULL,
  avg_volume DECIMAL(30,8) NOT NULL,
  volume_ratio DECIMAL(10,2) NOT NULL COMMENT '突破量/平均量',

  -- 目标和止损
  target_price DECIMAL(20,8) NOT NULL,
  stop_loss DECIMAL(20,8) NOT NULL,
  risk_reward_ratio DECIMAL(10,2) NOT NULL,

  -- 结果追踪
  result ENUM('pending', 'hit_target', 'hit_stop', 'failed') DEFAULT 'pending',
  result_time BIGINT NULL,
  max_profit_percent DECIMAL(10,2) NULL,
  max_loss_percent DECIMAL(10,2) NULL,

  breakout_time BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- 索引
  INDEX idx_symbol_interval (symbol, `interval`),
  INDEX idx_breakout_time (breakout_time),
  INDEX idx_breakout_direction (breakout_direction),
  INDEX idx_result (result),
  INDEX idx_structure_id (structure_id),
  FOREIGN KEY (structure_id) REFERENCES structure_patterns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='突破信号表';

-- 3. 插入测试数据 (可选)
-- INSERT INTO structure_patterns (
--   symbol, `interval`, structure_type, key_levels, pattern_data,
--   confidence, strength, start_time, end_time, duration_bars
-- ) VALUES (
--   'BTCUSDT', '1h', 'range',
--   '{"support": 45000, "resistance": 46000, "middle": 45500}',
--   '{"range_percent": 2.22, "touch_count": 6, "support_touches": 3, "resistance_touches": 3}',
--   0.75, 80, 1642240000000, 1642320000000, 30
-- );
