# 实盘交易系统运行流程详解

> 基于 `scripts/run_live_trading_50usd.ts` 脚本分析

---

## 📋 一、启动前配置

### 1.1 交易参数配置

```typescript
初始资金: $50
单笔保证金: $5 (10%)
杠杆倍数: 6x
单笔仓位值: $30 (= $5 × 6倍)
最大持仓数: 5个
单笔最大亏损: $5 (逐仓自动限损)
```

### 1.2 策略配置

```typescript
策略类型: 只做多突破策略 (LONG only)
最低信号评分: 8分 (满分10分)
追高阈值: 8% (价格距2小时最低点超过8%则不开仓)
最大持仓时间: 120分钟 (超时自动平仓)
```

### 1.3 止盈配置 (分批止盈)

```typescript
第1批: 30% 仓位 @ +7% 盈利
第2批: 30% 仓位 @ +13.8% 盈利
第3批: 40% 仓位 @ 跟踪止盈 (激活条件: +5%, 回调3%触发)
```

### 1.4 风控配置

```typescript
止损: 无固定止损 (逐仓模式自动限损)
每日亏损熔断: 20% (亏损$10后暂停交易)
连续亏损限制: 不限制
```

---

## 🚀 二、启动流程

### 2.1 系统初始化 (第53-161行)

```
1. 加载环境变量配置
   └─ 读取币安API密钥、数据库连接等

2. 创建 OIPollingService (OI持仓量监控服务)
   └─ 负责每分钟检测币安所有币种的持仓量异动

3. 初始化 OICacheManager (缓存管理器)
   └─ Redis缓存，用于存储OI快照和统计数据

4. 初始化 MarketSentimentManager (市场情绪管理器)
   └─ 获取大户多空比等辅助数据

5. 初始化 TradingSystem (交易系统)
   └─ 传递上述配置，创建交易引擎核心
   └─ 设置追高阈值为8%
```

### 2.2 启动监控服务 (第161行)

```typescript
await oi_service.start();
```

**内部执行逻辑：**
```
1. 加载数据库配置 (轮询间隔、异动阈值等)
2. 刷新监控币种列表 (从币安获取所有U本位合约)
3. 预热2小时价格窗口缓存 (从数据库加载历史K线)
4. 开始定时轮询
   └─ 启动定时器，每60秒执行一次 poll()
5. 启动币种列表刷新定时器 (每2小时刷新一次)
```

### 2.3 同步币安持仓 (第165-176行)

```typescript
await trading_system.sync_positions_from_binance();
```

**执行逻辑：**
```
1. 调用币安 Position Risk API 获取当前所有持仓
2. 对比本地持仓记录：
   ├─ 币安有本地无 → 新增持仓到本地
   │  └─ ⭐ 调用 fetch_actual_entry_time() 反向查找真实开仓时间
   │  └─ 设置止盈止损价格
   ├─ 币安无本地有 → 标记为已平仓
   │  └─ 调用 fetch_actual_close_data() 获取平仓数据
   │  └─ 写入数据库 order_records 表
   └─ 两边都有 → 更新持仓信息
      └─ 检测部分止盈（数量变少）
      └─ 更新未实现盈亏
      └─ 检查是否达到保本止损条件 (盈利≥10%)
```

### 2.4 回填历史交易 (第178-194行)

```typescript
await trading_system.backfill_historical_trades(7);
```

**执行逻辑：**
```
1. 调用币安 Income API 获取最近7天的已实现盈亏记录
2. 通过 realizedPnl 区分开仓/平仓订单：
   ├─ realizedPnl ≈ 0 → 开仓订单
   └─ realizedPnl ≠ 0 → 平仓订单
3. 按时间顺序处理，构建 position_id 关联
4. 检查数据库是否已存在，不存在则插入 order_records 表
```

---

## ⏱️ 三、定时任务

### 3.1 OI监控轮询 (每60秒)

**触发位置:** `oi_polling_service.ts:712-723 schedule_next_poll()`

**执行流程：**
```
1. 获取所有监控币种的OI数据 (批量API请求)
   └─ 默认监控300个币种

2. 批量获取资金费率和标记价格数据
   └─ 用于价格变化计算和追高判断

3. 更新2小时价格滑动窗口
   └─ 环形队列存储120个价格点 (用于判断是否追高)

4. 保存OI快照到数据库
   └─ 表: oi_snapshots_YYYYMMDD (按日期分表)

5. 检测OI异动 (4个时间周期)
   ├─ 60秒变化 ≥ 3% → 异动
   ├─ 120秒变化 ≥ 3% → 异动
   ├─ 300秒变化 ≥ 3% → 异动
   └─ 900秒变化 ≥ 10% → 异动

6. 保存异动记录到数据库
   └─ 表: oi_anomaly_records

7. 缓存预热 (主动查询统计数据缓存到Redis)

8. ⭐ 更新交易系统持仓价格
   └─ 调用 trading_system.update_positions(price_map)
```

### 3.2 持仓更新与超时检查 (每60秒)

**触发位置:** `oi_polling_service.ts:788-816 update_trading_positions()`
**调用链:** `update_positions()` → `check_and_close_timeout_positions()`

**执行流程：**
```
1. 获取所有开仓持仓
2. 构建价格Map (symbol → markPrice)
3. 更新每个持仓的当前价格和未实现盈亏
4. 检查超时平仓条件：
   ├─ 计算持仓时长 = now - opened_at
   ├─ 如果持仓时长 ≥ 120分钟：
   │  ├─ 撤销该币种所有挂单
   │  └─ 市价平仓
   └─ 记录平仓原因为 'TIMEOUT'
```

**⭐ 修复后的开仓时间获取逻辑：**
```
系统重启后同步持仓时：
1. 调用 fetch_actual_entry_time(symbol, side, positionAmt, entryPrice)
2. 从币安获取最近7天的 userTrades 数据
3. 反向累加持仓量：
   ├─ 从最新交易往前遍历
   ├─ 平仓交易 → position_amt += qty
   ├─ 开仓交易 → position_amt -= qty
   └─ 当 position_amt 减到 0 时 → 找到真实开仓时间 ✅
4. 价格验证：开仓价格与币安entryPrice误差 < 5%
```

### 3.3 币安持仓同步 (每30秒)

**触发位置:** `run_live_trading_50usd.ts:197-203`

```typescript
setInterval(async () => {
  await trading_system.sync_positions_from_binance();
}, 30000);
```

**作用：**
```
1. 检测手动平仓 → 同步到本地并记录
2. 检测部分止盈 → 更新本地持仓数量，撤销多余挂单
3. 更新未实现盈亏
4. 检查是否达到保本止损条件 (盈利≥10%)
   └─ 自动下保本止损单 (覆盖手续费后保本)
```

### 3.4 状态打印 (每120秒)

**触发位置:** `run_live_trading_50usd.ts:294`

```typescript
setInterval(print_status, 120000);
```

**显示内容：**
```
- OI监控状态 (运行中/已停止、监控币种数、运行时长)
- 交易模式 (实盘/测试网/模拟)
- 当前持仓详情 (币种、方向、价格、盈亏、持仓时长)
- 总交易统计 (总交易数、胜率、总盈亏、最大回撤、手续费)
- 今日交易统计 (今日交易数、胜率、盈亏)
```

---

## 🎯 四、交易信号触发

### 4.1 信号生成时机

**触发位置:** OI监控检测到异动后自动触发

**执行链路：**
```
OI轮询检测到异动
  ↓
调用 signal_generator.generate_signals(anomalies, price_map)
  ↓
对每个异动进行评分 (0-10分)
  ├─ OI变化幅度评分
  ├─ 价格OI同向性评分
  ├─ 追高惩罚 (距2小时最低点 > 8% → 大幅扣分)
  ├─ 资金费率评分
  └─ 多周期异动加分
  ↓
过滤低分信号 (评分 < 8分 → 丢弃)
  ↓
调用 trading_system.process_signals(signals)
```

### 4.2 开仓决策

**执行流程：**
```
1. 风险检查
   ├─ 每日亏损是否超限 (> 20%)
   ├─ 当前持仓数是否已满 (≥ 5个)
   └─ 该币种是否已有持仓

2. 方向过滤
   └─ 只允许做多 (LONG only)

3. 追高检查
   └─ 当前价格距2小时最低点 > 8% → 拒绝开仓

4. 计算仓位大小
   ├─ 保证金 = 账户余额 × 10% = $5
   └─ 开仓数量 = (保证金 × 杠杆) / 当前价格

5. 下市价开仓单
   └─ 使用币安 NEW_ORDER API

6. 下分批止盈挂单
   ├─ 第1档: 30% @ +7%
   ├─ 第2档: 30% @ +13.8%
   └─ 第3档: 40% 跟踪止盈

7. 记录到数据库
   └─ order_records 表 (order_type='OPEN')
```

### 4.3 平仓决策

**触发条件：**
```
1. 超时平仓 (持仓 ≥ 120分钟)
2. 止盈单成交 (分批止盈或跟踪止盈)
3. 逐仓爆仓 (亏损 ≥ 保证金$5)
4. 手动平仓 (通过币安APP操作)
5. 保本止损触发 (盈利达10%后回调到成本价)
```

**平仓流程：**
```
1. 撤销该币种所有未成交挂单
2. 下市价平仓单
3. 记录已实现盈亏
4. 写入数据库 (order_type='CLOSE', close_reason)
5. 更新统计数据 (胜率、总盈亏等)
```

---

## 📊 五、数据存储

### 5.1 核心数据表

```sql
-- 订单记录表
order_records (
  id, order_id, symbol, side, position_side, order_type,
  price, quantity, realized_pnl, commission,
  position_id, order_time, close_reason
)

-- OI快照表 (按日期分表)
oi_snapshots_YYYYMMDD (
  id, symbol, open_interest, sum_open_interest,
  timestamp, mark_price, funding_rate
)

-- OI异动记录表
oi_anomaly_records (
  id, symbol, period_seconds, percent_change,
  oi_before, oi_after, price_change_percent,
  signal_score, signal_direction, severity
)
```

### 5.2 数据流转

```
币安API → 内存处理 → Redis缓存 → MySQL持久化
                              ↓
                        查询降级策略:
                        Redis → MySQL → API兜底
```

---

## 🔧 六、关键配置

### 6.1 环境变量 (.env)

```bash
# 币安API
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret

# 数据库
MYSQL_HOST=45.249.246.109
MYSQL_USER=navicatuser
MYSQL_PASSWORD=navicatuser
MYSQL_DATABASE=trading_master

# OI监控
OI_MAX_MONITORED_SYMBOLS=300  # 监控币种数量
```

### 6.2 数据库配置

```sql
-- 可通过数据库动态调整
UPDATE oi_monitoring_config SET config_value = '60000' WHERE config_key = 'polling_interval_ms';
UPDATE oi_monitoring_config SET config_value = '{"60":3,"120":3,"300":3,"900":10}' WHERE config_key = 'thresholds';
```

---

## ⚠️ 七、重要注意事项

### 7.1 时间敏感性

```
- 超时检查依赖准确的 opened_at 时间
- 系统重启后会通过 fetch_actual_entry_time() 反向查找
- 价格窗口缓存每分钟更新一次 (用于追高判断)
```

### 7.2 资金安全

```
- 逐仓模式：单笔最大亏损 = 保证金 ($5)
- 每日熔断：亏损20% ($10) 自动暂停
- 最坏情况：5个仓位同时爆仓 = -$25 (-50%)
```

### 7.3 API频率限制

```
- OI数据查询：每分钟1次 × 300币种 = 高频调用
- 同步持仓：每30秒1次
- 需注意币安API权重限制 (1200/min)
```

---

## 📈 八、完整调用链路图

```
┌─────────────────────────────────────────────────────────┐
│  run_live_trading_50usd.ts (启动脚本)                     │
└────────────────┬────────────────────────────────────────┘
                 │
                 ├─ 初始化 OIPollingService
                 │     │
                 │     ├─ start() → 每60秒执行 poll()
                 │     │     │
                 │     │     ├─ 获取OI数据
                 │     │     ├─ 检测异动
                 │     │     ├─ 保存数据库
                 │     │     └─ update_trading_positions()
                 │     │           └─ update_positions()
                 │     │                 └─ check_and_close_timeout_positions()
                 │     │
                 │     └─ 每2小时刷新币种列表
                 │
                 ├─ 初始化 TradingSystem
                 │     │
                 │     ├─ sync_positions_from_binance() (启动时 + 每30秒)
                 │     │     └─ fetch_actual_entry_time() ⭐ 修复重点
                 │     │
                 │     ├─ backfill_historical_trades() (启动时执行一次)
                 │     │
                 │     └─ process_signals() (检测到异动时触发)
                 │           ├─ 风险检查
                 │           ├─ 计算仓位
                 │           ├─ 下开仓单
                 │           └─ 下止盈单
                 │
                 └─ 定时打印状态 (每120秒)
```

---

## 🎯 总结

**核心定时任务频率：**
- OI监控轮询: **60秒**
- 持仓同步: **30秒**
- 超时检查: **60秒** (随OI轮询触发)
- 状态打印: **120秒**

**关键修复点：**
- `fetch_actual_entry_time()` 函数已修复为反向累加匹配算法
- 解决了多次开平仓场景下开仓时间错误的问题
- 支持部分止盈场景的准确时间追溯

**安全机制：**
- 逐仓模式限制单笔亏损
- 每日熔断机制防止连续亏损
- 追高限制避免高位接盘
- 超时平仓避免长期持仓风险
