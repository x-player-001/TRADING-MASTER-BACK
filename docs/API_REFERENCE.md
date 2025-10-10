# Trading Master Backend - API接口文档

## 📋 概述

Trading Master Backend提供完整的RESTful API接口，支持K线数据查询、OI数据监控、WebSocket管理、TOP币种配置、历史数据获取、系统监控等功能。

**服务地址**: `http://localhost:3000`
**API版本**: `v2.0.0`
**数据格式**: `JSON`
**数据源**: 币安U本位合约市场

---

## 🔗 核心接口

### 1. 基础信息

#### API根路径
```http
GET /api
```

**响应示例**:
```json
{
  "message": "Trading Master Backend API",
  "version": "2.0.0",
  "endpoints": {
    "health": "/health",
    "klines": "/api/klines/*",
    "websocket": "/api/websocket/*",
    "signals": "/api/signals/*",
    "top_symbols": "/api/top-symbols/*",
    "historical": "/api/historical/*",
    "oi": "/api/oi/*",
    "monitoring": "/api/monitoring/*",
    "status": "/api/status"
  },
  "data_source": "Binance U-margined Futures",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### 健康检查
```http
GET /health
```

**响应示例**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "trading-master-backend"
}
```

---

## 📊 OI数据接口

### 1. OI统计数据
```http
GET /api/oi/statistics
```

**查询参数**:
- `symbol` (可选): 币种符号，如 `BTCUSDT`
- `date` (可选): 查询日期，格式 `YYYY-MM-DD`，如 `2024-01-15`。不传则返回最近24小时数据

**日期参数说明**:
- 传入 `date` 参数时，返回该日期当天 00:00:00 到 23:59:59 的数据
- 不传 `date` 参数时，返回最近24小时的数据
- 日期格式必须为 `YYYY-MM-DD`

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC",
      "latest_oi": 1234567890.50,
      "daily_change_pct": 2.5,
      "anomaly_count_24h": 3,
      "last_anomaly_time": "2024-01-15T10:25:00.000Z",
      "first_anomaly_time": "2024-01-15T08:15:00.000Z",
      "avg_oi_24h": 1200000000.00
    },
    {
      "symbol": "ETH",
      "latest_oi": 987654321.25,
      "daily_change_pct": -1.2,
      "anomaly_count_24h": 1,
      "last_anomaly_time": "2024-01-15T09:30:00.000Z",
      "first_anomaly_time": "2024-01-15T09:30:00.000Z",
      "avg_oi_24h": 950000000.00
    }
  ],
  "params": {
    "symbol": null,
    "date": "2024-01-15"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. OI快照数据
```http
GET /api/oi/snapshots
```

**查询参数**:
- `symbol` (可选): 币种符号，如 `BTCUSDT`
- `start_time` (可选): 开始时间
- `end_time` (可选): 结束时间
- `order` (可选): 排序方式，`ASC` 或 `DESC`，默认 `DESC`

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC",
      "oi_value": 1234567890.50,
      "timestamp": "2024-01-15T10:29:00.000Z"
    }
  ],
  "count": 100,
  "params": {
    "order": "DESC"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 3. 异动记录
```http
GET /api/oi/anomalies
```

**查询参数**:
- `symbol` (可选): 币种符号，如 `BTCUSDT`
- `period_seconds` (可选): 监控周期(秒)
- `severity` (可选): 严重级别，`low`/`medium`/`high`
- `start_time` (可选): 开始时间
- `end_time` (可选): 结束时间
- `order` (可选): 排序方式，默认 `DESC`

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC",
      "period_seconds": 1800,
      "percent_change": 15.5,
      "oi_before": 1000000000,
      "oi_after": 1155000000,
      "oi_change": 155000000,
      "severity": "medium",
      "anomaly_time": "2024-01-15T10:25:00.000Z",
      "threshold_value": 10.0
    }
  ],
  "count": 5,
  "params": {
    "order": "DESC"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 4. 最近异常数据
```http
GET /api/oi/recent-anomalies
```

**查询参数**:
- `symbol` (可选): 币种符号，如 `BTCUSDT`
- `date` (可选): 查询日期，格式 `YYYY-MM-DD`，如 `2024-01-15`。不传则返回最近数据
- `severity` (可选): 异动严重级别，`low`/`medium`/`high`

**日期参数说明**:
- 传入 `date` 参数时，返回该日期当天 00:00:00 到 23:59:59 的异动记录
- 不传 `date` 参数时，返回最近的异动记录
- 日期格式必须为 `YYYY-MM-DD`

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC",
      "period_minutes": 30,
      "percent_change": 15.5,
      "oi_before": 1000000000,
      "oi_after": 1155000000,
      "oi_change": 155000000,
      "severity": "medium",
      "anomaly_time": "2024-01-15T10:25:00.000Z",
      "threshold_value": 10.0
    }
  ],
  "count": 1,
  "params": {
    "symbol": null,
    "date": "2024-01-15",
    "severity": null
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 5. 启用币种列表
```http
GET /api/oi/symbols
```

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "base_asset": "BTC",
      "quote_asset": "USDT",
      "contract_type": "PERPETUAL",
      "status": "TRADING",
      "enabled": true,
      "priority": 90
    },
    {
      "id": 2,
      "symbol": "ETHUSDT",
      "base_asset": "ETH",
      "quote_asset": "USDT",
      "contract_type": "PERPETUAL",
      "status": "TRADING",
      "enabled": true,
      "priority": 85
    }
  ],
  "count": 2,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 6. OI服务状态
```http
GET /api/oi/status
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "is_running": true,
    "active_symbols_count": 45,
    "uptime_ms": 3600000,
    "last_poll_time": "2024-01-15T10:29:30.000Z",
    "config": {
      "polling_interval_ms": 30000,
      "enabled_symbols": ["BTC", "ETH"]
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 7. 触发手动轮询
```http
POST /api/oi/trigger-poll
```

**响应示例**:
```json
{
  "success": true,
  "message": "Manual poll triggered successfully",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 8. 获取监控配置
```http
GET /api/oi/config
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "polling_interval_ms": 30000,
    "enabled_symbols": ["BTC", "ETH"],
    "anomaly_thresholds": {
      "30min": 10.0,
      "1hour": 15.0
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 9. 更新监控配置
```http
PUT /api/oi/config/:key
```

**请求体**:
```json
{
  "value": 45000
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Config polling_interval_ms updated successfully",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 10. 系统状态 (废弃，请使用监控接口)
```http
GET /api/status
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "polling_service_status": {
      "is_running": true,
      "active_symbols_count": 45,
      "uptime_ms": 3600000,
      "last_poll_time": "2024-01-15T10:29:30.000Z"
    },
    "data_status": {
      "total_records": 12345,
      "last_update": "2024-01-15T10:29:30.000Z"
    }
  }
}
```

### 11. 获取黑名单 ⭐ 新增
```http
GET /api/oi/blacklist
```

**功能描述**: 获取OI监控的币种黑名单列表

**响应示例**:
```json
{
  "success": true,
  "data": {
    "blacklist": ["USDC", "BUSD"],
    "count": 2
  }
}
```

### 12. 添加币种到黑名单 ⭐ 新增
```http
POST /api/oi/blacklist
```

**功能描述**: 将指定币种添加到黑名单，该币种将不再被OI监控

**请求体**:
```json
{
  "symbol": "USDC"
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Added USDC to blacklist",
  "data": {
    "blacklist": ["USDC"],
    "count": 1
  }
}
```

### 13. 从黑名单移除币种 ⭐ 新增
```http
DELETE /api/oi/blacklist/:symbol
```

**功能描述**: 从黑名单中移除指定币种，该币种将恢复OI监控

**路径参数**:
- `symbol`: 币种关键词，如 `USDC`

**响应示例**:
```json
{
  "success": true,
  "message": "Removed USDC from blacklist",
  "data": {
    "blacklist": [],
    "count": 0
  }
}
```

---

## 🔍 系统监控接口

### 1. 系统健康检查

#### 完整健康状态
```http
GET /api/monitoring/health
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "overall_status": "healthy",
    "checks": [
      {
        "service": "MySQL数据库",
        "status": "healthy",
        "message": "连接正常",
        "response_time": 25,
        "last_check": "2024-01-15T10:30:00.000Z",
        "details": {
          "host": "localhost",
          "database": "trading_master"
        }
      },
      {
        "service": "Redis缓存",
        "status": "healthy",
        "message": "连接正常",
        "response_time": 5,
        "last_check": "2024-01-15T10:30:00.000Z"
      }
    ],
    "uptime": 150,
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

#### 特定服务健康状态
```http
GET /api/monitoring/health/:service
```

**路径参数**:
- `service`: 服务名称 (`mysql`, `redis`, `binance`, `memory`, `disk`)

### 2. 系统指标查询

#### 最新系统指标
```http
GET /api/monitoring/metrics/latest
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "timestamp": "2024-01-15T10:30:00.000Z",
    "uptime": 3600000,
    "memory": {
      "used": 536870912,
      "total": 8589934592,
      "free": 8053063680,
      "usage_percentage": 6
    },
    "cpu": {
      "usage_percentage": 15,
      "load_average": [0.5, 0.7, 0.8]
    },
    "database": {
      "mysql": {
        "active_connections": 3,
        "max_connections": 10,
        "connection_usage_percentage": 30,
        "query_count": 150,
        "avg_query_time": 25
      },
      "redis": {
        "connected": true,
        "memory_used": 52428800,
        "key_count": 1250,
        "hit_rate": 95
      }
    },
    "api": {
      "request_count": 850,
      "error_count": 5,
      "avg_response_time": 120,
      "active_connections": 8
    },
    "websocket": {
      "connected": false,
      "subscribed_streams": 0,
      "message_count": 0,
      "reconnect_count": 0
    },
    "oi_monitoring": {
      "active_symbols": 0,
      "polling_interval_ms": 30000,
      "last_update": null,
      "error_count": 0,
      "is_running": false
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### 历史指标数据
```http
GET /api/monitoring/metrics
```

**查询参数**:
- `limit` (可选): 返回数据条数，默认10
- `hours` (可选): 查询时间范围(小时)，默认1

**响应示例**:
```json
{
  "success": true,
  "data": {
    "latest": "最新指标数据对象",
    "query": {
      "limit": 10,
      "hours": 1,
      "note": "历史数据查询功能待实现"
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}

### 3. 告警管理

#### 活跃告警列表
```http
GET /api/monitoring/alerts
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "alerts": [
      {
        "id": "memory_1642247400000",
        "type": "memory",
        "severity": "warning",
        "message": "内存使用率过高: 85%",
        "value": 85,
        "threshold": 80,
        "timestamp": "2024-01-15T10:30:00.000Z",
        "resolved": false
      }
    ],
    "count": 1,
    "critical_count": 0,
    "warning_count": 1
  }
}
```

#### 告警历史记录
```http
GET /api/monitoring/alerts/history
```

**查询参数**:
- `hours` (可选): 查询时间范围(小时)，默认24
- `limit` (可选): 返回数据条数，默认50

### 4. 性能统计

#### 性能统计摘要
```http
GET /api/monitoring/stats
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "system": {
      "uptime": 3600000,
      "memory_usage": 6,
      "cpu_usage": 15
    },
    "database": {
      "mysql_connections": 30,
      "redis_connected": true,
      "redis_memory_mb": 50
    },
    "api": {
      "total_requests": 850,
      "error_rate": 1,
      "avg_response_time": 120
    },
    "websocket": {
      "connected": false,
      "streams": 0,
      "messages": 0
    },
    "health": {
      "overall_status": "healthy",
      "healthy_services": 5,
      "total_services": 5
    }
  }
}
```

#### 统计数据摘要
```http
GET /api/monitoring/stats/summary
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "system_status": "healthy",
    "monitoring_active": true,
    "active_alerts": 1,
    "critical_alerts": 0,
    "uptime_hours": 1,
    "memory_usage": 6,
    "api_requests": 850,
    "last_update": "2024-01-15T10:30:00.000Z"
  }
}
```

### 5. 监控服务状态
```http
GET /api/monitoring/status
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "is_running": true,
    "uptime": 3600000,
    "latest_collection": "2024-01-15T10:30:00.000Z",
    "latest_health_check": "2024-01-15T10:30:00.000Z",
    "active_alerts_count": 1,
    "config": {
      "collection_interval": 30000,
      "health_check_interval": 60000,
      "metrics_retention_hours": 24,
      "alert_thresholds": {
        "memory_usage": 80,
        "cpu_usage": 75,
        "mysql_connection_usage": 90,
        "api_response_time": 1000,
        "redis_memory_mb": 500
      }
    }
  }
}
```

---

## 📈 K线数据接口

### 1. 获取K线数据
```http
GET /api/klines/:symbol/:interval
```

**路径参数**:
- `symbol`: 币种符号，如 `BTCUSDT`
- `interval`: 时间周期，如 `1m`, `5m`, `15m`, `1h`, `4h`, `1d`

**查询参数**:
- `limit` (可选): 返回数据条数，默认300，最大1000
- `start_time` (可选): 开始时间戳(毫秒)
- `end_time` (可选): 结束时间戳(毫秒)

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "count": 300,
    "storage_type": "multi_table",
    "klines": [
      {
        "open_time": 1642247400000,
        "close_time": 1642247459999,
        "open": "45000.50",
        "high": "45100.00",
        "low": "44950.00",
        "close": "45080.00",
        "volume": "123.45",
        "trade_count": 856
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 2. 获取最新K线数据
```http
GET /api/klines/:symbol/:interval/latest
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `limit` (可选): 返回数据条数，默认100，最大500

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "count": 100,
    "klines": [...]
  },
  "timestamp": 1642247460000
}
```

### 3. 按时间范围查询K线数据
```http
GET /api/klines/:symbol/:interval/range
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `start_time` (必填): 开始时间戳(毫秒)
- `end_time` (必填): 结束时间戳(毫秒)
- `limit` (可选): 返回数据条数，默认1000，最大2000

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "start_time": 1642240000000,
    "end_time": 1642247400000,
    "count": 123,
    "klines": [...]
  },
  "timestamp": 1642247460000
}
```

### 4. 获取K线数据统计信息
```http
GET /api/klines/:symbol/statistics
```

**路径参数**:
- `symbol`: 币种符号

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "storage": {
      "1m": {
        "count": 43200,
        "oldest": "2024-01-01T00:00:00.000Z",
        "newest": "2024-01-15T10:30:00.000Z"
      },
      "5m": {
        "count": 8640,
        "oldest": "2024-01-01T00:00:00.000Z",
        "newest": "2024-01-15T10:25:00.000Z"
      }
    },
    "supported_intervals": ["1m", "5m", "15m", "1h", "4h", "1d"]
  },
  "timestamp": 1642247460000
}
```

### 5. 检查数据完整性
```http
GET /api/klines/:symbol/:interval/integrity
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `days` (可选): 检查天数，默认1，最大30

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "days_checked": 1,
    "expected_count": 1440,
    "actual_count": 1438,
    "missing_count": 2,
    "completeness": 99.86,
    "missing_ranges": [
      {
        "start": 1642240000000,
        "end": 1642240120000
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 6. 获取支持的时间周期列表
```http
GET /api/klines/config/intervals
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "supported_intervals": ["1m", "5m", "15m", "1h", "4h", "1d"]
  },
  "timestamp": 1642247460000
}
```

### 7. 获取TOP币种的K线数据概览
```http
GET /api/klines/overview/top-symbols
```

**查询参数**:
- `interval` (可选): 时间周期，默认 `1m`
- `limit` (可选): 返回币种数量，默认10

**响应示例**:
```json
{
  "success": true,
  "data": {
    "interval": "1m",
    "overview": [
      {
        "symbol": "BTCUSDT",
        "display_name": "Bitcoin",
        "rank_order": 1,
        "latest_kline": {
          "open_time": 1642247400000,
          "open": "45000.50",
          "high": "45100.00",
          "low": "44950.00",
          "close": "45080.00",
          "volume": "123.45"
        },
        "has_data": true
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 8. 批量获取多个币种的最新K线
```http
POST /api/klines/batch/latest
```

**请求体**:
```json
{
  "symbols": ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  "interval": "1m",
  "limit": 1
}
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "interval": "1m",
    "requested_symbols": 3,
    "results": [
      {
        "symbol": "BTCUSDT",
        "success": true,
        "count": 1,
        "klines": [...]
      },
      {
        "symbol": "ETHUSDT",
        "success": true,
        "count": 1,
        "klines": [...]
      }
    ]
  },
  "timestamp": 1642247460000
}
```

---

## 🔌 WebSocket管理接口

### 1. 获取WebSocket连接状态
```http
GET /api/websocket/status
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "connected": true,
    "reconnect_attempts": 0,
    "total_streams": 45,
    "timestamp": 1642247460000
  }
}
```

### 2. 获取订阅的数据流列表
```http
GET /api/websocket/streams
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "total_count": 45,
    "streams": [
      "btcusdt@kline_1m",
      "btcusdt@kline_5m",
      "ethusdt@kline_1m"
    ],
    "grouped": {
      "kline": ["btcusdt@kline_1m", "btcusdt@kline_5m"],
      "ticker": [],
      "depth": [],
      "trade": []
    },
    "timestamp": 1642247460000
  }
}
```

### 3. 获取详细的订阅信息
```http
GET /api/websocket/subscriptions
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "connection": {
      "connected": true,
      "reconnect_attempts": 0
    },
    "statistics": {
      "total_streams": 45,
      "kline_streams": 40,
      "ticker_streams": 0,
      "depth_streams": 0,
      "trade_streams": 0
    },
    "streams_by_type": {
      "kline": ["btcusdt@kline_1m", "btcusdt@kline_5m"],
      "ticker": [],
      "depth": [],
      "trade": []
    },
    "timestamp": 1642247460000
  }
}
```

### 4. 重新连接WebSocket
```http
POST /api/websocket/reconnect
```

**响应示例**:
```json
{
  "success": true,
  "message": "WebSocket reconnection initiated",
  "timestamp": 1642247460000
}
```

---

## 🏆 TOP币种配置接口

### 1. 获取所有TOP币种配置
```http
GET /api/top-symbols/
```

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "display_name": "Bitcoin",
      "rank_order": 1,
      "enabled": true,
      "subscription_intervals": ["15m", "1h"],
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "count": 10,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. 获取启用的TOP币种配置
```http
GET /api/top-symbols/enabled
```

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "display_name": "Bitcoin",
      "rank_order": 1,
      "enabled": true,
      "subscription_intervals": ["15m", "1h"]
    }
  ],
  "count": 8,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 3. 获取单个币种配置
```http
GET /api/top-symbols/:symbol
```

**路径参数**:
- `symbol`: 币种符号，如 `BTCUSDT`

**响应示例**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "symbol": "BTCUSDT",
    "display_name": "Bitcoin",
    "rank_order": 1,
    "enabled": true,
    "subscription_intervals": ["15m", "1h"],
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 4. 创建币种配置
```http
POST /api/top-symbols/
```

**请求体**:
```json
{
  "symbol": "BTCUSDT",
  "display_name": "Bitcoin",
  "rank_order": 1,
  "enabled": true,
  "subscription_intervals": ["15m", "1h"]
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Created TOP symbol: BTCUSDT",
  "data": {
    "id": 1,
    "symbol": "BTCUSDT"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 5. 更新币种配置
```http
PUT /api/top-symbols/:symbol
```

**路径参数**:
- `symbol`: 币种符号

**请求体**:
```json
{
  "display_name": "Bitcoin (Updated)",
  "rank_order": 2,
  "subscription_intervals": ["1m", "5m", "1h"]
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Updated TOP symbol: BTCUSDT",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 6. 删除币种配置
```http
DELETE /api/top-symbols/:symbol
```

**路径参数**:
- `symbol`: 币种符号

**响应示例**:
```json
{
  "success": true,
  "message": "Deleted TOP symbol: BTCUSDT",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 7. 批量更新排序
```http
PUT /api/top-symbols/batch/order
```

**请求体**:
```json
[
  { "symbol": "BTCUSDT", "rank_order": 1 },
  { "symbol": "ETHUSDT", "rank_order": 2 },
  { "symbol": "BNBUSDT", "rank_order": 3 }
]
```

**响应示例**:
```json
{
  "success": true,
  "message": "Updated 3 symbols order",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 8. 启用/禁用币种
```http
PUT /api/top-symbols/:symbol/toggle
```

**路径参数**:
- `symbol`: 币种符号

**请求体**:
```json
{
  "enabled": false
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Disabled TOP symbol: BTCUSDT",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 9. 获取订阅流配置
```http
GET /api/top-symbols/subscription/streams
```

**响应示例**:
```json
{
  "success": true,
  "data": [
    "btcusdt@kline_15m",
    "btcusdt@kline_1h",
    "ethusdt@kline_15m",
    "ethusdt@kline_1h"
  ],
  "count": 16,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 10. 获取统计信息
```http
GET /api/top-symbols/statistics
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "total_symbols": 10,
    "enabled_symbols": 8,
    "disabled_symbols": 2,
    "total_streams": 16,
    "intervals_used": ["15m", "1h"]
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## 📚 历史数据接口

### 1. 获取历史K线数据
```http
GET /api/historical/klines/:symbol
```

**路径参数**:
- `symbol`: 币种符号

**查询参数**:
- `interval` (可选): 时间周期，默认 `1m`
- `start_time` (可选): 开始时间戳(毫秒)
- `end_time` (可选): 结束时间戳(毫秒)
- `limit` (可选): 返回数据条数，默认300，最大1000

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "count": 300,
    "klines": [...]
  },
  "timestamp": 1642247460000
}
```

### 2. 获取最新K线数据
```http
GET /api/historical/klines/:symbol/latest
```

**路径参数**:
- `symbol`: 币种符号

**查询参数**:
- `interval` (可选): 时间周期，默认 `1m`
- `limit` (可选): 返回数据条数，默认100，最大500

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "count": 100,
    "klines": [...]
  },
  "timestamp": 1642247460000
}
```

### 3. 按时间范围获取K线数据
```http
GET /api/historical/klines/:symbol/range
```

**路径参数**:
- `symbol`: 币种符号

**查询参数**:
- `interval` (可选): 时间周期，默认 `1m`
- `start_time` (必填): 开始时间戳(毫秒)
- `end_time` (必填): 结束时间戳(毫秒)

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1m",
    "start_time": 1642240000000,
    "end_time": 1642247400000,
    "count": 123,
    "klines": [...]
  },
  "timestamp": 1642247460000
}
```

### 4. 预加载热门币种历史数据
```http
POST /api/historical/preload/popular
```

**响应示例**:
```json
{
  "success": true,
  "message": "Popular symbols data preloaded successfully",
  "timestamp": 1642247460000
}
```

### 5. 获取缓存统计信息
```http
GET /api/historical/cache/stats
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "total_cached_symbols": 10,
    "total_cached_intervals": 6,
    "cache_size_mb": 125.5,
    "hit_rate": 95.2,
    "symbols": [
      {
        "symbol": "BTCUSDT",
        "intervals": ["1m", "5m", "15m", "1h"],
        "total_records": 5000
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 6. 回溯补全历史K线数据 ⭐ **新增**
```http
POST /api/historical/backfill
```

**请求体**:
```json
{
  "symbol": "BTCUSDT",
  "interval": "15m",
  "batch_size": 1000
}
```

**参数说明**:
- `symbol` (必填): 币种符号，如 `BTCUSDT`
- `interval` (可选): 时间周期，默认 `15m`
  - 支持: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1mo`
- `batch_size` (可选): 每批拉取数量，默认1000，范围100-1000

**功能说明**:
- 🔄 **自动向前回溯**: 查询数据库最早K线时间，向前补充历史数据
- 💾 **增量存储**: 只拉取缺失的数据，自动去重
- 🎯 **无需返回K线**: 只返回拉取状态和统计信息，节省带宽
- 🔁 **可循环调用**: 每次调用向前补充一批数据，直到达到目标日期

**响应示例（初次加载）**:
```json
{
  "success": true,
  "mode": "initial_load",
  "fetched_count": 1000,
  "time_range": {
    "start": "2025-09-20T10:00:00.000Z",
    "end": "2025-10-08T14:45:00.000Z"
  },
  "database_status": {
    "earliest_before": null,
    "earliest_after": "2025-09-20T10:00:00.000Z",
    "total_records": 1000
  },
  "message": "初始加载1000根K线数据"
}
```

**响应示例（回溯补全）**:
```json
{
  "success": true,
  "mode": "backfill",
  "fetched_count": 1000,
  "time_range": {
    "start": "2025-09-15T04:00:00.000Z",
    "end": "2025-09-20T09:45:00.000Z"
  },
  "database_status": {
    "earliest_before": "2025-09-20T10:00:00.000Z",
    "earliest_after": "2025-09-15T04:00:00.000Z",
    "total_records": 2000
  },
  "message": "成功向前补全1000根K线数据"
}
```

**使用示例**:
```bash
# 第一次调用：拉取最新1000根K线
curl -X POST http://localhost:3000/api/historical/backfill \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","interval":"15m","batch_size":1000}'

# 第二次调用：从最早时间向前补充1000根
curl -X POST http://localhost:3000/api/historical/backfill \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","interval":"15m","batch_size":1000}'

# 循环调用直到补全到目标日期（如2025-01-01）
for i in {1..30}; do
  curl -X POST http://localhost:3000/api/historical/backfill \
    -H "Content-Type: application/json" \
    -d '{"symbol":"BTCUSDT","interval":"15m","batch_size":1000}'
  sleep 1
done
```

**典型应用场景**:
1. **准备回测数据**: 补全指定时间段的历史K线
2. **数据修复**: 补充缺失的历史数据段
3. **定期更新**: 定时向前回溯，保持数据库完整性

---

## 📡 交易信号接口

### 1. 获取最新信号
```http
GET /api/signals/:symbol/:interval/latest
```

**路径参数**:
- `symbol`: 币种符号，如 `BTCUSDT`
- `interval`: 时间周期，如 `1m`, `5m`, `15m`, `1h`, `4h`, `1d`

**查询参数**:
- `limit` (可选): 返回信号数量，默认1，最大50

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "count": 1,
    "signals": [
      {
        "id": 123,
        "symbol": "BTCUSDT",
        "interval": "15m",
        "signal_type": "BUY",
        "strength": 75,
        "price": 45000.50,
        "indicators": {
          "ma_cross": {
            "type": "golden",
            "fast_ma": 45020.5,
            "slow_ma": 44980.2
          },
          "rsi": {
            "value": 28.5,
            "status": "oversold"
          },
          "macd": {
            "macd": 12.5,
            "signal": 10.2,
            "histogram": 2.3,
            "cross": "bullish"
          },
          "pattern": "bullish_engulfing"
        },
        "description": "MA金叉 + RSI超卖(28.50) + MACD多头 + 看涨吞没形态",
        "timestamp": 1642247400000,
        "created_at": "2024-01-15T10:30:00.000Z"
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 2. 获取历史信号
```http
GET /api/signals/:symbol/:interval/history
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `start_time` (可选): 开始时间戳(毫秒)
- `end_time` (可选): 结束时间戳(毫秒)
- `limit` (可选): 返回数量，默认50，最大200

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "count": 10,
    "signals": [
      {
        "id": 123,
        "symbol": "BTCUSDT",
        "interval": "15m",
        "signal_type": "BUY",
        "strength": 75,
        "price": 45000.50,
        "indicators": {...},
        "description": "MA金叉 + RSI超卖 + MACD多头",
        "timestamp": 1642247400000,
        "created_at": "2024-01-15T10:30:00.000Z"
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 3. 获取多币种信号概览
```http
GET /api/signals/overview/:interval
```

**路径参数**:
- `interval`: 时间周期

**查询参数**:
- `limit` (可选): 返回币种数量，默认10

**响应示例**:
```json
{
  "success": true,
  "data": {
    "interval": "15m",
    "count": 3,
    "signals": [
      {
        "symbol": "BTCUSDT",
        "signal_type": "BUY",
        "strength": 75,
        "price": 45000.50,
        "description": "MA金叉 + RSI超卖",
        "timestamp": 1642247400000
      },
      {
        "symbol": "ETHUSDT",
        "signal_type": "SELL",
        "strength": 68,
        "price": 2800.30,
        "description": "MA死叉 + RSI超买",
        "timestamp": 1642247340000
      }
    ]
  },
  "timestamp": 1642247460000
}
```

### 4. 手动生成信号（测试用）
```http
POST /api/signals/:symbol/:interval/generate
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `kline_count` (可选): K线数据数量，默认100，最大500（至少需要60根）

**响应示例（生成成功）**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "signal": {
      "id": 124,
      "symbol": "BTCUSDT",
      "interval": "15m",
      "signal_type": "BUY",
      "strength": 75,
      "price": 45000.50,
      "indicators": {
        "ma_cross": {
          "type": "golden",
          "fast_ma": 45020.5,
          "slow_ma": 44980.2
        },
        "rsi": {
          "value": 28.5,
          "status": "oversold"
        }
      },
      "description": "MA金叉 + RSI超卖(28.50)",
      "timestamp": 1642247400000
    },
    "message": "Signal generated and saved successfully"
  },
  "timestamp": 1642247460000
}
```

**响应示例（无信号）**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "signal": null,
    "message": "No signal generated (strength too weak or neutral)"
  },
  "timestamp": 1642247460000
}
```

### 5. 获取形态识别记录
```http
GET /api/signals/:symbol/:interval/patterns
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `limit` (可选): 返回数量，默认10，最大50

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "count": 3,
    "patterns": [
      {
        "id": 45,
        "symbol": "BTCUSDT",
        "interval": "15m",
        "pattern_type": "bullish_engulfing",
        "confidence": 0.8,
        "description": "看涨吞没形态",
        "detected_at": 1642247400000,
        "created_at": "2024-01-15T10:30:00.000Z"
      },
      {
        "id": 44,
        "symbol": "BTCUSDT",
        "interval": "15m",
        "pattern_type": "hammer",
        "confidence": 0.7,
        "description": "锤子线形态，可能反转信号",
        "detected_at": 1642246500000,
        "created_at": "2024-01-15T10:15:00.000Z"
      },
      {
        "id": 43,
        "symbol": "BTCUSDT",
        "interval": "15m",
        "pattern_type": "doji",
        "confidence": 0.6,
        "description": "十字星形态，市场犹豫",
        "detected_at": 1642245600000,
        "created_at": "2024-01-15T10:00:00.000Z"
      }
    ]
  },
  "timestamp": 1642247460000
}
```

**形态类型说明**:
- `hammer` - 锤子线（看涨反转）
- `shooting_star` - 射击之星（看跌反转）
- `bullish_engulfing` - 看涨吞没
- `bearish_engulfing` - 看跌吞没
- `doji` - 十字星（趋势不明）

---

## 🚨 错误响应格式

所有错误响应遵循统一格式：

```json
{
  "success": false,
  "error": "错误类型",
  "message": "详细错误信息",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**常见HTTP状态码**:
- `200` - 成功
- `400` - 请求参数错误
- `404` - 资源不存在
- `500` - 服务器内部错误

---

## 📝 使用说明

### 前端集成建议

#### 交易信号集成 ⭐ 新增
1. **信号监控**: 建议每30秒调用 `/api/signals/overview/:interval` 监控多币种信号
2. **历史回溯**: 使用 `/api/signals/:symbol/:interval/history` 查看历史信号准确率
3. **形态识别**: 调用 `/api/signals/:symbol/:interval/patterns` 获取K线形态,展示在图表上
4. **手动测试**: 开发阶段可用 `/api/signals/:symbol/:interval/generate` 测试信号生成
5. **信号强度**: 信号强度0-40为弱,41-70为中,71-100为强,建议只展示中强信号

#### K线数据集成 ⭐ 新增
1. **实时K线**: 建议每3-5秒调用 `/api/klines/:symbol/:interval/latest?limit=1` 获取最新K线
2. **历史K线**: 使用 `/api/klines/:symbol/:interval` 或 `/api/klines/:symbol/:interval/range` 获取历史数据
3. **批量查询**: 使用 `/api/klines/batch/latest` 一次获取多个币种最新K线
4. **数据完整性**: 定期调用 `/api/klines/:symbol/:interval/integrity` 检查数据质量
5. **TOP币种概览**: 使用 `/api/klines/overview/top-symbols` 展示主要币种行情

#### WebSocket管理集成 ⭐ 新增
1. **连接监控**: 建议每30秒调用 `/api/websocket/status` 监控连接状态
2. **订阅详情**: 使用 `/api/websocket/subscriptions` 查看当前订阅情况
3. **手动重连**: 连接异常时可调用 `/api/websocket/reconnect` 触发重连

#### TOP币种配置集成 ⭐ 新增
1. **币种列表**: 使用 `/api/top-symbols/enabled` 获取启用的币种列表
2. **配置管理**: 通过CRUD接口管理币种配置和排序
3. **订阅流**: 使用 `/api/top-symbols/subscription/streams` 查看当前订阅的数据流
4. **统计信息**: 调用 `/api/top-symbols/statistics` 查看币种配置统计

#### 历史数据集成 ⭐ 新增
1. **按需加载**: 使用 `/api/historical/klines/:symbol` 按需获取历史K线
2. **缓存统计**: 调用 `/api/historical/cache/stats` 查看缓存命中率
3. **预加载**: 首次加载时可调用 `/api/historical/preload/popular` 预热缓存

#### 监控系统集成
1. **健康检查轮询**: 建议每30秒调用 `/api/monitoring/health` 检查系统状态
2. **性能监控**: 建议每60秒调用 `/api/monitoring/metrics/latest` 获取最新指标
3. **告警监控**: 建议每30秒调用 `/api/monitoring/alerts` 检查新告警
4. **统计摘要**: 建议每5分钟调用 `/api/monitoring/stats/summary` 更新仪表板

#### OI数据集成
1. **OI统计**: 建议每分钟调用 `/api/oi/statistics` 获取最新OI数据
2. **异常监控**: 建议每30秒调用 `/api/oi/recent-anomalies` 检查新异常
3. **服务状态**: 建议每60秒调用 `/api/oi/status` 检查OI服务状态
4. **历史数据查询**: 使用日期参数查询特定时间范围的数据

### API调用示例

```javascript
// 获取系统健康状态
const healthResponse = await fetch('/api/monitoring/health');
const healthData = await healthResponse.json();

// 获取最新性能指标
const metricsResponse = await fetch('/api/monitoring/metrics/latest');
const metricsData = await metricsResponse.json();

// 获取活跃告警
const alertsResponse = await fetch('/api/monitoring/alerts');
const alertsData = await alertsResponse.json();

// 获取OI统计数据（默认最近24小时）
const oiStatsResponse = await fetch('/api/oi/statistics');
const oiStatsData = await oiStatsResponse.json();

// 获取特定币种的OI统计
const btcStatsResponse = await fetch('/api/oi/statistics?symbol=BTCUSDT');
const btcStatsData = await btcStatsResponse.json();

// 获取指定日期的OI统计
const dateStatsResponse = await fetch('/api/oi/statistics?date=2024-01-15');
const dateStatsData = await dateStatsResponse.json();

// 获取指定日期特定币种的OI统计
const btcDateStatsResponse = await fetch('/api/oi/statistics?symbol=BTCUSDT&date=2024-01-15');
const btcDateStatsData = await btcDateStatsResponse.json();

// 获取最近异常（默认50条）
const anomaliesResponse = await fetch('/api/oi/recent-anomalies');
const anomaliesData = await anomaliesResponse.json();

// 获取指定日期的异常记录
const dateAnomaliesResponse = await fetch('/api/oi/recent-anomalies?date=2024-01-15');
const dateAnomaliesData = await dateAnomaliesResponse.json();

// 获取指定日期、特定币种和严重级别的异常
const filteredAnomaliesResponse = await fetch('/api/oi/recent-anomalies?date=2024-01-15&symbol=BTCUSDT&severity=high&limit=20');
const filteredAnomaliesData = await filteredAnomaliesResponse.json();

// 错误处理示例
try {
  const response = await fetch('/api/monitoring/health');
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    console.error('API Error:', data.error, data.message);
  }
} catch (error) {
  console.error('Network Error:', error);
}
```

---

## 📊 结构形态检测接口 (7个) ⭐ 最新

### 1. 获取区间形态
```http
GET /api/structure/ranges/:symbol/:interval
```

**路径参数**:
- `symbol`: 币种符号 (如 BTCUSDT)
- `interval`: 时间周期 (5m/15m/1h/4h/1d)

**查询参数**:
- `limit` (可选): 返回数量，默认10
- `status` (可选): 状态过滤 ('forming' = 仅返回未突破的区间)

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "interval": "1h",
      "structure_type": "range",
      "key_levels": {
        "support": 45000.00,
        "resistance": 46000.00,
        "middle": 45500.00
      },
      "pattern_data": {
        "range_size": 1000.00,
        "range_percent": 2.22,
        "touch_count": 6,
        "support_touches": 3,
        "resistance_touches": 3,
        "duration_bars": 24,
        "avg_volume": 125.5
      },
      "breakout_status": "forming",
      "confidence": 0.85,
      "strength": 78,
      "first_touch_time": 1705320000000,
      "last_touch_time": 1705406400000,
      "created_at": "2025-10-07T12:00:00.000Z"
    }
  ],
  "count": 1
}
```

### 2. 获取突破信号
```http
GET /api/structure/breakouts/:symbol/:interval
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `limit` (可选): 返回数量，默认20

**响应示例**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "pattern_id": 1,
      "symbol": "BTCUSDT",
      "interval": "1h",
      "direction": "up",
      "breakout_price": 46120.00,
      "target_price": 47000.00,
      "stop_loss": 45800.00,
      "risk_reward_ratio": 2.75,
      "volume_surge": 1.85,
      "confirmation_bars": 2,
      "strength": 82,
      "result": null,
      "actual_exit_price": null,
      "breakout_time": 1705410000000,
      "created_at": "2025-10-07T13:30:00.000Z"
    }
  ],
  "count": 1
}
```

### 3. 获取信号统计
```http
GET /api/structure/statistics/:symbol/:interval
```

**路径参数**:
- `symbol`: 币种符号
- `interval`: 时间周期

**查询参数**:
- `days` (可选): 统计天数，默认30

**响应示例**:
```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "1h",
    "period_days": 30,
    "total_signals": 45,
    "completed_signals": 38,
    "pending_signals": 7,
    "win_count": 28,
    "loss_count": 10,
    "win_rate": 73.68,
    "avg_risk_reward": 2.15,
    "direction_stats": {
      "up": {
        "count": 22,
        "win_count": 16,
        "win_rate": 72.73
      },
      "down": {
        "count": 16,
        "win_count": 12,
        "win_rate": 75.00
      }
    }
  }
}
```

### 4. 更新信号结果
```http
POST /api/structure/update-signal-result/:signal_id
```

**路径参数**:
- `signal_id`: 信号ID

**请求体**:
```json
{
  "result": "hit_target",
  "actual_exit_price": 47050.00
}
```

**result 值**:
- `hit_target`: 达到目标价
- `hit_stop`: 触发止损
- `failed`: 信号失败

**响应示例**:
```json
{
  "success": true,
  "message": "Signal result updated"
}
```

### 5. 获取检测配置
```http
GET /api/structure/config
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "detection_interval": 10,
    "cache_ttl": 300000,
    "range_detection": {
      "lookback": 50,
      "min_duration": 15,
      "max_duration": 50,
      "min_touches": 4,
      "min_confidence": 0.5
    },
    "breakout_confirmation": {
      "price_threshold": 2.0,
      "volume_multiplier": 1.3,
      "confirmation_bars": 2,
      "min_strength": 70,
      "min_risk_reward": 1.5
    },
    "monitored_intervals": ["5m", "15m", "1h", "4h"]
  }
}
```

### 6. 更新检测配置
```http
PUT /api/structure/config
```

**请求体**:
```json
{
  "enabled": true,
  "detection_interval": 20,
  "breakout_confirmation": {
    "min_strength": 75
  }
}
```

**响应示例**:
```json
{
  "success": true,
  "message": "Configuration updated",
  "data": {
    "enabled": true,
    "detection_interval": 20,
    ...
  }
}
```

### 7. 重置配置为默认值
```http
POST /api/structure/config/reset
```

**响应示例**:
```json
{
  "success": true,
  "message": "Configuration reset to default",
  "data": { ... }
}
```

### 8. 手动触发区间检测 ⭐ 新增
```http
POST /api/structure/detect/:symbol/:interval
```

**路径参数**:
- `symbol`: 币种符号 (如 BTCUSDT)
- `interval`: 时间周期 (1m/5m/15m/1h/4h/1d)

**查询参数**:
- `force` (可选): 是否强制检测，忽略去重 (true/false，默认false)

**使用场景**:
- 测试区间检测算法
- 手动触发特定币种的检测
- 强制重新检测（force=true）

**响应示例（检测到区间）**:
```json
{
  "success": true,
  "message": "Detected 3 ranges, saved 1 unique ranges",
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "kline_count": 250,
    "detected_count": 3,
    "saved_count": 1,
    "ranges": [
      {
        "id": 1,
        "symbol": "BTCUSDT",
        "interval": "15m",
        "type": "range",
        "support": 45000.00,
        "resistance": 46000.00,
        "middle": 45500.00,
        "range_size": 1000.00,
        "range_percent": 2.22,
        "touch_count": 6,
        "support_touches": 3,
        "resistance_touches": 3,
        "duration_bars": 30,
        "confidence": 0.85,
        "strength": 78,
        "start_time": 1705320000000,
        "end_time": 1705406400000
      }
    ]
  }
}
```

**响应示例（未检测到区间）**:
```json
{
  "success": true,
  "message": "No ranges detected",
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "kline_count": 250,
    "ranges": [],
    "detected_count": 0
  }
}
```

**错误响应示例**:
```json
{
  "success": false,
  "error": "Insufficient K-line data. Got 30, need at least 50"
}
```

**调用示例**:
```bash
# 普通检测（会去重）
curl -X POST http://localhost:3000/api/structure/detect/BTCUSDT/15m

# 强制检测（忽略去重）
curl -X POST http://localhost:3000/api/structure/detect/BTCUSDT/15m?force=true
```

---

**文档版本**: v3.1.0
**最后更新**: 2025-10-07

**更新内容**:
- ✨ 新增 **手动触发检测接口** - 支持手动触发区间检测，方便测试和调试 ⭐ 最新
- ✨ 新增 **结构形态检测接口** (8个接口) - 交易区间识别、突破信号、统计数据
- ✨ 新增 **K线数据接口** (8个接口) - 支持多表存储、数据完整性检查、批量查询
- ✨ 新增 **WebSocket管理接口** (4个接口) - 连接状态管理、订阅流监控
- ✨ 新增 **TOP币种配置接口** (10个接口) - 币种管理、排序、启用/禁用
- ✨ 新增 **历史数据接口** (5个接口) - 历史K线查询、缓存统计
- 📝 完善所有接口文档，补充请求参数和响应示例
- 🔧 更新数据源为币安U本位合约市场

**接口分类汇总**:
- 基础信息接口: 2个
- OI数据接口: 13个 ⭐ 新增黑名单管理
- 系统监控接口: 10个
- K线数据接口: 8个
- WebSocket管理接口: 4个
- TOP币种配置接口: 10个
- 历史数据接口: 5个
- 交易信号接口: 5个
- 结构形态检测接口: 8个

**总计**: 65个API接口

**维护团队**: Trading Master Development Team