# 数据库迁移脚本执行指南

## 📋 当前需要执行的迁移脚本

### 方案一：执行合并脚本（推荐）

```bash
mysql -u root -p trading_master < database/migrations/add_price_and_sentiment_fields.sql
```

**优势**：
- ✅ 一次性添加所有字段（价格+情绪）
- ✅ 自动检测字段是否存在，避免重复执行报错
- ✅ 执行后自动验证字段

### 方案二：分步执行

```bash
# 1. 先添加价格字段
mysql -u root -p trading_master < database/migrations/add_price_to_anomaly_records.sql

# 2. 再添加情绪字段
mysql -u root -p trading_master < database/migrations/add_sentiment_to_anomaly_records.sql
```

### 其他可选迁移

```bash
# 更新去重阈值配置（可选）
mysql -u root -p trading_master < database/migrations/update_dedup_threshold_to_2.sql

# 添加资金费率字段到OI快照表（如需要）
mysql -u root -p trading_master < database/migrations/add_funding_rate_columns.sql
```

## 📊 字段说明

### 价格变化字段 (4个)
| 字段名 | 类型 | 说明 |
|--------|------|------|
| price_before | DECIMAL(20,8) | 异动发生前的价格 |
| price_after | DECIMAL(20,8) | 异动发生后的价格 |
| price_change | DECIMAL(20,8) | 价格绝对变化量 |
| price_change_percent | DECIMAL(10,4) | 价格变化百分比 |

### 市场情绪字段 (4个)
| 字段名 | 类型 | 说明 |
|--------|------|------|
| top_trader_long_short_ratio | DECIMAL(10,4) | 大户持仓量多空比 |
| top_account_long_short_ratio | DECIMAL(10,4) | 大户账户数多空比 |
| global_long_short_ratio | DECIMAL(10,4) | 全市场多空人数比 |
| taker_buy_sell_ratio | DECIMAL(10,4) | 主动买卖量比 |

## ⚠️ 注意事项

1. **执行前备份**：建议先备份 `oi_anomaly_records` 表
   ```bash
   mysqldump -u root -p trading_master oi_anomaly_records > oi_anomaly_records_backup.sql
   ```

2. **字段可空**：所有新字段均为 `NULL COMMENT`，向后兼容旧数据

3. **执行时机**：建议在业务低峰期执行

4. **验证结果**：执行后检查字段是否添加成功
   ```sql
   DESCRIBE oi_anomaly_records;
   ```

5. **回滚方案**：如需回滚，执行脚本中注释的 ALTER TABLE DROP COLUMN 语句

## 🔄 迁移脚本历史

| 脚本名称 | 日期 | 状态 | 说明 |
|---------|------|------|------|
| add_funding_rate_columns.sql | 2025-11-12 | ✅ 已执行 | OI快照表添加资金费率字段 |
| add_price_to_anomaly_records.sql | 2025-11-12 | ⏳ 待执行 | 异动表添加价格字段 |
| add_sentiment_to_anomaly_records.sql | 2025-11-12 | ⏳ 待执行 | 异动表添加情绪字段 |
| **add_price_and_sentiment_fields.sql** | 2025-11-12 | 🎯 推荐 | 合并版（价格+情绪） |
| update_dedup_threshold_to_2.sql | 2025-11-12 | 可选 | 更新去重阈值配置 |

## 📝 执行记录模板

```bash
# 执行日期：2025-11-12
# 执行人：[你的名字]
# 数据库：trading_master
# 服务器：45.249.246.109

mysql -u root -p trading_master < database/migrations/add_price_and_sentiment_fields.sql

# 执行结果：
# ✅ 成功添加8个字段到 oi_anomaly_records 表
```
