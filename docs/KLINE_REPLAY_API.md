# K线回放 + 模拟交易 API

**分工：前端负责揭示 K 线和撮合，后端负责下发数据、存储和统计。**

前缀 `/api/replay`。所有响应形如 `{ success: true, data }`；业务错误返回 `{ success: false, error }`，状态码 400 表示参数错误、404 表示不存在、409 表示同步版本过期。
时间均为毫秒时间戳，K 线时间是 `open_time`。

## 前端需要复制的代码

复制后端仓库的这 3 个文件，它们是纯 TS，没有任何依赖：

| 文件 | 作用 |
|---|---|
| `src/services/kline_replay/replay_types.ts` | 类型定义 |
| `src/services/kline_replay/replay_matching_engine.ts` | 撮合引擎（后端单测覆盖） |
| `src/services/kline_replay/replay_account.ts` | **前端直接用这个**：包装引擎，累积全部历史，可以从后端恢复，能导出同步数据 |

## 典型流程

```ts
// 1. 建会话（或从列表里选一个继续）
const { session, cursor_bar, positions, orders, fills } =
  await POST('/sessions', { symbol: 'BTCUSDT', start_time });          // 继续已有会话用 GET /sessions/:id
const account = new ReplayAccount(session, { positions, orders, fills });
let revision = session.sync_revision;

// 2. 历史部分（游标及之前）
GET(`/sessions/${id}/klines?interval=5m&end_time=${session.cursor_time}&limit=500`);
GET(`/sessions/${id}/klines?interval=1h&end_time=${session.cursor_time}&limit=300`);  // 最后一根可能未收盘

// 3. 未来部分：一次拉一块，放在前端缓冲区里，不渲染
const { bars, end_of_data } = await GET(`/sessions/${id}/bars?after=${session.cursor_time}&limit=600`);
// 缓冲区剩余不多（比如 < 100 根）时，用 after=缓冲区最后一根的 open_time 预取下一块

// 4. 下一步：纯本地
const bar = buffer.shift();
const events = account.process_bar(bar);   // 成交/止损/止盈提示
cursor_bar = bar;
// 5m 图追加 bar；大周期用 5m 聚合，更新最后一根（桶起点 = floor(open_time / 周期毫秒) × 周期毫秒）

// 5. 下单：纯本地，数量由前端换算
const { order, events } = account.submit_order(
  { side: 'buy', order_type: 'market', qty, stop_loss, take_profit, tags: ['lv1'] }, cursor_bar);

// 6. 同步（见下文）
POST(`/sessions/${id}/sync`, account.to_sync_payload(
  { cursor_time: cursor_bar.open_time, last_price: cursor_bar.close, bars_stepped, status: 'active' },
  ++revision));
```

`ReplayAccount` 的方法有：
- `process_bar`：推进一根 K 线；
- `submit_order`：下单；
- `cancel_order(client_id)`：撤单；
- `set_protection(sl, tp, bar)`：改止损止盈，`undefined` 表示不改，`null` 表示清除；
- `close_position(bar, qty?)`：平仓，不传数量就全平；
- `finish(bar)`：平仓并撤掉全部挂单；
- `update_journal(position_client_id, {tags, note})`：改复盘标签和笔记；
- `get_equity(price)`：当前权益。

按风险下单时，数量这样算：`qty = account.get_equity(price) × 风险% ÷ |委托价 − 止损价|`。

## 接口

### 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/data-coverage` | 5m 数据的连续段 `[{start_date:'20251214', end_date, days}]`，日期是北京时间 |
| POST | `/sessions` | 创建会话。body：`symbol`*、`start_time`*、`name`、`initial_balance`=10000、`leverage`=10、`taker_fee_rate`=0.0005、`maker_fee_rate`=0.0002、`slippage_rate`=0、`note`。起点会对齐到所在（或之前 1 天内最近）的 5m K 线。返回结构与 `GET /sessions/:id` 相同 |
| GET | `/sessions?status=active\|finished&symbol=&limit=&offset=` | 会话列表，按最近更新排序 |
| GET | `/sessions/:id` | 完整状态 `{ session, cursor_bar, positions, orders, fills }`，用于恢复 `ReplayAccount` |
| PATCH | `/sessions/:id` | 修改 `{name?, note?}` |
| DELETE | `/sessions/:id` | 删除会话及其全部交易记录 |

`session` 里的字段：`id, name, symbol, start_time, cursor_time, last_price, initial_balance, balance, leverage, taker_fee_rate, maker_fee_rate, slippage_rate, status, bars_stepped, sync_revision, note, finished_at`。

### K 线

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:id/bars?after=&limit=600` | `after` 之后的 5m，默认从会话起点之后开始，`limit` 最大 2000。返回 `{ bars, end_of_data }`。**会自动跨过数据空洞**，前端可以比较相邻两根的时间差来提示「跳过了 N 天」 |
| GET | `/sessions/:id/klines?interval=5m\|15m\|1h\|4h&end_time=&limit=300` | 截止到 `end_time`（默认会话起点）的历史 K 线，`limit` 最大 1500。每根带 `is_closed`；大周期的最后一根可能未收盘，由 5m 聚合而来 |

5m 数据在 **2026-02-09 ~ 2026-05-25 整段缺失**，另有零星缺天，以 `/data-coverage` 的结果为准。

### 同步

**POST `/sessions/:id/sync`**

```ts
{
  revision: number,              // 必须大于上次同步的值，否则返回 409（附带 current_revision）
  progress: { cursor_time, last_price, balance, bars_stepped, status: 'active' | 'finished' },
  positions?: Position[],        // 三个数组要么都带（整份替换本会话的交易记录），要么都不带（只更新进度）
  orders?: Order[],
  fills?: Fill[],
}
```

- 用 `account.to_sync_payload(progress, revision)` 生成，它会带上完整的交易记录。只更新进度时，自己拼 `{ revision, progress }`。
- **什么时候同步**：有交易操作（下单、撤单、成交、改止损、平仓、改笔记）后同步一次；纯推进每隔几秒、暂停时同步一次；关页面时用 `navigator.sendBeacon(url, JSON.stringify(payload))` 发最后一次。这个接口接受 `text/plain` 的 JSON，跨域也能发。
- **同步请求请串行发送**：上一次返回后再发下一次。收到 409 说明已经有更新的版本入库，这次可以忽略，但要把本地 `revision` 调到比返回的 `current_revision` 更大。
- 结束会话：先调 `account.finish(cursor_bar)`，再用 `status: 'finished'` 同步。
- 后端只检查格式和关联关系：`client_id` 不能重复，成交关联的仓位必须在同步数据里。撮合结果本身不做校验。

### 查询与统计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:id/orders?status=` | 委托列表 |
| GET | `/sessions/:id/stats` | 单会话统计 |
| GET | `/stats?session_ids=1,2&symbol=&direction=long\|short&tag=&start_time=&end_time=` | 跨会话累计统计，时间按平仓时间过滤 |

统计的返回结构：

```ts
{
  overall: Stats,
  by_direction: { long: Stats, short: Stats },
  by_tag: { [tag]: Stats },            // 没有标签的归到 '(无标签)'
  by_exit_reason: { [reason]: Stats },
  equity_curve: [{ position_id, close_bar_time, cum_net_pnl, cum_r }],
}
```

Stats 字段：`trade_count`、`win_count`/`loss_count`、`win_rate`、`total_net_pnl`、`total_fee`、`avg_win`/`avg_loss`、`payoff_ratio`、`profit_factor`、`expectancy`、`r_trade_count`、`total_r`、`avg_r`（期望 R）、`avg_win_r`/`avg_loss_r`、`max_consecutive_wins`/`losses`、`max_drawdown`（USDT）、`max_drawdown_pct`（只有单会话统计有值）、`max_drawdown_r`、`avg_bars_held`、`avg_mfe_pct`/`avg_mae_pct`。胜负按 `net_pnl`（扣除手续费后）判定。

## 撮合规则（引擎内置）

- **账户模式**：单向持仓。同方向下单是加仓；反方向下单先平仓，剩余数量反手开仓，旧仓的 exit_reason 记为 `reverse`。
- **市价单**：按当前 K 线收盘价立即成交（taker，加滑点）。
- **限价单**：如果价格已经越过当前价，按收盘价立即成交（taker）；否则挂单，从下一根开始撮合，按挂单价成交（maker）。
- **条件单**：触发价必须在当前价外侧，否则拒单；触发后按触发价成交（taker，加滑点）。
- **K 线内的价格路径**：持多仓按 O→L→H→C，持空仓按 O→H→L→C，即先走不利方向，所以同一根里止损优先。空仓时，开盘价离高点近就先走高点。沿路径依次撮合，所以可能出现「挂单成交后同一根就被止损」。
- **跳空**：对你不利的（止损、条件单）按开盘价成交，对你有利的（限价单、止盈）按挂单价成交。
- **保证金**：新开仓的名义价值 ÷ 杠杆必须 ≤ 可用权益，否则拒单。不模拟强平。
- 仓位平掉后，剩下的只减仓挂单会自动撤销。
- 开仓时没设止损、之后首次补设的，用这个止损定义 1R；始终没设止损的，`r_multiple` 为 null。

仓位、委托、成交之间用前端生成的 `client_id` 关联（`position_client_id` / `order_client_id`），后端入库时换算成数据库 id（`position_id` / `order_id`）。每次同步都会整份重建，所以数据库 id 会变，**前端请始终用 `client_id`**。
