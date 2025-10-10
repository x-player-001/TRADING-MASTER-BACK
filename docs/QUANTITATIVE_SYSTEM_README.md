# 量化交易系统 - 完整开发文档

## 📋 概述

独立的量化交易模块，完全解耦于现有系统，提供策略回测、实盘交易（预留）、风险管理等功能。

**核心特性：**
- ✅ 完整的回测引擎（支持多周期、多策略）
- ✅ 两种内置策略（突破策略、趋势跟踪策略）
- ✅ 专业级风险管理（仓位计算、止损止盈、风险检查）
- ✅ 详细的性能分析（夏普比率、最大回撤、盈亏比）
- ✅ 25+ RESTful API接口
- ✅ 完全异步处理，支持高并发

---

## 🎯 开发进度

### ✅ 第1期：基础架构 (已完成)

#### 数据库表结构 (6张表)
- ✅ `quant_strategies` - 策略配置表
- ✅ `quant_backtest_results` - 回测结果表
- ✅ `quant_trades` - 交易记录表
- ✅ `quant_positions` - 持仓表
- ✅ `quant_strategy_performance` - 策略性能统计表
- ✅ `quant_risk_config` - 风控配置表

#### Repository层 (5个)
- ✅ `StrategyRepository` - 策略配置CRUD，性能统计
- ✅ `BacktestRepository` - 回测结果CRUD，最佳结果查询
- ✅ `TradeRepository` - 交易记录CRUD，批量保存，统计分析
- ✅ `PositionRepository` - 持仓CRUD，开平仓管理，持仓统计
- ✅ `RiskRepository` - 风控配置CRUD，黑名单管理

#### 类型定义 (4个)
- ✅ `strategy_types.ts` - 策略类型、配置、参数
- ✅ `backtest_types.ts` - 回测结果、性能数据、资金曲线
- ✅ `trading_types.ts` - 交易记录、持仓、入场/出场信号
- ✅ `risk_types.ts` - 风控配置、风险检查、仓位计算

#### 策略框架
- ✅ `BaseStrategy` - 策略抽象基类（含技术指标计算）
- ✅ `StrategyManager` - 策略管理器（单例模式）
- ✅ `StrategyRegistry` - 策略注册器（自动初始化）

#### API路由
- ✅ 策略管理API (7个接口)
- ✅ 回测系统API (7个接口)
- ✅ 交易记录API (4个接口)
- ✅ 持仓管理API (4个接口)
- ✅ 风险管理API (4个接口)

---

### ✅ 第2期：回测引擎 (已完成)

#### 核心组件
- ✅ **TradeSimulator** - 交易模拟器
  - 持仓管理（开仓、平仓）
  - 止损止盈自动触发
  - 手续费计算（默认0.1%）
  - 资金曲线生成

- ✅ **PerformanceAnalyzer** - 性能分析器
  - 夏普比率计算
  - 最大回撤分析
  - 胜率、盈亏比统计
  - 月度收益分解

- ✅ **BacktestEngine** - 回测引擎
  - 多周期K线数据加载
  - 实时信号生成
  - 交易模拟执行
  - 进度回调支持

#### 性能指标
```typescript
- 总收益率 (Total Return)
- 年化收益率 (Annual Return)
- 夏普比率 (Sharpe Ratio)
- 最大回撤 (Max Drawdown)
- 胜率 (Win Rate)
- 盈亏比 (Profit Factor)
- 平均盈利/亏损
- 连续盈亏统计
```

---

### ✅ 第3期：策略实现 (已完成)

#### 1. 突破策略 (BreakoutStrategy)
**核心逻辑：**
- 复用现有 `RangeDetector` 检测区间
- 复用现有 `BreakoutAnalyzer` 分析突破
- 缓存区间数据（5分钟TTL）
- 过滤条件：触碰次数、置信度、强度

**参数配置：**
```typescript
{
  lookback_period: 200,        // 回溯周期
  min_range_touches: 4,        // 最小触碰次数
  min_confidence: 0.7,         // 最小置信度
  min_strength: 0.6,           // 最小强度
  stop_loss_percent: 2.0,      // 止损百分比
  take_profit_percent: 5.0,    // 止盈百分比
  position_size_percent: 10.0  // 仓位百分比
}
```

**入场条件：**
- 检测到有效区间
- 突破方向确认
- 突破强度 >= min_strength
- 突破置信度 >= min_confidence

**出场条件：**
- 触及止损价
- 触及止盈价
- 价格回到区间内（突破失败）

#### 2. 趋势跟踪策略 (TrendFollowingStrategy)
**核心逻辑：**
- 快慢均线交叉（MA Crossover）
- 趋势均线过滤
- RSI确认信号

**参数配置：**
```typescript
{
  fast_ma_period: 10,          // 快速均线周期
  slow_ma_period: 30,          // 慢速均线周期
  trend_ma_period: 50,         // 趋势均线周期
  rsi_period: 14,              // RSI周期
  stop_loss_percent: 3.0,      // 止损百分比
  take_profit_percent: 8.0,    // 止盈百分比
  position_size_percent: 15.0  // 仓位百分比
}
```

**多头入场条件：**
- 金叉（快线上穿慢线）
- 价格 > 趋势均线
- RSI > 50

**空头入场条件：**
- 死叉（快线下穿慢线）
- 价格 < 趋势均线
- RSI < 50

**出场条件：**
- 触及止损价
- 触及止盈价
- 均线反向交叉

---

### ✅ 第4期：风险管理 (已完成)

#### 1. 仓位计算器 (PositionSizer)
**三种计算方法：**

##### 方法1：固定百分比
```typescript
calculate_fixed_percent(
  total_capital: 10000,
  position_percent: 10,  // 10%仓位
  entry_price: 50000,
  stop_loss_percent: 2,
  take_profit_percent: 5,
  side: 'LONG'
)
// 返回：数量、预期盈亏、风险收益比
```

##### 方法2：固定风险
```typescript
calculate_fixed_risk(
  total_capital: 10000,
  risk_percent: 1,       // 单笔风险1%
  entry_price: 50000,
  stop_loss_percent: 2
)
// 返回：根据止损距离计算的最优数量
```

##### 方法3：凯利公式
```typescript
calculate_kelly(
  total_capital: 10000,
  win_rate: 0.6,         // 60%胜率
  avg_win: 500,          // 平均盈利500
  avg_loss: 200,         // 平均亏损200
  entry_price: 50000,
  max_kelly_fraction: 0.25  // 最大凯利比例25%
)
// 返回：Kelly比例优化的数量
```

#### 2. 止损计算器 (StopLossCalculator)
**四种止损策略：**

##### 策略1：百分比止损
```typescript
calculate_percent_based({
  entry_price: 50000,
  stop_loss_percent: 2,
  take_profit_percent: 5,
  side: 'LONG'
})
// 返回：stop_loss=49000, take_profit=52500
```

##### 策略2：ATR止损
```typescript
calculate_atr_based({
  entry_price: 50000,
  atr_value: 500,
  atr_multiplier: 2,
  side: 'LONG'
})
// 返回：stop_loss=49000 (entry - 2*ATR)
```

##### 策略3：支撑阻力止损
```typescript
calculate_support_resistance_based({
  entry_price: 50000,
  support_level: 48000,
  resistance_level: 52000,
  side: 'LONG'
})
// 返回：止损在支撑位下方，止盈在阻力位
```

##### 策略4：追踪止损
```typescript
calculate_trailing_stop({
  entry_price: 50000,
  current_price: 51000,
  trailing_percent: 1,
  side: 'LONG'
})
// 返回：动态止损价随价格上涨而上移
```

#### 3. 风险检查器 (RiskCalculator)
**全方位风险检查：**

```typescript
// 检查是否可以开仓
await check_can_open_position(
  strategy_id: 1,
  symbol: 'BTCUSDT',
  position_value: 1000,
  total_capital: 10000
)

// 返回检查结果：
{
  can_open: true/false,
  reason: '检查通过' | '具体失败原因',
  current_positions_count: 3,
  current_risk_percent: 15.5,
  daily_pnl_percent: -2.3
}
```

**检查项目：**
1. ✅ 币种黑名单检查
2. ✅ 最大持仓数量限制
3. ✅ 单笔仓位占比限制
4. ✅ 总风险敞口限制
5. ✅ 当日亏损限制

**风险敞口查询：**
```typescript
await get_risk_exposure(strategy_id: 1, total_capital: 10000)

// 返回：
{
  total_positions: 3,
  total_risk_amount: 1500,
  total_risk_percent: 15.0,
  available_capital: 8500,
  daily_pnl: -230,
  daily_pnl_percent: -2.3,
  positions: [...详细持仓列表]
}
```

---

## 📁 目录结构

```
src/
├── quantitative/                    # 量化交易独立模块
│   ├── types/                       # 类型定义
│   │   ├── strategy_types.ts        # ✅ 策略类型（StrategyConfig、策略参数）
│   │   ├── backtest_types.ts        # ✅ 回测类型（BacktestResult、性能数据）
│   │   ├── trading_types.ts         # ✅ 交易类型（Trade、Position、信号）
│   │   └── risk_types.ts            # ✅ 风险类型（风控配置、检查结果）
│   │
│   ├── strategies/                  # 策略层
│   │   ├── base_strategy.ts         # ✅ 策略基类（含技术指标）
│   │   ├── strategy_manager.ts      # ✅ 策略管理器（单例）
│   │   ├── strategy_registry.ts     # ✅ 策略注册器（自动初始化）
│   │   └── implementations/         # 策略实现
│   │       ├── breakout_strategy.ts          # ✅ 突破策略
│   │       └── trend_following_strategy.ts   # ✅ 趋势跟踪策略
│   │
│   ├── backtesting/                 # 回测引擎
│   │   ├── backtest_engine.ts       # ✅ 回测引擎（主控制器）
│   │   ├── performance_analyzer.ts  # ✅ 性能分析器（指标计算）
│   │   └── trade_simulator.ts       # ✅ 交易模拟器（持仓管理）
│   │
│   └── risk/                        # 风险管理
│       ├── risk_calculator.ts       # ✅ 风险检查器（开仓检查）
│       ├── position_sizer.ts        # ✅ 仓位计算器（3种方法）
│       └── stop_loss_calculator.ts  # ✅ 止损计算器（4种策略）
│
├── database/quantitative/           # 数据库层
│   ├── strategy_repository.ts       # ✅ 策略配置CRUD + 性能统计
│   ├── backtest_repository.ts       # ✅ 回测结果CRUD + 最佳结果查询
│   ├── trade_repository.ts          # ✅ 交易记录CRUD + 批量保存
│   ├── position_repository.ts       # ✅ 持仓CRUD + 持仓统计
│   └── risk_repository.ts           # ✅ 风控配置CRUD + 黑名单管理
│
└── api/routes/
    └── quantitative_routes.ts       # ✅ 量化交易API（25+接口）
```

---

## 🗄️ 数据库初始化

### 步骤1：执行SQL迁移文件

```bash
# 连接MySQL
mysql -u your_username -p trading_master

# 执行迁移文件
source database/migrations/006_create_quantitative_tables.sql
```

### 步骤2：验证表创建

```sql
-- 查看所有量化交易相关表
SHOW TABLES LIKE 'quant_%';

-- 应该看到6张表:
-- quant_strategies
-- quant_backtest_results
-- quant_trades
-- quant_positions
-- quant_strategy_performance
-- quant_risk_config
```

### 步骤3：查看默认数据

```sql
-- 查看预置策略
SELECT * FROM quant_strategies;

-- 查看风控配置
SELECT * FROM quant_risk_config;
```

---

## 🔌 API接口

### 基础URL
```
http://localhost:3000/api/quant
```

### 策略管理 (7个接口)

#### 1. 获取所有策略
```http
GET /api/quant/strategies
```

**响应示例:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Default Breakout Strategy",
      "type": "breakout",
      "description": "基于区间突破的交易策略",
      "parameters": {
        "lookback_period": 200,
        "min_range_touches": 4,
        "min_confidence": 0.7
      },
      "enabled": false,
      "mode": "backtest",
      "created_at": "2025-10-07T12:00:00.000Z"
    }
  ],
  "count": 2
}
```

#### 2. 获取策略详情
```http
GET /api/quant/strategies/:id
```

#### 3. 创建策略
```http
POST /api/quant/strategies
Content-Type: application/json

{
  "name": "My Custom Strategy",
  "type": "breakout",
  "description": "我的自定义突破策略",
  "parameters": {
    "lookback_period": 100,
    "min_confidence": 0.8
  },
  "mode": "backtest"
}
```

#### 4. 更新策略
```http
PUT /api/quant/strategies/:id
Content-Type: application/json

{
  "parameters": {
    "lookback_period": 150
  },
  "enabled": true
}
```

#### 5. 删除策略
```http
DELETE /api/quant/strategies/:id
```

#### 6. 启用/禁用策略
```http
POST /api/quant/strategies/:id/toggle
Content-Type: application/json

{
  "enabled": true
}
```

#### 7. 获取策略性能统计
```http
GET /api/quant/strategies/:id/performance
```

**响应示例:**
```json
{
  "success": true,
  "data": {
    "strategy_id": 1,
    "total_backtests": 10,
    "total_trades": 245,
    "win_trades": 180,
    "loss_trades": 65,
    "win_rate": 73.47,
    "avg_return": 5.23,
    "avg_sharpe": 1.85,
    "avg_max_drawdown": -12.45
  }
}
```

### 回测系统 (10个接口)

> ⚠️ **重要更新**：回测系统已升级为**异步任务模式**，解决长时间回测超时问题。

#### 异步回测工作流程

```
1. 发起回测 → 立即返回 task_id
2. 轮询进度 → 实时获取进度和状态
3. 完成后   → 获取回测结果
```

#### 1. 运行回测 ⭐ (异步)
```http
POST /api/quant/backtest/run
Content-Type: application/json

{
  "strategy_id": 1,
  "symbol": "BTCUSDT",
  "interval": "15m",
  "start_time": 1704067200000,
  "end_time": 1706745600000,
  "initial_capital": 10000
}
```

**响应示例（立即返回任务ID）：**
```json
{
  "success": true,
  "message": "Backtest task created successfully",
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "message": "Use GET /api/quant/backtest/tasks/:task_id to check progress"
  }
}
```

#### 2. 查询任务状态和进度 ⭐ (新增)
```http
GET /api/quant/backtest/tasks/:task_id
```

**响应示例（运行中）：**
```json
{
  "success": true,
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "running",
    "progress": {
      "current_kline": 1500,
      "total_klines": 2112,
      "trades_count": 8,
      "elapsed_seconds": 45
    },
    "created_at": 1704067200000,
    "started_at": 1704067205000
  }
}
```

**响应示例（完成）：**
```json
{
  "success": true,
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "result": {
      "id": 123,
      "strategy_id": 1,
      "symbol": "BTCUSDT",
      "interval": "15m",
      "start_time": "2024-01-01T00:00:00.000Z",
      "end_time": "2024-02-01T00:00:00.000Z",
      "initial_capital": 10000,
      "final_capital": 11523.45,
      "total_return": 15.23,
      "annual_return": 91.38,
      "sharpe_ratio": 1.85,
      "max_drawdown": -8.45,
      "total_trades": 45,
      "win_rate": 71.11,
      "profit_factor": 1.99,
    "performance_data": {
      "equity_curve": [...],
      "drawdown_curve": [...],
      "monthly_returns": {...}
    }
  },
  "created_at": 1704067200000,
  "started_at": 1704067205000,
  "completed_at": 1704067250000
}
```

**响应示例（失败）：**
```json
{
  "success": true,
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "failed",
    "error": "No historical klines found for the specified period",
    "created_at": 1704067200000,
    "started_at": 1704067205000,
    "completed_at": 1704067210000
  }
}
```

**任务状态说明：**
- `pending` - 等待执行
- `running` - 执行中
- `completed` - 执行完成
- `failed` - 执行失败
- `cancelled` - 已取消

#### 3. 获取任务列表 (新增)
```http
GET /api/quant/backtest/tasks?limit=10
```

**响应示例：**
```json
{
  "success": true,
  "data": [
    {
      "task_id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed",
      "request": {
        "strategy_id": 1,
        "symbol": "BTCUSDT",
        "interval": "15m"
      },
      "created_at": 1704067200000
    }
  ],
  "count": 1
}
```

#### 4. 取消任务 (新增)
```http
DELETE /api/quant/backtest/tasks/:task_id
```

**响应示例：**
```json
{
  "success": true,
  "message": "Backtest task cancelled successfully"
}
```

**注意：** 只能取消 `pending` 或 `running` 状态的任务。

---

#### 前端轮询示例代码

```javascript
// 发起回测并轮询进度
async function runBacktest() {
  // 1. 创建任务
  const { data } = await axios.post('/api/quant/backtest/run', {
    strategy_id: 1,
    symbol: 'BTCUSDT',
    interval: '15m',
    start_time: 1704067200000,
    end_time: 1706659200000,
    initial_capital: 10000
  });

  const task_id = data.data.task_id;
  console.log('任务已创建:', task_id);

  // 2. 轮询进度
  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const { data: response } = await axios.get(`/api/quant/backtest/tasks/${task_id}`);
        const task = response.data;

        if (task.status === 'running' && task.progress) {
          const percent = (task.progress.current_kline / task.progress.total_klines * 100).toFixed(1);
          console.log(`进度: ${percent}% (${task.progress.current_kline}/${task.progress.total_klines} K线)`);
          console.log(`已用时: ${task.progress.elapsed_seconds}秒, 交易数: ${task.progress.trades_count}`);
        }

        if (task.status === 'completed') {
          clearInterval(poll);
          console.log('✅ 回测完成！');
          resolve(task.result);
        }

        if (task.status === 'failed') {
          clearInterval(poll);
          console.error('❌ 回测失败:', task.error);
          reject(new Error(task.error));
        }

        if (task.status === 'cancelled') {
          clearInterval(poll);
          console.warn('⚠️ 回测已取消');
          reject(new Error('Task cancelled'));
        }
      } catch (error) {
        clearInterval(poll);
        reject(error);
      }
    }, 3000); // 每3秒轮询一次
  });
}

// 使用示例
runBacktest()
  .then(result => {
    console.log('回测结果:', result);
    console.log(`总收益率: ${result.total_return}%`);
    console.log(`夏普比率: ${result.sharpe_ratio}`);
    console.log(`总交易数: ${result.total_trades}`);
  })
  .catch(error => {
    console.error('回测错误:', error);
  });
```

---

#### 5. 获取回测结果列表
```http
GET /api/quant/backtest/results?limit=50&offset=0&strategy_id=1&symbol=BTCUSDT
```

#### 6. 获取回测详情
```http
GET /api/quant/backtest/results/:id
```

#### 7. 获取回测交易明细
```http
GET /api/quant/backtest/results/:id/trades
```

**响应示例：**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "backtest_id": 123,
      "symbol": "BTCUSDT",
      "side": "LONG",
      "entry_price": 50000,
      "exit_price": 52500,
      "quantity": 0.2,
      "entry_time": "2024-01-05T10:30:00.000Z",
      "exit_time": "2024-01-06T14:20:00.000Z",
      "pnl": 500,
      "pnl_percent": 5.0,
      "exit_reason": "take_profit"
    }
  ]
}
```

#### 8. 获取策略最佳回测
```http
GET /api/quant/backtest/best/:strategy_id?metric=sharpe_ratio
```

#### 9. 按币种获取回测
```http
GET /api/quant/backtest/symbol/:symbol?interval=15m
```

#### 10. 删除回测记录
```http
DELETE /api/quant/backtest/results/:id
```

### 交易记录 (4个接口)

#### 1. 获取交易记录
```http
GET /api/quant/trades?strategy_id=1&symbol=BTCUSDT&limit=100&offset=0
```

#### 2. 获取交易详情
```http
GET /api/quant/trades/:id
```

#### 3. 获取交易统计
```http
GET /api/quant/trades/statistics?strategy_id=1&symbol=BTCUSDT
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "total_trades": 245,
    "win_trades": 180,
    "loss_trades": 65,
    "win_rate": 73.47,
    "total_pnl": 12345.67,
    "avg_pnl": 50.39,
    "avg_win": 125.45,
    "avg_loss": -85.32,
    "profit_factor": 1.47,
    "max_consecutive_wins": 8,
    "max_consecutive_losses": 3
  }
}
```

#### 4. 按回测ID获取交易
```http
GET /api/quant/trades/backtest/:backtest_id
```

### 持仓管理 (4个接口)

#### 1. 获取持仓列表
```http
GET /api/quant/positions?strategy_id=1&status=open
```

**响应示例：**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "strategy_id": 1,
      "symbol": "BTCUSDT",
      "side": "LONG",
      "entry_price": 50000,
      "quantity": 0.2,
      "entry_time": "2024-01-05T10:30:00.000Z",
      "stop_loss": 49000,
      "take_profit": 52500,
      "unrealized_pnl": 200,
      "status": "open"
    }
  ]
}
```

#### 2. 获取持仓详情
```http
GET /api/quant/positions/:id
```

#### 3. 获取持仓统计
```http
GET /api/quant/positions/statistics?strategy_id=1
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "total_positions": 120,
    "open_positions": 5,
    "closed_positions": 115,
    "total_value": 10000,
    "total_unrealized_pnl": 500,
    "total_realized_pnl": 3500
  }
}
```

#### 4. 按策略获取持仓
```http
GET /api/quant/positions/strategy/:strategy_id?status=open
```

### 风险管理 (4个接口)

#### 1. 获取风控配置
```http
GET /api/quant/risk/config/:strategy_id
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "strategy_id": 1,
    "max_positions": 5,
    "max_position_size_percent": 20.00,
    "max_total_risk_percent": 50.00,
    "stop_loss_percent": 2.00,
    "take_profit_percent": 5.00,
    "max_daily_loss_percent": 10.00,
    "blacklist_symbols": ["DOGEUSDT", "SHIBUSDT"]
  }
}
```

#### 2. 更新风控配置
```http
PUT /api/quant/risk/config/:strategy_id
Content-Type: application/json

{
  "max_positions": 10,
  "stop_loss_percent": 3.00,
  "blacklist_symbols": ["DOGEUSDT", "SHIBUSDT"]
}
```

#### 3. 获取风险敞口 ⭐
```http
GET /api/quant/risk/exposure?strategy_id=1&total_capital=10000
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "total_positions": 3,
    "total_risk_amount": 1500,
    "total_risk_percent": 15.0,
    "available_capital": 8500,
    "daily_pnl": -230,
    "daily_pnl_percent": -2.3,
    "positions": [
      {
        "symbol": "BTCUSDT",
        "side": "LONG",
        "position_value": 1000,
        "risk_amount": 200,
        "unrealized_pnl": 50
      }
    ]
  }
}
```

#### 4. 检查开仓风险 ⭐
```http
GET /api/quant/risk/check/:strategy_id?symbol=BTCUSDT&position_value=1000&total_capital=10000
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "can_open": true,
    "reason": "检查通过",
    "current_positions_count": 3,
    "current_risk_percent": 15.5,
    "daily_pnl_percent": -2.3
  }
}
```

---

## 🧪 完整测试流程

### 步骤1：启动服务
```bash
npm run dev
```

### 步骤2：验证策略已注册
```bash
# 获取所有策略（应该看到2个预置策略）
curl http://localhost:3000/api/quant/strategies

# 响应应包含：
# 1. Default Breakout Strategy (id: 1)
# 2. Default Trend Following Strategy (id: 2)
```

### 步骤3：运行回测 ⭐
```bash
# 回测突破策略 (BTCUSDT, 15分钟, 1个月数据)
curl -X POST http://localhost:3000/api/quant/backtest/run \
  -H "Content-Type: application/json" \
  -d '{
    "strategy_id": 1,
    "symbol": "BTCUSDT",
    "interval": "15m",
    "start_time": 1704067200000,
    "end_time": 1706745600000,
    "initial_capital": 10000,
    "commission_rate": 0.001
  }'

# 回测趋势跟踪策略
curl -X POST http://localhost:3000/api/quant/backtest/run \
  -H "Content-Type: application/json" \
  -d '{
    "strategy_id": 2,
    "symbol": "ETHUSDT",
    "interval": "1h",
    "start_time": 1704067200000,
    "end_time": 1706745600000,
    "initial_capital": 10000
  }'
```

### 步骤4：查看回测结果
```bash
# 获取回测结果列表
curl "http://localhost:3000/api/quant/backtest/results?limit=10"

# 获取回测详情（假设回测ID为1）
curl http://localhost:3000/api/quant/backtest/results/1

# 获取回测交易明细
curl http://localhost:3000/api/quant/backtest/results/1/trades

# 获取策略最佳回测（按夏普比率）
curl "http://localhost:3000/api/quant/backtest/best/1?metric=sharpe_ratio"
```

### 步骤5：查看交易统计
```bash
# 获取交易统计
curl "http://localhost:3000/api/quant/trades/statistics?strategy_id=1"

# 获取交易列表
curl "http://localhost:3000/api/quant/trades?strategy_id=1&limit=50"
```

### 步骤6：风险管理测试
```bash
# 获取风控配置
curl http://localhost:3000/api/quant/risk/config/1

# 更新风控配置
curl -X PUT http://localhost:3000/api/quant/risk/config/1 \
  -H "Content-Type: application/json" \
  -d '{
    "max_positions": 8,
    "max_position_size_percent": 15.0,
    "stop_loss_percent": 2.5,
    "blacklist_symbols": ["DOGEUSDT", "SHIBUSDT"]
  }'

# 检查开仓风险
curl "http://localhost:3000/api/quant/risk/check/1?symbol=BTCUSDT&position_value=1000&total_capital=10000"

# 查看风险敞口
curl "http://localhost:3000/api/quant/risk/exposure?strategy_id=1&total_capital=10000"
```

### 步骤7：策略管理
```bash
# 更新策略参数
curl -X PUT http://localhost:3000/api/quant/strategies/1 \
  -H "Content-Type: application/json" \
  -d '{
    "parameters": {
      "lookback_period": 300,
      "min_confidence": 0.8
    }
  }'

# 启用/禁用策略
curl -X POST http://localhost:3000/api/quant/strategies/1/toggle \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# 获取策略性能统计
curl http://localhost:3000/api/quant/strategies/1/performance
```

---

## 💡 使用示例

### 示例1：批量回测多个币种
```bash
# 对TOP10币种分别回测突破策略
for symbol in BTCUSDT ETHUSDT BNBUSDT SOLUSDT ADAUSDT XRPUSDT DOGEUSDT DOTUSDT MATICUSDT AVAXUSDT
do
  curl -X POST http://localhost:3000/api/quant/backtest/run \
    -H "Content-Type: application/json" \
    -d "{
      \"strategy_id\": 1,
      \"symbol\": \"$symbol\",
      \"interval\": \"15m\",
      \"start_time\": 1704067200000,
      \"end_time\": 1706745600000,
      \"initial_capital\": 10000
    }"
  sleep 2
done
```

### 示例2：参数优化测试
```bash
# 测试不同的止损百分比
for stop_loss in 1.5 2.0 2.5 3.0
do
  # 更新策略参数
  curl -X PUT http://localhost:3000/api/quant/strategies/1 \
    -H "Content-Type: application/json" \
    -d "{\"parameters\": {\"stop_loss_percent\": $stop_loss}}"

  # 运行回测
  curl -X POST http://localhost:3000/api/quant/backtest/run \
    -H "Content-Type: application/json" \
    -d '{
      "strategy_id": 1,
      "symbol": "BTCUSDT",
      "interval": "15m",
      "start_time": 1704067200000,
      "end_time": 1706745600000,
      "initial_capital": 10000
    }'
  sleep 2
done

# 查找最佳参数
curl "http://localhost:3000/api/quant/backtest/best/1?metric=sharpe_ratio"
```

### 示例3：风险检查工作流
```typescript
// 在开仓前检查风险
const checkRisk = async (strategyId: number, symbol: string, positionValue: number) => {
  const response = await fetch(
    `http://localhost:3000/api/quant/risk/check/${strategyId}?` +
    `symbol=${symbol}&position_value=${positionValue}&total_capital=10000`
  );
  const { data } = await response.json();

  if (!data.can_open) {
    console.log(`❌ 无法开仓: ${data.reason}`);
    return false;
  }

  console.log(`✅ 风险检查通过`);
  console.log(`当前持仓数: ${data.current_positions_count}`);
  console.log(`当前风险: ${data.current_risk_percent}%`);
  return true;
};

// 使用示例
await checkRisk(1, 'BTCUSDT', 1000);
```

---

## 📊 性能指标说明

### 核心指标解释

| 指标 | 说明 | 优秀标准 |
|------|------|----------|
| **总收益率** | (期末资金 - 期初资金) / 期初资金 | > 20% |
| **年化收益率** | 总收益率按年化计算 | > 50% |
| **夏普比率** | (年化收益率 - 无风险利率) / 收益波动率 | > 1.5 |
| **最大回撤** | 资金曲线最大跌幅 | < 15% |
| **胜率** | 盈利交易数 / 总交易数 | > 50% |
| **盈亏比** | 总盈利 / 总亏损 | > 1.5 |
| **平均盈利** | 所有盈利交易的平均值 | - |
| **平均亏损** | 所有亏损交易的平均值 | - |

### 策略评估标准
```
优秀策略：
- 夏普比率 > 2.0
- 最大回撤 < 10%
- 胜率 > 60%
- 盈亏比 > 2.0

良好策略：
- 夏普比率 > 1.5
- 最大回撤 < 15%
- 胜率 > 50%
- 盈亏比 > 1.5

需优化：
- 夏普比率 < 1.0
- 最大回撤 > 20%
- 胜率 < 40%
- 盈亏比 < 1.0
```

---

## 🔧 故障排查

### 常见问题

#### 1. 回测返回空交易
**原因：** K线数据不足或策略参数过严
**解决：**
```bash
# 检查K线数据是否存在
curl "http://localhost:3000/api/klines/BTCUSDT/15m?limit=100"

# 放宽策略参数
curl -X PUT http://localhost:3000/api/quant/strategies/1 \
  -H "Content-Type: application/json" \
  -d '{"parameters": {"min_confidence": 0.5, "min_strength": 0.4}}'
```

#### 2. 风险检查总是失败
**原因：** 风控配置过严或已有持仓过多
**解决：**
```bash
# 检查当前风险敞口
curl "http://localhost:3000/api/quant/risk/exposure?strategy_id=1&total_capital=10000"

# 放宽风控限制
curl -X PUT http://localhost:3000/api/quant/risk/config/1 \
  -H "Content-Type: application/json" \
  -d '{"max_positions": 10, "max_total_risk_percent": 60.0}'
```

#### 3. 策略未自动注册
**原因：** 服务启动时未执行策略注册
**解决：**
```bash
# 检查日志确认策略注册
# 应看到类似日志：
# "✅ Strategy registered: breakout"
# "✅ Strategy registered: trend_following"

# 重启服务
npm run dev
```

---

## 📚 相关文档

- **[API总文档](./API_REFERENCE.md)** - 完整的API接口说明
- **[项目开发指南](../CLAUDE.md)** - 系统架构和开发规范
- **[数据库迁移文件](../database/migrations/006_create_quantitative_tables.sql)** - 数据库表结构
- **[突破策略实现](../src/quantitative/strategies/implementations/breakout_strategy.ts)** - 突破策略源码
- **[趋势跟踪策略实现](../src/quantitative/strategies/implementations/trend_following_strategy.ts)** - 趋势策略源码

---

## 🎯 后续优化方向

### 短期优化（1-2周）
1. ✅ 添加更多技术指标（MACD、布林带、KDJ）
2. ✅ 实现实时策略运行（预留接口）
3. ✅ 添加策略组合功能
4. ✅ 实现参数自动优化

### 中期优化（1-2月）
1. ✅ 接入实盘交易API（币安下单）
2. ✅ 实现仓位动态调整
3. ✅ 添加更多策略类型（网格、马丁格尔）
4. ✅ 实现策略性能监控告警

### 长期优化（3-6月）
1. ✅ 机器学习策略集成
2. ✅ 多交易所支持
3. ✅ 分布式回测系统
4. ✅ Web可视化管理界面

---

**更新时间**: 2025-10-07
**当前版本**: v1.0.0 - All Phases Complete
**开发状态**: ✅ 生产就绪 (Production Ready)
**下一里程碑**: 实盘交易集成
