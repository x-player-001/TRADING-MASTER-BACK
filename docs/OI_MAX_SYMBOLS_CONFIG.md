# OI监控最大币种数配置指南

## 📋 功能说明

从现在开始，OI监控模块支持配置最大监控币种数量，可以通过环境变量或数据库灵活控制监控多少个币种。

### 新增特性
- ✅ 支持环境变量配置 `OI_MAX_MONITORED_SYMBOLS`
- ✅ 支持数据库配置 `max_monitored_symbols`
- ✅ 支持设置为 `max` 表示不限制，监控所有币安返回的USDT永续合约
- ✅ 配置优先级：环境变量 > 数据库配置 > 默认值(300)

---

## 🔧 配置方法

### 方法1: 环境变量配置 (推荐)

编辑 `.env` 文件：

```bash
# 限制监控300个币种（默认）
OI_MAX_MONITORED_SYMBOLS=300

# 限制监控100个币种
OI_MAX_MONITORED_SYMBOLS=100

# 不限制，监控所有币种
OI_MAX_MONITORED_SYMBOLS=max
```

### 方法2: 数据库配置

执行SQL更新配置：

```sql
-- 限制为500个币种
UPDATE oi_monitoring_config
SET config_value = '500'
WHERE config_key = 'max_monitored_symbols';

-- 不限制
UPDATE oi_monitoring_config
SET config_value = 'max'
WHERE config_key = 'max_monitored_symbols';
```

或通过API更新（需要实现对应的API端点）：

```bash
curl -X PUT "http://localhost:3000/api/oi/config/max_monitored_symbols" \
  -H "Content-Type: application/json" \
  -d '{"value": "max"}'
```

---

## 📊 配置说明

| 配置值 | 说明 | 效果 |
|--------|------|------|
| `300` | 限制300个 | 只监控优先级最高的300个币种 |
| `100` | 限制100个 | 只监控优先级最高的100个币种 |
| `max` | 不限制 | 监控所有币安返回的USDT永续合约（约400+个） |
| 未设置 | 使用默认值 | 默认监控300个币种 |

### 币种优先级规则

系统会按照以下优先级排序，然后取前N个：

1. **主流币** (优先级90)：BTC, ETH, BNB, ADA, DOT, SOL, MATIC, AVAX
2. **热门币** (优先级70)：DOGE, SHIB, UNI, LINK, LTC, XRP, TRX
3. **其他币** (优先级50)：剩余所有币种

---

## 🚀 使用示例

### 场景1: 测试环境只监控10个币种

```bash
# .env
OI_MAX_MONITORED_SYMBOLS=10
```

重启服务后，只会监控优先级最高的10个币种（如BTC, ETH, BNB等）。

### 场景2: 生产环境监控所有币种

```bash
# .env
OI_MAX_MONITORED_SYMBOLS=max
```

重启服务后，会监控币安所有USDT永续合约（约400+个）。

### 场景3: 根据服务器性能动态调整

```bash
# 低配服务器
OI_MAX_MONITORED_SYMBOLS=100

# 中配服务器
OI_MAX_MONITORED_SYMBOLS=200

# 高配服务器
OI_MAX_MONITORED_SYMBOLS=max
```

---

## 📈 性能影响

| 监控数量 | 每次轮询耗时 | 日均API请求 | Redis内存占用 | MySQL存储/天 |
|---------|------------|------------|--------------|-------------|
| 10个 | ~1秒 | ~14,400 | ~10 MB | ~14 MB |
| 100个 | ~5秒 | ~144,000 | ~100 MB | ~144 MB |
| 300个 | ~10秒 | ~432,000 | ~300 MB | ~432 MB |
| max (~400个) | ~15秒 | ~576,000 | ~400 MB | ~576 MB |

**说明**：
- 轮询耗时受并发请求数（默认50）和网络延迟影响
- 日均API请求 = 币种数 × 每天轮询次数（1440次/天）
- 存储空间根据实际数据量可能有所不同

---

## 🔄 配置生效时机

### 环境变量修改
1. 修改 `.env` 文件
2. **重启服务** （配置在服务启动时加载）
3. 查看日志确认：`[OIPolling] Max monitored symbols set to xxx`

### 数据库配置修改
1. 更新数据库配置
2. **重启服务** （配置在服务启动时加载）
3. 或等待下次币种刷新（默认2小时）

**注意**: 当前实现需要重启服务才能生效。如需热更新，可通过API触发手动刷新。

---

## 📝 数据库迁移

如果你是从旧版本升级，需要执行以下迁移脚本：

```bash
mysql -u root -p trading_db < database/migrations/add_max_monitored_symbols_config.sql
```

迁移脚本内容：
```sql
INSERT INTO oi_monitoring_config (config_key, config_value, description, is_active)
VALUES ('max_monitored_symbols', '300', '最大监控币种数量，设置为"max"表示不限制', 1)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  updated_at = CURRENT_TIMESTAMP;
```

---

## 🧪 测试验证

运行测试脚本验证配置是否生效：

```bash
npx ts-node src/test/test_max_symbols_config.ts
```

测试脚本会：
1. 测试默认参数（300个）
2. 测试限制10个币种
3. 测试不限制（max）
4. 测试环境变量读取

---

## 🔍 日志监控

启动服务后，关注以下日志：

```
[OIPolling] Max monitored symbols set to max
[OIPolling] Configuration loaded successfully { max_monitored_symbols: 'max', ... }
[BinanceAPI] Fetched 437 USDT perpetual symbols (limit: max)
[OIPolling] Symbol list refreshed: 435 active symbols (config limit: max)
```

**关键字段**:
- `Max monitored symbols set to`: 环境变量读取结果
- `Fetched X symbols (limit: Y)`: 从币安获取的币种数
- `active symbols (config limit: Z)`: 过滤黑名单后的实际监控数

---

## ❓ 常见问题

### Q1: 设置为 `max` 后会监控多少个币种？
**A**: 取决于币安返回的USDT永续合约数量，通常在400-450个之间。会实时跟随币安上新/下架。

### Q2: 配置修改后为什么没生效？
**A**: 需要重启服务。配置在服务启动时加载，运行期间不会自动重新加载。

### Q3: 环境变量和数据库配置冲突怎么办？
**A**: 环境变量优先级更高。如果同时设置，会使用环境变量的值。

### Q4: 监控太多币种会不会被币安限流？
**A**: 系统使用并发限制（默认50）和rate limiter来避免触发限流。但建议根据实际情况调整。

### Q5: 如何查看当前实际监控了多少币种？
**A**:
```bash
# 方法1: 查看日志
tail -f logs/app.log | grep "active symbols"

# 方法2: 查询数据库
SELECT COUNT(*) FROM contract_symbols_config WHERE enabled = 1 AND status = 'TRADING';

# 方法3: 调用API
curl http://localhost:3000/api/oi/symbols
```

---

## 📚 相关文件

- 环境变量配置: `.env.example`, `.env`
- 类型定义: `src/types/oi_types.ts`
- API实现: `src/api/binance_futures_api.ts`
- 轮询服务: `src/services/oi_polling_service.ts`
- 数据库迁移: `database/migrations/add_max_monitored_symbols_config.sql`
- 测试脚本: `src/test/test_max_symbols_config.ts`

---

## 🎉 总结

通过这个配置，你可以灵活控制OI监控模块的监控范围：

- 🧪 **测试环境**: 设置为 `10` 或 `20`，减少资源消耗
- 🏭 **生产环境（保守）**: 使用默认 `300`，平衡覆盖率和性能
- 🚀 **生产环境（激进）**: 设置为 `max`，全面监控市场

根据你的服务器性能和监控需求选择合适的配置即可！
