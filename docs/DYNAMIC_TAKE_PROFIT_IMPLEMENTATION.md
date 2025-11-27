# 分批止盈功能实现文档

## 概述

在回测引擎中实现了分批止盈（Dynamic Take Profit）功能，支持将仓位分批平仓以优化盈利，并支持跟踪止盈（Trailing Stop）来锁定利润。

## 实现日期

2025-11-27

## 核心组件

### 1. TrailingStopManager (src/trading/trailing_stop_manager.ts)

已有的分批止盈管理器，提供核心逻辑：

- **start_tracking()**: 开始跟踪一个仓位
- **update_price()**: 更新价格并检查止盈条件
- **stop_tracking()**: 停止跟踪仓位

**主要功能**：
- 管理多个止盈批次（targets）
- 支持固定价格止盈
- 支持跟踪止盈（Trailing Stop）
- 记录已实现盈亏

### 2. BacktestEngine (src/trading/backtest_engine.ts)

在回测引擎中集成分批止盈功能：

#### 修改内容

**a. 导入依赖**
```typescript
import { TrailingStopManager, TakeProfitAction } from './trailing_stop_manager';
```

**b. 添加成员变量**
```typescript
private trailing_stop_manager: TrailingStopManager;
```

**c. 开仓时启动跟踪**
在 `run_backtest()` 方法中，开仓后立即启动分批止盈跟踪（如果配置了 `dynamic_take_profit`）：

```typescript
// 如果配置了动态止盈，启动跟踪
if (config.dynamic_take_profit) {
  this.trailing_stop_manager.start_tracking(
    position.id!,
    position.symbol,
    position.side,
    entry_price,
    quantity,
    config.dynamic_take_profit
  );
}
```

**d. 修改持仓模拟逻辑**
在 `simulate_position_holding()` 方法中：

1. **检查分批止盈条件**：在每个价格点调用 `TrailingStopManager.update_price()`
2. **执行分批平仓**：根据返回的 `TakeProfitAction` 执行部分平仓
3. **计算批次盈亏**：使用新增的 `calculate_partial_pnl()` 和 `calculate_partial_commission()`
4. **更新仓位状态**：累计 `realized_pnl`，减少 `remaining_quantity`
5. **停止跟踪**：在全部平仓、止损、爆仓或超时时停止跟踪

**e. 修改平仓逻辑**
在主循环的平仓处理中：

1. **区分模式**：检查是否使用分批止盈模式
2. **计算最终盈亏**：
   - 分批模式：已实现盈亏 + 剩余仓位盈亏
   - 标准模式：一次性计算全部盈亏
3. **更新资金**：返还保证金 + 最终盈亏

**f. 新增辅助方法**

```typescript
/**
 * 计算部分仓位盈亏（用于分批止盈）
 */
private calculate_partial_pnl(
  position: PositionRecord,
  exit_price: number,
  quantity: number
): number

/**
 * 计算部分仓位手续费（用于分批止盈）
 * 注意：只计算平仓手续费，开仓手续费已在开仓时计算
 */
private calculate_partial_commission(
  position: PositionRecord,
  exit_price: number,
  quantity: number,
  config: BacktestConfig
): number
```

## 配置说明

### BacktestConfig 配置

```typescript
interface BacktestConfig {
  // ... 其他配置

  // 分批止盈配置（可选）
  dynamic_take_profit?: DynamicTakeProfitConfig;
}
```

### DynamicTakeProfitConfig 配置

```typescript
interface DynamicTakeProfitConfig {
  targets: TakeProfitTarget[];           // 分批止盈目标
  enable_trailing: boolean;              // 是否启用跟踪止盈
  trailing_start_profit_pct: number;     // 启动跟踪的最低盈利（如首次止盈达到后）
}
```

### TakeProfitTarget 配置

```typescript
interface TakeProfitTarget {
  percentage: number;                    // 仓位百分比（如40表示40%仓位）
  price: number;                         // 止盈价格（运行时计算）
  target_profit_pct: number;             // 目标收益率（如6表示+6%）
  is_trailing: boolean;                  // 是否使用跟踪止盈
  trailing_callback_pct?: number;        // 跟踪回调百分比（如30表示保留30%利润空间）
}
```

## 使用示例

### 示例1：三批次分批止盈

```typescript
const config: BacktestConfig = {
  // ... 基础配置

  dynamic_take_profit: {
    enable_trailing: true,
    trailing_start_profit_pct: 6,
    targets: [
      {
        percentage: 40,           // 第一批：40%仓位
        price: 0,                 // 运行时计算
        target_profit_pct: 6,     // +6%止盈
        is_trailing: false,
        trailing_callback_pct: undefined
      },
      {
        percentage: 30,           // 第二批：30%仓位
        price: 0,
        target_profit_pct: 10,    // +10%止盈
        is_trailing: false,
        trailing_callback_pct: undefined
      },
      {
        percentage: 30,           // 第三批：剩余30%仓位
        price: 0,
        target_profit_pct: 15,    // +15%止盈
        is_trailing: true,        // 使用跟踪止盈
        trailing_callback_pct: 30 // 回调30%触发
      }
    ]
  }
};
```

### 示例2：简单两批次止盈

```typescript
dynamic_take_profit: {
  enable_trailing: false,
  trailing_start_profit_pct: 0,
  targets: [
    {
      percentage: 50,           // 50%仓位在+5%止盈
      target_profit_pct: 5,
      is_trailing: false
    },
    {
      percentage: 50,           // 剩余50%仓位在+10%止盈
      target_profit_pct: 10,
      is_trailing: false
    }
  ]
}
```

## 执行流程

### 1. 开仓阶段
```
1. 风险检查通过
2. 计算仓位大小和入场价
3. 创建 PositionRecord (初始化 realized_pnl = 0)
4. 如果配置了 dynamic_take_profit:
   - 调用 TrailingStopManager.start_tracking()
   - 传入仓位信息和止盈配置
```

### 2. 持仓模拟阶段
```
遍历价格数据:
  for each price_point:
    1. 如果启用分批止盈:
       - 调用 TrailingStopManager.update_price()
       - 获取 TakeProfitAction[] 列表

    2. 处理每个止盈操作:
       - 应用滑点
       - 计算部分手续费
       - 计算部分盈亏
       - 累计到 position.realized_pnl
       - 减少 remaining_quantity
       - 记录日志

    3. 如果全部平仓:
       - 停止跟踪
       - 返回退出结果

    4. 检查其他退出条件（爆仓、止损、固定止盈）

  如果超时:
    - 停止跟踪
    - 返回超时退出
```

### 3. 平仓阶段
```
1. 检查是否使用分批止盈模式
2. 计算最终盈亏:
   - 分批模式:
     * 已有 realized_pnl（已平仓批次）
     * 加上剩余仓位盈亏
   - 标准模式:
     * 一次性计算全部盈亏

3. 更新资金:
   - 返还保证金
   - 加上最终盈亏

4. 记录交易结果到风险管理器
5. 移入已平仓列表
```

## 关键特性

### 1. 精确的盈亏计算
- 每个批次单独计算盈亏和手续费
- 累计到 `position.realized_pnl`
- 避免重复计算

### 2. 灵活的止盈策略
- 支持固定价格止盈
- 支持跟踪止盈
- 可混合使用

### 3. 完整的生命周期管理
- 开仓时启动跟踪
- 持仓期间实时检查
- 平仓时停止跟踪
- 异常情况（爆仓、止损）也会正确停止

### 4. 浮点数精度处理
```typescript
if (remaining_quantity <= 0.0001) {  // 处理浮点数精度
  // 全部平仓
}
```

### 5. 详细的日志记录
```typescript
logger.info(`[BacktestEngine] BATCH_TAKE_PROFIT: ${symbol} closed ${quantity} @ ${price}, PnL=${pnl} (达到第1批止盈目标 +6%)`);
```

## 测试

可以使用 `test_dynamic_tp.ts` 测试文件验证功能：

```bash
npx ts-node test_dynamic_tp.ts
```

## 注意事项

### 1. 手续费计算
- 开仓手续费在开仓时一次性计算（双边手续费）
- 分批平仓时每批只计算平仓手续费（单边）
- 避免重复计算开仓手续费

### 2. 数量精度
- 使用 0.0001 作为最小精度阈值
- 处理浮点数累计误差

### 3. 价格计算
- 分批止盈的目标价格在 TrailingStopManager 内部根据 target_profit_pct 计算
- 开仓时 price 字段可以设为 0

### 4. 与固定止盈的兼容性
- 如果配置了 `dynamic_take_profit`，则忽略固定的 `take_profit_price`
- 如果未配置 `dynamic_take_profit`，使用标准的固定止盈逻辑

### 5. 跟踪止盈激活条件
- 当第一批次执行后，自动激活跟踪止盈
- 跟踪止盈只对标记为 `is_trailing: true` 的批次生效

## 性能考虑

- TrailingStopManager 使用 Map 存储跟踪状态，O(1) 查询复杂度
- 每个价格点只调用一次 `update_price()`
- 批次状态检查在内存中进行，无需数据库查询

## 未来改进

1. **动态调整批次**
   - 根据市场波动性动态调整止盈目标
   - 根据持仓时间调整策略

2. **统计分析**
   - 记录每批次的执行统计
   - 分析最优批次配置

3. **可视化**
   - 展示分批止盈执行过程
   - 资金曲线对比（分批 vs 固定止盈）

4. **更多止盈模式**
   - 基于时间的止盈
   - 基于波动率的止盈
   - 自适应止盈

## 相关文件

- `/Users/mac/Documents/code/TRADING-MASTER-BACK/src/trading/backtest_engine.ts` - 回测引擎（修改）
- `/Users/mac/Documents/code/TRADING-MASTER-BACK/src/trading/trailing_stop_manager.ts` - 跟踪止盈管理器（已有）
- `/Users/mac/Documents/code/TRADING-MASTER-BACK/src/types/trading_types.ts` - 类型定义（已有）
- `/Users/mac/Documents/code/TRADING-MASTER-BACK/test_dynamic_tp.ts` - 测试文件（新增）

## 更新日志

### 2025-11-27
- ✅ 在 BacktestEngine 中集成 TrailingStopManager
- ✅ 实现开仓时启动跟踪
- ✅ 实现持仓期间分批止盈检查
- ✅ 实现分批平仓盈亏计算
- ✅ 实现完整的生命周期管理
- ✅ 添加辅助方法和日志记录
- ✅ 创建测试文件和文档
