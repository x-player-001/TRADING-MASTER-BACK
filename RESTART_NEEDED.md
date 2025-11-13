# ⚠️ 服务器需要重启

## 问题
服务器日志显示 2025-11-13 06:04:02 的JCTUSDT异动记录中资金费率仍然为NULL，说明服务器运行的是旧版本代码。

## 关键修复Commit

### 1. `0d6b33d` - 修复资金费率计算错误
**问题**: MySQL返回的decimal字段是string类型，直接运算导致NaN
**修复**: 添加类型检查和parseFloat()转换

```typescript
// 修复前
funding_rate_before = closest_snapshot.funding_rate;  // string类型

// 修复后
funding_rate_before = typeof closest_snapshot.funding_rate === 'string'
  ? parseFloat(closest_snapshot.funding_rate)
  : closest_snapshot.funding_rate;
```

### 2. `013a788` - 优化premium数据处理
**问题**: premium_data被遍历3次，性能浪费
**修复**: 统一在poll()中构建1次Map

### 3. `f66d4c4` - 更新文档
补充v1.2.1版本说明和数据类型处理注意事项

## 重启步骤

### 方法1: 直接重启（快速）
```bash
cd /root/TRADING-MASTER-BACK
pm2 restart trading-master-back
```

### 方法2: 更新代码后重启（推荐）
```bash
cd /root/TRADING-MASTER-BACK
git pull origin main
npm install  # 如果package.json有变化
pm2 restart trading-master-back
```

## 验证修复

重启后，等待下一次异动检测，查询数据库验证：

```sql
SELECT
  id, symbol, period_seconds,
  funding_rate_before, funding_rate_after,
  funding_rate_change, funding_rate_change_percent,
  anomaly_time
FROM oi_anomaly_records
WHERE created_at > NOW()
ORDER BY created_at DESC
LIMIT 5;
```

✅ 如果看到资金费率字段有值（不是NULL），说明修复成功！

## 预期结果

修复后的异动记录应该包含：
- `funding_rate_before`: 如 0.00021736
- `funding_rate_after`: 如 0.00023046
- `funding_rate_change`: 如 0.00001310
- `funding_rate_change_percent`: 如 6.02

---
**创建时间**: 2025-11-13 14:20
**需要操作**: 立即拉取代码并重启服务
