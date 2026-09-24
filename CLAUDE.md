# 智能加密货币交易后端系统 - Claude 开发指南

## 📋 项目概述

基于 Node.js + TypeScript 的加密货币量化交易后端。系统当前的**业务重心是趋势跟随信号系统**：
全市场实时监控 → 识别强势第一波 → 回调分级报警 → 多周期扳机确认 → 事后评估闭环 → AI 复盘。

OI 监控、成交量异动、盘口、形态扫描、支撑阻力等作为**辅助信号源**并行运行，
回测与实盘执行框架已具备但非当前主线。

## 🛠️ 技术栈

- **Node.js + TypeScript**（`snake_case` 命名，见开发规范）
- **Express.js** — REST API
- **WebSocket** — 币安 U 本位合约实时流 `wss://fstream.binance.com`
- **MySQL** — K线分表、信号、报警、交易日志
- **Redis** — 缓存
- **AI SDK** — Claude / OpenAI / DeepSeek（交易复盘，**仅服务器有**）
- **Telegram Bot** — 报警推送
- **pm2 + swc** — 生产部署

## 🚀 运行形态（生产）

服务跑在**服务器**上，通过 pm2 托管三个进程（见 `ecosystem.config.js`）：

| 进程 | 入口 | 职责 |
|---|---|---|
| `api` | `dist/index_api_only.js` | 只读 API 服务（swc build 产物，非 ts-node） |
| `trend` | `scripts/run_trend_follow_monitor.ts` | **核心**：全市场 5m WS 监控 + 分级报警 |
| `alerts` | `scripts/evaluate_alert_outcomes.ts --loop` | 报警事后评估器（常驻） |

```bash
npm run build          # swc 编译到 dist/
pm2 restart api        # 更新 api 需先 build
pm2 restart trend alerts
```

> ⚠️ **本机无法访问币安 API**，涉及行情拉取的脚本必须在服务器执行。
> 本机可直连服务器 MySQL 做数据分析（脚本读 `.env`）。

## 🎯 核心业务：趋势跟随分级报警

主逻辑在 `src/services/trend_follow_service.ts`，运行器 `scripts/run_trend_follow_monitor.ts`。

### 状态机

```
IDLE → DETECTING → WATCHING → ALERTED
                      ↓          ↓
                 ABANDONED   BREAKTHROUGH
```

5m / 15m / 1h / 4h **四周期并行**，每个 `symbol × timeframe` 一个独立 `WatchContext`；
进程重启时从 `trend_follow_watch_contexts` 表恢复上下文。

### 回调分级（斐波那契）

| 等级 | 条件 | 说明 |
|---|---|---|
| **Lv1** | 回调 < 38.2%，缩量 | 轻度回调 |
| **Lv2** | 回调 38.2%~50%，缩量 + 止跌形态 | 黄金回调 |
| **Lv3** | 回调 50%~61.8% | 深度回调（**通知已静音**） |
| **废弃** | > 61.8% / 超时 / 连续大阴线 | 转 ABANDONED |

信号特征附加判定：`volume_shrink`（缩量）、`reversal_signal`（止跌形态）、`ema20_support`（回调低点贴近 EMA20）。

### 多周期扳机（Entry Trigger）

大周期（1h/4h）进入 ALERTED 后，挂一个该 symbol 的 **5m 监视器**，
等小周期结构确认（突破最近 N 根 5m 高点）才发「入场确认」，超时未确认则移除。
扳机门槛当前为 **Lv1**（曾为 Lv2，见 commit `13c9198`）。

### 事后评估闭环

`scripts/evaluate_alert_outcomes.ts` 对每条报警打标：
- `win` → 触及 target（第一波高点）
- `loss` → 触及 stop（回调低点下方 0.3%）
- `open` → 评估窗内未触及
- 记录 MFE / MAE，支持 **low / wave 两种止损口径**

结果写入 `trend_follow_alert_outcomes`，用于信号质量统计。

## 📁 项目结构

```
src/
├── index.ts                 # 全功能入口
├── index_api_only.ts        # 只读 API 入口（pm2 api 用）
├── api/
│   ├── api_server.ts        # Express 装配，挂载 20 个路由组
│   ├── routes/              # 各业务路由
│   ├── binance_api.ts / binance_futures_api.ts
│   └── binance_futures_trading_api.ts   # 下单/持仓
├── services/                # 12 个监控服务（业务主体）
│   ├── trend_follow_service.ts     ⭐ 核心
│   ├── ema20_push_service.ts
│   ├── oi_polling_service.ts
│   ├── volume_monitor_service.ts
│   ├── orderbook_monitor_service.ts
│   ├── kline_breakout_service.ts
│   ├── sr_alert_service.ts
│   ├── pattern_scan_service.ts
│   ├── perfect_hammer_trader.ts
│   ├── trade_log_service.ts        # AI 复盘（三层架构）
│   ├── market_sentiment_manager.ts
│   └── telegram_service.ts
├── analysis/                # 技术分析
│   ├── chan_theory/         # 缠论：分型/笔/中枢
│   ├── overlap_range_detector.ts   # 震荡区间识别（~2k 行）
│   ├── pattern_detector.ts
│   ├── support_resistance_detector.ts
│   ├── breakout_predictor.ts
│   └── technical_indicators.ts
├── trading/                 # 实盘/回测执行
│   ├── trading_system.ts    # 总装配（~2.2k 行）
│   ├── live_trading_engine.ts / backtest_engine.ts
│   ├── order_executor.ts / position_tracker.ts
│   ├── trailing_stop_manager.ts / risk_manager.ts
│   └── trading_cooldown_manager.ts
├── quantitative/            # 策略框架（策略/回测/风控/类型）
├── database/                # 30+ Repository
├── core/
│   ├── data/                # WS 订阅池、K线聚合、历史数据
│   ├── config/              # ConfigManager、TOP币种
│   ├── cache/               # Redis
│   └── monitoring/          # 健康检查、指标
├── signals/ · risk/ · rules/ · websocket/ · utils/ · types/
scripts/                     # 运行脚本（见下）
```

## 📜 脚本目录约定 ⭐

```
scripts/
├── run_trend_follow_monitor.ts     # pm2 trend
├── evaluate_alert_outcomes.ts      # pm2 alerts
├── run_backtest.ts / run_live_trading.ts / replay_trend_follow.ts
├── run_oi_monitor.ts / run_sr_monitor.ts / run_volume_monitor.ts ...
├── backfill_*.ts                   # K线回填（例行数据运维）
├── run_db_migration.ts · migrations/
└── dev/                            # ⚠️ 一次性脚本，不参与线上运行
    ├── analysis/      # analyze_* / export_* / list_*  信号质量与EV分析
    ├── debug/         # debug_* / diagnose_* / check_* / tmp_*
    ├── backtest/      # backtest_* / compare_*  参数试验
    ├── verify/        # test_* / verify_*
    └── maintenance/   # migrate_* / clear_* / truncate_*
```

**约定**：新增一次性调试/分析脚本请放进 `scripts/dev/<分类>/`，
根目录只保留 pm2 入口、npm scripts 引用、例行回填。

`dev/` 下脚本位于二级目录，相对导入为 `../../../src/...`（用 `@/` 别名则不受影响）：

```bash
npx ts-node -r tsconfig-paths/register scripts/dev/analysis/analyze_trend_signal_quality.ts
```

## 🗄️ 数据库

### K线分表
`kline_1m` / `kline_5m` / `kline_15m` / `kline_1h` / `kline_4h`
（`UNIQUE (symbol, open_time)` + `INSERT IGNORE` 去重；5m 为 WS 落库主表，
15m/1h/4h 由 `kline_aggregator` 聚合，也可回填）

### 业务表（按域）

| 域 | 表 |
|---|---|
| **趋势跟随** | `trend_follow_watch_contexts`、`trend_follow_alerts`、`trend_follow_entry_triggers`、`trend_follow_alert_outcomes` |
| **K线回放模拟交易** | `replay_sessions`、`replay_orders`、`replay_positions`、`replay_fills` |
| **EMA20 推动** | `ema20_push_contexts`、`ema20_push_records` |
| **交易日志** | `trade_log`、`trade_log_analysis`、`trade_log_review`、`binance_trades`、`trade_records`、`order_records` |
| **其他报警** | `volume_alerts`、`orderbook_alerts`、`sr_alerts`、`sr_levels`、`pattern_alerts`、`pattern_scan_results`、`pattern_scan_tasks` |
| **配置** | `symbol_configs`、`top_symbols_config`、`subscription_status`、`volume_monitor_symbols` |
| **缓存/信号** | `historical_data_cache`、`trading_signal_logs` |

> Repository 内部用 `CREATE TABLE IF NOT EXISTS` 自建表，启动即幂等初始化。

## 📡 API 路由（`src/api/api_server.ts`）

```
/api/oi            /api/monitoring     /api/top-symbols    /api/historical
/api/klines        /api/websocket      /api/signals        /api/structure
/api/quant         /api/trading        /api/backtest       /api/breakout
/api/boundary-alerts    /api/sr        /api/volume-monitor /api/pattern-scan
/api/orderbook     /api/trend-follow   /api/ema20-push     /api/trade-record
/api/replay
```

## 🎬 K线回放 + 模拟交易

`src/services/kline_replay/`，接口文档 `docs/KLINE_REPLAY_API.md`（前端自行实现）。

- **撮合在前端**：前端复制 `replay_types.ts` / `replay_matching_engine.ts` / `replay_account.ts`（纯 TS 无依赖），批量拉 5m 本地逐根揭示
- **后端只存储**：下发 5m 批量块（跨数据空洞）与历史K线（大周期未收盘由 5m 聚合），
  接收前端同步（进度 + 整份交易记录，`client_id` 关联，`revision` 防乱序），基于已存回合出统计
- 引擎规则：单向持仓、多空、市价/限价/条件单、SL/TP；K线内路径按不利方向优先（先打止损），跳空不利按开盘价、有利按挂单价
- 单测 `tests/kline_replay/`；端到端验证 `scripts/dev/verify/verify_kline_replay.ts`（需在服务器跑）

## 🤖 AI 交易复盘

`src/services/trade_log_service.ts` — 以**币安真实成交为主体的三层架构**
（`trade_log` 回合 → `trade_log_analysis` AI 分析 → `trade_log_review` 复盘）。

- 通过 `AI_PROVIDER` 切换 Claude / OpenAI / DeepSeek
- 模型经 `CLAUDE_MODEL` / `OPENAI_MODEL` / `DEEPSEEK_MODEL` 配置
- 入场评估与持仓再评估**异步执行**，立即返回 `journal_id` 避免前端超时
- K线以北京时间紧凑标注（`MMDD/HHMM`）传给 AI

## 📝 开发规范

### 命名（snake_case）
```typescript
const market_data = await get_market_data();
function calculate_rsi(prices: number[]): number {}

class DataManager {}          // 类/接口保持 PascalCase
interface TradingRule {}

const MAX_RETRY_ATTEMPTS = 3; // 常量 UPPER_SNAKE
```

### 约定
- 接口请求统一封装到 `src/api`，数据库操作统一封装到 `src/database`
- 每个方法/函数加简介注释
- 注意模块封装，减少代码冗余
- 全面 TypeScript 类型定义；完整异常捕获

## 💡 关键实现点

- **实时数据** — 全市场 5m WS 流，带 watchdog 自动重连
- **K线聚合** — `src/core/data/kline_aggregator.ts` 由 5m 合成 15m/1h/4h
- **查询降级** — Redis → MySQL → 币安 API 兜底
- **回填限速** — 币安权重限制，回填脚本控制在 **2400 权重/分钟**以内避免 429
- **`--force` 回填** — 补中间空洞，区分「API 拉取数」与「实际入库数」
- **状态持久化** — 监控上下文落库，进程重启无缝恢复

---

**目标**：以趋势跟随信号为核心，构建「信号生成 → 事后评估 → 质量分析 → 策略迭代」的可验证闭环。
