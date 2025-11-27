# 持仓重复Bug修复报告

## 修改时间
2025-11-26 23:35

## Bug描述

回测中发现CROSSUSDT在7分钟内开了4个仓位，违反了配置 `max_positions_per_symbol: 2`

**实际案例**:
```
Config: max_positions_per_symbol: 2

实际开仓（修复前）:
Position 1: 00:37:37 → 00:45:50 (持仓8分13秒)
Position 2: 00:39:41 → 00:46:53 (持仓7分12秒) ❌ 超限
Position 3: 00:41:46 → 00:46:53 (持仓5分7秒) ❌ 超限
Position 4: 00:43:54 → 00:47:56 (持仓4分2秒) ❌ 超限
```

---

## 根本原因

回测引擎的处理方式与真实交易场景存在本质差异：

### 回测引擎的处理模式
```typescript
for (const anomaly of anomalies) {
  // 1. 开仓
  open_positions.push(position);

  // 2. 模拟完整生命周期（0-12小时）
  const exit_result = await simulate_position_holding(position, ...);

  // 3. 立即平仓（在回测循环中）
  position.is_open = false;
  open_positions.splice(index, 1);
  closed_positions.push(position);

  // 4. 处理下一个异动 ← 此时open_positions已经不包含刚才的仓位
}
```

### 真实交易场景
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

**问题**: 回测循环中，每个仓位瞬间完成整个生命周期，所以 `open_positions` 在处理下一个异动时总是空的或者不包含已处理的仓位。风险管理器只检查 `open_positions`，导致无法检测到真实时间维度上的重叠持仓。

---

## 修复方案

### 修改1: 风险管理器 - 检查时间重叠的仓位

**文件**: `src/trading/risk_manager.ts`
**备份**: `src/trading/risk_manager.ts.backup_20251126_233000`

```typescript
// 4. 检查总持仓数量（考虑时间重叠）✨
let active_positions: PositionRecord[];
if (current_time) {
  // 回测模式：检查在current_time时刻，哪些仓位在时间上存在
  active_positions = current_positions.filter(p => {
    if (p.is_open) return true;  // 未平仓的肯定存在

    // 已平仓的，检查是否在时间上重叠
    if (p.closed_at) {
      return p.opened_at <= current_time && p.closed_at > current_time;
    }

    return false;
  });
} else {
  // 实盘模式：只检查未平仓的
  active_positions = current_positions.filter(p => p.is_open);
}

if (active_positions.length >= this.config.max_total_positions) {
  return {
    allowed: false,
    reason: `Maximum total positions (${this.config.max_total_positions}) reached${current_time ? ` at ${current_time.toISOString()}` : ''}`
  };
}

// 5. 检查单币种持仓数量（考虑时间重叠）✨
const symbol_positions = active_positions.filter(p => p.symbol === signal.symbol);
if (symbol_positions.length >= this.config.max_positions_per_symbol) {
  return {
    allowed: false,
    reason: `Maximum positions for ${signal.symbol} (${this.config.max_positions_per_symbol}) reached${current_time ? ` at ${current_time.toISOString()}` : ''}`
  };
}
```

**核心改进**:
1. 引入 `active_positions` 概念，区分"未平仓"和"在该时刻存在"
2. 回测模式：检查 `opened_at <= current_time && closed_at > current_time`
3. 实盘模式：保持原逻辑（只检查 `is_open`）

### 修改2: 回测引擎 - 传入所有仓位

**文件**: `src/trading/backtest_engine.ts`

```typescript
// 风险检查（传入回测当前时间 + 所有仓位包括已平仓）✨
const risk_check = this.risk_manager.can_open_position(
  signal,
  [...open_positions, ...closed_positions],  // 传入所有仓位以检查时间重叠
  balance,
  anomaly.anomaly_time  // 回测模式：使用异动发生的时间
);
```

**改进点**:
- 传入 `[...open_positions, ...closed_positions]` 而不是只传 `open_positions`
- 让风险管理器能够看到所有历史仓位，从而检查时间重叠

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
  结果: ❌ 拒绝 "Maximum positions for CROSSUSDT (2) reached at 2025-11-26T00:41:46.000Z"

00:43:54 - 异动4到达
  检查: Position 1和2 在00:43时刻都存在
  结果: ❌ 拒绝 "Maximum positions for CROSSUSDT (2) reached at 2025-11-26T00:43:54.000Z"
```

**最终结果**: CROSSUSDT只会开2个仓位，符合配置！

---

## 兼容性

### 实盘模式
修改完全向后兼容实盘模式：
- 当 `current_time` 未传入时，使用原逻辑（只检查 `is_open`）
- 实盘交易中，`open_positions` 本来就是真实的未平仓列表

### 回测模式
- 现在正确反映真实时间维度的持仓状态
- 不会再出现"回测循环允许，但真实场景超限"的情况

---

## 验证方法

1. 重新运行回测: `npx ts-node scripts/backtest_7days_score7_v2.ts`
2. 检查结果JSON文件，搜索 `CROSSUSDT` 或其他币种
3. 确认同一币种的并发持仓数 ≤ 2
4. 检查被拒绝的信号，应该有 "Maximum positions for XXX (2) reached" 的原因

---

## 回滚方法

如需回滚到修复前版本：

```bash
# 回滚风险管理器
cp src/trading/risk_manager.ts.backup_20251126_233000 src/trading/risk_manager.ts

# 手动恢复backtest_engine.ts的修改（只改了一行）
# 将 [...open_positions, ...closed_positions] 改回 open_positions
```

---

## 相关文档

- **Bug分析**: [POSITION_DUPLICATE_BUG_ANALYSIS.md](./POSITION_DUPLICATE_BUG_ANALYSIS.md)
- **评分系统优化**: [SCORING_OPTIMIZATION_V2.md](./SCORING_OPTIMIZATION_V2.md)

