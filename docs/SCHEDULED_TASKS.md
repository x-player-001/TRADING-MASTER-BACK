# 系统定时任务清单

**文档日期**: 2025-12-01
**系统**: Trading Master Backend
**目的**: 记录所有定时任务，便于维护和优化

---

## 📊 任务总览

| 模块 | 任务数量 | 执行频率范围 | 状态 |
|------|----------|--------------|------|
| 实盘交易 | 2 | 30秒 - 120秒 | ✅ 活跃 |
| OI监控 | 2 | 60秒 - 2小时 | ✅ 活跃 |
| 系统监控 | 3 | 10分钟 - 1小时 | ✅ 活跃 |
| 数据库维护 | 1 | 每天1次 | ✅ 活跃 |
| 缓存清理 | 1 | 每小时 | ✅ 活跃 |
| WebSocket | 2 | 20秒 - 30秒 | ⚠️ 已禁用 |
| **总计** | **11** | - | **8个活跃** |

---

## 1️⃣ 实盘交易模块 (Live Trading)

### 1.1 币安持仓同步 ⭐ **核心任务**

**文件**: [scripts/run_live_trading_50usd.ts:197-203](scripts/run_live_trading_50usd.ts#L197-L203)

```typescript
setInterval(async () => {
  await trading_system.sync_positions_from_binance();
}, 30000);
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 30秒 |
| **主要职责** | 从币安同步持仓数据、更新价格、执行超时检查 |
| **调用方法** | `TradingSystem.sync_positions_from_binance()` |
| **数据源** | Binance Position Risk API |
| **关键操作** | ✅ 同步持仓<br>✅ 更新盈亏<br>✅ 检查超时平仓 (120分钟)<br>✅ 部分止盈检测<br>✅ 保本止损检测 |

**⚠️ 重要变更** (2025-12-01):
- 新增了超时平仓检查功能 (之前在OI轮询中，现已移至此处)
- 超时检查频率从60秒提升至30秒 → 响应更快 ✅

---

### 1.2 交易状态打印

**文件**: [scripts/run_live_trading_50usd.ts:294](scripts/run_live_trading_50usd.ts#L294)

```typescript
setInterval(print_status, 120000);
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 120秒 (2分钟) |
| **主要职责** | 打印当前交易状态、持仓信息、盈亏统计 |
| **调用方法** | `print_status()` |
| **输出内容** | ✅ 当前持仓<br>✅ 今日盈亏<br>✅ 累计盈亏<br>✅ 交易次数统计 |

---

## 2️⃣ OI监控模块 (Open Interest Monitoring)

### 2.1 OI数据轮询 ⭐ **核心任务**

**文件**: [src/services/oi_polling_service.ts:147](src/services/oi_polling_service.ts#L147)

```typescript
this.schedule_next_poll(); // 递归setTimeout，默认60秒
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 60秒 (可配置) |
| **主要职责** | 轮询持仓量数据、检测异动、生成交易信号 |
| **调用方法** | `OIPollingService.poll()` |
| **数据源** | Binance Premium Index API |
| **关键操作** | ✅ 拉取OI数据<br>✅ 多周期异动检测 (60s/120s/300s/900s)<br>✅ 生成交易信号<br>✅ 传递信号给交易系统 |

**⚠️ 重要变更** (2025-12-01):
- **已删除**: `update_trading_positions()` 调用
- **原因**: 职责分离 - OI监控不再直接管理交易系统持仓
- **新架构**: 只负责监控和信号生成，持仓管理完全由交易系统自主完成

**实现方式**: 递归 `setTimeout`（非 `setInterval`）
```typescript
private schedule_next_poll() {
  this.poll_timer = setTimeout(async () => {
    await this.poll();
    this.schedule_next_poll(); // 递归调用
  }, this.config.polling_interval_ms);
}
```

**优点**: 避免任务堆积（上次未完成时不会启动新任务）

---

### 2.2 监控币种列表刷新

**文件**: [src/services/oi_polling_service.ts:150-153](src/services/oi_polling_service.ts#L150-L153)

```typescript
this.symbol_refresh_timer = setInterval(
  () => this.refresh_symbols(),
  this.config.symbol_refresh_interval_ms  // 默认7200000ms = 2小时
);
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 2小时 |
| **主要职责** | 刷新监控的币种列表（动态获取交易量TOP币种） |
| **调用方法** | `OIPollingService.refresh_symbols()` |
| **数据源** | Binance 24hr Ticker API |
| **关键操作** | ✅ 获取最新TOP币种<br>✅ 更新监控列表<br>✅ 清理过期缓存 |

---

## 3️⃣ 系统监控模块 (System Monitoring)

### 3.1 系统指标收集 ⭐ **核心任务**

**文件**: [src/core/monitoring/monitoring_manager.ts:103-109](src/core/monitoring/monitoring_manager.ts#L103-L109)

```typescript
this.collection_timer = setInterval(async () => {
  await this.collect_and_store_metrics();
}, this.config.collection_interval); // 默认600000ms = 10分钟
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 10分钟 |
| **主要职责** | 收集系统性能指标、存储到Redis、检测告警条件 |
| **调用方法** | `MonitoringManager.collect_and_store_metrics()` |
| **收集指标** | ✅ 内存使用率<br>✅ CPU使用率<br>✅ MySQL连接池状态<br>✅ Redis内存使用<br>✅ API请求统计<br>✅ WebSocket连接状态 |
| **存储位置** | Redis (24小时TTL) |
| **告警检测** | ✅ 内存 > 80%<br>✅ CPU > 80%<br>✅ MySQL连接 > 80%<br>✅ API响应 > 1000ms<br>✅ Redis内存 > 500MB |

---

### 3.2 系统健康检查

**文件**: [src/core/monitoring/monitoring_manager.ts:116-122](src/core/monitoring/monitoring_manager.ts#L116-L122)

```typescript
this.health_check_timer = setInterval(async () => {
  await this.check_and_store_health();
}, this.config.health_check_interval); // 默认60000ms = 60秒
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 60秒 |
| **主要职责** | 检查各服务健康状态、存储到Redis |
| **调用方法** | `MonitoringManager.check_and_store_health()` |
| **检查项** | ✅ MySQL连接<br>✅ Redis连接<br>✅ Binance API<br>✅ WebSocket连接 |
| **存储位置** | Redis (5分钟TTL) |

---

### 3.3 监控数据清理

**文件**: [src/core/monitoring/monitoring_manager.ts:130-136](src/core/monitoring/monitoring_manager.ts#L130-L136)

```typescript
this.cleanup_timer = setInterval(async () => {
  await this.cleanup_expired_data();
}, 60 * 60 * 1000); // 每小时
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 1小时 |
| **主要职责** | 清理Redis中过期的监控数据、清理已解决的告警 |
| **调用方法** | `MonitoringManager.cleanup_expired_data()` |
| **清理内容** | ✅ 过期指标数据<br>✅ 过期健康检查数据<br>✅ 已解决的告警记录 |

---

## 4️⃣ 数据库维护模块 (Database Maintenance)

### 4.1 OI日期分表清理 ⭐ **核心任务**

**文件**: [src/database/daily_table_manager.ts:225-248](src/database/daily_table_manager.ts#L225-L248)

```typescript
// 首次延迟到凌晨1点执行
setTimeout(() => {
  this.run_cleanup_task();

  // 之后每24小时执行一次
  setInterval(() => {
    this.run_cleanup_task();
  }, 24 * 60 * 60 * 1000);
}, delay);
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 每天凌晨1点 |
| **主要职责** | 清理20天前的OI快照表、创建明天的表 |
| **调用方法** | `DailyTableManager.run_cleanup_task()` |
| **清理规则** | 删除 `open_interest_snapshots_YYYYMMDD` 表（日期 < 当前-20天） |
| **关键操作** | ✅ 删除旧表<br>✅ 释放存储空间<br>✅ 提前创建明天的表 |

**实现特点**:
- 动态计算首次执行延迟（到下一个凌晨1点）
- 首次执行后启动24小时循环定时器

---

## 5️⃣ 缓存清理模块 (Cache Cleanup)

### 5.1 历史数据缓存清理

**文件**: [src/index.ts:152-160](src/index.ts#L152-L160)

```typescript
setInterval(async () => {
  await this.historical_data_manager.cleanup_expired_cache();
  logger.info('🧹 Cache cleanup completed');
}, 60 * 60 * 1000); // 每小时
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 1小时 |
| **主要职责** | 清理Redis中过期的历史K线数据缓存 |
| **调用方法** | `HistoricalDataManager.cleanup_expired_cache()` |
| **清理规则** | TTL过期的缓存key（默认24小时） |

---

## 6️⃣ WebSocket模块 (已禁用) ⚠️

### 6.1 WebSocket心跳检测 (已禁用)

**文件**: [src/core/data/subscription_pool.ts:220](src/core/data/subscription_pool.ts#L220)

```typescript
this.ping_timer = setInterval(() => {
  if (this.ws && this.is_connected) {
    this.ws.ping();
  }
}, this.config.ping_interval); // 默认30000ms = 30秒
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 30秒 |
| **状态** | ⚠️ 已禁用 (WebSocket功能已关闭) |
| **主要职责** | 发送ping帧保持连接活跃 |

---

### 6.2 订阅状态监控 (已禁用)

**文件**: [src/core/data/multi_symbol_manager.ts:389](src/core/data/multi_symbol_manager.ts#L389)

```typescript
this.status_update_timer = setInterval(async () => {
  // 更新Redis订阅状态
}, 20000); // 20秒
```

| 属性 | 值 |
|------|-----|
| **执行频率** | 20秒 |
| **状态** | ⚠️ 已禁用 (WebSocket功能已关闭) |
| **主要职责** | 更新订阅流状态到Redis |

---

## 📈 任务执行时间线 (30秒窗口)

```
00:00  ├─ 币安持仓同步 (30s)
       ├─ WebSocket心跳 (30s) [已禁用]
00:20  ├─ 订阅状态监控 (20s) [已禁用]
00:30  ├─ 币安持仓同步 (30s)
00:40  ├─ 订阅状态监控 (20s) [已禁用]
01:00  ├─ 币安持仓同步 (30s)
       ├─ OI数据轮询 (60s)
       ├─ 系统健康检查 (60s)
       └─ WebSocket心跳 (30s) [已禁用]
```

---

## 📈 任务执行时间线 (完整周期)

```
时间轴              任务
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
每30秒              币安持仓同步 ⭐
每60秒              OI数据轮询 ⭐
                    系统健康检查
每2分钟             交易状态打印
每10分钟            系统指标收集 ⭐
每1小时             监控数据清理
                    缓存清理
每2小时             监控币种刷新
每天凌晨1点         OI日期分表清理 ⭐
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⭐ = 核心任务
```

---

## 🔍 任务依赖关系

```
币安持仓同步 (30s)
  ├─ 同步持仓数据
  ├─ 更新价格和盈亏
  ├─ 检查超时平仓 ⭐ (新增)
  ├─ 检测部分止盈
  └─ 检查保本止损

OI数据轮询 (60s)
  ├─ 拉取OI数据
  ├─ 异动检测
  ├─ 生成交易信号
  └─ 传递给交易系统 → 触发开仓判断
      └─ 可能触发: 币安开仓API调用
          └─ 下个周期: 持仓同步发现新仓位

系统指标收集 (10分钟)
  ├─ 收集性能数据
  ├─ 检查告警条件
  └─ 触发告警事件 (如有)
```

---

## ⚠️ 重要说明

### **1. 架构优化变更 (2025-12-01)**

#### **变更前**:
```
OI轮询 (60s)
  └─ update_trading_positions()  ❌ 越界调用
     └─ 检查超时平仓

币安同步 (30s)
  └─ 只同步持仓
```

**问题**: 职责混乱、数据源冲突

#### **变更后**:
```
OI轮询 (60s)
  └─ 只负责: 监控 + 信号生成 ✅

币安同步 (30s)
  └─ 完全自主: 同步 + 更新 + 超时检查 + 止盈止损 ✅
```

**优点**: 职责清晰、数据统一、无冲突

---

### **2. 定时器类型选择**

| 场景 | 使用方式 | 原因 |
|------|----------|------|
| **OI轮询** | 递归`setTimeout` | 避免任务堆积（上次未完成时不启动新任务） |
| **其他任务** | `setInterval` | 固定间隔执行，任务耗时短不会堆积 |

---

### **3. 性能影响**

| 任务 | CPU占用 | 内存占用 | 网络请求 |
|------|---------|----------|----------|
| 币安持仓同步 | 低 | 低 | 1次/30s (Position Risk API) |
| OI数据轮询 | 中 | 中 | 1次/60s (Premium Index API, 批量) |
| 系统指标收集 | 低 | 低 | 0 (本地收集) |
| 健康检查 | 低 | 低 | 3次/60s (MySQL, Redis, Binance) |

---

## 📝 维护建议

### **1. 监控重点**
- ✅ 确保币安持仓同步不超时（30秒内完成）
- ✅ OI轮询不堆积（使用递归setTimeout确保）
- ✅ 监控Redis内存使用（告警 > 500MB）

### **2. 性能优化**
- 如果币种数量 > 300，考虑增加OI轮询间隔（60s → 90s）
- 监控数据清理可以降低频率（1小时 → 2小时）

### **3. 故障排查**
```bash
# 查看定时器运行状态
grep "setInterval\|setTimeout" src/**/*.ts

# 检查Redis缓存大小
redis-cli INFO memory

# 查看MySQL连接池状态
mysql -e "SHOW PROCESSLIST"
```

---

## 🎯 总结

**活跃任务数**: 8个
**最高频率**: 30秒 (币安持仓同步)
**最低频率**: 每天 (OI分表清理)
**架构状态**: ✅ 职责清晰、解耦完成
**性能状态**: ✅ 轻量级、无性能瓶颈

**核心任务**:
1. 币安持仓同步 (30s) - 持仓管理的心脏
2. OI数据轮询 (60s) - 交易信号的源头
3. 系统指标收集 (10min) - 性能监控基础
4. OI日期分表清理 (每天) - 存储空间优化

---

**文档维护**: 如有新增或修改定时任务，请及时更新此文档
