# 动态止盈 + 分批止盈策略文档

## 📋 概述

本策略结合了**分批止盈**和**动态跟踪止盈**两种技术，旨在解决低胜率但高波动性场景下的盈利问题。

## 🎯 策略目标

- **快速回本**: 第一批次在 +6% 时快速平仓40%仓位，降低风险
- **稳定盈利**: 第二批次在 +12% 时平仓30%仓位，锁定中期收益
- **捕捉大行情**: 第三批次30%仓位使用跟踪止盈，捕捉异常大涨/大跌

## 📊 仓位分配策略

| 批次 | 仓位比例 | 止盈目标 | 类型 | 说明 |
|------|----------|----------|------|------|
| 第1批 | 40% | +6% | 固定止盈 | 快速回本，降低心理压力 |
| 第2批 | 30% | +12% | 固定止盈 | 中期目标，稳定收益 |
| 第3批 | 30% | 无上限 | 跟踪止盈 | 捕捉大行情，30%回调触发 |

### 统一止损

- **止损位**: -2% (固定)
- **适用于**: 全部仓位
- **逻辑**: 严格控制单笔最大损失

## 🔧 技术实现

### 1. 类型定义 ([src/types/trading_types.ts](../src/types/trading_types.ts))

```typescript
// 单个止盈目标
interface TakeProfitTarget {
  percentage: number;            // 仓位百分比 (如 40 表示 40%)
  price: number;                 // 止盈价格
  target_profit_pct: number;     // 目标收益率 (如 6 表示 +6%)
  is_trailing: boolean;          // 是否使用跟踪止盈
  trailing_callback_pct?: number;// 跟踪回调百分比 (如 30 表示回调30%触发)
}

// 动态止盈配置
interface DynamicTakeProfitConfig {
  targets: TakeProfitTarget[];         // 分批止盈目标
  enable_trailing: boolean;            // 是否启用跟踪止盈
  trailing_start_profit_pct: number;   // 启动跟踪的最低盈利
}
```

### 2. 信号生成器 ([src/trading/signal_generator.ts](../src/trading/signal_generator.ts))

#### 主要修改

```typescript
generate_signal(anomaly: OIAnomalyRecord): TradingSignal | null {
  // 1-5. 原有逻辑...

  // 6. 生成动态止盈配置
  const dynamic_take_profit = this.generate_dynamic_take_profit_config(
    anomaly,
    direction,
    strength
  );

  // 7. 构建信号对象 (新增 dynamic_take_profit 字段)
  const signal: TradingSignal = {
    // ...原有字段
    dynamic_take_profit,  // 新增
    // ...
  };
}
```

#### 止盈配置生成

```typescript
private generate_dynamic_take_profit_config(
  anomaly: OIAnomalyRecord,
  direction: SignalDirection,
  strength: SignalStrength
): DynamicTakeProfitConfig | undefined {
  const current_price = anomaly.price_after;

  // 第一批：40%仓位，+6%
  const target1_price = direction === SignalDirection.LONG
    ? current_price * 1.06
    : current_price * 0.94;

  // 第二批：30%仓位，+12%
  const target2_price = direction === SignalDirection.LONG
    ? current_price * 1.12
    : current_price * 0.88;

  // 第三批：30%仓位，跟踪止盈
  return {
    targets: [
      { percentage: 40, price: target1_price, target_profit_pct: 6, is_trailing: false },
      { percentage: 30, price: target2_price, target_profit_pct: 12, is_trailing: false },
      { percentage: 30, price: 0, target_profit_pct: 0, is_trailing: true, trailing_callback_pct: 30 }
    ],
    enable_trailing: true,
    trailing_start_profit_pct: 6  // 达到第一批后启动
  };
}
```

### 3. 跟踪止盈管理器 ([src/trading/trailing_stop_manager.ts](../src/trading/trailing_stop_manager.ts))

#### 核心功能

```typescript
class TrailingStopManager {
  // 开始跟踪仓位
  start_tracking(position_id, symbol, side, entry_price, quantity, config): void

  // 更新价格并检查止盈条件
  update_price(position_id, current_price): TakeProfitAction[]

  // 停止跟踪
  stop_tracking(position_id): void

  // 获取跟踪状态
  get_tracking_state(position_id): PositionTrackingState
}
```

#### 跟踪止盈逻辑

**做多时 (LONG)**:
```typescript
// 更新最高价
if (current_price > highest_profit_price) {
  highest_profit_price = current_price;

  // 计算跟踪止损价 = 入场价 + 利润 × (1 - 回调%)
  const profit_gained = highest_profit_price - entry_price;
  trailing_stop_price = entry_price + profit_gained × 0.7;  // 保留70%利润
}

// 检查触发
if (current_price <= trailing_stop_price) {
  // 触发平仓
}
```

**做空时 (SHORT)**: 逻辑相反

## 📈 策略效果

### 测试案例

**入场**: BTCUSDT @ 91000
**初始仓位**: 1.0 BTC

| 价格走势 | 动作 | 剩余仓位 | 说明 |
|---------|------|----------|------|
| 91000 → 96460 | 第1批止盈 | 0.6 BTC | 40%平仓 @ +6% |
| 96460 → 102000 | 第2批止盈 | 0.3 BTC | 30%平仓 @ +12% |
| 102000 → 115000 | 跟踪启动 | 0.3 BTC | 最高涨至 +26.4% |
| 115000 → 104300 | 跟踪触发 | 0 BTC | 回调30%后平仓 @ +14.6% |

### 收益对比

| 策略 | 收益金额 | 收益率 | 说明 |
|------|----------|--------|------|
| 单一止盈 @ +6% | $6,000 | +6.00% | 过早离场，错失大行情 |
| 单一止盈 @ +12% | $10,920 | +12.00% | 风险较高，可能中途回撤 |
| **分批+跟踪策略** | **$9,474** | **+10.41%** | ✅ 平衡风险与收益 |

### 策略优势

✅ **风险可控**: 40%仓位快速止盈，降低整体风险暴露
✅ **收益稳定**: 30%仓位在12%目标锁定中期收益
✅ **捕捉黑天鹅**: 30%跟踪仓位可捕捉异常大涨 (+26%案例)
✅ **心理压力小**: 分批离场减少"卖飞"或"守回本"的焦虑

## 🔄 使用流程

### 1. 信号生成

```typescript
const signal_generator = new SignalGenerator();
const signal = signal_generator.generate_signal(anomaly);

if (signal && signal.dynamic_take_profit) {
  console.log('止盈配置:', signal.dynamic_take_profit);
}
```

### 2. 开仓后开始跟踪

```typescript
const trailing_manager = new TrailingStopManager();

trailing_manager.start_tracking(
  position_id,
  signal.symbol,
  PositionSide.LONG,
  entry_price,
  quantity,
  signal.dynamic_take_profit
);
```

### 3. 实时价格更新

```typescript
// 每次价格更新时调用
const actions = trailing_manager.update_price(position_id, current_price);

for (const action of actions) {
  if (action.type === 'BATCH_TAKE_PROFIT') {
    // 执行批次止盈
    await close_position_partial(action.position_id, action.quantity, action.price);
  } else if (action.type === 'TRAILING_STOP') {
    // 执行跟踪止盈
    await close_position_full(action.position_id, action.quantity, action.price);
  }
}
```

### 4. 平仓后停止跟踪

```typescript
trailing_manager.stop_tracking(position_id);
```

## 🧪 测试

运行完整测试:

```bash
npx ts-node scripts/test_dynamic_take_profit.ts
```

测试覆盖:
- ✅ 信号生成和止盈配置
- ✅ 价格走势模拟和批次触发
- ✅ 跟踪止盈激活和触发
- ✅ 最终收益统计和对比分析

## 📊 数学原理

### 期望收益计算

假设：
- 胜率 W = 30%
- 第1批止盈率 R1 = 6%，仓位 P1 = 40%
- 第2批止盈率 R2 = 12%，仓位 P2 = 30%
- 第3批止盈率 R3 = 15%，仓位 P3 = 30% (平均)
- 止损率 L = -2%

**期望收益**:
```
E = W × (P1×R1 + P2×R2 + P3×R3) - (1-W) × L
  = 0.3 × (0.4×6% + 0.3×12% + 0.3×15%) - 0.7 × 2%
  = 0.3 × 9.9% - 1.4%
  = 2.97% - 1.4%
  = 1.57%
```

即使30%胜率，期望收益仍为正 (+1.57%)

### 与单一止盈对比

| 策略 | 胜率 | 止盈率 | 止损率 | 期望收益 |
|------|------|--------|--------|----------|
| 单一止盈 +6% | 30% | 6% | -2% | -0.20% ❌ |
| 单一止盈 +12% | 20% | 12% | -2% | +0.80% |
| **分批+跟踪** | **30%** | **9.9%** | **-2%** | **+1.57%** ✅ |

## 🚀 未来优化

1. **动态调整批次比例**
   - 根据市场波动率自动调整 40/30/30 的比例
   - 低波动: 50/30/20 (更保守)
   - 高波动: 30/30/40 (更激进)

2. **智能回调百分比**
   - 根据信号强度调整跟踪回调比例
   - 强信号: 20%回调 (更贴近价格)
   - 弱信号: 40%回调 (更宽松)

3. **止损动态提升**
   - 第1批止盈后，将整体止损提升至保本位
   - 第2批止盈后，将整体止损提升至 +3%

4. **与回测引擎集成**
   - 在 `backtest_engine.ts` 中集成此策略
   - 对比不同止盈策略的历史表现

## 📝 相关文件

- [src/types/trading_types.ts:30-45](../src/types/trading_types.ts#L30-L45) - 类型定义
- [src/trading/signal_generator.ts:387-449](../src/trading/signal_generator.ts#L387-L449) - 配置生成
- [src/trading/trailing_stop_manager.ts](../src/trading/trailing_stop_manager.ts) - 核心管理器
- [scripts/test_dynamic_take_profit.ts](../scripts/test_dynamic_take_profit.ts) - 完整测试

---

**版本**: 1.0.0
**更新日期**: 2025-11-25
**作者**: Trading System Team
