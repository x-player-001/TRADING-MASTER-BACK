# 📊 OI (Open Interest) 监控功能集成指南

## 🎯 功能概述

本集成将B项目的OI异动监控功能完整迁移到主项目中，提供：

- **实时OI数据监控** - 1分钟频率轮询币安期货OI数据
- **异动检测算法** - 多时间周期(1min/2min/5min/15min)变化率监控
- **数据存储管理** - MySQL + Redis双重存储策略
- **HTTP API接口** - RESTful API查询统计和历史数据
- **系统健康监控** - 完整的状态监控和错误处理

## 🏗️ 新增文件结构

```
src/
├── types/oi_types.ts                    # OI相关类型定义
├── database/
│   ├── oi_repository.ts                 # OI数据库操作层
│   └── migrations/create_oi_tables.sql  # 数据表创建脚本
├── api/
│   ├── binance_futures_api.ts           # 币安期货API客户端
│   ├── api_server.ts                    # HTTP API服务器
│   └── routes/oi_routes.ts              # OI API路由
├── services/
│   └── oi_polling_service.ts            # OI轮询和异动检测服务
├── core/data/
│   └── oi_data_manager.ts               # OI数据统一管理器
└── test/
    └── oi_integration_test.ts           # 集成测试脚本
```

## 🗄️ 数据库设计

### 核心数据表

1. **contract_symbols_config** - 合约币种配置
2. **open_interest_snapshots** - OI快照数据(时序)
3. **oi_anomaly_records** - OI异动记录
4. **oi_monitoring_config** - 监控配置管理

### 初始化数据库

```sql
-- 执行SQL脚本创建表结构
source database/migrations/create_oi_tables.sql;
```

## 🚀 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
# .env 文件
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=trading_master

REDIS_HOST=127.0.0.1
REDIS_PORT=6379

API_PORT=3000
```

### 3. 运行集成测试

```bash
# 测试OI功能是否正常
npx ts-node -r tsconfig-paths/register src/test/oi_integration_test.ts
```

### 4. 启动主服务

```bash
npm run dev
```

## 📡 API接口说明

服务启动后，访问 `http://localhost:3000`

### 核心接口

| 接口路径 | 方法 | 说明 |
|---------|------|------|
| `/health` | GET | 服务健康检查 |
| `/api/status` | GET | 系统状态总览 |
| `/api/oi/statistics` | GET | OI统计数据 |
| `/api/oi/recent-anomalies` | GET | 最近50条异动记录 |
| `/api/oi/snapshots` | GET | OI快照历史数据 |
| `/api/oi/symbols` | GET | 启用的币种列表 |
| `/api/oi/status` | GET | OI监控服务状态 |

### 示例请求

```bash
# 获取最近异动
curl http://localhost:3000/api/oi/recent-anomalies

# 获取BTCUSDT的OI统计
curl "http://localhost:3000/api/oi/statistics?symbol=BTCUSDT"

# 获取系统健康状态
curl http://localhost:3000/api/status
```

## ⚙️ 配置参数

### 轮询配置

- **轮询间隔**: 60秒 (正常) / 15分钟 (0-7点)
- **并发请求**: 50个/批次
- **异动阈值**: 1min(3%), 2min(3%), 5min(3%), 15min(10%)

### 可动态调整配置

```bash
# 更新轮询间隔为2分钟
curl -X PUT http://localhost:3000/api/oi/config/polling_interval_ms \
  -H "Content-Type: application/json" \
  -d '{"value": 120000}'
```

## 📊 监控数据说明

### OI异动记录字段

```typescript
{
  symbol: "BTCUSDT",           // 币种
  period_minutes: 1,           // 监控周期(分钟)
  percent_change: 15.25,       // 变化百分比
  oi_before: 1000000,          // 变化前OI
  oi_after: 1152500,           // 变化后OI
  severity: "medium",          // 严重程度: low/medium/high
  anomaly_time: "2024-01-01T12:00:00Z"
}
```

### 严重程度判定

- **High** (高): 变化率 ≥ 30%
- **Medium** (中): 变化率 ≥ 15%
- **Low** (低): 变化率 < 15%

## 🔧 故障排除

### 常见问题

1. **数据库连接失败**
   ```bash
   # 检查MySQL服务状态
   systemctl status mysql
   # 验证数据库配置
   mysql -h localhost -u root -p trading_master
   ```

2. **币安API连接失败**
   ```bash
   # 测试网络连接
   curl https://fapi.binance.com/fapi/v1/ping
   ```

3. **内存使用过高**
   ```bash
   # 检查轮询频率和并发数
   curl http://localhost:3000/api/oi/config
   ```

### 日志监控

```bash
# 查看实时日志
tail -f logs/app.log | grep "OIPolling"

# 监控异动检测
tail -f logs/app.log | grep "anomalies detected"
```

## 🧪 测试验证

### 手动验证步骤

1. **服务启动验证**
   ```bash
   curl http://localhost:3000/health
   ```

2. **数据轮询验证**
   ```bash
   # 触发手动轮询
   curl -X POST http://localhost:3000/api/oi/trigger-poll
   ```

3. **数据查询验证**
   ```bash
   # 查看最新数据
   curl http://localhost:3000/api/oi/recent-anomalies
   ```

### 性能基准

- **轮询延迟**: < 30秒 (100个币种)
- **API响应时间**: < 500ms
- **内存使用**: < 500MB
- **CPU使用**: < 10% (正常运行)

## 📝 开发说明

### 扩展新功能

1. **添加新的异动检测算法**
   - 修改 `oi_polling_service.ts` 中的 `detect_anomalies` 方法

2. **增加新的API接口**
   - 在 `oi_routes.ts` 中添加新路由

3. **自定义通知渠道**
   - 继承 `OIPollingService` 并重写异动处理逻辑

### 代码规范

- 遵循项目的 snake_case 命名约定
- 所有异步操作使用 async/await
- 完整的错误处理和日志记录
- TypeScript 严格类型检查

## 🚨 注意事项

1. **生产环境部署**
   - 确保数据库连接池配置合理
   - 设置适当的API请求限制
   - 配置日志轮转和监控

2. **数据安全**
   - 定期清理过期数据 (默认30天)
   - 备份关键配置和异动记录

3. **性能优化**
   - 根据实际需求调整并发数
   - 监控数据库查询性能
   - 适当使用Redis缓存

---

🎉 **集成完成！** OI监控功能已成功整合到主项目中，可以开始监控市场异动了。