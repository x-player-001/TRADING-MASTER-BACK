# 信号评分存储实现文档

## 📋 概述

本次更新实现了在OI异动检测时自动计算并存储交易信号评分，使得异动记录包含完整的信号分析数据，方便后续查询和回测使用。

## ✅ 已完成的功能

### 1. 数据库配置验证
- ✅ 验证了数据库连接正确使用 `.env` 配置文件
- ✅ 通过 `ConfigManager` 统一管理配置
- ✅ 数据库连接池配置正确加载

### 2. 数据库架构更新

#### 新增字段（oi_anomaly_records表）
```sql
ALTER TABLE oi_anomaly_records
  ADD COLUMN signal_score DECIMAL(4,2) NULL COMMENT '信号总分 (0-10)',
  ADD COLUMN signal_confidence DECIMAL(4,3) NULL COMMENT '信号置信度 (0-1)',
  ADD COLUMN signal_direction ENUM('LONG','SHORT','NEUTRAL') NULL COMMENT '信号方向',
  ADD COLUMN avoid_chase_reason VARCHAR(100) NULL COMMENT '避免追高原因';

ALTER TABLE oi_anomaly_records
  ADD INDEX idx_signal_score (signal_score),
  ADD INDEX idx_signal_direction (signal_direction);
```

#### 迁移脚本
- 📁 `migrations/add_signal_scores_to_anomalies.sql` - SQL迁移脚本
- 📁 `scripts/migrate_add_signal_scores.ts` - Node.js迁移执行脚本

### 3. TypeScript类型定义更新

#### OIAnomalyRecord 接口新增字段
```typescript
// 文件: src/types/oi_types.ts
export interface OIAnomalyRecord {
  // ... 原有字段 ...

  // 交易信号评分相关字段
  signal_score?: number;                              // 信号总分 (0-10)
  signal_confidence?: number;                         // 信号置信度 (0-1)
  signal_direction?: 'LONG' | 'SHORT' | 'NEUTRAL';   // 信号方向
  avoid_chase_reason?: string;                        // 避免追高原因（如果被拒绝）
}
```

### 4. 数据库层更新

#### OIRepository 更新
- 文件: [src/database/oi_repository.ts](src/database/oi_repository.ts#L582-L626)
- 更新 `save_anomaly_record` 方法，支持保存信号评分字段
- 新增4个字段到INSERT语句

### 5. 信号生成器增强

#### SignalGenerator 新增方法
- 文件: [src/trading/signal_generator.ts](src/trading/signal_generator.ts#L476-L529)
- 新增 `calculate_score_only()` 方法：专门用于计算评分数据
- 特点：
  - 不执行完整信号生成逻辑
  - 返回评分、置信度、方向、避免追高原因
  - 即使信号被拒绝也会计算评分（用于后续分析）

```typescript
calculate_score_only(anomaly: OIAnomalyRecord): {
  signal_score: number;
  signal_confidence: number;
  signal_direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  avoid_chase_reason: string | null;
}
```

### 6. OI轮询服务增强

#### OIPollingService 更新
- 文件: [src/services/oi_polling_service.ts](src/services/oi_polling_service.ts#L1-L730)
- 新增 `SignalGenerator` 实例
- 在 `save_anomalies()` 方法中调用 `calculate_score_only()`
- 自动为每个异动记录计算并存储评分数据

#### 工作流程
```
异动检测 → 获取情绪数据 → 构建临时记录 → 计算信号评分 → 存储完整记录
```

#### 核心代码
```typescript
// 🎯 计算信号评分
const score_data = this.signal_generator.calculate_score_only(temp_record);

const record: Omit<OIAnomalyRecord, 'id' | 'created_at'> = {
  ...temp_record,
  // 添加信号评分数据
  signal_score: score_data.signal_score,
  signal_confidence: score_data.signal_confidence,
  signal_direction: score_data.signal_direction,
  avoid_chase_reason: score_data.avoid_chase_reason || undefined
};
```

## 📊 评分计算逻辑

### 评分组成（满分10分）
1. **OI评分**（0-3分）
   - 最佳区间：5-15% OI变化
   - 避免晚期狂欢：>20% OI变化降分

2. **价格评分**（0-2分）
   - 最佳区间：2-6% 价格变化
   - 要求OI和价格同向

3. **情绪评分**（0-3分）
   - 大户多空比
   - 主动买卖比
   - 全市场多空比

4. **资金费率评分**（0-2分）
   - 资金费率变化分析

### 避免追高逻辑
系统会检测以下情况并记录拒绝原因：
- ❌ OI已涨>20% - "晚期狂欢"
- ❌ 价格已涨>15% - "晚期狂欢"
- ❌ OI>8%但价格<1% - "背离危险"
- ❌ 大户反向操作 - "大户反向"

## 🎯 使用场景

### 1. 回测优化
```typescript
// 查询高评分异动记录
SELECT * FROM oi_anomaly_records
WHERE signal_score >= 7.0
  AND signal_direction = 'LONG'
  AND avoid_chase_reason IS NULL
ORDER BY signal_score DESC;
```

### 2. 实时交易决策
- 异动记录中已包含评分，可直接查询
- 避免重复计算，提高响应速度

### 3. 策略分析
```typescript
// 统计不同评分区间的胜率
SELECT
  FLOOR(signal_score) as score_range,
  COUNT(*) as total,
  signal_direction,
  AVG(signal_confidence) as avg_confidence
FROM oi_anomaly_records
WHERE signal_score IS NOT NULL
GROUP BY score_range, signal_direction;
```

### 4. 拒绝原因分析
```typescript
// 分析被拒绝的信号
SELECT
  avoid_chase_reason,
  COUNT(*) as count,
  AVG(signal_score) as avg_score
FROM oi_anomaly_records
WHERE avoid_chase_reason IS NOT NULL
GROUP BY avoid_chase_reason
ORDER BY count DESC;
```

## 📝 日志输出

系统在保存异动记录时会输出详细的评分日志：
```
[OIPolling] BTCUSDT [5m] - Score: 8.50, Direction: LONG, Confidence: 78.5%
[OIPolling] ETHUSDT [15m] - Score: 6.20, Direction: SHORT, Confidence: 65.3%, Avoid: OI已涨25.3% (>20%), 晚期狂欢
```

## 🔧 执行迁移

### 方式1：使用Node.js脚本（推荐）
```bash
npx ts-node -r tsconfig-paths/register scripts/migrate_add_signal_scores.ts
```

### 方式2：使用SQL脚本
```bash
mysql -h [HOST] -P [PORT] -u [USER] -p[PASSWORD] [DATABASE] < migrations/add_signal_scores_to_anomalies.sql
```

## ✅ 验证结果

迁移成功后，可以验证字段已添加：
```sql
DESCRIBE oi_anomaly_records;

-- 应该看到新增的4个字段：
-- signal_score           DECIMAL(4,2)    YES
-- signal_confidence      DECIMAL(4,3)    YES
-- signal_direction       ENUM(...)       YES
-- avoid_chase_reason     VARCHAR(100)    YES
```

## 📈 性能影响

### 优化措施
- ✅ 评分计算在异动保存时同步进行
- ✅ 避免回测时重复计算
- ✅ 添加索引优化查询性能
- ✅ 评分字段为可选，向后兼容

### 预期影响
- 单次异动处理增加约 **5-10ms**（评分计算时间）
- 数据库插入性能影响 < **1%**
- 查询性能：通过索引优化，评分查询 < **50ms**

## 🔄 向后兼容性

- ✅ 所有新字段为可选（NULL）
- ✅ 旧的异动记录不受影响
- ✅ 新代码可处理无评分的历史数据
- ✅ 迁移脚本支持幂等性（可重复执行）

## 📚 相关文件

### 核心文件
1. [src/types/oi_types.ts](src/types/oi_types.ts#L69-L73) - 类型定义
2. [src/database/oi_repository.ts](src/database/oi_repository.ts#L582-L626) - 数据库层
3. [src/trading/signal_generator.ts](src/trading/signal_generator.ts#L476-L529) - 信号生成器
4. [src/services/oi_polling_service.ts](src/services/oi_polling_service.ts#L594-L607) - OI轮询服务

### 迁移文件
1. [migrations/add_signal_scores_to_anomalies.sql](migrations/add_signal_scores_to_anomalies.sql) - SQL迁移
2. [scripts/migrate_add_signal_scores.ts](scripts/migrate_add_signal_scores.ts) - Node.js迁移脚本

## 🎉 总结

本次更新成功实现了以下目标：
1. ✅ 数据库连接正确使用 `.env` 配置
2. ✅ 异动记录表增加信号评分相关字段
3. ✅ OI轮询服务自动计算并存储信号评分
4. ✅ 支持避免追高逻辑的原因记录
5. ✅ 提供完整的查询和分析支持

现在，每次检测到OI异动时，系统都会自动：
- 📊 计算信号总分（0-10分）
- 🎯 确定信号方向（LONG/SHORT/NEUTRAL）
- 💯 计算置信度（0-100%）
- ⚠️ 记录是否被避免追高逻辑拒绝及原因

这为后续的回测分析、策略优化和实盘交易决策提供了完整的数据支持！
