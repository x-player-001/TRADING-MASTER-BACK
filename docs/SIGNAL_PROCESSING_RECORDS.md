# 信号处理记录功能文档

**创建日期**: 2025-12-01
**功能**: 记录交易系统对每个信号的处理结果（接受/拒绝）和详细原因

---

## 📋 功能概述

交易系统在接收到OI异动信号后，会经过多层过滤和风控检查。这个功能**自动记录每个信号的处理过程和结果**，包括：

- ✅ **信号接受** - 成功开仓的记录
- ❌ **信号拒绝** - 拒绝原因和分类

---

## 🗄️ 数据库表结构

### **signal_processing_records**

| 字段 | 类型 | 说明 |
|------|------|------|
| **id** | BIGINT | 主键ID |
| **anomaly_id** | BIGINT | 关联的OI异动记录ID |
| **symbol** | VARCHAR(20) | 交易对（如BTCUSDT） |
| **signal_direction** | ENUM | 信号方向（LONG/SHORT） |
| **signal_score** | DECIMAL(5,2) | 信号评分 |
| **signal_source** | VARCHAR(50) | 信号来源（默认OI_ANOMALY） |
| **processing_result** | ENUM | 处理结果（ACCEPTED/REJECTED） |
| **rejection_reason** | VARCHAR(255) | 拒绝原因文本 |
| **rejection_category** | ENUM | 拒绝原因分类 |
| **order_id** | VARCHAR(50) | 订单ID（如果开仓成功） |
| **position_id** | VARCHAR(100) | 持仓ID |
| **entry_price** | DECIMAL(20,8) | 开仓价格 |
| **quantity** | DECIMAL(30,8) | 开仓数量 |
| **position_value_usd** | DECIMAL(20,2) | 持仓价值 |
| **current_daily_loss** | DECIMAL(20,8) | 当前日亏损 |
| **current_open_positions** | INT | 当前持仓数量 |
| **available_balance** | DECIMAL(20,8) | 可用余额 |
| **signal_received_at** | TIMESTAMP | 信号接收时间 |
| **processed_at** | TIMESTAMP | 处理时间 |
| **error_message** | TEXT | 错误信息（如果有） |
| **metadata** | JSON | 其他元数据 |

---

## 🏷️ 拒绝原因分类

| 分类 | 说明 | 示例 |
|------|------|------|
| **DAILY_LOSS_LIMIT** | 达到日亏损限制 | "已达到日亏损限制 -$20.00" |
| **MAX_POSITIONS_LIMIT** | 达到最大持仓数量 | "已达到最大持仓数量限制 (3/3)" |
| **POSITION_EXISTS** | 已有该币种持仓 | "BTCUSDT已有持仓" |
| **INSUFFICIENT_BALANCE** | 余额不足 | "余额不足，无法开仓" |
| **SIGNAL_SCORE_TOO_LOW** | 信号评分过低 | "信号评分7.5低于阈值8.0" |
| **MARKET_CONDITIONS** | 市场条件不满足 | "追高风险：涨幅9.5%超过阈值8%" |
| **RISK_MANAGEMENT** | 风控拒绝 | "风险评估未通过" |
| **SYSTEM_ERROR** | 系统错误 | "API调用失败" |
| **OTHER** | 其他原因 | - |

---

## 🔄 自动记录流程

### **信号处理流程**

```
OI异动信号
   ↓
[1] 生成交易信号
   ├─ ❌ 无有效信号 → 记录拒绝 (SIGNAL_SCORE_TOO_LOW)
   └─ ✅ 生成信号
       ↓
[2] 方向过滤
   ├─ ❌ 方向不允许 → 记录拒绝 (MARKET_CONDITIONS)
   └─ ✅ 通过
       ↓
[3] 策略评估
   ├─ ❌ 追高/评分低 → 记录拒绝 (MARKET_CONDITIONS/SIGNAL_SCORE_TOO_LOW)
   └─ ✅ 通过
       ↓
[4] 风险检查
   ├─ ❌ 风控拒绝 → 记录拒绝 (DAILY_LOSS_LIMIT/MAX_POSITIONS_LIMIT/等)
   └─ ✅ 通过
       ↓
[5] 执行开仓
   ├─ ❌ 执行错误 → 记录拒绝 (SYSTEM_ERROR)
   └─ ✅ 成功开仓 → 记录接受 (ACCEPTED)
```

### **记录内容差异**

#### **拒绝记录**
- ✅ anomaly_id, symbol, signal_direction, signal_score
- ✅ rejection_reason（具体原因文本）
- ✅ rejection_category（分类）
- ✅ current_daily_loss, current_open_positions, available_balance
- ❌ order_id, position_id, entry_price, quantity（全为NULL）

#### **接受记录**
- ✅ anomaly_id, symbol, signal_direction, signal_score
- ✅ order_id, position_id, entry_price, quantity, position_value_usd
- ✅ current_open_positions, available_balance
- ❌ rejection_reason, rejection_category（全为NULL）

---

## 💻 代码集成

### **TradingSystem 中的自动记录**

在 [src/trading/trading_system.ts](src/trading/trading_system.ts) 的 `process_anomaly()` 方法中，每个决策点都会自动记录：

```typescript
// 示例：信号拒绝记录
await this.record_signal_rejection({
  anomaly_id: anomaly.id,
  symbol: signal.symbol,
  signal_direction: SignalDirection.LONG,
  signal_score: signal.score,
  rejection_reason: '追高风险：涨幅9.5%超过阈值8%',
  rejection_category: RejectionCategory.MARKET_CONDITIONS,
  current_open_positions: 2,
  available_balance: 950.50,
  signal_received_at: new Date()
});

// 示例：信号接受记录
await this.record_signal_acceptance({
  anomaly_id: anomaly.id,
  symbol: position.symbol,
  signal_direction: SignalDirection.LONG,
  signal_score: signal.score,
  position_id: position.id,
  entry_price: position.entry_price,
  quantity: position.quantity,
  position_value_usd: position.quantity * position.entry_price,
  current_open_positions: 3,
  available_balance: 851.48,
  signal_received_at: new Date()
});
```

**重要特性**:
- ✅ 异步记录，不阻塞主流程
- ✅ 记录失败不影响交易执行
- ✅ 自动分类拒绝原因

---

## 📊 数据查询

### **使用 Repository 查询**

```typescript
import { signal_processing_repository } from '@/database/signal_processing_repository';

// 1. 查询最近100条记录
const recent = await signal_processing_repository.get_recent_records(100);

// 2. 根据anomaly_id查询
const record = await signal_processing_repository.get_by_anomaly_id(12345);

// 3. 查询指定时间范围
const start = new Date('2025-12-01');
const end = new Date('2025-12-02');
const records = await signal_processing_repository.get_records_by_time_range(
  start,
  end,
  {
    symbol: 'BTCUSDT',  // 可选过滤
    processing_result: SignalProcessingResult.REJECTED
  }
);

// 4. 统计信号处理结果
const stats = await signal_processing_repository.get_processing_statistics(start, end);
console.log(stats);
// {
//   total: 100,
//   accepted: 30,
//   rejected: 70,
//   rejection_breakdown: {
//     MARKET_CONDITIONS: 25,
//     MAX_POSITIONS_LIMIT: 20,
//     SIGNAL_SCORE_TOO_LOW: 15,
//     DAILY_LOSS_LIMIT: 10
//   }
// }
```

### **直接 SQL 查询**

```sql
-- 查询今日所有拒绝记录
SELECT
  symbol,
  signal_score,
  rejection_reason,
  rejection_category,
  signal_received_at
FROM signal_processing_records
WHERE processing_result = 'REJECTED'
  AND DATE(signal_received_at) = CURDATE()
ORDER BY signal_received_at DESC;

-- 统计拒绝原因分布
SELECT
  rejection_category,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
FROM signal_processing_records
WHERE processing_result = 'REJECTED'
  AND signal_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY rejection_category
ORDER BY count DESC;

-- 分析信号接受率
SELECT
  DATE(signal_received_at) as date,
  COUNT(*) as total_signals,
  SUM(CASE WHEN processing_result = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted,
  SUM(CASE WHEN processing_result = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
  ROUND(SUM(CASE WHEN processing_result = 'ACCEPTED' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as acceptance_rate
FROM signal_processing_records
WHERE signal_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(signal_received_at)
ORDER BY date DESC;
```

---

## 🧪 测试

运行测试脚本验证功能：

```bash
npx ts-node -r tsconfig-paths/register scripts/test_signal_processing.ts
```

**测试覆盖**:
- ✅ 创建拒绝记录（追高拒绝）
- ✅ 创建接受记录（成功开仓）
- ✅ 创建风控拒绝记录（持仓限制）
- ✅ 查询最近记录
- ✅ 统计信号处理结果
- ✅ 根据anomaly_id查询

---

## 📈 实际应用场景

### **1. 优化信号质量**

通过分析拒绝记录，识别哪些信号类型最常被拒绝：

```sql
-- 按币种统计拒绝率
SELECT
  symbol,
  COUNT(*) as total,
  SUM(CASE WHEN processing_result = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
  ROUND(SUM(CASE WHEN processing_result = 'REJECTED' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as rejection_rate
FROM signal_processing_records
WHERE signal_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY symbol
HAVING total >= 5
ORDER BY rejection_rate DESC;
```

**用途**: 发现某些币种的信号质量较差，调整监控参数。

### **2. 评估风控策略**

分析风控拒绝的频率和原因：

```sql
-- 风控拒绝详情
SELECT
  rejection_category,
  COUNT(*) as count,
  GROUP_CONCAT(DISTINCT symbol ORDER BY symbol) as affected_symbols
FROM signal_processing_records
WHERE processing_result = 'REJECTED'
  AND rejection_category IN ('DAILY_LOSS_LIMIT', 'MAX_POSITIONS_LIMIT', 'POSITION_EXISTS', 'INSUFFICIENT_BALANCE')
  AND signal_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY rejection_category;
```

**用途**: 判断风控策略是否过于严格或宽松。

### **3. 信号质量评分分析**

分析不同评分区间的信号接受率：

```sql
-- 按评分区间统计
SELECT
  CASE
    WHEN signal_score >= 9.5 THEN '9.5+'
    WHEN signal_score >= 9.0 THEN '9.0-9.5'
    WHEN signal_score >= 8.5 THEN '8.5-9.0'
    WHEN signal_score >= 8.0 THEN '8.0-8.5'
    ELSE '<8.0'
  END as score_range,
  COUNT(*) as total,
  SUM(CASE WHEN processing_result = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted,
  ROUND(SUM(CASE WHEN processing_result = 'ACCEPTED' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as acceptance_rate
FROM signal_processing_records
WHERE signal_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY score_range
ORDER BY score_range DESC;
```

**用途**: 优化最低信号评分阈值。

### **4. 追高拒绝分析**

统计因追高被拒绝的信号：

```sql
-- 追高拒绝统计
SELECT
  symbol,
  COUNT(*) as chase_high_rejections,
  AVG(signal_score) as avg_score
FROM signal_processing_records
WHERE rejection_reason LIKE '%追高%'
  AND signal_received_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY symbol
ORDER BY chase_high_rejections DESC
LIMIT 10;
```

**用途**: 调整追高阈值参数。

---

## ⚠️ 注意事项

1. **性能影响** - 每个信号都会写数据库，但异步执行不阻塞主流程
2. **数据清理** - 建议定期清理旧记录（如保留30天）
3. **索引优化** - 已创建索引，支持高效查询：
   - `idx_symbol` - 按币种查询
   - `idx_result` - 按结果查询
   - `idx_rejection_category` - 按拒绝分类查询
   - `idx_signal_received` - 按时间查询
   - `idx_anomaly_id` - 关联OI异动查询

---

## 🎯 未来扩展

可能的扩展功能：

1. **API接口** - 提供HTTP API查询信号处理记录
2. **实时统计** - Redis缓存实时统计数据
3. **告警机制** - 拒绝率过高时发送告警
4. **可视化面板** - 图表展示信号处理趋势
5. **A/B测试** - 对比不同策略参数的信号接受率

---

**文档维护**: 如有功能更新，请及时更新此文档
