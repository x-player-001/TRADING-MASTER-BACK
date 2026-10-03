# 策略回测结果 API

**分工：回测由服务器上的脚本 `scripts/run_strategy_backtest.ts` 跑离线 K 线缓存产生并入库，API 只读；前端负责列表、统计和逐笔画图展示。**
接口与数据格式对所有策略通用：以后新增的回测策略沿用同一套接口，前端不需要为每个策略单独适配，只需按 `annotations` 画图。

前缀 `/api/strategy-backtest`。所有响应形如 `{ success: true, data }`，列表额外带 `total`；出错返回 `{ success: false, error }`，404 表示不存在。
时间均为毫秒时间戳（UTC）；K 线时间是 `open_time`，前端显示时自行转北京时间。

## 概念

- **策略（strategy）**：一套识别 + 交易规则，有 `id`、默认参数、出场原因说明。
- **运行（run）**：某个策略用某组参数，在某段历史数据上跑一次全市场回测。同一个策略可以有多次运行（不同参数），用 `run_id` 区分。
- **交易（trade）**：一次运行产出的每一笔。`status = closed` 是已成交并平仓的交易；`status = unfilled` 是识别到形态并挂了单、但没有成交的信号（同样带标注，可以查看）。

## 当前策略

| id | 名称 | 周期 |
|---|---|---|
| `flag_third_push` | 高位整理第三推低点限价做多 | 5m |
| `flag_third_push_confirm` | 高位整理第三推确认做多 | 5m |

`flag_third_push` 规则（默认参数）：

1. **拉升段**：创近 150 根新高、相对近 30 根低点涨幅 ≥3% 的推动；可见拉升段 ≥3 根K线、涨幅 4%~20%、单根实体不超过拉升高度的 60%；拉升起点前 24 小时内推动波 ≤2 个（避开最后一波）。
2. **整理与三推**：推动高点后收盘未突破区间上沿；分型低点（左右各 2 根更高，低点后 2 根确认）记为一推，两推之间的反弹需 ≥ 区间高度 50%，否则算同一推；三推低点逐个抬高（可选：容差持平）；回撤 ≤50%。
3. **入场**：第三推确认的K线收盘时，在第三推低点挂限价买单（挂单价离区间上沿 ≤5%），有效 40 根；价格回踩到挂单价即成交（跳空低开按开盘价）。
4. **仓位**：10U 保证金 × 10 倍，不设止损（下跌约 9.5% 爆仓，亏损 10U）；手续费按名义价值单边 0.05%。
5. **出场**（逐根，同根先判不利方向）：爆仓 → 到量度目标（区间上沿 + 拉升高度）→ 突破区间上沿后 MACD 柱首次缩短 → 20 根内未突破区间上沿按收盘离场 → 288 根到时。

`flag_third_push_confirm`：识别、仓位、出场与上面相同，区别是**第三推确认的K线收盘直接入场**（不挂限价单，没有 `unfilled`），
并要求**反弹高点不抬高**：第三推前的反弹高点不高于第二推前的反弹高点（`features.hi_trend ≤ 0`，以区间高度为单位）。
标注里没有「限价挂单」线，入场点就在确认K线上。

`exit_reason`：

| 代码 | 含义 |
|---|---|
| `target` | 到量度目标 |
| `macd_shrink` | 突破后 MACD 柱首次缩短 |
| `no_breakout` | 规定根数内未突破区间上沿 |
| `liquidation` | 爆仓（未设止损） |
| `stop` | 止损（参数设了 `stop_pct` 时） |
| `time` | 持仓到时 |
| `expired` | 仅 `unfilled`：挂单到期未成交 |

出场原因的中文说明也可以从 `/strategies` 的 `exit_reasons` 取，前端不必写死。

## 接口

### GET /strategies

已注册策略列表。

```json
{ "success": true, "data": [{
  "id": "flag_third_push", "name": "高位整理第三推低点限价做多", "description": "...", "timeframe": "5m", "version": 1,
  "default_params": { "leg_min_pct": 0.04, "...": "..." },
  "param_docs": [{ "key": "leg_min_pct", "label": "拉升最小涨幅" }],
  "exit_reasons": { "target": "到量度目标", "...": "..." }
}]}
```

### GET /runs

Query：`strategy_id`（可选）/ `limit`（默认 50，最大 200）/ `offset`。按创建时间倒序。

`data[]` 为运行对象：

| 字段 | 说明 |
|---|---|
| `id` | run_id |
| `strategy_id` / `strategy_name` / `strategy_version` / `timeframe` | 策略信息 |
| `params` | 本次使用的完整参数 |
| `data_from` / `data_to` | 回测数据区间 |
| `status` | `running` / `done` / `failed` |
| `symbols_total` | 参与回测的币种数 |
| `trade_count` | 已平仓交易数 |
| `signal_count` | 信号总数（含未成交） |
| `summary` | 汇总统计（结构同 `/runs/:id/stats` 的 `summary` / `by_month` / `by_exit_reason`），运行未完成时为 null |
| `note` | 备注 |
| `created_at` / `finished_at` | 开始 / 结束时间 |

### GET /runs/:id

`data = { run, strategy }`，`strategy` 同 `/strategies` 中的一项（用于显示参数说明与出场原因）。

### GET /runs/:id/trades

交易列表，**不含** `annotations`（看图请取详情）。

| Query | 说明 |
|---|---|
| `status` | `closed` / `unfilled`，逗号多选；不传为全部 |
| `symbol` | 币种 |
| `exit_reason` | 逗号多选 |
| `result` | `win`（pnl>0）/ `loss`（pnl≤0） |
| `from` / `to` | 按 `signal_time` 过滤（毫秒） |
| `sort` | `signal_time`（默认）/ `pnl` / `r_multiple` / `mfe_pct` / `mae_pct` |
| `order` | `desc`（默认）/ `asc` |
| `limit` / `offset` | 默认 50，最大 500 |

交易对象 `BacktestTrade`：

| 字段 | 说明 |
|---|---|
| `id` / `run_id` | 交易 id、所属运行 |
| `strategy_id` / `symbol` / `timeframe` / `side` | 策略、币种、周期、方向（`long`/`short`） |
| `status` | `closed` / `unfilled` |
| `signal_time` | 信号K线 open_time（该K线收盘时挂单） |
| `entry_time` / `entry_price` | 成交K线 open_time、成交价（未成交为 null） |
| `stop_price` | 硬止损价（不设止损为 null） |
| `target_price` | 目标价 |
| `exit_time` / `exit_price` / `exit_reason` | 出场K线 open_time、价格、原因；`unfilled` 的 `exit_time` 为挂单到期时间 |
| `pnl` / `pnl_pct` | 净盈亏（U，已扣手续费）、净盈亏 / 名义仓位 |
| `r_multiple` | 设了硬止损时的 R 倍数，否则 null |
| `mfe_pct` / `mae_pct` | 持仓期最大有利 / 不利波动（相对成交价，mae 为负数） |
| `bars_held` | 持仓根数 |
| `features` | 策略特征（键值对，各策略不同；前端可原样表格展示） |

`flag_third_push` 的 `features`：

| 键 | 说明 |
|---|---|
| `leg_pct` / `leg_bars` / `leg_max_bar` | 可见拉升段涨幅、根数、单根最大实体占比 |
| `impulse_pct` | 推动涨幅（相对近 30 根低点） |
| `pre_waves` | 拉升前 24h 推动波个数 |
| `retr` | 挂单时整理区间最大回撤（相对推动） |
| `push1` / `push2` / `push3` | 三推低点价 |
| `box_top` / `box_low` | 挂单时区间上沿 / 下沿 |
| `lamp` | 拉升高度（量度目标 = 区间上沿 + lamp） |
| `dist_to_top` | 挂单价离区间上沿 |
| `cons_bars` | 推动高点到挂单的根数 |
| `qv24` | 24h 成交额（U） |
| `lows_rising` / `lows_flat` / `lows_ge_first` | 三推低点关系：严格抬高 / 容差内持平 / 第三推不低于第一推 |
| `fill_wait_bars` | 挂单到成交的根数（仅成交） |
| `breakout` | 持仓期是否突破了区间上沿（仅成交） |

### GET /runs/:id/stats

按条件重算统计（只统计 `closed`）。Query：`symbol` / `from` / `to`（按信号时间）。

```json
{ "success": true, "data": {
  "summary": {
    "trades": 491, "wins": 290, "win_rate": 0.59, "total_pnl": 255.3, "avg_pnl": 0.52, "avg_win": 1.9, "avg_loss": -1.5,
    "profit_factor": 1.8, "t_stat": 4.6, "avg_r": null, "max_drawdown": 14.8, "max_consecutive_losses": 6, "symbols": 236
  },
  "by_month":       [{ "key": "2026-09", "trades": 39, "win_rate": 0.6, "total_pnl": 35.1, "avg_pnl": 0.9 }],
  "by_exit_reason": [{ "key": "macd_shrink", "trades": 180, "win_rate": 0.8, "total_pnl": 300, "avg_pnl": 1.67 }],
  "by_symbol":      [{ "key": "SYNUSDT", "trades": 5, "win_rate": 0.8, "total_pnl": 23, "avg_pnl": 4.6 }]
}}
```

- `by_month` 按平仓时间的北京时间月份；`by_symbol` 按合计盈亏倒序。
- `max_drawdown` 是按平仓时间顺序逐笔累计盈亏的最大回撤（U）；`t_stat` 为每笔盈亏均值的 t 值（越大越可信，>2 才算显著）。

### GET /trades/:id

单笔详情：交易（含 `annotations`）+ 画图用 K 线（可切换周期）+ 同筛选条件下的上一笔 / 下一笔。

| Query | 说明 |
|---|---|
| `interval` | K线周期：`5m` / `15m` / `1h` / `4h`，默认为交易本身的周期（目前都是 `5m`） |
| `bars_before` / `bars_after` | 在标注覆盖范围之外，向前 / 向后多取的K线根数，**单位是所选 `interval`**（默认 150 / 40，最大 1000） |
| 其余 | 与 `/runs/:id/trades` 相同的筛选参数（`status` / `symbol` / `exit_reason` / `result` / `from` / `to`），用于计算 `prev_id` / `next_id` |

```json
{ "success": true, "data": {
  "trade": { "id": 123, "symbol": "牛来USDT", "...": "...", "annotations": [ ... ] },
  "interval": "1h",
  "intervals": ["5m", "15m", "1h", "4h"],
  "klines": [{ "open_time": 1789000000000, "open": 0.101, "high": 0.102, "low": 0.1, "close": 0.1015, "volume": 12345 }],
  "prev_id": 122, "next_id": 124
}}
```

- `klines` 为所选周期的K线，覆盖全部标注：5m 读库中 5m 日表（最多 3000 根）；15m/1h/4h 读聚合表、缺失的K线用 5m 补齐（最多 1500 根），窗口末尾若到当前时刻，最后一根可能未收盘。
- `interval` 为实际使用的周期，`intervals` 为可切换的周期列表（前端可直接用来生成切换按钮）。
- **大周期下 `trade.annotations` 的时间已对齐到该周期K线的 open_time**（例如 5m 的 10:35 在 1h 图上变成 10:00），标记可以直接落在K线上；价格不变。
  切换周期时重新请求本接口即可，不要自己换算。
- `prev_id` / `next_id`：同一 run、同筛选条件下按 `signal_time` 排序的前一笔 / 后一笔（`prev` 更早，`next` 更晚），没有为 null。前端可以做「上一个 / 下一个」按钮快速翻看；翻页时带上同样的筛选参数。

## 画图标注 `annotations`

数组，元素按 `type` 区分。所有时间是K线 `open_time`；颜色 `color` 为建议值，可忽略。

| type | 字段 | 画法 |
|---|---|---|
| `marker` | `time` `price` `label` `role`（`entry`/`exit`/`point`）`position`（`above`/`below`） | 在该K线上画点或箭头，`label` 为文字；`entry` 建议向上箭头，`exit` 按盈亏着色 |
| `hline` | `from_time` `to_time` `price` `label` `style`（`solid`/`dashed`） | 从 `from_time` 到 `to_time` 的水平线段 |
| `segment` | `points[]`（`{time, price}`）`label` | 折线（连接各点） |
| `box` | `from_time` `to_time` `top` `bottom` `label` | 矩形区域 |

`flag_third_push` 会产出：

| 标注 | type | label |
|---|---|---|
| 拉升段（起涨低点 → 推动高点） | `segment` | `拉升 +x.x%` |
| 整理区间（推动高点 → 成交/到期） | `box` | `整理区间` |
| 三推低点 | `marker`（`point`） | `第1推` / `第2推` / `第3推` |
| 限价挂单（挂单 → 成交/到期） | `hline`（虚线） | `限价挂单` |
| 爆仓价或止损 | `hline`（虚线） | `爆仓价` / `止损` |
| 量度目标 | `hline`（虚线） | `量度目标` |
| 突破区间上沿 | `marker`（`point`） | `突破上沿` |
| 入场 / 出场 | `marker`（`entry`/`exit`） | `入场` / 出场原因中文 |

`unfilled` 只有前四项。

## 生成回测数据（服务器）

```bash
cd /root/TRADING-MASTER-BACK
nice -n 19 npx ts-node -r tsconfig-paths/register scripts/run_strategy_backtest.ts --strategy=flag_third_push --note="默认参数"
# 改参数：--params='{"lows_mode":"flat","stop_pct":0.03}'；限定区间：--from=20260601 --to=20261001
# 只看效果不入库：--dry-run；删除一次运行：--delete-run=<id>；列出策略：--list
```

全市场约 10 分钟，数据来自 `/root/kline_cache/5m`（先 `cd /root/kline_cache && nice -n 19 node export_5m.js` 增量导出到昨天）。

## 新增策略（后端）

在 `src/services/strategy_backtest/strategies/` 实现 `BacktestStrategy`（`run(series, params)` 返回 `BacktestTrade[]`，自带 `annotations`），
到 `strategy_registry.ts` 登记即可；回测脚本、入库、接口、前端展示全部复用。
