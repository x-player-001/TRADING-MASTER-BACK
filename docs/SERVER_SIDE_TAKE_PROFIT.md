# 服务端止盈订单实现文档

## 📋 概述

本文档说明如何使用币安服务端的止盈订单功能，在开仓时自动下单止盈订单，无需程序持续监控。

## 🎯 核心特性

### 优势
- ✅ **可靠性高** - 币安服务器执行，不受程序中断影响
- ✅ **延迟更低** - 服务器端触发，无10秒轮询延迟
- ✅ **减少带宽** - 无需频繁查询持仓数据
- ✅ **降低负载** - 程序无需监控价格触发

### 支持的订单类型
1. **TAKE_PROFIT_MARKET** - 固定价格止盈
2. **TRAILING_STOP_MARKET** - 跟踪止盈（回调触发）

## 🔧 API方法

### 1. 固定价格止盈订单

```typescript
// 在 binance_futures_trading_api.ts 中
async place_take_profit_market_order(
  symbol: string,              // 交易对 "BTCUSDT"
  side: OrderSide,            // SELL (平多仓) / BUY (平空仓)
  quantity: number,           // 平仓数量
  stopPrice: number,          // 触发价格
  positionSide: PositionSide = PositionSide.BOTH,
  reduceOnly: boolean = true  // 只减仓，防止反向开仓
): Promise<OrderResponse>
```

**使用示例**:
```typescript
// 开多仓 BTCUSDT，入场价 $50,000，止盈 +8% = $54,000
await trading_api.place_take_profit_market_order(
  'BTCUSDT',
  OrderSide.SELL,     // 平多仓用SELL
  0.001,              // 平仓数量
  54000,              // 触发价 $54,000
  PositionSide.LONG,
  true                // reduceOnly
);
```

### 2. 跟踪止盈订单

```typescript
// 在 binance_futures_trading_api.ts 中
async place_trailing_stop_order(
  symbol: string,
  side: OrderSide,
  quantity: number,
  callbackRate: number,       // 回调比例 0.1-10 (1表示1%)
  positionSide: PositionSide = PositionSide.BOTH,
  activationPrice?: number    // 可选：激活价格
): Promise<OrderResponse>
```

**使用示例**:
```typescript
// 开多仓，入场后价格上涨到最高点，回调15%时触发止盈
await trading_api.place_trailing_stop_order(
  'BTCUSDT',
  OrderSide.SELL,
  0.001,
  15,                 // 15%回调触发
  PositionSide.LONG
);
```

## 📦 集成到开仓流程

### OrderExecutor 新方法

```typescript
async execute_market_order_with_tp(
  signal: TradingSignal,
  quantity: number,
  leverage: number = 1,
  take_profit_config?: {
    targets: Array<{
      percentage: number;          // 此批次仓位百分比
      target_profit_pct: number;   // 目标盈利百分比
      is_trailing?: boolean;       // 是否使用跟踪止盈
      trailing_callback_pct?: number; // 跟踪止盈回调百分比
    }>;
  }
): Promise<{
  entry_order: OrderRecord;
  tp_order_ids: number[];
}>
```

### 使用示例

```typescript
const order_executor = new OrderExecutor(TradingMode.TESTNET);

// 开仓 + 分批止盈
const result = await order_executor.execute_market_order_with_tp(
  signal,
  0.001,  // 总数量
  6,      // 6倍杠杆
  {
    targets: [
      {
        percentage: 30,           // 30%仓位
        target_profit_pct: 8,     // +8%止盈
        is_trailing: false
      },
      {
        percentage: 30,           // 30%仓位
        target_profit_pct: 12,    // +12%止盈
        is_trailing: false
      },
      {
        percentage: 40,           // 40%仓位
        is_trailing: true,        // 跟踪止盈
        trailing_callback_pct: 15 // 回调15%触发
      }
    ]
  }
);

console.log('入场订单ID:', result.entry_order.order_id);
console.log('止盈订单IDs:', result.tp_order_ids);
```

## 🎮 实盘配置示例

### $50 小资金配置 (run_live_trading_50usd.ts)

```typescript
const trading_config: LiveTradingConfig = {
  initial_balance: 50,

  risk_config: {
    max_position_size_percent: 10,  // 10% = $5保证金
    max_leverage: 6,                // 6倍杠杆
    max_total_positions: 5,         // 最多5个仓位
  },

  // 分批止盈配置
  dynamic_take_profit: {
    targets: [
      {
        percentage: 30,             // 第1批: 30%仓位
        target_profit_pct: 8,       // +8%止盈
        is_trailing: false
      },
      {
        percentage: 30,             // 第2批: 30%仓位
        target_profit_pct: 12,      // +12%止盈
        is_trailing: false
      },
      {
        percentage: 40,             // 第3批: 40%仓位
        is_trailing: true,          // 跟踪止盈
        trailing_callback_pct: 15   // 回调15%触发
      }
    ],
    enable_trailing: true,
    trailing_start_profit_pct: 8    // 盈利8%后启动跟踪
  },

  allowed_directions: ['LONG'],     // 只做多
  max_holding_time_minutes: 180     // 3小时超时
};
```

### 仓位计算

```
单笔仓位:
- 保证金: $50 × 10% = $5
- 杠杆: 6倍
- 仓位价值: $5 × 6 = $30

止盈分批 (假设入场价 $1.00):
- 第1批: 30% × 数量, 触发价 $1.08 (+8%)
- 第2批: 30% × 数量, 触发价 $1.12 (+12%)
- 第3批: 40% × 数量, 跟踪止盈 (回调15%)

最大风险:
- 单笔最大亏损: $5 (逐仓爆仓)
- 最坏情况(5仓全爆): -$25 (账户剩$25, -50%)
- 熔断触发: -$10 (账户剩$40, -20%)
```

## 🚀 启动流程

### 1. 配置环境变量

在 `.env` 文件中添加:

```bash
# 测试网 (使用测试币)
BINANCE_TESTNET_API_KEY=your_testnet_api_key
BINANCE_TESTNET_SECRET_KEY=your_testnet_secret_key

# 实盘 (真实资金，谨慎使用!)
BINANCE_API_KEY=your_live_api_key
BINANCE_SECRET_KEY=your_live_secret_key
```

### 2. 运行测试网模式

```bash
# 默认使用TESTNET模式
npx ts-node -r tsconfig-paths/register scripts/run_live_trading_50usd.ts
```

### 3. 验证功能

在测试网完成以下验证:
- ✅ 能正常接收到交易信号
- ✅ 开仓订单成功执行
- ✅ 止盈订单正确下单 (检查币安账户)
- ✅ 触发价格时止盈自动成交
- ✅ 跟踪止盈正确跟随价格

### 4. 切换实盘模式

```typescript
// 在 run_live_trading_50usd.ts 修改
const trading_mode = TradingMode.LIVE;  // ⚠️ 改为LIVE

// 程序会显示5秒警告
console.log('🔴 警告: 即将使用真实资金交易!');
```

## ⚠️ 重要注意事项

### 1. 币种选择
- ❌ 避免 BTCUSDT - 最小订单金额约 $30，接近单笔仓位值
- ✅ 推荐低价币 - DOGE、SHIB、XRP 等，最小订单更灵活

### 2. 订单数量精度
```typescript
// 币安对数量有精度要求
// 例如 BTCUSDT 最小 0.001 BTC
// 确保 quantity 符合交易规则

// 检查交易规则
const exchange_info = await trading_api.get_exchange_info('BTCUSDT');
const lot_size = exchange_info.filters.find(f => f.filterType === 'LOT_SIZE');
console.log('最小数量:', lot_size.minQty);
console.log('步进:', lot_size.stepSize);
```

### 3. 止盈订单失败处理

如果止盈订单下单失败:
- 程序会记录错误日志
- 入场订单仍然有效
- **需要手动平仓或重新下止盈单**

### 4. 紧急平仓

程序提供手动平仓功能:
```typescript
// 平仓指定持仓
await order_executor.close_position(position);

// 或在币安网页端/APP手动平仓
```

## 📊 监控和日志

### 实时状态显示 (每30秒)

```
================================================================================
📊 实时状态 [2025-11-27 10:30:00]
================================================================================
运行状态: ✅ 运行中
模式: 🧪 测试网
当前持仓: 2个 / 5个
总交易次数: 10
胜率: 70.0% (7胜/3负)
总盈亏: +$12.50
收益率: 25.00%
当前余额: $62.50

📍 当前持仓:
  1. DOGEUSDT LONG @ $0.085000
     持仓: 45min | 盈亏: +9.5% | 当前价: $0.093075
     止盈: $0.091800 | 跟踪止盈: ✅
  2. SHIBUSDT LONG @ $0.000025
     持仓: 15min | 盈亏: +6.2% | 当前价: $0.000027
     止盈: $0.000027 | 跟踪止盈: ❌
================================================================================
```

### 日志查看

```bash
# 实时日志
tail -f logs/trading.log

# 关键事件
grep "TP order placed" logs/trading.log
grep "Position closed" logs/trading.log
```

## 🐛 常见问题

### Q1: 止盈订单显示"reduceOnly violation"
**原因**: 持仓数量不足以平仓

**解决**: 确保 `quantity` 不超过持仓量

### Q2: 跟踪止盈不触发
**原因**: 价格未达到激活条件或回调不足

**解决**: 检查 `activationPrice` 和 `callbackRate` 设置

### Q3: 订单被拒绝 "Order would immediately trigger"
**原因**: 止盈价格已经被当前价格触发

**解决**: 重新计算止盈价格，确保高于(多)/低于(空)当前价

## 📚 相关文档

- [币安API文档 - 止盈订单](https://binance-docs.github.io/apidocs/futures/cn/#trade-3)
- [API实现](../src/api/binance_futures_trading_api.ts)
- [订单执行器](../src/trading/order_executor.ts)
- [$50配置脚本](../scripts/run_live_trading_50usd.ts)

## 🎓 总结

服务端止盈订单为小资金实盘交易提供了:
- ✅ 更高的可靠性
- ✅ 更低的延迟
- ✅ 更少的资源消耗
- ✅ 分批止盈灵活性

**测试充分后再使用真实资金！** 🚀
