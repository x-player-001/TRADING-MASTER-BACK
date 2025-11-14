# OI持仓量监控模块文档

## 📋 功能概述

实时监控币安U本位合约的持仓量（Open Interest）变化，自动检测异动并记录到数据库，为量化交易提供数据支持。

---

## 🎯 核心功能

### 1. 数据采集
- **采集频率**: 1分钟一次（全天24小时）
- **监控币种**: 币安返回的全部合约币种
- **采集内容**:
  - 持仓量（OI）
  - 标记价格
  - 资金费率
  - 下次资金费时间

### 2. 异动检测

#### 检测阈值
根据不同时间窗口检测OI变化：

| 时间窗口 | 阈值 | 说明 |
|---------|------|------|
| 1分钟 | 3% | 短期快速变化 |
| 2分钟 | 3% | 短期快速变化 |
| 5分钟 | 3% | 中期趋势 |
| 15分钟 | 10% | 长期趋势 |

**触发条件**: OI变化率 ≥ 阈值

**严重程度分级**:
- **Low**: 变化 < 15%
- **Medium**: 15% ≤ 变化 < 30%
- **High**: 变化 ≥ 30%

#### 检测流程详解

**每1分钟轮询周期**:

1️⃣ **批量获取OI数据**
   ```
   请求: GET /fapi/v1/openInterest (批量，~530个币种)
   返回: { symbol, openInterest, time }
   耗时: ~13秒
   ```

2️⃣ **批量获取价格和资金费率**
   ```
   请求: GET /fapi/v1/premiumIndex (批量，~530个币种)
   返回: { symbol, markPrice, lastFundingRate, nextFundingTime }
   耗时: ~3秒
   ```

3️⃣ **存储快照数据**
   - 写入日期分表: `open_interest_snapshots_YYYYMMDD`
   - 包含: OI + 价格 + 资金费率

4️⃣ **异动检测** (对每个币种，检测4个时间窗口)
   - 查询历史快照: 从分表中获取N分钟前的数据
   - 计算变化率: `(当前OI - 历史OI) / 历史OI * 100`
   - 判断是否超过阈值

   **示例**:
   ```
   当前时间: 14:05:00, OI: 1,000,000
   查找 14:00:00 (5分钟前), OI: 950,000
   变化率: (1,000,000 - 950,000) / 950,000 = 5.26%
   结果: 超过5分钟阈值(3%) → 触发异动 ✓
   ```

5️⃣ **去重判断**
   - 检查Redis缓存: 该币种同周期是否有近期异动
   - 对比变化率: 与上次异动相比，变化差异 < 2% 则跳过
   - 目的: 避免连续记录相似的异动

6️⃣ **获取附加数据** (仅异动币种)

   **市场情绪数据**:
   ```
   请求: GET /futures/data/topLongShortPositionRatio (大户持仓多空比)
   请求: GET /futures/data/topLongShortAccountRatio (大户账户多空比)
   请求: GET /futures/data/globalLongShortAccountRatio (全市场多空比)
   请求: GET /futures/data/takerlongshortRatio (主动买卖比)
   ```

   **已有数据** (无需额外请求):
   - 价格变化: 从步骤2的数据计算
   - 资金费率变化: 从历史快照对比

7️⃣ **计算每日价格极值**
   - 维护内存缓存: 每个币种的当日最高价和最低价
   - 自动按日期重置: 每天0点自动初始化新的一天
   - 增量更新: 随着价格变化实时更新极值
   - 计算百分比: 当前价格相对于极值的涨跌幅

8️⃣ **计算交易信号评分**
   - OI评分 (0-3分): 基于OI变化率
   - 价格评分 (0-2分): 基于价格变化率
   - 情绪评分 (0-3分): 基于市场情绪数据
   - 资金费率评分 (0-2分): 基于资金费率变化
   - 避免追高检测: 检查是否晚期狂欢、价格极值等

9️⃣ **保存异动记录**
   - 写入表: `oi_anomaly_records`
   - 包含: OI变化 + 价格变化 + 资金费率变化 + 市场情绪 + 信号评分 + 价格极值
   - 更新Redis缓存: 用于下次去重判断

### 3. 数据存储

#### OI快照数据（历史数据）
- **存储位置**: 日期分表 `open_interest_snapshots_YYYYMMDD`
- **分表规则**: 按北京时间日期分表
- **保留时间**: 20天
- **字段**: symbol, open_interest, mark_price, funding_rate, snapshot_time

#### 异动记录（核心数据）
- **存储位置**: `oi_anomaly_records` 表
- **去重机制**: 变化率差异 < 2% 不重复记录
- **包含数据**:
  - OI变化（before/after/变化率）
  - 价格变化（before/after/变化率）
  - **资金费率变化**（before/after/变化率）✨
  - 市场情绪数据（多空比等）
  - **交易信号评分**（score/confidence/direction/avoid_chase_reason）✨
  - **每日价格极值**（daily_low/daily_high/price_from_low_pct/price_from_high_pct）✨

---

## 🔧 配置说明

### 数据库配置表 `oi_monitoring_config`

```sql
-- 轮询间隔（毫秒）
polling_interval_ms = 60000  -- 1分钟

-- 非交易时段配置（已禁用，全天1分钟）
off_hours_config = {"start":0,"end":0,"interval_ms":60000}

-- 异动阈值
thresholds = {"60":3,"120":3,"300":3,"900":10}

-- 去重阈值（百分比）
dedup_change_diff_threshold = 2

-- 严重程度阈值
severity_thresholds = {"high":30,"medium":15}
```

### 修改配置
```sql
-- 示例：修改5分钟阈值为5%
UPDATE oi_monitoring_config
SET config_value = '{"60":3,"120":3,"300":5,"900":10}'
WHERE config_key = 'thresholds';
```

配置会在2小时内自动重新加载，或重启服务立即生效。

---

## 📊 数据流程

```
┌─────────────┐
│ 币安API采集  │ 每1分钟
│ 530个币种    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 存储快照数据 │ 日期分表（北京时间）
│ OI + 价格    │ open_interest_snapshots_20251113
│ + 资金费率   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 异动检测     │ 4个时间窗口（1m/2m/5m/15m）
│ 对比历史数据 │ 超过阈值 → 触发异动
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 去重判断     │ 变化差异 < 2% 跳过
│ Cache优先    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 保存异动记录 │ oi_anomaly_records
│ 包含附加数据 │ 价格+资金费率+市场情绪
└─────────────┘
```

---

## 🌟 增强功能说明

### 1. 资金费率数据

#### 作用
**仅作为附加数据**，不影响异动判断。当检测到OI异动时，自动记录当时的资金费率状态。

#### 数据内容
- `funding_rate_before` - 变化前的资金费率
- `funding_rate_after` - 变化后的资金费率
- `funding_rate_change` - 变化量
- `funding_rate_change_percent` - 变化百分比

#### 应用场景
- 分析OI暴涨时的市场情绪（资金费率高 → 多头过热）
- 判断OI变化的真实性（资金费率同向变化 → 真实需求）
- 识别轧空/爆仓事件（OI与资金费率反向 → 被动平仓）

### 2. 交易信号评分 ⭐ **核心特性**

#### 作用
为每个异动自动计算交易信号质量评分，帮助筛选高质量的交易机会。

#### 评分组成（满分10分）
- **OI评分** (0-3分)
  - 最佳区间：5-15% OI变化
  - 避免晚期狂欢：>20% OI变化降分
- **价格评分** (0-2分)
  - 最佳区间：2-6% 价格变化
  - 要求OI和价格同向
- **情绪评分** (0-3分)
  - 大户多空比
  - 主动买卖比
  - 全市场多空比
- **资金费率评分** (0-2分)
  - 资金费率变化分析

#### 避免追高逻辑
系统会检测以下情况并记录拒绝原因：
- ❌ OI已涨>20% - "晚期狂欢"
- ❌ 价格已涨>15% - "晚期狂欢"
- ❌ OI>8%但价格<1% - "背离危险"
- ❌ 大户反向操作 - "大户反向"
- ❌ 价格从日内低点已涨>10% - "避免追高"
- ❌ 价格从日内高点已跌>10% - "避免追跌"

#### 数据字段
- `signal_score` - 信号总分（0-10）
- `signal_confidence` - 信号置信度（0-1）
- `signal_direction` - 信号方向（LONG/SHORT/NEUTRAL）
- `avoid_chase_reason` - 避免追高原因（如果被拒绝）

### 3. 每日价格极值 ⭐ **性能优化**

#### 作用
实时跟踪每个币种的当日价格极值，用于判断当前价格位置，避免追高追跌。

#### 工作原理
- **内存缓存**: 使用Map存储每个币种的日内最高价和最低价
- **自动重置**: 每天0点（UTC+8）自动初始化新的一天
- **增量更新**: 随异动检测实时更新极值
- **零数据库查询**: 直接从缓存读取，性能提升50-200倍

#### 数据字段
- `daily_price_low` - 触发异动时的日内最低价
- `daily_price_high` - 触发异动时的日内最高价
- `price_from_low_pct` - 当前价格相对日内低点的涨幅(%)
- `price_from_high_pct` - 当前价格相对日内高点的跌幅(%)

#### 应用场景
- **避免追高**: 如果价格从日内低点已涨>10%，拒绝做多
- **避免追跌**: 如果价格从日内高点已跌>10%，拒绝做空
- **回测分析**: 了解异动触发时的价格位置
- **入场时机**: 选择价格位置更优的异动进行交易

---

## 📡 API接口

### 1. 查询异动记录
```http
GET /api/oi/anomalies
Query参数:
  - symbol: 币种（可选，如 BTCUSDT）
  - severity: 严重程度（可选，low/medium/high）
  - limit: 返回数量（默认100）
  - hours: 时间范围（默认24小时）
```

### 2. 查询币种异动历史
```http
GET /api/oi/anomalies/:symbol
Path参数:
  - symbol: 币种名称（如 BTCUSDT）
Query参数:
  - hours: 时间范围（默认24小时）
```

### 3. 查询OI曲线数据
```http
GET /api/oi/curve
Query参数:
  - symbol: 币种（必填，如 BTCUSDT）
  - date: 日期（必填，格式 YYYY-MM-DD）

返回: 该币种在指定日期的所有OI数据点
```

### 4. 查询最近异动
```http
GET /api/oi/recent-anomalies
Query参数:
  - limit: 返回数量（默认50）

返回字段说明:
  - symbol: 币种符号（去除USDT后缀）
  - period_minutes: 检测周期（分钟）
  - percent_change: OI变化百分比
  - oi_before/oi_after/oi_change: OI变化数据
  - severity: 严重程度（low/medium/high）
  - anomaly_type: 异动类型（oi/funding_rate/both）
  - price_before/price_after/price_change/price_change_percent: 价格变化数据
  - funding_rate_before/funding_rate_after/funding_rate_change/funding_rate_change_percent: 资金费率变化数据
  - top_trader_long_short_ratio: 大户持仓量多空比
  - top_account_long_short_ratio: 大户账户数多空比
  - global_long_short_ratio: 全市场多空人数比
  - taker_buy_sell_ratio: 主动买卖量比
  - signal_score: 信号总分（0-10）
  - signal_confidence: 信号置信度（0-1）
  - signal_direction: 信号方向（LONG/SHORT/NEUTRAL）
  - avoid_chase_reason: 避免追高原因（如果被拒绝）
  - daily_price_low: 触发时的日内最低价
  - daily_price_high: 触发时的日内最高价
  - price_from_low_pct: 相对日内低点的涨幅(%)
  - price_from_high_pct: 相对日内高点的跌幅(%)
```

---

## ⚠️ 重要注意事项

### 1. 时区处理
- **数据库TIMESTAMP**: 存储UTC时间
- **分表逻辑**: 按北京时间（UTC+8）日期分表
- **查询逻辑**: 自动转换为北京时间
- **结论**: 开发者无需关心时区，系统自动处理 ✅

### 2. 数据保留
- **OI快照**: 20天自动清理（DailyTableManager）
- **异动记录**: 永久保留

### 3. API权重
- **每次轮询**: ~530权重（530个币种 × 1权重）
- **1分钟限制**: 2400权重
- **占用率**: 22%，安全范围内 ✅

### 4. 去重机制
- **目的**: 避免相同异动重复记录
- **判断**: 同币种同周期，变化率差异 < 2% 则跳过
- **缓存**: 优先使用Redis缓存，提高性能

### 5. 分表查询
- **跨天查询**: 自动UNION多个日期表
- **降级策略**: 日期表不存在时，降级到原始表
- **性能**: 单表查询 < 100ms

### 6. 数据类型处理 ⚠️ **重要**
- **MySQL Decimal → Node.js String**:
  - MySQL的decimal字段返回到Node.js是**string类型**，不是number
  - `mark_price` 和 `funding_rate` 从数据库读取时都是string
  - 必须使用 `parseFloat()` 转换后才能进行数值运算
  - 否则会导致 `number - string = NaN`，保存到数据库变成NULL

  ```typescript
  // ❌ 错误写法
  const change = current_value - snapshot.funding_rate;  // NaN

  // ✅ 正确写法
  const rate = typeof snapshot.funding_rate === 'string'
    ? parseFloat(snapshot.funding_rate)
    : snapshot.funding_rate;
  const change = current_value - rate;  // 正确计算
  ```

### 7. 性能优化
- **premium数据Map化**: 统一构建一次Map，避免多次遍历（~530个币种）
- **Redis缓存优先**: 异动去重检测优先查Redis，减少数据库查询
- **批量API请求**: 使用币安批量接口，减少API调用次数

---

## 🔍 故障排查

### 1. 异动检测失败
**检查项**:
- [ ] 是否有足够的历史数据（至少5-15分钟）
- [ ] 配置表中的阈值是否合理
- [ ] Redis缓存是否正常
- [ ] 日志中是否有错误信息

### 2. 数据采集停止
**检查项**:
- [ ] OI轮询服务是否运行
- [ ] 币安API连接是否正常
- [ ] MySQL连接池是否耗尽
- [ ] 查看日志: `[OIPolling]` 相关信息

### 3. 分表查询失败
**检查项**:
- [ ] 日期表是否存在
- [ ] 查询时间范围是否正确
- [ ] 原始表作为降级是否可用

### 日志关键字
```bash
# 采集日志
[OIPolling] Polling cycle completed

# 异动检测
[OIPolling] Detected X anomalies

# 保存记录
[OIPolling] Saved X anomaly records

# 错误
[ERROR] [OIPolling] Failed to...
```

---

## 📈 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| 采集周期 | 1分钟 | 全天24小时 |
| 单次采集时长 | ~13秒 | 530个币种并发请求 |
| 异动检测耗时 | <1秒 | 基于内存计算 |
| 数据库写入 | <100ms | 批量插入优化 |
| API响应时间 | <200ms | 包含查询+格式化 |

---

## 🚀 未来优化方向

- [ ] 支持自定义异动阈值（按币种）
- [ ] 增加Webhook通知功能
- [ ] 优化去重算法（更精准）
- [ ] 添加异动预测功能（ML）
- [ ] 支持更多时间窗口（30m/1h/4h）

---

## 📝 更新日志

### v1.3.0 (2025-11-14) ⭐ **重大更新**
- ✨ **新增交易信号评分功能**
  - 为每个异动自动计算信号质量评分（0-10分）
  - 包含OI评分、价格评分、情绪评分、资金费率评分
  - 自动识别避免追高情况并记录原因
  - 记录信号方向（LONG/SHORT/NEUTRAL）和置信度
- ✨ **新增每日价格极值跟踪**
  - 实时跟踪每个币种的日内最高价和最低价
  - 内存缓存实现，性能提升50-200倍
  - 自动计算价格相对极值的百分比
  - 用于避免追高追跌的判断
- 🚀 **性能优化**
  - 移除信号生成器中的数据库查询（改用预计算字段）
  - 将async方法改回sync（无需数据库查询）
  - 每次信号生成节省50-200ms
- 📊 **API增强**
  - `/api/oi/recent-anomalies` 接口新增8个字段
  - 新增字段：signal_score, signal_confidence, signal_direction, avoid_chase_reason
  - 新增字段：daily_price_low, daily_price_high, price_from_low_pct, price_from_high_pct

### v1.2.1 (2025-11-13 晚)
- 🐛 **修复资金费率数据无法记录的Bug**
  - 问题：异动记录表中资金费率字段全部为NULL
  - 根因：MySQL返回的decimal字段是string类型，直接运算导致NaN
  - 修复：添加类型检查和parseFloat()转换
- 🚀 **性能优化：消除重复遍历**
  - 优化前：premium_data被遍历3次（save_snapshots + detect_anomalies构建2个Map）
  - 优化后：统一在poll()中构建1次Map，传递给子函数使用
  - 性能提升：减少2次数组遍历（~530个币种）
- ✨ **API完善**
  - 修复 `/api/oi/recent-anomalies` 接口缺失资金费率字段
  - 现在返回完整的anomaly_type和4个资金费率字段

### v1.2.0 (2025-11-13)
- ✨ 新增资金费率数据记录（作为附加数据，不作为异动判断条件）
- ✨ 取消非交易时段降频，全天24小时按1分钟采集
- 🐛 修复跨表查询时区问题（UTC转北京时间）
- 🐛 修复北京时间分表逻辑

### v1.1.0 (2025-11-12)
- ✨ 实现日期分表存储（按北京时间）
- ✨ 添加市场情绪数据收集（大户多空比等）
- 🔧 优化异动去重机制（Redis缓存优先）

### v1.0.0 (2025-09-28)
- 🎉 初始版本发布
- ✨ 基础OI监控功能
- ✨ 异动检测和记录

---

## 🔧 已知问题和解决方案

### 问题1: 资金费率字段为NULL
**现象**: 早期的异动记录中资金费率字段为NULL

**原因**:
1. 数据库返回的decimal类型在Node.js中是string
2. 代码未进行类型转换直接进行数值运算
3. 导致 `number - string = NaN`，保存到数据库变成NULL

**解决**: 已在v1.2.1中修复，新的异动记录会包含完整资金费率数据

**影响范围**: 2025-11-13 早期的异动记录

---

**维护人员**: Trading Master Team
**最后更新**: 2025-11-14
