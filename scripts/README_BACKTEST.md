# 回测脚本使用说明

## 快速开始

### 方式1：使用 JavaScript 脚本（推荐）

```bash
node scripts/backtest.js
```

**优点**：
- ✅ 简单直接，无需编译
- ✅ 配置在文件顶部，易于修改
- ✅ 适合快速测试不同参数

### 方式2：使用 npm 命令

```bash
npm run backtest
```

**说明**：使用 TypeScript 版本，需要编译

## 修改配置

编辑 `scripts/backtest.js` 文件顶部的 `BACKTEST_CONFIG` 对象：

```javascript
const BACKTEST_CONFIG = {
  // 回测时间范围
  days_back: 7,                          // 回测最近N天

  // 初始资金
  initial_balance: 100,                   // 初始资金 $100
  margin_percent: 10,                     // 每次开仓使用总资金的10%

  // 策略配置
  strategy: {
    min_signal_score: 7,                  // 最小信号分数 (1-10)
    min_confidence: 0.7,                  // 最小置信度 (0-1)
    min_oi_change_percent: 3,             // 最小OI变化百分比
    // ... 更多配置
  },

  // 风险配置
  risk: {
    stop_loss_percent: 5,                 // 止损百分比
    take_profit_percent: 15,              // 止盈百分比
    max_leverage: 10,                     // 最大杠杆
    // ... 更多配置
  },

  // 持仓时间限制
  max_holding_time_minutes: 60,           // 最大持仓时间(分钟)

  // 交易成本
  slippage_percent: 0.1,                  // 滑点百分比
  commission_percent: 0.05                // 手续费百分比
};
```

## 配置参数说明

### 时间参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `days_back` | 回测天数 | 7 |

### 资金管理

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `initial_balance` | 初始资金 | $100 |
| `margin_percent` | 每次开仓占总资金比例 | 10% |

### 策略参数

| 参数 | 说明 | 默认值 | 范围 |
|------|------|--------|------|
| `min_signal_score` | 最小信号分数 | 7 | 1-10 |
| `min_confidence` | 最小置信度 | 0.7 | 0-1 |
| `min_oi_change_percent` | 最小OI变化 | 3% | - |
| `require_price_oi_alignment` | 要求价格OI对齐 | true | true/false |
| `use_sentiment_filter` | 使用情绪过滤 | true | true/false |
| `min_trader_ratio` | 最小交易者比率 | 1.2 | - |
| `max_funding_rate` | 最大资金费率 | 0.01 | - |

### 风险参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `max_position_size_percent` | 单笔最大仓位 | 5% |
| `max_total_positions` | 最多同时持仓 | 3 |
| `max_positions_per_symbol` | 每币种最多持仓 | 1 |
| `stop_loss_percent` | 止损 | 5% |
| `take_profit_percent` | 止盈 | 15% |
| `use_trailing_stop` | 启用移动止损 | true |
| `trailing_stop_callback_rate` | 移动止损回调率 | 3% |
| `max_leverage` | 最大杠杆 | 10x |

### 杠杆配置

| 信号强度 | 杠杆倍数 |
|---------|---------|
| 弱信号 (weak) | 5x |
| 中信号 (medium) | 8x |
| 强信号 (strong) | 10x |

### 持仓时间

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `max_holding_time_minutes` | 最大持仓时间 | 60分钟 |

### 交易成本

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `slippage_percent` | 滑点 | 0.1% |
| `commission_percent` | 手续费 | 0.05% |

## 回测结果

### 结果文件

回测结果保存在 `backtest_results/` 目录：

```
backtest_results/
└── backtest_2025-11-20T01-21-48.json
```

### JSON 文件结构

```json
{
  "metadata": {
    "timestamp": "2025-11-20T01:21:48.123Z",
    "config": { /* 回测配置 */ },
    "execution_time_ms": 5432
  },
  "summary": {
    "total_trades": 41,
    "winning_trades": 14,
    "losing_trades": 27,
    "win_rate": 34.15,
    "total_pnl": 17.49,
    "roi_percent": 17.49,
    "average_win": 4.42,
    "average_loss": -1.64,
    "profit_factor": 2.69,
    "max_drawdown": 17.75,
    "max_drawdown_percent": 14.87,
    "average_hold_time": 48.45
  },
  "all_trades": [ /* 所有交易详情 */ ],
  "signals": 95,
  "rejected_signals": 54
}
```

## 查看结果

### 查看摘要

```bash
cat backtest_results/backtest_*.json | jq '.summary'
```

### 查看所有交易

```bash
cat backtest_results/backtest_*.json | jq '.all_trades'
```

### 验证保证金

```bash
node scripts/verify_fixed_margin.js
```

## 常见配置场景

### 场景1：保守策略（低风险）

```javascript
const BACKTEST_CONFIG = {
  initial_balance: 1000,
  margin_percent: 5,                      // 每次只用5%
  strategy: {
    min_signal_score: 8,                  // 只做高分信号
    min_confidence: 0.8,
  },
  risk: {
    stop_loss_percent: 3,                 // 严格止损
    take_profit_percent: 9,               // 3:1盈亏比
    max_leverage: 5,                      // 低杠杆
  }
};
```

### 场景2：激进策略（高风险）

```javascript
const BACKTEST_CONFIG = {
  initial_balance: 100,
  margin_percent: 20,                     // 每次用20%
  strategy: {
    min_signal_score: 6,                  // 接受中等信号
    min_confidence: 0.6,
  },
  risk: {
    stop_loss_percent: 8,
    take_profit_percent: 24,              // 3:1盈亏比
    max_leverage: 20,                     // 高杠杆
  }
};
```

### 场景3：快进快出

```javascript
const BACKTEST_CONFIG = {
  max_holding_time_minutes: 30,           // 最多持仓30分钟
  risk: {
    stop_loss_percent: 2,                 // 快速止损
    take_profit_percent: 6,               // 快速止盈
    use_trailing_stop: true,              // 启用移动止损
    trailing_stop_callback_rate: 2,       // 回调2%就止盈
  }
};
```

## 性能指标说明

### 胜率 (Win Rate)

- **公式**: 盈利交易数 / 总交易数
- **好的范围**: 40% 以上

### ROI (投资回报率)

- **公式**: (最终资金 - 初始资金) / 初始资金
- **说明**: 正值表示盈利，负值表示亏损

### 盈亏比 (Profit Factor)

- **公式**: 总盈利 / 总亏损
- **说明**:
  - > 2.0: 优秀
  - 1.5-2.0: 良好
  - < 1.0: 亏损

### 最大回撤 (Max Drawdown)

- **说明**: 从峰值到谷底的最大跌幅
- **目标**: 越小越好（< 20%）

### 平均持仓时间

- **说明**: 每笔交易平均持有时长
- **参考**: 应小于 `max_holding_time_minutes`

## 故障排除

### 问题1：没有交易

**原因**: 信号分数要求太高

**解决**: 降低 `min_signal_score` (从 7 降到 6)

### 问题2：胜率太低

**原因**: 止损太紧或追高

**解决**:
- 增加 `stop_loss_percent` (5% → 8%)
- 提高 `min_signal_score` (7 → 8)

### 问题3：盈亏比太低

**原因**: 止盈太早或移动止损太激进

**解决**:
- 增加 `take_profit_percent` (15% → 20%)
- 增加 `trailing_stop_callback_rate` (3% → 5%)

### 问题4：回撤太大

**原因**: 杠杆太高或仓位太大

**解决**:
- 降低 `max_leverage` (10x → 5x)
- 降低 `margin_percent` (10% → 5%)

## 进阶技巧

### 1. 多参数对比测试

创建不同配置文件，对比效果：

```bash
# 保守策略
cp scripts/backtest.js scripts/backtest_conservative.js
# 修改配置...
node scripts/backtest_conservative.js

# 激进策略
cp scripts/backtest.js scripts/backtest_aggressive.js
# 修改配置...
node scripts/backtest_aggressive.js
```

### 2. 时间段对比

```javascript
// 测试牛市
days_back: 7,   // 最近7天

// 测试更长时间
days_back: 30,  // 最近30天
```

### 3. 优化盈亏比

```javascript
// 尝试不同的止损止盈组合
{ stop_loss: 3, take_profit: 9 },   // 3:1
{ stop_loss: 5, take_profit: 15 },  // 3:1
{ stop_loss: 8, take_profit: 24 },  // 3:1
```

---

**提示**: 回测只是历史模拟，不代表未来收益。实盘前请充分测试和验证策略！
