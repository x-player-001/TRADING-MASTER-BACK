/*
 Navicat Premium Data Transfer

 Source Server         : Local
 Source Server Type    : MySQL
 Source Server Version : 80040
 Source Host           : localhost:3306
 Source Schema         : trading_master

 Target Server Type    : MySQL
 Target Server Version : 80040
 File Encoding         : 65001

 Date: 27/09/2025 23:31:48
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for contract_symbols_config
-- ----------------------------
DROP TABLE IF EXISTS `contract_symbols_config`;
CREATE TABLE `contract_symbols_config`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `base_asset` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `quote_asset` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `contract_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'PERPETUAL',
  `status` enum('TRADING','BREAK') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'TRADING',
  `enabled` tinyint(1) NULL DEFAULT 1,
  `priority` int NULL DEFAULT 50,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `symbol`(`symbol` ASC) USING BTREE,
  INDEX `idx_symbol`(`symbol` ASC) USING BTREE,
  INDEX `idx_enabled_priority`(`enabled` ASC, `priority` ASC) USING BTREE,
  INDEX `idx_status`(`status` ASC) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for historical_data_cache
-- ----------------------------
DROP TABLE IF EXISTS `historical_data_cache`;
CREATE TABLE `historical_data_cache`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `time_interval` enum('1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1mo') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `start_time` timestamp NOT NULL,
  `end_time` timestamp NOT NULL,
  `data_count` int NOT NULL,
  `cache_key` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` timestamp NOT NULL,
  `fetch_duration` int NULL DEFAULT 0,
  `data_source` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'binance_api',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_symbol_interval_time`(`symbol` ASC, `time_interval` ASC, `start_time` ASC) USING BTREE,
  INDEX `idx_expires_at`(`expires_at` ASC) USING BTREE,
  INDEX `idx_cache_key`(`cache_key` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 81 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for kline_data
-- ----------------------------
DROP TABLE IF EXISTS `kline_data`;
CREATE TABLE `kline_data`  (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `interval_type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `open_time` timestamp NOT NULL,
  `close_time` timestamp NOT NULL,
  `open` decimal(20, 8) NOT NULL,
  `high` decimal(20, 8) NOT NULL,
  `low` decimal(20, 8) NOT NULL,
  `close` decimal(20, 8) NOT NULL,
  `volume` decimal(30, 8) NOT NULL,
  `trade_count` int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_symbol_interval_time`(`symbol` ASC, `interval_type` ASC, `open_time` ASC) USING BTREE,
  INDEX `idx_symbol_time`(`symbol` ASC, `open_time` ASC) USING BTREE,
  INDEX `idx_interval_time`(`interval_type` ASC, `open_time` ASC) USING BTREE,
  INDEX `idx_symbol_interval`(`symbol` ASC, `interval_type` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 14401 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for oi_anomaly_records
-- ----------------------------
DROP TABLE IF EXISTS `oi_anomaly_records`;
CREATE TABLE `oi_anomaly_records`  (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `period_seconds` int NOT NULL,
  `percent_change` decimal(10, 4) NOT NULL,
  `oi_before` decimal(30, 8) NOT NULL,
  `oi_after` decimal(30, 8) NOT NULL,
  `oi_change` decimal(30, 8) NOT NULL,
  `threshold_value` decimal(10, 4) NOT NULL,
  `anomaly_time` timestamp NOT NULL,
  `severity` enum('low','medium','high') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'medium',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_symbol_time`(`symbol` ASC, `anomaly_time` ASC) USING BTREE,
  INDEX `idx_period_time`(`period_seconds` ASC, `anomaly_time` ASC) USING BTREE,
  INDEX `idx_severity_time`(`severity` ASC, `anomaly_time` ASC) USING BTREE,
  INDEX `idx_change_rate`(`percent_change` ASC) USING BTREE,
  CONSTRAINT `oi_anomaly_records_ibfk_1` FOREIGN KEY (`symbol`) REFERENCES `contract_symbols_config` (`symbol`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for oi_monitoring_config
-- ----------------------------
DROP TABLE IF EXISTS `oi_monitoring_config`;
CREATE TABLE `oi_monitoring_config`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `config_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `config_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL,
  `is_active` tinyint(1) NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `config_key`(`config_key` ASC) USING BTREE,
  INDEX `idx_key_active`(`config_key` ASC, `is_active` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 6 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for open_interest_snapshots
-- ----------------------------
DROP TABLE IF EXISTS `open_interest_snapshots`;
CREATE TABLE `open_interest_snapshots`  (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `open_interest` decimal(30, 8) NOT NULL,
  `timestamp_ms` bigint NOT NULL,
  `snapshot_time` timestamp NOT NULL,
  `data_source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'binance_api',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_symbol_timestamp`(`symbol` ASC, `timestamp_ms` ASC) USING BTREE,
  INDEX `idx_symbol_time`(`symbol` ASC, `snapshot_time` ASC) USING BTREE,
  INDEX `idx_timestamp`(`timestamp_ms` ASC) USING BTREE,
  CONSTRAINT `open_interest_snapshots_ibfk_1` FOREIGN KEY (`symbol`) REFERENCES `contract_symbols_config` (`symbol`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for subscription_status
-- ----------------------------
DROP TABLE IF EXISTS `subscription_status`;
CREATE TABLE `subscription_status`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `stream_type` enum('ticker','kline','depth','trade') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('active','inactive','error') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'inactive',
  `last_update` timestamp NULL DEFAULT NULL,
  `error_count` int NULL DEFAULT 0,
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  `reconnect_attempts` int NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_symbol_stream`(`symbol` ASC, `stream_type` ASC) USING BTREE,
  INDEX `idx_status`(`status` ASC) USING BTREE,
  INDEX `idx_last_update`(`last_update` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 1 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for symbol_configs
-- ----------------------------
DROP TABLE IF EXISTS `symbol_configs`;
CREATE TABLE `symbol_configs`  (
  `id` int NOT NULL AUTO_INCREMENT,
  `symbol` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `base_asset` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `quote_asset` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled` tinyint(1) NULL DEFAULT 1,
  `priority` int NULL DEFAULT 50,
  `category` enum('major','alt','stable') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'alt',
  `exchange` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'binance',
  `min_price` decimal(20, 8) NULL DEFAULT 0.00000000,
  `min_qty` decimal(20, 8) NULL DEFAULT 0.00000000,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `symbol`(`symbol` ASC) USING BTREE,
  INDEX `idx_symbol`(`symbol` ASC) USING BTREE,
  INDEX `idx_enabled_priority`(`enabled` ASC, `priority` ASC) USING BTREE,
  INDEX `idx_category`(`category` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 41 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = Dynamic;

SET FOREIGN_KEY_CHECKS = 1;



-- 插入默认配置
INSERT INTO oi_monitoring_config (config_key, config_value, description) VALUES
('polling_interval_ms', '60000', 'OI数据轮询间隔(毫秒)'),
('max_concurrent_requests', '50', '最大并发请求数'),
('thresholds', '{"60":3,"120":3,"300":3,"900":10}', '各时间周期异动阈值(%)'),
('symbol_refresh_interval_ms', '7200000', '币种列表刷新间隔(毫秒)'),
('off_hours_config', '{"start":0,"end":7,"interval_ms":900000}', '非交易时段配置');