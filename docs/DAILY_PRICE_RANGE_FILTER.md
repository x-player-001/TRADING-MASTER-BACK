# 当天价格极值过滤功能文档

## 📋 功能概述

在生成交易信号时，系统会自动检查当前价格相对于当天最高价和最低价的变化幅度。如果价格已经从日内极值变化超过10%，则拒绝该信号，避免追高或追跌。

## ✅ 实现细节

### 核心逻辑

```typescript
// 如果价格从日内低点已涨超过10% → 拒绝做多
if ((current_price - daily_low) / daily_low * 100 > 10) {
  return { allowed: false, reason: '价格从日内低点已涨XX% (>10%), 避免追高' };
}

// 如果价格从日内高点已跌超过10% → 拒绝做空
if ((daily_high - current_price) / daily_high * 100 > 10) {
  return { allowed: false, reason: '价格从日内高点已跌XX% (>10%), 避免追跌' };
}
```

### 数据来源

- 使用 `oi_snapshots_YYYY_MM_DD` 日期分表
- 查询当天所有快照的 `mark_price` 字段
- 计算日内最高价 (`daily_high`) 和最低价 (`daily_low`)

### 检查流程

```
异动检测 → 信号评分计算 → 避免追高检查 → 当天价格极值检查 → 其他策略检查
                                        ↓
                            如果涨跌幅 > 10% → 拒绝信号
```

## 🔧 代码实现

### 1. SignalGenerator 新增方法

**文件**: [src/trading/signal_generator.ts](src/trading/signal_generator.ts#L509-L573)

```typescript
/**
 * 检查当天价格极值（避免追高）
 * 如果当前价格相比当天最低/最高价已经变化超过10%，则拒绝入场
 */
private async check_daily_price_range(
  symbol: string,
  current_price: number,
  anomaly_time: Date
): Promise<{ allowed: boolean; reason?: string }> {
  // 1. 查询当天的所有OI快照
  const snapshots = await this.oi_repository.get_symbol_oi_curve(symbol, today_date);

  // 2. 提取所有价格数据
  const prices = snapshots.map(s => s.mark_price).filter(...);

  // 3. 计算当天最高价和最低价
  const daily_high = Math.max(...prices);
  const daily_low = Math.min(...prices);

  // 4. 计算涨跌幅并判断
  const rise_from_low = ((current_price - daily_low) / daily_low) * 100;
  const fall_from_high = ((daily_high - current_price) / daily_high) * 100;

  if (rise_from_low > 10) {
    return { allowed: false, reason: '价格从日内低点已涨XX%, 避免追高' };
  }

  if (fall_from_high > 10) {
    return { allowed: false, reason: '价格从日内高点已跌XX%, 避免追跌' };
  }

  return { allowed: true };
}
```

### 2. 集成到避免追高检查

**文件**: [src/trading/signal_generator.ts](src/trading/signal_generator.ts#L103-L121)

```typescript
private async check_avoid_chase_high(anomaly: OIAnomalyRecord): Promise<...> {
  // ❌ 新增：检查当天价格极值（如果价格已经变化超过10%就不入场）
  if (this.oi_repository && anomaly.price_after) {
    try {
      const daily_price_check = await this.check_daily_price_range(
        anomaly.symbol,
        anomaly.price_after,
        anomaly.anomaly_time
      );
      if (!daily_price_check.allowed) {
        return {
          allowed: false,
          reason: daily_price_check.reason
        };
      }
    } catch (error) {
      logger.warn('Failed to check daily price range:', error);
      // 查询失败不影响信号（继续执行其他检查）
    }
  }

  // ... 继续执行其他避免追高检查
}
```

### 3. OIPollingService 设置 Repository

**文件**: [src/services/oi_polling_service.ts](src/services/oi_polling_service.ts#L64-L70)

```typescript
constructor() {
  this.binance_api = new BinanceFuturesAPI(this.config.max_concurrent_requests);
  this.oi_repository = new OIRepository();
  this.signal_generator = new SignalGenerator();
  // 设置signal_generator的repository（用于查询当天价格极值）
  this.signal_generator.set_oi_repository(this.oi_repository);
}
```

## 📊 使用示例

### 示例1：拒绝追高

```typescript
// 当天价格数据
daily_low = 89500.00  // 日内最低价
daily_high = 92000.00  // 日内最高价
current_price = 99000.00  // 当前价格

// 计算涨幅
rise_from_low = (99000 - 89500) / 89500 * 100 = 10.61%

// 结果：拒绝
reason = "价格从日内低点89500.0000已涨10.6% (>10%), 避免追高"
```

### 示例2：拒绝追跌

```typescript
// 当天价格数据
daily_low = 89500.00  // 日内最低价
daily_high = 92000.00  // 日内最高价
current_price = 82500.00  // 当前价格

// 计算跌幅
fall_from_high = (92000 - 82500) / 92000 * 100 = 10.33%

// 结果：拒绝
reason = "价格从日内高点92000.0000已跌10.3% (>10%), 避免追跌"
```

### 示例3：允许入场

```typescript
// 当天价格数据
daily_low = 89500.00  // 日内最低价
daily_high = 92000.00  // 日内最高价
current_price = 91000.00  // 当前价格

// 计算涨跌幅
rise_from_low = (91000 - 89500) / 89500 * 100 = 1.68%  ✅ < 10%
fall_from_high = (92000 - 91000) / 92000 * 100 = 1.09%  ✅ < 10%

// 结果：允许
```

## 🎯 应用场景

### 场景1：日内反弹
```
价格轨迹: 100000 → 90000 (跌10%) → 当前93000
rise_from_low = 3.3% ✅ 允许做多
```

### 场景2：已经涨太多
```
价格轨迹: 100000 → 当前111000
rise_from_low = 11% ❌ 拒绝做多（避免追高）
```

### 场景3：已经跌太多
```
价格轨迹: 100000 → 当前89000
fall_from_high = 11% ❌ 拒绝做空（避免追跌）
```

## ⚙️ 配置参数

### 当前阈值
```typescript
const DAILY_RANGE_THRESHOLD = 10;  // 10% 阈值
```

### 未来可扩展配置
```typescript
// 可以根据币种市值调整阈值
const thresholds = {
  BTC: 8,    // 大市值币种用更严格的阈值
  ETH: 10,   // 中等市值
  ALTCOIN: 15  // 小市值币种用更宽松的阈值
};
```

## 🔍 调试日志

系统会输出详细的检查日志：

```typescript
// 查询成功
[SignalGenerator] BTCUSDT daily range check: low=89500, high=92000, current=99000, rise=10.6%
[SignalGenerator] Avoid chasing high: 价格从日内低点89500.0000已涨10.6% (>10%), 避免追高 for BTCUSDT

// 查询失败（不影响信号）
[SignalGenerator] Failed to check daily price range for BTCUSDT: Table not found
[SignalGenerator] Continue with other checks...
```

## 📈 性能考虑

### 查询优化
- ✅ 使用日期分表，每次只查询当天数据（约1440条记录）
- ✅ 仅提取 `mark_price` 字段，减少数据传输
- ✅ 查询失败不影响信号生成（容错设计）

### 预期性能
- 单次价格极值查询: **< 50ms**
- 对整体信号生成的影响: **< 5%**
- 缓存优化空间: 可缓存当天的 `daily_high` 和 `daily_low`

## 🔄 容错机制

### 1. 没有历史数据
```typescript
if (snapshots.length === 0) {
  return { allowed: true };  // 跳过检查
}
```

### 2. 没有价格数据
```typescript
if (prices.length === 0) {
  return { allowed: true };  // 跳过检查
}
```

### 3. Repository 未设置
```typescript
if (!this.oi_repository) {
  return { allowed: true };  // 跳过检查
}
```

### 4. 查询异常
```typescript
try {
  const check_result = await this.check_daily_price_range(...);
} catch (error) {
  logger.warn('Failed to check daily price range:', error);
  // 继续执行其他检查，不因查询失败而拒绝信号
}
```

## 📊 与其他过滤器的关系

### 过滤器优先级
```
1. ✅ 当天价格极值检查 (10%)      ← 新增
2. ✅ 晚期狂欢检查 (OI>20%, 价格>15%)
3. ✅ 背离危险检查 (OI>8%, 价格<1%)
4. ✅ 大户反向检查
5. ✅ 信号评分检查 (score >= 7)
```

### 组合示例
```typescript
// 同时满足多个条件才允许入场
✅ 价格从日内低点涨幅 < 10%
✅ OI变化在5-15%之间
✅ 价格变化在2-6%之间
✅ OI和价格同向
✅ 大户多空比支持
✅ 信号总分 >= 7分
```

## 🎉 总结

该功能通过检查当天价格极值，有效避免了在价格已经大幅上涨或下跌后才入场的情况，从而：

1. ✅ **降低风险** - 避免在高位做多、低位做空
2. ✅ **提高胜率** - 抓住早期启动机会
3. ✅ **优化盈亏比** - 避免追高追跌导致的大额止损
4. ✅ **完善策略** - 与其他过滤器形成多层防护

现在，系统会在每次生成信号时自动检查价格是否已经涨跌太多，确保只在合适的时机入场！🚀
