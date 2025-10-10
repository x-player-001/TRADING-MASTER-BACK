-- 添加OI监控币种黑名单配置
INSERT INTO oi_monitoring_config (config_key, config_value, description) VALUES
('symbol_blacklist', '["USDC"]', 'OI监控币种黑名单(不监控的币种列表)')
ON DUPLICATE KEY UPDATE
  config_value = VALUES(config_value),
  updated_at = CURRENT_TIMESTAMP;
