# 趋势跟随 · 合并观察列表 API

同一币种在 15m / 1h / 4h 的活跃观察区合并为一行，附带列表上直接可见的关键数字和排序分，按分数降序返回。
5m 不参与合并，仍用原接口 `GET /api/trend-follow/watch-contexts?timeframe=5m` 单独查看。

## GET /api/trend-follow/watchlist

| 参数 | 说明 |
|---|---|
| `timeframes` | 纳入合并的周期，逗号分隔，默认 `15m,1h,4h` |
| `min_score` | 只返回分数 ≥ 该值的币种（可选） |

### 响应

```json
{
  "success": true,
  "count": 28,
  "timeframes": ["15m", "1h", "4h"],
  "data": [
    {
      "symbol": "ONDOUSDT",
      "current_price": 0.9123,
      "quote_volume_24h": 600000000,
      "timeframes": ["4h", "1h"],
      "tf_count": 2,
      "primary_timeframe": "4h",
      "wave_amplitude_pct": 32.1,
      "retrace_now": 0.32,
      "retrace_max": 0.36,
      "pullback_bar_count": 4,
      "volume_shrink": true,
      "stage": "PULLBACK",
      "stale": false,
      "max_alert_level": 1,
      "score": 4,
      "score_tags": ["回调中", "缩量", "多周期×2"],
      "updated_at": "2026-09-26T08:05:00.000Z",
      "details": [ { "id": 16301, "timeframe": "4h", "...": "见下表" } ]
    }
  ]
}
```

### 行字段（取自最大周期 `primary_timeframe`）

| 字段 | 说明 |
|---|---|
| `current_price` | 现价（监控每 5 分钟用最新 5m 收盘价刷新） |
| `quote_volume_24h` | 24h 成交额（USDT） |
| `timeframes` / `tf_count` | 出现的周期（大周期在前）/ 个数 |
| `wave_amplitude_pct` | 第一波涨幅 % |
| `retrace_now` | 按现价的回撤比例（0~1，负数表示已高于第一波高点） |
| `retrace_max` | 按回调最低影线的最大回撤比例 |
| `pullback_bar_count` | 距第一波高点的根数（按 `primary_timeframe` 计） |
| `volume_shrink` | 回调均量 < 第一波均量 × 0.5 |
| `stage` | `RISING` <23.6% · `PULLBACK` 23.6~38.2% · `IN_ZONE` 38.2~61.8% · `DEEP` >61.8% |
| `stale` | 回调根数已达该周期上限的 70%（上限：15m 60 · 1h 36 · 4h 18 根，超过即移出列表） |
| `max_alert_level` | 各周期中最高的报警等级（没有报警为 null） |
| `score` / `score_tags` | 排序分与对应标签，见下 |

### 排序分

| 条件 | 分 | 标签 |
|---|---|---|
| 回撤到位（`IN_ZONE`） | +3 | 回撤到位 |
| 回调中（`PULLBACK`） | +1 | 回调中 |
| 缩量 | +2 | 缩量 |
| 2 个周期 / 3 个周期共振 | +1 / +2 | 多周期×N |
| 回撤过深（`DEEP`） | −2 | 回撤过深 |
| 临近超时 | −1 | 临近超时 |

同分按 24h 成交额降序。

### details（各周期明细，大周期在前）

| 字段 | 说明 |
|---|---|
| `id` | 观察区记录 id（备注 / 删除接口用） |
| `timeframe` / `state` / `last_alert_level` | 周期 / WATCHING·ALERTED / 报警等级 |
| `wave_start_price` / `wave_end_price` / `wave_end_time` | 第一波起涨价 / 高点(实体顶) / 高点时间 |
| `wave_amplitude_pct` / `wave_bar_count` | 第一波涨幅 % / 根数 |
| `pullback_lowest_price` / `pullback_bar_count` | 回调最低影线价 / 回调根数 |
| `max_pullback_bars` | 该周期回调根数上限 |
| `retrace_now` / `retrace_max` / `stage` / `stale` | 同行字段，按该周期第一波计算 |
| `volume_ratio` / `volume_shrink` | 回调均量 ÷ 第一波均量（回调不足 2 根为 null）/ 是否缩量 |
| `watch_start_time` / `remark` | 进入观察区时间 / 手动备注 |

### 配套接口（已有）

- `PATCH /api/trend-follow/watch-contexts/:id/remark` — 备注，Body `{ "remark": "看好" }`
- `DELETE /api/trend-follow/watch-contexts/:id` — 从列表移除（软删除）
- `GET /api/trend-follow/klines/:symbol/:timeframe` — K线（画图用）

> 建议看完形态后用 remark 标「看好 / 不看好」：积累一段时间后可以反推你看好的币在数据上的共同特征，用来改进排序。
