# 资金费率数据采集实现文档

## 📋 实施概述

**日期**: 2025-11-12
**版本**: v1.0.0
**状态**: ✅ 代码实现完成，待数据库迁移和测试

---

## 🎯 实施目标

在现有OI（持仓量）监控系统基础上，新增资金费率数据采集功能，实现：
1. 每分钟批量获取所有币种的标记价格和资金费率
2. 与OI数据合并存储到同一张表
3. 优化API调用，控制在币安免费额度内

---

## 📊 API调用优化

### 方案对比

| 方案 | 每分钟调用 | 每分钟权重 | 占用额度 | 选择 |
|------|-----------|-----------|---------|------|
| 单币种查询 | 530 OI + 530 资金费率 = 1060 | 1060 | 44.2% | ❌ |
| **批量查询** | 530 OI + 1 资金费率 = 531 | **540** | **22.5%** | ✅ |

### 最终配置

```typescript
// 每分钟API调用
530个 × GET /fapi/v1/openInterest?symbol=X    // 权重: 530
1个  × GET /fapi/v1/premiumIndex              // 权重: 10
-------------------------------------------------
总计: 540权重/分钟 (占币安免费额度2400的22.5%)
```

### 并发优化

- **原配置**: 50并发 → 约11秒完成530个请求（接近10秒限制）
- **新配置**: 40并发 → 约13秒完成530个请求（更安全）✅

---

## 🔧 代码修改清单

### 1. 类型定义 ✅

**文件**: `src/types/oi_types.ts`

```typescript
// 扩展OI快照数据接口
export interface OpenInterestSnapshot {
  // ... 原有字段

  // 新增字段（可选，向后兼容）
  mark_price?: number;          // 标记价格
  funding_rate?: number;        // 资金费率
  next_funding_time?: number;   // 下次资金费时间
}

// 新增币安API响应类型
export interface BinancePremiumIndexResponse {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  // ... 其他字段
}
```

### 2. API层 ✅

**文件**: `src/api/binance_futures_api.ts`

**新增方法**:
```typescript
// 批量获取所有币种的资金费率（权重10）
async get_all_premium_index(): Promise<BinancePremiumIndexResponse[]>

// 获取单个币种的资金费率（权重1）
async get_premium_index(symbol: string): Promise<BinancePremiumIndexResponse>
```

### 3. 数据库层 ✅

#### 表结构创建

**文件**: `src/database/daily_table_manager.ts`

**修改**: 创建表时自动包含新字段
```sql
CREATE TABLE open_interest_snapshots_YYYYMMDD (
  -- 原有字段...
  mark_price DECIMAL(20,8) NULL,
  funding_rate DECIMAL(10,8) NULL,
  next_funding_time BIGINT NULL,
  -- ...
);
```

#### Repository层

**文件**: `src/database/oi_repository.ts`

**修改**: 批量插入包含新字段
```typescript
async batch_save_snapshots(snapshots[]) {
  // 扩展到8个字段
  VALUES (symbol, open_interest, timestamp_ms, snapshot_time, data_source,
          mark_price, funding_rate, next_funding_time)
}
```

### 4. 服务层 ✅

**文件**: `src/services/oi_polling_service.ts`

#### 配置优化
```typescript
max_concurrent_requests: 40  // 从50降到40
```

#### 轮询逻辑修改
```typescript
private async poll() {
  // 1. 获取OI数据（530个请求）
  const oi_results = await this.binance_api.get_batch_open_interest(symbols);

  // 2. 批量获取资金费率（1个请求）⭐ 新增
  const premium_data = await this.binance_api.get_all_premium_index();

  // 3. 合并数据并保存
  await this.save_snapshots_with_premium(oi_results, premium_data);
}
```

#### 新增方法
```typescript
private async save_snapshots_with_premium(
  oi_results: OIPollingResult[],
  premium_data: BinancePremiumIndexResponse[]
) {
  // 构建Map快速查找
  const premium_map = new Map(premium_data.map(p => [p.symbol, p]));

  // 合并数据
  const snapshots = oi_results.map(result => {
    const premium = premium_map.get(result.symbol);
    return {
      ...result,
      mark_price: premium ? parseFloat(premium.markPrice) : undefined,
      funding_rate: premium ? parseFloat(premium.lastFundingRate) : undefined,
      next_funding_time: premium?.nextFundingTime
    };
  });

  await this.oi_repository.batch_save_snapshots(snapshots);
}
```

---

## 🗄️ 数据库迁移

### 迁移脚本

**文件**: `database/migrations/add_funding_rate_columns.sql`

### 执行步骤

```sql
-- 1. 修改原始表（兜底表）
ALTER TABLE open_interest_snapshots
ADD COLUMN mark_price DECIMAL(20,8) NULL COMMENT '标记价格',
ADD COLUMN funding_rate DECIMAL(10,8) NULL COMMENT '资金费率',
ADD COLUMN next_funding_time BIGINT NULL COMMENT '下次资金费时间';

-- 2. 修改所有已存在的日期分表
-- 示例：
ALTER TABLE open_interest_snapshots_20251112
ADD COLUMN mark_price DECIMAL(20,8) NULL,
ADD COLUMN funding_rate DECIMAL(10,8) NULL,
ADD COLUMN next_funding_time BIGINT NULL;

-- 重复上述语句为每个日期表添加字段
```

### 注意事项

1. ✅ **向后兼容**: 新字段允许NULL，不影响旧数据
2. ✅ **自动创建**: 未来新建的日期表自动包含这些字段
3. ⚠️ **手动迁移**: 需要手动为已存在的日期表添加字段
4. 📝 **执行时机**: 建议在业务低峰期执行

---

## 📦 数据存储示例

### 存储前（仅OI）
```
| symbol   | open_interest | mark_price | funding_rate | next_funding_time |
|----------|---------------|------------|--------------|-------------------|
| BTCUSDT  | 12345.67      | NULL       | NULL         | NULL              |
```

### 存储后（OI + 资金费率）
```
| symbol   | open_interest | mark_price | funding_rate | next_funding_time |
|----------|---------------|------------|--------------|-------------------|
| BTCUSDT  | 12345.67      | 89234.56   | 0.00010000   | 1731312000000     |
| ETHUSDT  | 23456.78      | 3421.12    | 0.00008000   | 1731312000000     |
```

---

## 📊 性能指标

### API调用统计

| 指标 | 数值 |
|------|------|
| 每分钟请求数 | 531次 |
| 每分钟权重 | 540 |
| 占用额度比例 | 22.5% |
| 剩余额度 | 77.5% (1860权重) |
| OI请求耗时 | 约13秒 (40并发) |
| 资金费率耗时 | <1秒 (1次请求) |

### 数据量预估

| 项目 | 数值 |
|------|------|
| 监控币种数 | 530个 |
| 每分钟快照数 | 530条 |
| 每小时快照数 | 31,800条 |
| 每天快照数 | 763,200条 |
| 单条记录大小 | ~100字节 |
| 每天数据量 | ~73MB |

---

## ✅ 实施检查清单

### 代码层面
- [x] 更新TypeScript类型定义
- [x] 添加BinanceFuturesAPI资金费率接口
- [x] 修改DailyTableManager表创建逻辑
- [x] 更新OIRepository批量保存方法
- [x] 修改OIPollingService轮询逻辑
- [x] 优化并发配置（50→40）
- [x] 生成数据库迁移SQL脚本

### 数据库层面
- [ ] 执行数据库迁移脚本
- [ ] 验证原始表结构
- [ ] 迁移所有已存在的日期分表
- [ ] 确认新表自动包含新字段

### 测试验证
- [ ] 编译TypeScript代码
- [ ] 启动OI监控服务
- [ ] 验证资金费率数据获取
- [ ] 检查数据库存储
- [ ] 监控API调用权重
- [ ] 验证异常处理
- [ ] 检查日志输出

### 监控指标
- [ ] 监控响应头 `X-MBX-USED-WEIGHT-1m`
- [ ] 确认权重在540左右
- [ ] 检查是否收到429错误
- [ ] 验证数据完整性

---

## 🔄 后续优化建议

### 短期优化
1. ✅ 实施响应头监控（记录权重使用情况）
2. ✅ 添加429错误自动退避机制
3. ✅ 完善日志输出（区分OI和资金费率）

### 长期优化
1. 考虑缓存热点资金费率数据
2. 实现资金费率异动检测
3. 添加资金费率相关API接口
4. 前端展示资金费率曲线图
5. 申请VIP等级提升API限额

---

## 📞 问题排查

### 常见问题

**Q: 资金费率数据为NULL？**
A: 检查币种是否在premium_data中，或币安API是否返回该币种数据

**Q: API调用超限429错误？**
A: 检查并发配置，确认为40；检查响应头权重使用情况

**Q: 日期表没有新字段？**
A: 需要手动执行迁移SQL为已存在的表添加字段

**Q: 数据存储失败？**
A: 检查Repository日志，确认SQL语句是否正确执行

---

## 📚 相关文档

- [币安期货API文档](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [OI监控模块总览](../CLAUDE.md#oi监控)
- [数据库迁移脚本](../database/migrations/add_funding_rate_columns.sql)
- [API速率限制分析](./BINANCE_API_USAGE_ANALYSIS.md)

---

**实施完成日期**: 2025-11-12
**实施人员**: Claude
**审核状态**: 待测试验证
