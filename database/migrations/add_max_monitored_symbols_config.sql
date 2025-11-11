-- ======================================
-- 添加OI监控最大币种数量配置
-- ======================================

-- 插入max_monitored_symbols配置项（如果不存在）
INSERT INTO oi_monitoring_config (config_key, config_value, description, is_active)
VALUES ('max_monitored_symbols', '300', '最大监控币种数量，设置为"max"表示不限制', 1)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  updated_at = CURRENT_TIMESTAMP;
