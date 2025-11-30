# OI监控与实盘交易系统逻辑梳理

## 1. 系统整体架构

```
OI监控服务 (OIPollingService)
    ↓ (60秒轮询一次)
[获取OI数据] → [获取资金费率] → [保存快照] → [检测异动] → [更新交易系统]
    ↓
交易系统 (TradingSystem)
    ↓
[同步币安持仓] → [更新持仓价格] → [检查保本止损] → [检查超时平仓]
```

---

## 2. OI监控服务流程 (OIPollingService)

### 2.1 启动流程
```
start()
  ├─ load_configuration()           // 从数据库加载配置（去重阈值、严重程度等）
  ├─ refresh_symbols()              // 获取启用的币种列表
  ├─ preheat_price_2h_window()      // 预热2小时价格窗口
  ├─ schedule_next_poll()           // 启动定时轮询
  └─ setInterval(refresh_symbols)   // 每2小时刷新币种列表
```

### 2.2 轮询周期 (poll方法)

**执行频率**: 60秒一次（`polling_interval_ms: 60000`）

**轮询步骤**:

```
poll() 执行流程：

1️⃣ 获取OI数据 (权重1 × 币种数)
   ├─ binance_api.get_batch_open_interest()
   └─ 返回: OIPollingResult[]
      {symbol, open_interest, timestamp_ms, ...}

2️⃣ 获取资金费率 (权重10)
   ├─ binance_api.get_all_premium_index()
   └─ 返回: PremiumIndex[]
      {symbol, markPrice, lastFundingRate, nextFundingTime, ...}

3️⃣ 构建数据Map
   └─ premium_map = {BTCUSDT: {markPrice, lastFundingRate, ...}, ...}

4️⃣ 更新2小时价格滑动窗口
   ├─ update_all_price_2h_windows(premium_map)
   └─ 用途: 识别"追高"异动（价格变化超过预期）

5️⃣ 保存OI快照 + 资金费率
   ├─ save_snapshots_with_premium()
   ├─ 表: oi_snapshots
   └─ 保存字段: symbol, open_interest, mark_price, funding_rate, timestamp

6️⃣ 检测OI异动
   ├─ detect_anomalies(oi_results, premium_map)
   ├─ 对比: 当前OI vs 历史OI (不同时间周期)
   ├─ 检查: 资金费率、价格变化、OI变化百分比
   └─ 输出: 异动记录 (symbol, percent_change, severity, period_minutes)

7️⃣ 保存异动记录
   ├─ save_anomalies()
   └─ 表: oi_anomalies

8️⃣ 缓存预热
   └─ preheat_statistics_cache()
      预先查询和缓存统计数据（例如异动数量、严重程度分布等）

9️⃣ 更新交易系统持仓价格
   └─ if (trading_system) {
        await update_trading_positions(premium_map)
      }

      这里的 premium_map 包含所有币种的最新mark_price
      用于: 更新持仓当前价格、触发保本止损、检查超时平仓
```

### 2.3 API使用量统计

每轮询一次 (60秒):
- `get_batch_open_interest()`: 权重 1 × 531个币种 ≈ 531
- `get_all_premium_index()`: 权重 10 × 1 ≈ 10
- **总权重**: 541 / 2400 = 22.5% 的配额

**结论**: OI轮询的API权重占用不多，可以保持60秒间隔

---

## 3. 交易系统中的持仓管理 (TradingSystem)

### 3.1 持仓同步流程 (sync_positions_from_binance)

**问题**: 目前这个方法定义了但**没有被定时调用**！

**应该被调用的地方**: 需要某个地方每10秒调用一次

**同步流程**:

```
sync_positions_from_binance()
  ├─ 获取币安实际持仓: get_binance_positions()
  │  └─ 调用 /fapi/v2/positionRisk (权重5)
  │  └─ 返回: {symbol, positionAmt, entryPrice, leverage, side, unrealizedProfit, ...}
  │
  ├─ 获取本地持仓: position_tracker.get_open_positions()
  │
  ├─ 对比1: 币安有但本地没有 (外部开仓的持仓)
  │  └─ 调用 add_synced_position() 添加到本地内存
  │
  ├─ 对比2: 本地有但币安没有 (已被平仓)
  │  ├─ 撤销该币种所有未成交的止盈/止损挂单
  │  ├─ 从币安查询精确的平仓数据
  │  ├─ 标记本地持仓为已关闭
  │  └─ 将平仓记录保存到 order_records 表
  │
  └─ 对比3: 币安和本地都有 (同步更新)
     └─ 更新 unrealized_pnl 和 unrealized_pnl_percent
        ├─ 计算: current_margin = entry_price × quantity / leverage
        ├─ 获取: unrealized_pnl 来自币安的 unrealizedProfit
        └─ 计算: unrealized_pnl_percent = unrealized_pnl / margin × 100
```

### 3.2 保本止损机制 (try_place_breakeven_stop_loss)

**触发条件**:
```
if (unrealized_pnl_percent >= 10 && !breakeven_sl_placed) {
  await try_place_breakeven_stop_loss(position)
}
```

**当前检查频率**: 同步时检查一次 ❌ **问题：没被定时调用！**

**止损价格计算**:
```
fee_compensation_rate = 0.0015 (0.15%)

如果 LONG:
  breakeven_price = entry_price × (1 + 0.0015)
  = 开仓价 + 0.15%
  解释: 覆盖开仓手续费(0.05%) + 平仓手续费(0.05%) + 滑点(0.05%)

如果 SHORT:
  breakeven_price = entry_price × (1 - 0.0015)
  = 开仓价 - 0.15%
```

**下单逻辑**:
```
1. 先检查是否已有止损单 (通过币安API查询)
2. 如果已存在 → 只标记 breakeven_sl_placed = true
3. 如果不存在 → 下 STOP_MARKET 订单
   ├─ stopPrice = breakeven_price
   ├─ reduceOnly = true (只能平仓)
   └─ quantity = position.quantity (全部头寸)
4. 标记 breakeven_sl_placed = true
```

---

## 4. 持仓价格更新流程 (update_positions)

**调用来源**: OI轮询时每60秒调用一次

**流程**:

```
update_positions(price_map)
  // price_map 来自 premium_map，包含所有币种的markPrice

  ├─ 更新所有持仓的当前价格
  │  ├─ 调用: position_tracker.update_all_positions_prices(price_map)
  │  ├─ 作用: 更新持仓的 current_price 和 unrealized_pnl
  │  └─ 触发: 检查止盈止损条件（Trailing Stop等）
  │
  └─ 检查超时平仓
     ├─ 调用: check_and_close_timeout_positions(price_map)
     ├─ 条件: holding_time_minutes >= max_holding_time_minutes
     ├─ 逻辑:
     │  ├─ 1. 撤销所有未成交挂单
     │  ├─ 2. 市价平仓
     │  └─ 3. 保存平仓记录
     └─ 注意: 这里不检查保本止损！
```

---

## 5. 完整的时间线

### 时间轴

```
T=0s   启动交易系统
       ├─ 初始化 trading_system
       └─ 启动 OI 监控服务

T=60s  第1次OI轮询执行
       ├─ 获取OI、资金费率
       ├─ 保存快照、检测异动
       └─ 调用 update_trading_positions(premium_map) ← 只更新价格和超时检查
           不会调用 sync_positions_from_binance() ❌

T=120s 第2次OI轮询执行
       └─ 同上

...

每60秒一次轮询
- 更新持仓价格 ✅ (每60秒)
- 检查超时平仓 ✅ (每60秒)
- 检查保本止损 ❌ (从未被执行！)
- 同步币安持仓 ❌ (从未被执行！)
```

---

## 6. 关键问题分析

### 问题1: 保本止损检查频率太低

**现状**:
- 保本止损是在 `sync_positions_from_binance()` 中检查的
- 但 `sync_positions_from_binance()` 从未被定时调用
- 结果: 保本止损永远不会被触发！❌

**后果**:
- 即使盈利达到10%，也不会自动下保本止损单
- 用户需要手动在币安下单

### 问题2: 手动平仓后本地持仓不同步

**现状**:
- 用户在币安网页手动平仓后
- 本地持仓仍然显示为开仓状态
- 需要等待某次同步才能更新

**原因**: 没有定时同步

### 问题3: 外部开仓检测延迟

**现状**:
- 用户在币安网页直接开仓
- 本地不知道这个仓位存在
- 需要等待同步才能发现

**原因**: 没有定时同步

---

## 7. 数据流和API调用汇总

### 每轮询一次 (60秒)

| 操作 | API | 权重 | 频率 | 总和 |
|------|-----|------|------|------|
| 获取OI | `get_batch_open_interest` | 1 | 531个币种 | 531 |
| 获取资金费率 | `get_all_premium_index` | 10 | 1次 | 10 |
| **OI轮询小计** | | | | **541/轮** |

### 如果每10秒同步一次 (新增)

| 操作 | API | 权重 | 频率 | 总和 |
|------|-----|------|------|------|
| 获取持仓 | `positionRisk` | 5 | 1次 | 5 |
| **同步小计** | | | | **5/轮** |
| **总计 (60秒内)** | | | | 541 + (5×6) = **571** |

**配额占用**: 571 / 2400 = 23.8% ✅ 仍在安全范围内

---

## 8. 建议的改进方案

### 方案: 在OI轮询中添加同步逻辑

```typescript
// 在 oi_polling_service.ts 中修改

private async poll(): Promise<void> {
  // ... 现有的OI监控逻辑 ...

  // 9️⃣ 更新交易系统持仓价格（检查超时平仓、保本止损）
  if (this.trading_system) {
    // ⭐ 添加: 每轮询一次就同步币安持仓
    // 注: OI轮询60秒一次，相当于每60秒同步一次持仓
    await this.trading_system.sync_positions_from_binance();

    // 再更新持仓价格和检查超时
    await this.update_trading_positions(premium_map);
  }
}
```

**效果**:
- 保本止损检查: 每60秒一次 (改进)
- 手动平仓同步: 每60秒一次 (改进)
- 外部开仓检测: 每60秒一次 (改进)
- API额度: 571/2400 = 23.8% ✅

### 备选方案: 单独的10秒同步定时器

如果想要更频繁的保本止损检查 (10秒一次):

```typescript
// 在 oi_polling_service.ts 中添加

private sync_timer: NodeJS.Timeout | null = null;

start() {
  // ... 现有逻辑 ...

  // 启动单独的同步定时器 (10秒一次)
  this.sync_timer = setInterval(async () => {
    if (this.trading_system && this.is_running) {
      try {
        await this.trading_system.sync_positions_from_binance();
      } catch (error) {
        logger.error('[OIPolling] Position sync failed:', error);
      }
    }
  }, 10000); // 10秒
}
```

**效果**:
- 保本止损检查: 每10秒一次 (更快)
- API额度: 541 + (5×6) = 571/2400 = 23.8% ✅ (如果OI也是60秒)
          或者 541 + (5×360) = 2341/2400 = 97.5% ❌ (接近限制)

**结论**: 备选方案如果OI和同步同时都是高频会有风险，建议用方案1

---

## 9. 保本止损的执行时序

假设用户在10:00:00开仓BTCUSDT，盈利达到10%:

```
10:00:00  开仓 @ 100USDT, 盈利 0%

10:00:30  OI轮询 #1 (盈利 5%)
          - 更新价格
          - 检查超时
          ✗ 不检查保本止损 (因为没调用sync)

10:01:00  OI轮询 #2 (盈利 10%) ← 达到触发条件
          - 更新价格
          - 检查超时
          ✗ 不检查保本止损 (因为没调用sync)

... 用户仍未设置保本止损 ...

10:05:00  用户手动平仓于 110USDT
          本地仍显示开仓状态 ✗

10:06:00  OI轮询 (突然发现币安无该仓位)
          - 撤销挂单
          - 查询平仓数据
          - 标记为已关闭 ✓ (延迟了1分钟)
```

---

## 10. 改进后的执行时序 (方案1)

```
10:00:00  开仓 @ 100USDT, 盈利 0%

10:00:30  OI轮询 #1 (盈利 5%)
          - 同步币安持仓 ← 新增
          - 更新价格
          - 检查超时

10:01:00  OI轮询 #2 (盈利 10%) ← 达到触发条件
          - 同步币安持仓 ← 在这里检查保本止损！
          - 检查: unrealized_pnl_percent >= 10? YES
          - 行动: 下保本止损单 @ 100.15USDT ✓
          - 更新价格
          - 检查超时

10:05:00  用户手动平仓于 110USDT
          保本止损单被手动撤销或未成交

10:06:00  OI轮询 (发现币安无该仓位)
          - 同步币安持仓 ← 立即发现平仓
          - 撤销剩余挂单
          - 查询平仓数据
          - 标记为已关闭 ✓ (仅延迟了1分钟)
```

---

## 总结

| 功能 | 当前状态 | 频率 | 问题 |
|------|---------|------|------|
| OI异动检测 | ✅ 工作 | 60秒 | 无 |
| 持仓价格更新 | ✅ 工作 | 60秒 | 无 |
| 超时平仓检查 | ✅ 工作 | 60秒 | 无 |
| 保本止损检查 | ❌ 不工作 | 从未 | 需要调用sync |
| 持仓同步 | ❌ 不工作 | 从未 | 需要调用sync |
| 手动平仓同步 | ❌ 缓慢 | 从未 | 需要调用sync |

**建议**: 在OI轮询的poll()方法中调用 `sync_positions_from_binance()`，每60秒执行一次
