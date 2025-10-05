# 智能加密货币交易后端系统 - Claude 开发指南

## 📋 项目概述

基于Node.js的智能加密货币交易后端系统，专注于实时数据处理、技术分析、交易规则引擎、风险管理和信号生成。

## 🛠️ 技术栈

- **Node.js** + **TypeScript** - 核心开发语言
- **Express.js** - REST API框架
- **WebSocket** - 币安U本位合约实时数据流
- **MySQL** - K线数据多表存储、配置和规则数据
- **Redis** - 缓存和消息队列
- **币安API** - U本位合约数据源

## 🏗️ 系统架构

```
数据输入层 → 数据处理核心 → 技术分析引擎 → 交易规则引擎 → 信号处理中心 → 风险控制系统
```

## 🎯 核心模块

### 1. 数据处理核心 (`src/core/data`)
- **subscription_pool.ts** - 统一WebSocket连接池管理
- **multi_symbol_manager.ts** - 多币种同时订阅管理
- **stream_dispatcher.ts** - 实时数据流分发器
- **data_validator.ts** - 数据验证和清洗
- **symbol_config_manager.ts** - 币种配置和订阅管理
- **historical_data_manager.ts** - 历史数据按需获取
- **rest_api_manager.ts** - 币安REST API管理器
- **cache_manager.ts** - Redis缓存策略

### 2. 技术分析引擎 (`src/analysis`)
- **technical_analysis.ts** - 技术指标计算(MA/RSI/MACD等)
- **pattern_recognition.ts** - 图表形态识别
- **support_resistance.ts** - 关键支撑阻力位

### 3. 交易规则引擎 (`src/rules`) ⭐ **核心特性**
- **rule_engine.ts** - 规则调度引擎
- **rule_compiler.ts** - DSL规则编译器
- **rule_executor.ts** - 实时规则执行
- **rule_templates.ts** - 预设策略模板

### 4. 规则管理 (`src/rules_management`)
- **rule_backtester.ts** - 历史回测
- **rule_version_control.ts** - 版本管理
- **rule_performance_monitor.ts** - 性能监控

### 5. 信号处理 (`src/signals`)
- **signal_generator.ts** - 交易信号生成
- **signal_filter.ts** - 信号过滤优化
- **signal_scorer.ts** - 信号强度评分

### 6. 风险控制 (`src/risk`)
- **risk_manager.ts** - 风险评估控制
- **position_sizer.ts** - 智能仓位管理
- **stop_loss_manager.ts** - 止损止盈

### 7. 系统监控 (`src/core/monitoring`) ⭐ **新增核心模块**
- **monitoring_manager.ts** - 监控服务总控制器
- **metrics_collector.ts** - 系统指标收集器
- **health_checker.ts** - 系统健康状态检查
- **monitoring_types.ts** - 监控相关类型定义

## 📁 项目结构

```
src/
├── core/
│   ├── data/                # 数据处理(WebSocket、历史数据)
│   ├── cache/               # Redis缓存管理
│   ├── config/              # 配置管理(统一配置、TOP币种)
│   ├── oi/                  # OI持仓量监控
│   └── monitoring/          # 系统监控(健康检查、指标收集)
├── api/                     # REST接口(49个API)
│   └── routes/              # K线、WebSocket、TOP币种、历史数据、OI、监控
├── database/                # 数据库层(多表Repository、OI数据)
├── utils/                   # 工具函数
└── types/                   # TypeScript类型定义
```

## 🔧 规则引擎核心设计

```typescript
interface TradingRule {
  id: string;
  name: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  timeframe: string;
  enabled: boolean;
}

enum RuleType {
  BREAKOUT = 'breakout',      // 突破策略
  MA_CROSS = 'ma_cross',      // 均线交叉
  PATTERN = 'pattern',        // 形态识别
  CUSTOM = 'custom'           // 自定义
}
```

## 📝 开发规范

### 命名约定 (snake_case)
```typescript
// 文件和变量
const market_data = await get_market_data();
function calculate_rsi(prices: number[]): number {}

// 类和接口保持PascalCase
class DataManager {}
interface TradingRule {}

// 常量
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_TIMEFRAME = '1m';

// 功能模块封装
// 注意功能模块封装，减少代码冗余
// 接口请求统一封装到 src/api
// 数据库操作统一封装到 src/database

//注释
//每个方法或函数都加上简介注释
```

## 💡 核心要求

1. **类型安全** - 全面TypeScript类型定义
2. **实时处理** - 毫秒级数据处理延迟
3. **规则引擎** - 核心竞争力，重点关注
4. **错误处理** - 完整异常捕获机制
5. **测试覆盖** - 关键模块单元测试
6. **代码规范** - ESLint + Prettier统一风格
7. **命名统一** - 采用snake_case命名规则

## 🔍 关键实现点

- **数据源** - 币安U本位合约WebSocket实时流 (`wss://fstream.binance.com/ws`)
- **多表存储** - K线数据按周期分表存储 (`kline_1m`/`kline_5m`/`kline_15m`/`kline_1h`/`kline_4h`/`kline_1d`)
- **数据去重** - UNIQUE约束 + INSERT IGNORE防重复写入
- **查询降级** - Redis缓存 → MySQL持久化 → 币安API兜底
- **缓存策略** - 24小时Redis + 永久MySQL存储
- **TOP币种管理** - 动态配置、订阅流管理、排序控制
- **OI监控** - TOP10持仓量异动检测
- **监控体系** - 系统健康检查、性能指标、告警机制
- **配置管理** - 统一环境变量处理、配置中心

## 🗄️ 数据库设计

### MySQL 表结构设计

#### 1. 币种配置表 (symbol_configs)
```sql
CREATE TABLE symbol_configs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL UNIQUE,       -- BTCUSDT
  display_name VARCHAR(50) NOT NULL,        -- Bitcoin/USDT
  base_asset VARCHAR(10) NOT NULL,          -- BTC
  quote_asset VARCHAR(10) NOT NULL,         -- USDT
  enabled TINYINT(1) DEFAULT 1,             -- 是否启用订阅
  priority INT DEFAULT 50,                  -- 显示优先级 (1-100)
  category ENUM('major','alt','stable') DEFAULT 'alt',
  exchange VARCHAR(20) DEFAULT 'binance',
  min_price DECIMAL(20,8) DEFAULT 0,        -- 最小价格精度
  min_qty DECIMAL(20,8) DEFAULT 0,          -- 最小数量精度
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_symbol (symbol),
  INDEX idx_enabled_priority (enabled, priority),
  INDEX idx_category (category)
);
```

#### 2. 订阅状态表 (subscription_status)
```sql
CREATE TABLE subscription_status (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,                    -- BTCUSDT
  stream_type ENUM('ticker','kline','depth','trade') NOT NULL,
  status ENUM('active','inactive','error') DEFAULT 'inactive',
  last_update TIMESTAMP NULL,                     -- 最后数据更新时间
  error_count INT DEFAULT 0,                      -- 错误次数
  error_message TEXT NULL,                        -- 错误信息
  reconnect_attempts INT DEFAULT 0,               -- 重连次数
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_stream (symbol, stream_type),
  INDEX idx_status (status),
  INDEX idx_last_update (last_update),
  FOREIGN KEY (symbol) REFERENCES symbol_configs(symbol) ON DELETE CASCADE
);
```

#### 3. K线数据多表 (kline_1m / kline_5m / kline_15m / kline_1h / kline_4h / kline_1d) ⭐ **核心**
```sql
-- 按时间周期分表存储，以kline_1m为例
CREATE TABLE kline_1m (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,                        -- BTCUSDT
  open_time BIGINT NOT NULL,                          -- K线开始时间(ms)
  close_time BIGINT NOT NULL,                         -- K线结束时间(ms)
  open DECIMAL(20,8) NOT NULL,                        -- 开盘价
  high DECIMAL(20,8) NOT NULL,                        -- 最高价
  low DECIMAL(20,8) NOT NULL,                         -- 最低价
  close DECIMAL(20,8) NOT NULL,                       -- 收盘价
  volume DECIMAL(30,8) NOT NULL,                      -- 成交量
  trade_count INT NOT NULL,                           -- 成交笔数
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_time (symbol, open_time),
  INDEX idx_open_time (open_time),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 其他周期表: kline_5m, kline_15m, kline_1h, kline_4h, kline_1d 结构相同
```

#### 4. TOP币种配置表 (top_symbols)
```sql
CREATE TABLE top_symbols (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL UNIQUE,                -- BTCUSDT
  display_name VARCHAR(100) NOT NULL,                -- Bitcoin
  rank_order INT NOT NULL,                           -- 排序(1-10)
  enabled TINYINT(1) DEFAULT 1,                      -- 是否启用
  subscription_intervals JSON,                       -- 订阅周期 ["15m","1h"]
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_rank (rank_order),
  INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 5. OI持仓量数据表 (oi_snapshots / oi_anomalies)
```sql
-- OI快照表
CREATE TABLE oi_snapshots (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  oi_value DECIMAL(30,8) NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  UNIQUE KEY uk_symbol_time (symbol, timestamp)
);

-- OI异动表
CREATE TABLE oi_anomalies (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  period_seconds INT NOT NULL,
  percent_change DECIMAL(10,4) NOT NULL,
  severity ENUM('low','medium','high'),
  anomaly_time TIMESTAMP NOT NULL
);
```


## 📊 **K线数据存储架构** ⭐ **核心特性**

### **数据流转路径**
```
币安API/WebSocket → 数据验证 → [Redis缓存 + MySQL存储] → 应用层
                    ↓
              查询降级策略: Redis → MySQL → API兜底
```

### **存储触发机制**
1. **历史数据获取时** - API调用后自动存储
2. **实时数据接收时** - WebSocket完整K线 (`is_final: true`) 自动存储
3. **异步存储** - 不阻塞主数据流，保证实时性能

### **数据去重保证**
- **数据库层**: `UNIQUE KEY (symbol, interval_type, open_time)`
- **应用层**: `INSERT IGNORE` 语句防重复插入
- **查询优化**: 复合索引加速检索

### Redis 缓存结构设计

```typescript
// K线历史数据缓存 (24小时过期)
"historical:BTCUSDT:1m:start_TIME:end_TIME:limit_COUNT" => [{kline_data}, ...]

// 实时行情缓存
"market:ticker:BTCUSDT" => {price, volume, change, timestamp}

// 订阅配置缓存
"config:symbols:active" => ["BTCUSDT", "ETHUSDT", ...]

// 连接状态缓存
"status:websocket:binance" => {connected, last_ping, error_count}

// 监控数据缓存 ⭐ 新增
"monitoring:metrics:latest" => {timestamp, uptime, memory, cpu, database, api...}
"monitoring:health:latest" => {overall_status, checks[], uptime, timestamp}
"monitoring:alert:ALERT_ID" => {id, type, severity, message, timestamp...}
```

### **核心组件职责**
| 组件 | 文件位置 | 主要职责 |
|------|----------|----------|
| **KlineMultiTableRepository** | `src/database/kline_multi_table_repository.ts` | K线多表存储、批量插入、查询优化 |
| **HistoricalDataManager** | `src/core/data/historical_data_manager.ts` | 历史数据缓存、API调用、存储协调 |
| **MultiSymbolManager** | `src/core/data/multi_symbol_manager.ts` | WebSocket管理、实时数据接收存储 |
| **SubscriptionPool** | `src/core/data/subscription_pool.ts` | WebSocket连接池、订阅管理、重连机制 |
| **TopSymbolsManager** | `src/core/config/top_symbols_manager.ts` | TOP币种配置管理、订阅流生成 |
| **OIManager** | `src/core/oi/oi_manager.ts` | OI持仓量监控、异动检测 |
| **MonitoringManager** | `src/core/monitoring/monitoring_manager.ts` | 系统监控、健康检查、告警 |

## 🎯 **系统监控架构** ⭐ **核心特性**

### **监控数据流程**
```
指标收集器 → 数据验证 → [Redis存储] → API接口 → 前端展示
     ↓              ↓
健康检查器 → 告警检测 → 告警通知
```

### **监控功能特性**
1. **实时指标收集** - 10分钟间隔收集系统、数据库、API性能指标
2. **健康状态检查** - 60秒间隔检查各服务连接状态和响应时间
3. **智能告警机制** - 基于阈值的自动告警，支持warning/critical级别
4. **性能数据持久化** - Redis存储24小时监控数据
5. **RESTful监控API** - 10个完整的监控数据查询接口

### **监控API端点**
```typescript
// 系统健康检查
GET /api/monitoring/health              // 完整系统健康状态
GET /api/monitoring/health/:service     // 特定服务健康状态

// 系统指标查询
GET /api/monitoring/metrics             // 系统性能指标
GET /api/monitoring/metrics/latest      // 最新指标数据

// 告警管理
GET /api/monitoring/alerts              // 活跃告警列表
GET /api/monitoring/alerts/history      // 告警历史记录

// 监控服务管理
GET /api/monitoring/status              // 监控服务状态
GET /api/monitoring/stats               // 性能统计摘要
GET /api/monitoring/stats/summary       // 统计数据摘要
```

### **配置管理架构**
```typescript
// 配置类型定义
interface AppConfig {
  database: DatabaseConfig;    // MySQL + Redis配置
  binance: BinanceConfig;      // 币安API配置
  server: ServerConfig;        // 服务器配置
  cache: CacheConfig;          // 缓存配置
}

// 统一配置管理器
ConfigManager.getInstance()
  .get_database_config()     // 获取数据库配置
  .get_binance_config()      // 获取币安配置
  .get_server_config()       // 获取服务器配置
```

### **监控指标类型**
- **系统指标**: 内存使用率、CPU使用率、系统运行时间
- **数据库指标**: MySQL连接池状态、Redis连接状态和内存使用
- **API指标**: 请求数量、错误率、平均响应时间、活跃连接数
- **WebSocket指标**: 连接状态、订阅流数量、消息数量、重连次数
- **业务指标**: OI监控活跃币种、轮询间隔、最后更新时间

## 📡 API接口总览

系统提供49个RESTful API接口，详见 [API文档](docs/API_REFERENCE.md)

### 接口分类
- **K线数据** (8个) - 实时/历史K线查询、数据完整性检查、批量查询
- **WebSocket管理** (4个) - 连接状态、订阅流监控、手动重连
- **TOP币种配置** (10个) - 币种CRUD、排序管理、订阅流配置
- **历史数据** (5个) - 历史K线获取、缓存统计、预加载
- **OI数据** (10个) - 持仓量统计、异动检测、配置管理
- **系统监控** (10个) - 健康检查、性能指标、告警管理
- **基础信息** (2个) - API根路径、健康检查

### 核心接口示例
```typescript
// K线数据
GET  /api/klines/:symbol/:interval           // 获取K线数据
POST /api/klines/batch/latest                // 批量获取最新K线

// WebSocket管理
GET  /api/websocket/status                   // WebSocket连接状态
POST /api/websocket/reconnect                // 手动重连

// TOP币种配置
GET  /api/top-symbols/enabled                // 获取启用的币种
PUT  /api/top-symbols/:symbol/toggle         // 启用/禁用币种

// 系统监控
GET  /api/monitoring/health                  // 系统健康检查
GET  /api/monitoring/metrics/latest          // 最新性能指标
```

---

**目标**: 构建高性能、可扩展的加密货币数据处理后端系统，提供实时K线数据、OI监控、完善的监控体系，为量化交易提供稳定的数据支撑。