# K线回放 + 模拟交易 API

前缀 `/api/replay`。所有响应形如 `{ success: true, data }`；业务错误 `{ success: false, error }`（400 参数错误 / 404 不存在 / 409 会话已结束）。
时间均为毫秒时间戳，K线时间是 `open_time`。

## 典型流程

```
GET  /data-coverage                      → 选一个有数据的起点
POST /sessions {symbol, start_time}      → 拿到 session.id 和 snapshot
GET  /sessions/:id/klines?interval=5m&limit=500   ┐ 初始化各周期图表
GET  /sessions/:id/klines?interval=1h&limit=300   ┘（最后一根可能 is_closed=false）
POST /sessions/:id/step {bars:1, intervals:['15m','1h','4h']}
     → bars: 追加到 5m 图；interval_bars[iv]: 按 open_time 更新/追加到对应大周期图
     → events: 成交/平仓/撤单提示；snapshot: 刷新账户面板
POST /sessions/:id/orders {...}          → 下单
POST /sessions/:id/finish                → 结束，看 /sessions/:id/stats
```

游标之后的K线服务端从不下发，前端无需做防偷看处理。

**性能与落库**：活跃会话常驻服务端内存，`step` 只改内存，服务端处理约 2ms，单步耗时基本等于网络往返，每根发一次请求即可。
有成交、委托变化或其他交易操作时立即写库；纯推进每 3 秒批量写一次；服务正常重启前会全部写库。
进程异常崩溃最多丢失最近约 3 秒的推进进度，已发生的交易不会丢。

## 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/data-coverage` | 5m 数据连续段 `[{start_date:'20251214', end_date, days}]`（北京时间日期） |
| POST | `/sessions` | 创建。body：`symbol`*、`start_time`*、`name`、`initial_balance`=10000、`leverage`=10、`taker_fee_rate`=0.0005、`maker_fee_rate`=0.0002、`slippage_rate`=0、`note`。起点会对齐到所在（或之前 1 天内最近）的 5m K线。返回 snapshot |
| GET | `/sessions?status=active\|finished&symbol=&limit=&offset=` | 列表（按最近更新排序） |
| GET | `/sessions/:id` | snapshot |
| PATCH | `/sessions/:id` | `{name?, note?}` |
| DELETE | `/sessions/:id` | 删除会话及全部交易记录 |
| POST | `/sessions/:id/finish` | 按当前收盘价平仓（exit_reason=`session_end`）、撤挂单、status=finished，之后只读 |

**snapshot**

```ts
{
  session: { id, name, symbol, start_time, cursor_time, last_price, initial_balance, balance,
             leverage, taker_fee_rate, maker_fee_rate, slippage_rate, status, bars_stepped, note, ... },
  current_bar: Bar,             // 游标K线
  equity: number,               // balance + 浮盈
  unrealized_pnl: number,
  position: Position & { unrealized_pnl, unrealized_r } | null,
  pending_orders: Order[],
}
```

## 回放

**GET `/sessions/:id/klines?interval=5m|15m|1h|4h&limit=300`**（limit ≤ 1500）
返回 `Bar[]`，每根带 `is_closed`。大周期最后一根由 5m 聚合，未收盘时 `is_closed=false`。

**POST `/sessions/:id/step`**

| 字段 | 说明 |
|---|---|
| `bars` | 推进根数，默认 1，上限 2000 |
| `until_time` | 推进到该时间（含）；只给它时最多推进 2000 根 |
| `stop_on` | `none`(默认) / `fill` / `position_closed`：快进途中遇到事件就停 |
| `intervals` | 需要同步返回的大周期，如 `['15m','1h','4h']` |

返回：

```ts
{
  bars: Bar[],                              // 新揭示的 5m
  interval_bars: { '1h': IntervalBar[] },   // 本次受影响的大周期K线，按 open_time 覆盖即可
  events: Event[],
  end_of_data: boolean,                     // true = 后面没数据了，禁用「下一步」
  snapshot,
}
```

5m 数据在 **2026-02-09 ~ 2026-05-25 整段缺失**（另有零星缺天）。步进遇到空洞会直接跳到下一根有数据的K线，并发出 `gap` 事件。

## 交易

**POST `/sessions/:id/orders`**

| 字段 | 说明 |
|---|---|
| `side`* | `buy` / `sell`（做空 = sell 开仓） |
| `order_type`* | `market` / `limit` / `stop` |
| `qty` \| `notional` \| `risk_pct` | **三选一**：数量 / 名义价值 USDT / 权益风险 %（需带 `stop_loss`，数量 = 权益×% ÷ \|委托价−止损\|） |
| `price` | limit=限价，stop=触发价；market 不填 |
| `stop_loss` / `take_profit` | 成交后挂到仓位上 |
| `reduce_only` | 只减仓 |
| `tags` / `note` | 开仓时带到仓位上，用于复盘统计 |

返回 `{ order, events, snapshot }`。**被拒的委托也返回 200**，此时 `order.status='rejected'`，原因在 `order.reject_reason`（同时有 `order_rejected` 事件）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:id/orders?status=pending\|filled\|cancelled\|rejected` | 委托列表 |
| DELETE | `/sessions/:id/orders/:order_id` | 撤单 |
| PATCH | `/sessions/:id/position` | `{stop_loss?, take_profit?}`：不传=不改，`null`=清除 |
| POST | `/sessions/:id/position/close` | `{qty?}`：按当前收盘价市价平仓，不传=全平 |
| GET | `/sessions/:id/positions?status=open\|closed` | 仓位回合 |
| PATCH | `/sessions/:id/positions/:position_id` | `{tags?, note?}`：复盘标签/笔记，会话结束后也能改 |
| GET | `/sessions/:id/fills` | 成交明细：用 `bar_time` + `price` + `side` + `action` 在图上打点 |

### 撮合规则

- **账户模式**：单向持仓。同向下单是加仓；反向下单先平仓，剩余数量反手开仓（旧仓 exit_reason=`reverse`）。
- **市价单**：按游标K线收盘价立即成交（taker，加滑点）。
- **限价单**：如果价格已经越过当前价，按收盘价立即成交（taker）；否则挂单，从下一根开始撮合，按挂单价成交（maker）。
- **条件单**：触发价必须在当前价外侧，否则拒单。触发后按触发价成交（taker，加滑点）。
- **K线内路径**：持多仓按 O→L→H→C，持空仓按 O→H→L→C，也就是先走不利方向、同根K线里止损优先；空仓时开盘价离高点近就先走高点。沿路径依次撮合，所以可能出现「挂单成交后同一根就被止损」。
- **跳空**：不利方向的（止损、条件单）按开盘价成交；有利方向的（限价单、止盈）按挂单价成交。
- **保证金**：新开仓的名义价值 ÷ 杠杆 必须 ≤ 可用权益，否则拒单。不模拟强平。
- 仓位平掉后，残留的只减仓挂单会自动撤销。

### Position 关键字段

`direction`、`qty`/`max_qty`、`avg_entry_price`/`avg_exit_price`、`stop_loss`/`take_profit`、
`initial_stop_loss`（定义 1R）、`risk_amount`（计划风险 USDT）、`realized_pnl`（毛）、`fee_total`、`net_pnl`、
`r_multiple` = net_pnl / risk_amount、`mfe_pct`/`mae_pct`（持仓期间最大有利/不利偏移 %）、
`open_bar_time`/`close_bar_time`/`bars_held`、
`exit_reason`：`take_profit` / `stop_loss` / `manual` / `order` / `reverse` / `session_end`。

开仓时没设止损、之后首次补设的，以补设的那个止损定义 1R；从头到尾都没设止损的，`r_multiple` 为 null。

### Event

```ts
{ type: 'fill', fill }
{ type: 'position_opened', position }
{ type: 'position_closed', position }
{ type: 'order_cancelled', order, reason }
{ type: 'order_rejected', order, reason }
{ type: 'gap', from_time, to_time, missing_bars }
```

## 统计

- **GET `/sessions/:id/stats`**：单个会话。
- **GET `/stats?session_ids=1,2&symbol=&direction=long|short&tag=&start_time=&end_time=`**：跨会话累计，时间按平仓时间过滤。

```ts
{
  overall: Stats,
  by_direction: { long: Stats, short: Stats },
  by_tag: { [tag]: Stats },            // 无标签的归到 '(无标签)'
  by_exit_reason: { [reason]: Stats },
  equity_curve: [{ position_id, close_bar_time, cum_net_pnl, cum_r }],
}
```

Stats 字段：`trade_count`、`win_count`/`loss_count`、`win_rate`、`total_net_pnl`、`total_fee`、`avg_win`/`avg_loss`、`payoff_ratio`、`profit_factor`、`expectancy`、`r_trade_count`、`total_r`、`avg_r`（期望 R）、`avg_win_r`/`avg_loss_r`、`max_consecutive_wins`/`losses`、`max_drawdown`(USDT)、`max_drawdown_pct`（仅单会话统计有值）、`max_drawdown_r`、`avg_bars_held`、`avg_mfe_pct`/`avg_mae_pct`。

胜负按 `net_pnl`（扣手续费后）判定。
