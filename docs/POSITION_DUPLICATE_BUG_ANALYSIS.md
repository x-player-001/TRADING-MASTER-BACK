# 持仓重复Bug分析

## 修改时间
2025-11-26 23:30

## Bug描述

回测中发现CROSSUSDT在7分钟内开了4个仓位，违反了配置 `max_positions_per_symbol: 2`

### 实际案例
```
Config: max_positions_per_symbol: 2

实际开仓:
Position 1: 00:37:37 → 00:45:50 (持仓8分13秒)
Position 2: 00:39:41 → 00:46:53 (持仓7分12秒)
Position 3: 00:41:46 → 00:46:53 (持仓5分7秒)
Position 4: 00:43:54 → 00:47:56 (持仓4分2秒)
```

**关键发现**: 4个仓位在真实时间上有重叠（都在00:37-00:48之间持仓），但回测引擎允许了它们全部开仓。

---

## 根本原因分析

### 回测引擎的处理流程

```typescript
// backtest_engine.ts 主循环 (lines 73-206)
for (const anomaly of anomalies) {
  // 1. 生成信号
  const signal = this.signal_generator.generate_signal(anomaly);

  // 2. 策略评估
  const strategy_result = this.strategy_engine.evaluate_signal(signal);

  // 3. 风险检查 ⚠️ 问题所在
  const risk_check = this.risk_manager.can_open_position(
    signal,
    open_positions,  // 只检查当前未平仓的
    balance,
    anomaly.anomaly_time
  );

  // 4. 防重复检查（10秒窗口）⚠️ 问题所在
  const has_recent_position = [...open_positions, ...closed_positions].some(pos => {
    if (pos.symbol !== signal.symbol) return false;
    const time_diff = Math.abs(anomaly.anomaly_time.getTime() - pos.opened_at.getTime());
    return time_diff < 10 * 1000;  // 只检查10秒内
  });

  // 5. 开仓
  open_positions.push(position);

  // 6. 模拟完整持仓周期（0-12小时）
  const exit_result = await this.simulate_position_holding(
    position,
    anomaly.anomaly_time,
    config
  );

  // 7. 平仓（在backtest时间线上立即完成）
  position.is_open = false;
  open_positions.splice(index, 1);  // 从open_positions移除
  closed_positions.push(position);  // 加入closed_positions

  // 8. 继续处理下一个异动 ⚠️ 此时open_positions已经不包含刚才的仓位
}
```

### Bug的双重原因

#### 原因1: 风险管理器只检查 `open_positions`

```typescript
// risk_manager.ts lines 97-103
const symbol_positions = open_positions.filter(p => p.symbol === signal.symbol);
if (symbol_positions.length >= this.config.max_positions_per_symbol) {
  return { allowed: false, reason: '...' };
}
```

**问题**: 在回测循环中，每个仓位在模拟完成后立即从 `open_positions` 移除。所以当处理下一个异动时，`open_positions` 总是空的或者不包含已处理的仓位。

#### 原因2: 防重复窗口太小（10秒）

```typescript
// backtest_engine.ts lines 104-109
const recent_time_window = 10 * 1000; // 10秒
const time_diff = Math.abs(anomaly.anomaly_time.getTime() - pos.opened_at.getTime());
return time_diff < recent_time_window;
```

**问题**: CROSSUSDT的4个异动间隔为2分钟左右，远超10秒窗口。

### 为什么会有重叠持仓？

虽然在**回测循环的处理顺序**上，仓位是串行处理的（先开后关再处理下一个），但在**真实时间维度**上：

```
真实时间轴:
00:37  00:39  00:41  00:43  00:45  00:46  00:47
  |      |      |      |      |      |      |
  P1开   P2开   P3开   P4开   P1关   P2关   P3关   P4关
  |===============================|  P1持仓
         |===========================|  P2持仓
                |=====================|  P3持仓
                       |===============|  P4持仓
```

在00:43时刻，**真实交易场景下应该有4个仓位同时存在**，但配置要求最多2个！

---

## 核心问题

**回测引擎的模拟方式与真实交易场景脱节**：

- **回测循环**: 串行处理，每个仓位"瞬间"完成整个生命周期（开仓→持有→平仓），然后处理下一个
- **真实交易**: 并发持仓，多个仓位在时间上重叠存在

当前的 `open_positions` 只反映"回测循环中尚未处理完的仓位"，而不是"在该时间点真实存在的仓位"。

---

## 修复方案

### 方案1: 修改风险检查逻辑（推荐）✅

在风险管理器检查时，不仅要检查 `open_positions`，还要检查在**当前异动时间点**，有多少仓位在真实时间维度上是开着的。

```typescript
// risk_manager.ts 修改 can_open_position 方法
public can_open_position(
  signal: TradingSignal,
  current_positions: PositionRecord[],
  balance: number,
  current_time: Date  // 新增：当前回测时间
): RiskCheckResult {
  // ... 其他检查 ...

  // 5. 检查单币种持仓数量（考虑时间重叠）✨
  const symbol_positions = current_positions.filter(p => {
    if (p.symbol !== signal.symbol) return false;

    // 检查该仓位在 current_time 是否还存在
    if (p.is_open) return true;  // 未平仓的肯定存在

    // 已平仓的，检查是否在时间上重叠
    if (p.closed_at) {
      return p.opened_at <= current_time && p.closed_at > current_time;
    }

    return false;
  });

  if (symbol_positions.length >= this.config.max_positions_per_symbol) {
    return {
      allowed: false,
      reason: `Maximum positions for ${signal.symbol} (${this.config.max_positions_per_symbol}) reached at ${current_time.toISOString()}`
    };
  }

  // ...
}
```

### 方案2: 扩大防重复窗口

将10秒窗口扩大到最大持仓时间（12小时）：

```typescript
// backtest_engine.ts lines 104-109
const recent_time_window = config.max_holding_time_minutes * 60 * 1000; // 12小时
```

**问题**: 这会完全阻止同一币种在12小时内开第二个仓位，过于严格。

### 方案3: 修改回测引擎状态管理

维护一个"时间窗口内的所有仓位"列表，而不是简单的开/关两个列表。

---

## 推荐修复

**采用方案1** - 修改风险管理器的检查逻辑：

1. **传入当前回测时间**: `can_open_position()` 方法需要知道当前异动的时间
2. **检查时间重叠**: 不仅检查 `is_open`，还要检查已平仓但在时间上重叠的仓位
3. **传入完整历史**: `current_positions` 参数应包含 `open_positions + closed_positions`

### 具体修改

#### 文件1: `src/trading/risk_manager.ts`

```typescript
// 修改方法签名，新增 current_time 参数
public can_open_position(
  signal: TradingSignal,
  all_positions: PositionRecord[],  // 改名：包含open+closed
  balance: number,
  current_time: Date  // 新增：当前回测时间
): RiskCheckResult
```

#### 文件2: `src/trading/backtest_engine.ts`

```typescript
// line 90-95: 传入完整仓位列表 + 当前时间
const risk_check = this.risk_manager.can_open_position(
  signal,
  [...open_positions, ...closed_positions],  // 传入全部仓位
  balance,
  anomaly.anomaly_time  // 当前异动时间
);
```

---

## 预期效果

修复后，对于CROSSUSDT案例：

```
00:37:37 - 异动1到达
  检查: 无重叠仓位
  结果: ✅ 开仓 Position 1

00:39:41 - 异动2到达
  检查: Position 1 在00:39时刻仍存在 (00:37开，00:45关)
  结果: ✅ 开仓 Position 2 (总数1+1=2, 未超限)

00:41:46 - 异动3到达
  检查: Position 1和2 在00:41时刻都存在
  结果: ❌ 拒绝 "Maximum positions for CROSSUSDT (2) reached"

00:43:54 - 异动4到达
  检查: Position 1和2 在00:43时刻都存在
  结果: ❌ 拒绝 "Maximum positions for CROSSUSDT (2) reached"
```

最终: CROSSUSDT只会开2个仓位，符合配置！

---

## 下一步

1. 实施方案1的代码修改
2. 重新运行回测，验证修复效果
3. 检查是否有其他币种也存在此问题

