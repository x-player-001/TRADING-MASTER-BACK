-- =====================================================
-- 量化交易系统数据库表结构
-- 创建时间: 2025-10-07
-- 说明: 独立的量化交易模块数据库表
-- =====================================================

-- 1. 策略配置表
CREATE TABLE IF NOT EXISTS quant_strategies (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL UNIQUE COMMENT '策略名称',
  type VARCHAR(50) NOT NULL COMMENT '策略类型: breakout/trend_following',
  description TEXT COMMENT '策略描述',
  parameters JSON NOT NULL COMMENT '策略参数配置',
  enabled TINYINT(1) DEFAULT 0 COMMENT '是否启用: 0=禁用 1=启用',
  mode ENUM('backtest','paper','live') DEFAULT 'backtest' COMMENT '运行模式: 回测/模拟/实盘',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_type (type),
  INDEX idx_enabled (enabled),
  INDEX idx_mode (mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='量化策略配置表';

-- 2. 回测结果表
CREATE TABLE IF NOT EXISTS quant_backtest_results (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  strategy_id INT NOT NULL COMMENT '策略ID',
  symbol VARCHAR(20) NOT NULL COMMENT '交易币种',
  `interval` VARCHAR(10) NOT NULL COMMENT '时间周期',
  start_time BIGINT NOT NULL COMMENT '回测开始时间(ms)',
  end_time BIGINT NOT NULL COMMENT '回测结束时间(ms)',
  initial_capital DECIMAL(20,8) NOT NULL COMMENT '初始资金',
  final_capital DECIMAL(20,8) NOT NULL COMMENT '最终资金',
  total_return DECIMAL(10,4) COMMENT '总收益率%',
  annual_return DECIMAL(10,4) COMMENT '年化收益率%',
  sharpe_ratio DECIMAL(10,4) COMMENT '夏普比率',
  max_drawdown DECIMAL(10,4) COMMENT '最大回撤%',
  win_rate DECIMAL(10,4) COMMENT '胜率%',
  total_trades INT COMMENT '总交易次数',
  avg_trade_duration INT COMMENT '平均持仓时长(秒)',
  profit_factor DECIMAL(10,4) COMMENT '盈亏比',
  performance_data JSON COMMENT '详细性能数据',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_strategy (strategy_id),
  INDEX idx_symbol_interval (symbol, `interval`),
  INDEX idx_sharpe (sharpe_ratio DESC),
  INDEX idx_created (created_at DESC),
  FOREIGN KEY (strategy_id) REFERENCES quant_strategies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='回测结果表';

-- 3. 交易记录表
CREATE TABLE IF NOT EXISTS quant_trades (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  strategy_id INT NOT NULL COMMENT '策略ID',
  backtest_id BIGINT NULL COMMENT '回测ID(回测时有值)',
  symbol VARCHAR(20) NOT NULL COMMENT '交易币种',
  `interval` VARCHAR(10) NOT NULL COMMENT '时间周期',
  side ENUM('LONG','SHORT') NOT NULL COMMENT '方向: 做多/做空',
  entry_price DECIMAL(20,8) NOT NULL COMMENT '入场价格',
  exit_price DECIMAL(20,8) NOT NULL COMMENT '出场价格',
  quantity DECIMAL(20,8) NOT NULL COMMENT '交易数量',
  entry_time BIGINT NOT NULL COMMENT '入场时间(ms)',
  exit_time BIGINT NOT NULL COMMENT '出场时间(ms)',
  holding_duration INT NOT NULL COMMENT '持仓时长(秒)',
  pnl DECIMAL(20,8) NOT NULL COMMENT '盈亏金额',
  pnl_percent DECIMAL(10,4) NOT NULL COMMENT '盈亏百分比',
  commission DECIMAL(20,8) DEFAULT 0 COMMENT '手续费',
  exit_reason VARCHAR(50) COMMENT '平仓原因: stop_loss/take_profit/signal',
  trade_data JSON COMMENT '交易详情数据',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_strategy (strategy_id),
  INDEX idx_backtest (backtest_id),
  INDEX idx_symbol (symbol),
  INDEX idx_entry_time (entry_time),
  INDEX idx_side (side),
  FOREIGN KEY (strategy_id) REFERENCES quant_strategies(id) ON DELETE CASCADE,
  FOREIGN KEY (backtest_id) REFERENCES quant_backtest_results(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='交易记录表';

-- 4. 持仓表
CREATE TABLE IF NOT EXISTS quant_positions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  strategy_id INT NOT NULL COMMENT '策略ID',
  symbol VARCHAR(20) NOT NULL COMMENT '交易币种',
  `interval` VARCHAR(10) NOT NULL COMMENT '时间周期',
  side ENUM('LONG','SHORT') NOT NULL COMMENT '方向: 做多/做空',
  entry_price DECIMAL(20,8) NOT NULL COMMENT '入场价格',
  quantity DECIMAL(20,8) NOT NULL COMMENT '持仓数量',
  current_price DECIMAL(20,8) COMMENT '当前价格',
  stop_loss DECIMAL(20,8) COMMENT '止损价格',
  take_profit DECIMAL(20,8) COMMENT '止盈价格',
  unrealized_pnl DECIMAL(20,8) COMMENT '浮动盈亏',
  unrealized_pnl_percent DECIMAL(10,4) COMMENT '浮动盈亏百分比',
  status ENUM('open','closed') DEFAULT 'open' COMMENT '状态: 开仓/平仓',
  entry_time BIGINT NOT NULL COMMENT '开仓时间(ms)',
  close_time BIGINT NULL COMMENT '平仓时间(ms)',
  entry_indicators JSON COMMENT '入场时指标快照',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_strategy_symbol_open (strategy_id, symbol, status),
  INDEX idx_status (status),
  INDEX idx_symbol (symbol),
  FOREIGN KEY (strategy_id) REFERENCES quant_strategies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='持仓表';

-- 5. 策略性能表
CREATE TABLE IF NOT EXISTS quant_strategy_performance (
  id INT PRIMARY KEY AUTO_INCREMENT,
  strategy_id INT NOT NULL UNIQUE COMMENT '策略ID',
  total_backtests INT DEFAULT 0 COMMENT '回测次数',
  total_trades INT DEFAULT 0 COMMENT '总交易次数',
  win_trades INT DEFAULT 0 COMMENT '盈利交易次数',
  loss_trades INT DEFAULT 0 COMMENT '亏损交易次数',
  win_rate DECIMAL(10,4) COMMENT '胜率%',
  avg_return DECIMAL(10,4) COMMENT '平均收益率%',
  best_return DECIMAL(10,4) COMMENT '最佳收益率%',
  worst_return DECIMAL(10,4) COMMENT '最差收益率%',
  avg_sharpe DECIMAL(10,4) COMMENT '平均夏普比率',
  avg_max_drawdown DECIMAL(10,4) COMMENT '平均最大回撤%',
  last_backtest_at TIMESTAMP NULL COMMENT '最后回测时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (strategy_id) REFERENCES quant_strategies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='策略性能统计表';

-- 6. 风控配置表
CREATE TABLE IF NOT EXISTS quant_risk_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  strategy_id INT NOT NULL UNIQUE COMMENT '策略ID',
  max_positions INT DEFAULT 5 COMMENT '最大持仓数量',
  max_position_size_percent DECIMAL(10,4) DEFAULT 20.00 COMMENT '单仓最大占比%',
  max_total_risk_percent DECIMAL(10,4) DEFAULT 50.00 COMMENT '总风险敞口%',
  stop_loss_percent DECIMAL(10,4) DEFAULT 2.00 COMMENT '止损百分比%',
  take_profit_percent DECIMAL(10,4) DEFAULT 5.00 COMMENT '止盈百分比%',
  max_daily_loss_percent DECIMAL(10,4) DEFAULT 10.00 COMMENT '单日最大亏损%',
  blacklist_symbols JSON COMMENT '黑名单币种',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (strategy_id) REFERENCES quant_strategies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='风控配置表';

-- =====================================================
-- 初始化数据
-- =====================================================

-- 插入默认突破策略配置
INSERT INTO quant_strategies (name, type, description, parameters, enabled, mode) VALUES
(
  'Default Breakout Strategy',
  'breakout',
  '基于区间突破的交易策略，当价格突破支撑或阻力位时触发交易信号',
  '{
    "lookback_period": 200,
    "min_range_touches": 4,
    "min_confidence": 0.7,
    "min_volume_surge": 1.3,
    "min_strength": 70,
    "min_risk_reward": 1.5
  }',
  0,
  'backtest'
);

-- 插入默认趋势跟踪策略配置
INSERT INTO quant_strategies (name, type, description, parameters, enabled, mode) VALUES
(
  'Default Trend Following Strategy',
  'trend_following',
  '基于移动平均线的趋势跟踪策略，通过均线交叉判断趋势方向',
  '{
    "fast_ma_period": 20,
    "slow_ma_period": 50,
    "trend_ma_period": 200,
    "rsi_period": 14,
    "rsi_oversold": 30,
    "rsi_overbought": 70,
    "min_trend_strength": 0.02
  }',
  0,
  'backtest'
);

-- 为每个策略创建默认风控配置
INSERT INTO quant_risk_config (strategy_id, max_positions, max_position_size_percent, max_total_risk_percent, stop_loss_percent, take_profit_percent, max_daily_loss_percent, blacklist_symbols)
SELECT
  id,
  5,
  20.00,
  50.00,
  2.00,
  5.00,
  10.00,
  '[]'
FROM quant_strategies;

-- =====================================================
-- 完成
-- =====================================================
