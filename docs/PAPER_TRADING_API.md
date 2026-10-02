# 模拟盘 API

**分工：交易由服务器上的 pm2 `paper` 进程用实时行情自动产生（信号 → 条件单 → 模拟撮合），API 只读，前端负责展示。**

前缀 `/api/paper`。所有响应形如 `{ success: true, data }`；出错返回 `{ success: false, error }`，404 表示交易不存在。
时间均为毫秒时间戳（UTC）；K 线时间是 `open_time`，前端显示时自行转北京时间。

## 策略规则（当前五套，研究记录见 docs/MACD_DIVERGENCE_STRATEGIES.md）

| 策略 id | 名称 | 周期 | 止损 | 附加条件 |
|---|---|---|---|---|
| `macd_top_div_15m` | S1 15m 顶背离 | 15m | 新高 | — |
| `macd_top_div_5m` | S2 5m 顶背离 | 5m | 新高 + 0.5 ATR | — |
| `macd_top_div_15m_vol` | S3 15m 顶背离 + 放量 | 15m | 新高 | 放量倍数 ≥2 |
| `macd_top_div_5m_vol` | S4 5m 顶背离 + 放量 | 5m | 新高 + 0.5 ATR | 放量倍数 ≥2 |
| `macd_top_div_5m_imp30` | S5 5m 顶背离 前波≥30% | 5m | 新高 + 0.5 ATR | 前波涨幅 ≥30% |

所有策略：2R 止盈，最长持仓 48 根（15m 为 12 小时、5m 为 4 小时）。
共同条件：两峰之间翻绿 ≥3 根且绿柱深度 ≥20%；DIF 比 <0.6；红柱比 <0.3；前波涨幅 ≥20%；末段涨幅 ≥10%；24h 成交额 ≥10M；成交时止损距离在 0.3%~10% 之间。
放量倍数 = 信号时刻 24h 成交额 ÷ 前一个 24h 成交额。

S2、S4、S5 的信号经常重叠（S4、S5 是 S2 的子集），同一个信号会在各策略里各下一单，分别统计。

流程：反转K线收盘后挂空单，价格跌破反转K线低点时成交（跳空按开盘价）；条件单有效 6 根，未成交前价格先突破新高则撤单。
每笔固定止损 10U（`qty = 10 / |止损 − 成交价|`），手续费按名义价值单边 0.05%；**同一策略内**同一个币同一时间只有一笔挂单或持仓，后来的信号记为 `skipped`；不同策略互不影响。
撮合用已收盘 5m K 线，同一根内先判止损（不利方向优先）。

## 交易状态

| status | 含义 |
|---|---|
| `pending` | 已挂条件单，等待成交 |
| `open` | 已成交持仓 |
| `closed` | 已平仓，`exit_reason` = `stop` / `take_profit` / `time` |
| `cancelled` | 撤单，`cancel_reason` = `stop_before_entry`（先破新高）/ `risk_out_of_range`（止损距离不在 0.3%~10%） |
| `expired` | 条件单 6 根内未触发 |
| `skipped` | 信号成立但该策略在该币已有挂单或持仓，`cancel_reason = symbol_busy`（仅留痕，不交易） |

## 交易对象 `PaperTrade`

| 字段 | 说明 |
|---|---|
| `id` | 交易 id |
| `strategy_id` / `symbol` / `timeframe` / `side` | 策略、币种、周期（`5m`/`15m`）、方向（`short`/`long`） |
| `status` | 见上表 |
| `trigger_time` | 背离触发K线（峰内首次创新高）的 open_time |
| `setup_time` | 反转K线 open_time |
| `signal_time` | 挂单生效时刻（反转K线收盘） |
| `entry_trigger` | 条件单触发价（反转K线低点） |
| `base_stop` | 背离新高（未成交前触及即撤单） |
| `stop_price` | 成交后的止损价（15m = 新高；5m = 新高 + 0.5ATR） |
| `take_profit` | 止盈价（成交后按实际成交价计算，未成交为 null） |
| `expire_at` | 条件单失效时刻 |
| `max_hold_until` | 时间平仓时刻（成交后才有） |
| `fill_time` / `fill_price` / `qty` / `notional` | 成交时间（所在 5m 的 open_time）、成交价、数量、名义价值（U） |
| `risk_usdt` | 每笔风险（10U） |
| `exit_time` / `exit_price` / `exit_reason` | 平仓时间（所在 5m 的 open_time）、价格、原因 |
| `gross_pnl` / `fees` / `pnl` | 毛盈亏、手续费、净盈亏（U） |
| `r_multiple` | 净盈亏 / 风险（R） |
| `mfe_r` / `mae_r` | 持仓期最大有利 / 不利波动（R） |
| `cancel_reason` | 撤单/跳过原因 |
| `features` | 信号特征：`dif_ratio` `hist_ratio` `gap` `gdep` `imp_pct`（前波%）`leg_pct`（末段%）`qv24_m`（24h 成交额，百万U）`qv_surge`（放量倍数，历史不足为 null）`atr_pct` `range48` `wait` `wick` `body` |

列表、详情、汇总里的持仓（`status = open`）额外带：`last_price`（库中最新 5m 收盘价）、`unrealized_pnl`（扣除双边手续费后的浮动盈亏，U）、`unrealized_r`。非持仓这三个字段为 null。

## 接口

### GET `/status`

运行状态，前端顶部状态条用（建议每 30~60 秒轮询）。

```json
{ "phase": "running", "online": true, "data_lag_minutes": 1.2, "uptime_minutes": 360, "server_time": 1790900000000,
  "status": { "started_at": ..., "heartbeat_at": ..., "last_bar_time": ..., "ws_connected": true, "symbols": 527,
              "bars_processed": 680000, "gap_filled": 0, "pending": 2, "open_positions": 1 } }
```

| phase | 含义 | 建议展示 |
|---|---|---|
| `running` | 正常运行 | 绿 |
| `starting` | 刚启动，正在预热历史K线（约 1 分钟） | 黄 |
| `reconnecting` | 行情 WebSocket 断开，自动重连中 | 黄 |
| `lagging` | 最新已处理K线落后超过 15 分钟 | 红 |
| `offline` | 超过 3 分钟无心跳（进程未运行），或从未运行过（此时 `status` 为 null） | 红 |

`data_lag_minutes`：当前时间 − 最新已处理 5m K线收盘时间（分钟），正常在 0~5 之间。

### GET `/strategies`

策略与账户配置。

```json
{ "account": { "risk_per_trade_usdt": 10, "fee_rate": 0.0005, "one_position_per_symbol": true },
  "strategies": [ { "id": "macd_top_div_15m", "name": "...", "timeframe": "15m", "filters": { ... }, "stop_atr_buffer": 0, "take_profit_r": 2, "order_valid_bars": 6, "max_hold_bars": 48 } ] }
```

### GET `/summary`

总览页用。参数 `from` / `to`（可选，按平仓时间过滤统计）。

```json
{
  "account": { ... },
  "total": PaperStats,
  "strategies": [ { "strategy_id": "...", "name": "...", "enabled": true,
                    "status_counts": { "pending": 0, "open": 1, "closed": 12, "cancelled": 3, "expired": 1, "skipped": 0 },
                    "stats": PaperStats } ],
  "open_positions": [ PaperTrade + last_price/unrealized_pnl/unrealized_r ],
  "pending_orders": [ PaperTrade ],
  "unrealized_pnl": 3.2
}
```

`PaperStats`：

| 字段 | 说明 |
|---|---|
| `closed` / `wins` / `losses` | 已平仓笔数 / 盈利笔数 / 亏损笔数（净盈亏 ≤0 计亏） |
| `win_rate` | 胜率（0~1，无交易为 null） |
| `total_pnl` / `total_fees` | 累计净盈亏 / 累计手续费（U） |
| `total_r` / `avg_r` | 累计 R / 每笔平均 R（期望） |
| `profit_factor` | 总盈利 / 总亏损（无亏损为 null） |
| `max_drawdown` | 已实现资金曲线最大回撤（U） |
| `best_r` / `worst_r` | 单笔最好 / 最差 R |
| `by_exit_reason` | 各平仓原因笔数 |

### GET `/trades`

交易列表，按挂单时间倒序。

| 参数 | 说明 |
|---|---|
| `status` | 逗号分隔多选，如 `open,pending`；不传为全部 |
| `strategy_id` | 策略 |
| `symbol` | 币种 |
| `from` / `to` | 按挂单时间（`signal_time`）过滤 |
| `limit` / `offset` | 分页，默认 50，最大 500 |

返回 `{ data: PaperTrade[], total }`，`total` 为满足条件的总数。

### GET `/trades/:id`

单笔交易 + 画图用 K 线（按该策略周期，15m 由 5m 按 UTC 对齐聚合）。

| 参数 | 说明 |
|---|---|
| `bars_before` | 反转K线之前的根数，默认 120，最大 500 |
| `bars_after` | 平仓之后的根数（未平仓则到最新），默认 30，最大 500 |

返回 `{ trade, timeframe, klines: [{ open_time, open, high, low, close, volume }] }`。

画图建议：在 `trigger_time` 标背离点，`setup_time` 标反转K线，水平线画 `entry_trigger` / `stop_price` / `take_profit`，`fill_time` 和 `exit_time` 标进出场。

### GET `/equity`

已实现资金曲线，按平仓时间升序。参数 `strategy_id`（不传为全部）、`from` / `to`（按平仓时间）。

```json
[ { "time": 1790777400000, "trade_id": 12, "symbol": "ARKUSDT", "pnl": 19.7, "equity": 45.3, "drawdown": 0 } ]
```

### GET `/daily`

按日统计（北京时间，按平仓日），柱状图 + 累计曲线用。参数 `strategy_id`（不传为全部）、`days`（最近 N 天，默认 90）。

```json
[ { "date": "2026-10-02", "trades": 3, "wins": 2, "pnl": 25.4, "r": 2.54, "equity": 61.2 } ]
```

`equity` 为所选区间内截至当日的累计已实现盈亏。

## 前端页面建议

1. 顶部状态条：`/status` 的 phase + 数据延迟 + 挂单/持仓数
2. 总览：`/summary` 的 `total` 与各策略卡片（笔数、胜率、累计盈亏、平均 R、最大回撤）
3. 当前持仓与挂单：`/summary` 的 `open_positions`（含浮动盈亏）与 `pending_orders`
4. 资金曲线 / 每日盈亏：`/equity`、`/daily`，可按策略切换
5. 交易列表 + 详情K线图：`/trades`、`/trades/:id`

## 运维

- 进程：`pm2 start ecosystem.config.js --only paper`（入口 `scripts/run_paper_trading.ts`）。启动时读最近 4 天 5m 日表预热，然后独立订阅全市场 5m WS。
- 重启安全：进行中的交易从 `paper_trades` 恢复，并从 `last_bar_time` 之后续跑撮合。
- 表：`paper_trades`（唯一键 `strategy_id + symbol + setup_time`，写入幂等）、`paper_runtime_status`（进程心跳，单行，每 60 秒更新）。
- 修改策略参数：`src/services/paper_trading/paper_strategies.ts`，改完 `pm2 restart paper`；API 端改动需要 `npm run build && pm2 restart api`。
