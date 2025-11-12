# OI曲线数据API文档

## 📋 概述

新增API接口用于查询指定币种在指定日期的OI（持仓量）变化曲线数据，支持前端绘制时序图表。

## 🎯 API端点

```
GET /api/oi/curve
```

## 📝 请求参数

| 参数名 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| symbol | string | 是 | 币种符号（包含USDT后缀） | BTCUSDT, ETHUSDT |
| date | string | 是 | 查询日期（格式：YYYY-MM-DD） | 2025-11-11 |

## 📤 响应格式

### 成功响应 (200)

```json
{
  "success": true,
  "data": {
    "symbol": "BTC",
    "date": "2025-11-11",
    "curve": [
      {
        "timestamp": 1731283200000,
        "snapshot_time": "2025-11-11T00:00:00.000Z",
        "open_interest": 123456.789,
        "data_source": "binance"
      },
      {
        "timestamp": 1731283260000,
        "snapshot_time": "2025-11-11T00:01:00.000Z",
        "open_interest": 123500.123,
        "data_source": "binance"
      }
      // ... 更多数据点
    ],
    "count": 847
  },
  "timestamp": "2025-11-11T08:30:00.000Z"
}
```

### 错误响应

#### 缺少参数 (400)
```json
{
  "success": false,
  "error": "Missing or invalid parameter: symbol",
  "message": "symbol is required and must be a string (e.g., BTCUSDT)"
}
```

#### 日期格式错误 (400)
```json
{
  "success": false,
  "error": "Invalid date format",
  "message": "date must be in format YYYY-MM-DD (e.g., 2025-11-11)"
}
```

#### 服务器错误 (500)
```json
{
  "success": false,
  "error": "Failed to get OI curve",
  "message": "具体错误信息"
}
```

## 📊 返回数据说明

### curve数组中的每个数据点

| 字段 | 类型 | 说明 |
|------|------|------|
| timestamp | number | Unix时间戳（毫秒） |
| snapshot_time | string | ISO格式时间字符串 |
| open_interest | number | 持仓量数值 |
| data_source | string | 数据来源（binance） |

## 🔍 使用示例

### cURL示例

```bash
# 查询BTC在2025-11-11的OI曲线
curl "http://localhost:3000/api/oi/curve?symbol=BTCUSDT&date=2025-11-11"

# 查询ETH在2025-11-10的OI曲线
curl "http://localhost:3000/api/oi/curve?symbol=ETHUSDT&date=2025-11-10"
```

### JavaScript示例

```javascript
// 使用fetch API
async function getOICurve(symbol, date) {
  const response = await fetch(
    `/api/oi/curve?symbol=${symbol}&date=${date}`
  );
  const result = await response.json();

  if (result.success) {
    // 绘制曲线图
    drawChart(result.data.curve);
  } else {
    console.error(result.error);
  }
}

// 调用示例
getOICurve('BTCUSDT', '2025-11-11');
```

### 前端绘图示例（使用Chart.js）

```javascript
function drawOICurve(curveData) {
  const ctx = document.getElementById('oiChart').getContext('2d');

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: curveData.curve.map(d => new Date(d.timestamp)),
      datasets: [{
        label: `${curveData.symbol} 持仓量`,
        data: curveData.curve.map(d => d.open_interest),
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1
      }]
    },
    options: {
      responsive: true,
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'hour'
          }
        },
        y: {
          title: {
            display: true,
            text: '持仓量'
          }
        }
      }
    }
  });
}
```

## ⚡ 性能特点

### 查询优化
- **日期分表存储**：数据按日期分表存储（表名格式：`open_interest_snapshots_YYYYMMDD`）
- **自动降级查询**：优先查询日期表，若不存在则自动降级到原始表
- **索引优化**：使用复合索引 `(symbol, timestamp_ms)` 加速查询
- **快速响应**：单日数据查询时间 < 100ms（典型场景约800条数据）

### 数据量预估
- **每个币种每天**：约800-1000条快照（采样间隔60-120秒）
- **典型查询结果**：单币种单日约800条数据点
- **数据保留期**：20天（超过自动清理）

## 🛠️ 技术实现

### 后端实现

#### Repository层 (oi_repository.ts)
```typescript
/**
 * 获取指定币种在指定日期的OI曲线数据（用于前端绘图）
 */
async get_symbol_oi_curve(symbol: string, date: string): Promise<OpenInterestSnapshot[]> {
  // 1. 从日期表查询
  // 2. 失败则降级到原始表
  // 3. 按时间升序返回
}
```

#### Routes层 (oi_routes.ts)
```typescript
/**
 * 获取OI曲线数据（用于前端绘图）
 * GET /api/oi/curve?symbol=BTCUSDT&date=2025-11-11
 */
private async get_oi_curve(req: Request, res: Response): Promise<void> {
  // 1. 参数验证
  // 2. 调用repository查询
  // 3. 格式化返回数据（移除USDT后缀）
}
```

### 数据库表结构

```sql
-- 日期分表示例：open_interest_snapshots_20251111
CREATE TABLE open_interest_snapshots_20251111 (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(20) NOT NULL,
  open_interest DECIMAL(30,8) NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  snapshot_time TIMESTAMP NOT NULL,
  data_source VARCHAR(20) DEFAULT 'binance',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_symbol_timestamp (symbol, timestamp_ms),
  INDEX idx_snapshot_time (snapshot_time),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## 📈 数据验证

### 可用数据示例
```bash
# 查看2025-11-11的数据统计
SELECT symbol, COUNT(*) as count
FROM open_interest_snapshots_20251111
GROUP BY symbol
ORDER BY count DESC
LIMIT 5;

# 结果示例
# ETHUSDT   847
# BTCUSDT   847
# SOLUSDT   847
```

## ⚠️ 注意事项

1. **日期格式严格**：必须为 `YYYY-MM-DD` 格式，否则返回400错误
2. **符号完整性**：必须包含USDT后缀（如BTCUSDT），返回时会自动移除
3. **数据范围限制**：只能查询近20天的数据（超过则可能无数据）
4. **时间排序**：返回数据已按时间升序排列，适合直接绘图
5. **数据精度**：open_interest为浮点数，前端使用时注意精度处理

## 🔄 后续优化建议

1. **缓存机制**：可考虑添加Redis缓存热点日期数据
2. **分页支持**：若单日数据量过大，可添加分页参数
3. **聚合选项**：可添加聚合参数（如每5分钟、每小时）减少数据点
4. **多日期查询**：支持日期范围查询（start_date + end_date）
5. **数据压缩**：对于历史数据可考虑降采样压缩

## 📞 联系与支持

如有问题或建议，请联系后端开发团队。

---

**最后更新**: 2025-11-11
**版本**: v1.0.0
