# 实盘交易（MACD 顶背离 S1 / S2）

`src/services/live_trading/`，入口 `scripts/run_live_trader.ts`（pm2 `live`）。独立于旧交易系统（`src/trading/`），不复用其代码与密钥。

## 策略与口径

| | S1 `macd_top_div_15m` | S2 `macd_top_div_5m` |
|---|---|---|
| 信号 | 与模拟盘同一检测器、同一参数（直接读 `PAPER_STRATEGIES`） | 同左 |
| 入场 | 反转K线收盘后挂 STOP 卖出条件单，触发价 = 反转K线低点，**IOC 限价** | 同左 |
| 止损 | 极值（新高） | 极值 + 0.5 ATR |
| 止盈 | 按实际成交均价 2R | 同左 |
| 条件单有效 | 6 根 15m；未触发先破极值即撤 | 6 根 5m |
| 时间平仓 | 48 根 15m | 48 根 5m |

止损 / 止盈 / 入场都按**最新成交价（CONTRACT_PRICE）**触发，与回测「K线高低点触及」一致。

与模拟盘的差异（均为实盘必需）：

- 止损距离 `[0.3%, 10%]` 在**挂单前**按触发价检查（模拟盘在成交后检查）。不跳空时两者完全一致；跳空由 IOC 限价兜底。
- IOC 限价 = max(止损 − 1.5×止损距离, 极值/1.1, 触发价×(价格带下限+1%))。最多多亏 0.5R；跳空过深时不成交（对应模拟盘的 `risk_out_of_range`）。
- 止盈单在成交后立即挂上，模拟盘成交当根不判止盈。
- 两个策略合计**同一币只做一笔**，后到的信号记为 `skipped / symbol_busy`。

## 资金与风控（`live_config.ts`）

| 参数 | 值 | 说明 |
|---|---|---|
| 每笔风险 | 2U | 触发价到止损 |
| 单笔名义上限 | 150U | 止损太近时缩小数量 |
| 杠杆 | 自动，≤ 10x | 保证强平距离 ≥ 2 倍最差止损距离；逐仓 |
| 同时进行中 | 3 笔 | 挂单 + 持仓 |
| 日亏损上限 | 8U | 北京时间当日已平仓净亏损，达到后当日不再开仓 |
| 信号延迟上限 | 90s | 补缺口补出的旧信号不下单 |

另有：任何一笔进入 `error` 状态后禁止开新仓；该币存在非本程序的持仓或挂单时跳过并告警。

## 状态机与正确性保证

```
placing → pending → entering → open → closing → closed
   ↘          ↘                      ↗
   cancelled   cancelled     （平仓失败超过 5 次 → error，需人工处理）
```

- **交易所是唯一事实来源**：用户数据流事件只用来唤醒同步，同步时一律通过 REST 查询条件单、订单、持仓。另有 30 秒兜底和 60 秒账户对账。
- **先落库再下单**：client id 由交易 id 加序号确定（`LV{id}E/I/S{n}/T{n}/X{n}`）。请求结果未知（超时 / 5xx）时，按 client id 查询确认，不会重复下单。
- **持仓必须有止损**：成交后立即挂 closePosition 止损。挂单时价格已越过止损，就立即市价平仓；连续 3 次被拒也市价平仓。每次同步都检查止损单是否还在，丢了就重挂。
- **平仓过程中止损一直挂着**：持仓确认归零后才撤保护单。
- **结算按成交明细**：已实现盈亏、手续费（USDT）、资金费都来自交易所数据。

## 部署与操作

1. **币安账户设置**：单向持仓、单币保证金模式；**关闭「BNB 抵扣手续费」**（否则手续费无法按 USDT 结算）。新 API key 只开「合约交易」，禁止提现，绑定服务器 IP。
2. **服务器 `.env`**：

   ```
   LIVE_BINANCE_API_KEY=...
   LIVE_BINANCE_API_SECRET=...
   LIVE_TRADING_MODE=shadow     # 先影子模式，确认后改为 live
   ```

3. **接口验证**（零风险，不开仓）：

   ```
   npx ts-node -r tsconfig-paths/register scripts/dev/verify/verify_live_api.ts
   ```

4. **启动**：`pm2 start ecosystem.config.js --only live`。之后修改 `.env` 需执行 `pm2 restart live --update-env`。
5. **控制**（进程每 15 秒读取一次）：

   ```
   npx ts-node -r tsconfig-paths/register scripts/live_control.ts                 # 查看状态
   ... --mode=paused     # 停开新仓（已有持仓照常管理）
   ... --mode=running    # 恢复
   ... --mode=flatten    # 撤全部入场单 + 市价平全部持仓，完成后自动转 paused
   ... --resolve=<id> --as=closed|cancelled --note=...   # 人工处理完 error 交易后标记结束，然后重启进程
   ```

6. **停止进程不会撤单**：止损止盈留在交易所，重启后自动接管。

## 数据表

- `live_trades`：唯一键 `(strategy_id, symbol, setup_time)` 与 `paper_trades` 相同，可直接 JOIN 对比实盘与模拟盘
- `live_events`：审计日志（下单、撤单、成交、异常）
- `live_control`：控制开关
- `live_runtime_status`：进程心跳（含余额、两条 WS 连接状态）

## 测试

`tests/live_trading/`：用模拟交易所测完整生命周期，覆盖以下场景：

- 止盈、止损、到时平仓
- 入场单过期、先破极值撤单、撤单失败后重试
- 挂单时已越过触发价走 IOC；跳空不成交
- 下单结果未知（实际已挂上 / 实际未挂上）
- 止损单丢失重挂；成交即越过止损；保护单连续失败
- 外部平仓、平仓原因推断、平仓失败转 error
- 重启续跑、各项风控、一键平仓、账户对账、影子模式
