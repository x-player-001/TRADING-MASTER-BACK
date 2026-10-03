# 实盘 API

**分工：交易由服务器上的 pm2 `live` 进程在币安真实下单，API 只读，前端负责展示。** 暂停、恢复、一键平仓等控制操作不提供接口，只能在服务器上用 `scripts/live_control.ts` 执行。

前缀 `/api/live`。所有响应形如 `{ success: true, data }`；出错返回 `{ success: false, error }`，404 表示交易不存在。
时间均为毫秒时间戳（UTC）；K 线时间是 `open_time`，前端显示时自行转北京时间。金额单位 USDT。

## 策略规则

当前接入模拟盘的 S1、S2 两套策略，识别和过滤参数与模拟盘完全相同（见 `docs/PAPER_TRADING_API.md`）：

| 策略 id | 名称 | 周期 | 止损 |
|---|---|---|---|
| `macd_top_div_15m` | S1 15m 顶背离 | 15m | 新高 |
| `macd_top_div_5m` | S2 5m 顶背离 | 5m | 新高 + 0.5 ATR |

**流程**：
1. 反转K线收盘后挂 STOP 卖出条件单，触发价为反转K线低点，触发后以 IOC 限价成交。
2. 成交后立即挂止损单和止盈单，止盈为成交均价起算的 2R。
3. 条件单有效 6 根；未触发前价格先破新高则撤单。持仓满 48 根后市价平仓。

**和模拟盘的区别**：
- **两个策略合计**，同一个币同一时间只做一笔，后到的信号记为 `skipped / symbol_busy`。
- 每笔风险固定 10U：`qty = 10 / (止损 − 触发价)`。最终数量还受名义价值上限和保证金约束；盈亏和手续费全部取自交易所成交明细。

## 交易状态 `status`

| status | 含义 |
|---|---|
| `placing` | 已记录，入场单请求在途（通常只持续几秒） |
| `pending` | 入场条件单已挂在交易所，等待触发 |
| `entering` | 已成交，正在挂止损 / 止盈（通常只持续几秒） |
| `open` | 持仓中，止损止盈都在交易所 |
| `closing` | 正在市价平仓，或已平仓、正在结算 |
| `closed` | 已平仓并结算 |
| `cancelled` | 入场单没有成交就结束了，原因见 `cancel_reason` |
| `skipped` | 信号没有下单（风控 / 保证金 / 同币占用），原因见 `cancel_reason` |
| `shadow` | 影子模式下的计划记录（没有真实下单） |
| `error` | 程序无法自动处理（如平仓多次失败），**需人工处理**，期间不开新仓 |

进行中 = `placing / pending / entering / open / closing`。

### `cancel_reason`（cancelled / skipped）

| 值 | 状态 | 含义 |
|---|---|---|
| `expired` | cancelled | 条件单到期未触发 |
| `stop_before_entry` | cancelled | 未触发前价格先破新高 |
| `entry_unfilled` | cancelled | 触发了，但价格穿过 IOC 限价（跳空），没有成交 |
| `insufficient_margin` | cancelled / skipped | 保证金不足（下单前算出不够，或交易所拒单） |
| `rejected_on_trigger` | cancelled | 触发时被交易所拒单（多半是保证金不足） |
| `entry_rejected:<code>` | cancelled | 挂单被交易所拒绝（`<code>` 为币安错误码） |
| `symbol_busy` | skipped | 该币已有进行中的实盘交易 |
| `max_active_trades` | skipped | 进行中交易数已达上限 |
| `daily_loss_limit` | skipped | 当日已平仓亏损达到上限 |
| `risk_out_of_range` | skipped | 极值到触发价的距离不在 0.3%~10% |
| `symbol_dirty` | skipped | 该币存在非本程序管理的持仓或挂单 |
| `stale_signal` | skipped | 信号延迟超过 90 秒（如断线补数据补出的旧信号） |
| `control_paused` / `control_flatten` | skipped | 控制开关为暂停 / 一键平仓 |
| `error_pending` | skipped | 有交易待人工处理 |
| 其他 | skipped | 计划不合格：`below_min_qty`、`below_min_notional`、`stop_too_wide`、`symbol_not_trading` 等 |

### `exit_reason`（closed）

| 值 | 含义 |
|---|---|
| `stop` | 止损 |
| `take_profit` | 止盈 |
| `time` | 持仓到期，市价平仓 |
| `flatten` | 人工一键平仓 |
| `protect_failed` | 止损单挂不上，市价平仓 |
| `wrong_side` | 持仓方向异常，市价平仓 |
| `external` | 非本程序平仓（手动 / 强平 / ADL） |

## 交易对象 `LiveTrade`

| 字段 | 含义 |
|---|---|
| `id` | 交易 id |
| `strategy_id` / `symbol` / `timeframe` / `side` | 策略 / 币种 / 策略周期 / 恒为 `short` |
| `status` | 见上 |
| `trigger_time` | 背离触发K线 open_time |
| `setup_time` | 反转K线 open_time（与模拟盘同一信号的唯一键） |
| `signal_time` | 信号可用时刻（反转K线收盘），挂单时刻 |
| `entry_trigger` | 入场触发价（反转K线低点） |
| `entry_limit` | IOC 限价（最差可接受成交价） |
| `base_stop` | 背离极值（新高） |
| `stop_price` | 止损触发价 |
| `take_profit` | 止盈触发价（成交后才有） |
| `planned_qty` / `leverage` / `risk_usdt` | 计划数量 / 杠杆（逐仓）/ 计划风险 |
| `expire_at` | 入场单失效时刻 |
| `max_hold_until` | 到期平仓时刻（成交后才有） |
| `entry_mode` | `algo`（条件单触发）/ `ioc`（挂单时已越过触发价，直接 IOC 限价单） |
| `filled_qty` / `fill_price` / `fill_time` | 实际成交数量 / 成交均价 / 成交时间 |
| `exit_time` / `exit_price` / `exit_reason` | 平仓时间 / 平仓均价 / 平仓原因 |
| `gross_pnl` | 已实现盈亏，不含手续费 |
| `fees` | 手续费（开 + 平） |
| `funding` | 资金费（正数为收入） |
| `pnl` | 净盈亏 = `gross_pnl − fees + funding` |
| `r_multiple` | `pnl / (成交数量 × (止损 − 成交价))` |
| `mfe_r` / `mae_r` | 持仓期最大有利 / 不利波动（R） |
| `cancel_reason` / `error_msg` | 见上 / 异常说明 |
| `features` | 信号特征，同模拟盘（`dif_ratio`、`hist_ratio`、`imp_pct`、`leg_pct`、`qv24_m` 等） |

列表和详情里，`open` 状态的交易额外带三个字段：
- `last_price`：库中最新一根 5m 的收盘价；
- `unrealized_pnl`：浮动盈亏，已扣开仓手续费和按 0.05% 估算的平仓手续费；
- `unrealized_r`：浮动盈亏折算成 R。

其他状态这三个字段为 `null`。

---

## GET /api/live/status

进程运行状态，建议 30~60 秒轮询一次。

```json
{
  "phase": "running",          // offline（3 分钟无心跳）/ starting / reconnecting（WS 断开）/ lagging（K线延迟 >15 分钟）/ running
  "online": true,
  "mode": "live",              // live 真实下单 / shadow 影子模式
  "control": "running",        // running / paused（停开新仓）/ flatten（一键平仓中）
  "data_lag_minutes": 0.4,
  "uptime_minutes": 125,
  "server_time": 1791030000000,
  "today_pnl": -10.3,          // 北京时间今日已平仓净盈亏
  "daily_loss_limit": 30,
  "status": {
    "started_at": 0, "heartbeat_at": 0, "mode": "live", "control": "running",
    "market_ws": true, "user_ws": true, "last_bar_time": 0,
    "balance": 115.27,         // 钱包余额
    "available": 85.1,         // 可用余额
    "active_trades": 1, "error_trades": 0
  }
}
```

## GET /api/live/config

资金风控配置 `config` 和策略参数 `strategies`。`config` 包含 `risk_per_trade_usdt`、`max_notional_usdt`、`max_leverage`、`max_active_trades`、`daily_loss_limit_usdt` 等。

## GET /api/live/summary

Query：`from` / `to`（毫秒，可选）。统计按平仓时间过滤；状态和原因分布按信号时间过滤。

```json
{
  "config": { },
  "total": {
    "status_counts": { "pending": 0, "open": 1, "closed": 12, "cancelled": 5, "skipped": 3 },
    "cancel_reasons": { "expired": 3, "stop_before_entry": 2 },
    "skip_reasons": { "symbol_busy": 2, "insufficient_margin": 1 },
    "stats": {
      "closed": 12, "wins": 5, "losses": 7, "win_rate": 0.42,
      "total_pnl": 18.5, "total_fees": 1.9, "total_r": 1.85, "avg_r": 0.15,
      "profit_factor": 1.3, "max_drawdown": 32.1, "best_r": 1.97, "worst_r": -1.2,
      "by_exit_reason": { "stop": 7, "take_profit": 4, "time": 1 }
    },
    "total_funding": -0.12
  },
  "strategies": [
    { "strategy_id": "macd_top_div_15m", "name": "S1 15m 顶背离", "timeframe": "15m",
      "status_counts": {}, "cancel_reasons": {}, "skip_reasons": {}, "stats": {} }
  ],
  "open_positions": [ /* LiveTrade + last_price / unrealized_pnl / unrealized_r */ ],
  "pending_orders": [ /* 其他进行中的 LiveTrade（placing / pending / entering / closing） */ ],
  "error_trades": [ /* 待人工处理的 LiveTrade，非空时前端应醒目提示 */ ],
  "unrealized_pnl": -3.2
}
```

## GET /api/live/trades

Query：

| 参数 | 说明 |
|---|---|
| `status` | 逗号分隔多选，如 `open,closed` |
| `strategy_id` | 策略 id |
| `symbol` | 币种（不区分大小写） |
| `from` / `to` | 按信号时间过滤（毫秒） |
| `limit` / `offset` | 分页，`limit` 默认 50、最大 500 |

响应：`{ success, data: LiveTrade[], total }`，按 id 倒序。

## GET /api/live/trades/:id

Query：

| 参数 | 说明 |
|---|---|
| `interval` | K线周期 `5m` / `15m` / `1h` / `4h`，默认为策略周期 |
| `bars_before` | 反转K线之前的根数，默认 120，最大 500 |
| `bars_after` | 平仓之后的根数，默认 30，最大 500；进行中的交易画到当前 |

```json
{
  "trade": { /* LiveTrade */ },
  "interval": "15m",
  "klines": [ { "open_time": 0, "open": 0, "high": 0, "low": 0, "close": 0, "volume": 0 } ],
  "levels": [                  // 价位线
    { "kind": "entry_trigger", "price": 100 },
    { "kind": "entry_limit", "price": 98 },
    { "kind": "base_stop", "price": 104 },
    { "kind": "stop", "price": 104 },
    { "kind": "take_profit", "price": 90.5 }   // 成交后才有
  ],
  "markers": [                 // 时间点，price 为 null 时标在 K 线上即可
    { "kind": "trigger", "time": 0, "price": null },
    { "kind": "setup", "time": 0, "price": null },
    { "kind": "entry", "time": 0, "price": 99.5 },
    { "kind": "exit", "time": 0, "price": 90.4, "reason": "take_profit" }
  ],
  "events": [                  // 审计流水（时间升序，最多 500 条）
    { "id": 1, "kind": "entry_placed", "payload": { }, "created_at": "2026-10-03T12:00:01.123Z" }
  ],
  "paper_trade": { /* 同一信号的模拟盘交易（PaperTrade），模拟盘没有这笔时为 null */ }
}
```

`events.kind` 常见值：

- 入场相关：`entry_placed`、`entry_ioc`、`entry_filled`、`fill_recovered`、`entry_cancel_sent`、`insufficient_margin`、`entry_rejected`、`cancelled`
- 持仓相关：`stop_placed`、`tp_placed`、`stop_failed`、`tp_failed`、`opened`
- 平仓相关：`flatten_begin`、`flatten_sent`、`flatten_failed`、`closed`、`exit_reason_inferred`
- 异常：`op_error`、`error`

`paper_trade` 用于对比实盘和模拟盘：成交价差就是滑点；模拟盘成交、实盘没成交（或反过来），就是漏单。

## GET /api/live/equity

Query：`strategy_id`（不传为全部）、`from` / `to`（按平仓时间）。

响应：`[{ time, trade_id, symbol, pnl, equity, drawdown }]`，按平仓时间升序。`equity` 是累计已实现净盈亏，`drawdown` 是距前高的回撤（≥0）。

## GET /api/live/daily

Query：`strategy_id`（不传为全部）、`days`（最近 N 天，默认 90）。

响应：`[{ date, trades, wins, pnl, r, equity }]`，`date` 为北京时间平仓日 `YYYY-MM-DD`。
