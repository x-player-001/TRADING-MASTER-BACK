# 区间检测日志示例

## 日志输出示例

### 场景1: 首次检测（找到区间）

```log
[2025-10-09 10:15:30] INFO [SignalManager] BTCUSDT:15m - 触发区间扫描 (第10根K线)

[2025-10-09 10:15:31] INFO [RangeDetector] BTCUSDT:15m - 检测完成 {
  total_klines: 500,
  lookback: 500,
  candidates: 12,
  detected_ranges: 5,
  merged_ranges: 3,
  final_ranges: 3,
  filtered: {
    too_short: 3,
    no_boundaries: 2,
    low_density: 1,
    invalid: 1
  },
  results: [
    {
      support: "95800.00",
      resistance: "97200.00",
      range_pct: "1.46%",
      confidence: "82.5%",
      strength: 85,
      touches: 8,
      duration: 45
    },
    {
      support: "93500.00",
      resistance: "95000.00",
      range_pct: "1.60%",
      confidence: "75.2%",
      strength: 78,
      touches: 6,
      duration: 32
    },
    {
      support: "91200.00",
      resistance: "93800.00",
      range_pct: "2.85%",
      confidence: "68.8%",
      strength: 72,
      touches: 5,
      duration: 28
    }
  ]
}

[2025-10-09 10:15:31] INFO [SignalManager] BTCUSDT:15m - 保存区间 {
  detected: 3,
  unique: 2,
  saved: 2,
  duplicates_filtered: 1
}
```

---

### 场景2: 使用缓存（未到检测间隔）

```log
[2025-10-09 10:15:45] DEBUG [SignalManager] BTCUSDT:15m - 使用缓存区间 (2个)
```

---

### 场景3: 检测但未找到区间

```log
[2025-10-09 10:30:30] INFO [SignalManager] ETHUSDT:1h - 触发区间扫描 (第10根K线)

[2025-10-09 10:30:30] INFO [RangeDetector] ETHUSDT:1h - 检测完成 {
  total_klines: 500,
  lookback: 500,
  candidates: 8,
  detected_ranges: 0,
  merged_ranges: 0,
  final_ranges: 0,
  filtered: {
    too_short: 2,
    no_boundaries: 3,
    low_density: 2,
    invalid: 1
  },
  results: []
}
```

---

### 场景4: 检测到区间但全部重复

```log
[2025-10-09 10:45:30] INFO [SignalManager] BNBUSDT:15m - 触发区间扫描 (第20根K线)

[2025-10-09 10:45:31] INFO [RangeDetector] BNBUSDT:15m - 检测完成 {
  total_klines: 500,
  lookback: 500,
  candidates: 6,
  detected_ranges: 2,
  merged_ranges: 2,
  final_ranges: 2,
  filtered: {
    too_short: 1,
    no_boundaries: 1,
    low_density: 1,
    invalid: 1
  },
  results: [
    {
      support: "610.50",
      resistance: "625.00",
      range_pct: "2.37%",
      confidence: "71.3%",
      strength: 76,
      touches: 6,
      duration: 38
    },
    {
      support: "595.00",
      resistance: "608.00",
      range_pct: "2.18%",
      confidence: "65.8%",
      strength: 70,
      touches: 5,
      duration: 25
    }
  ]
}

[2025-10-09 10:45:31] DEBUG [SignalManager] BNBUSDT:15m - 所有检测到的区间已存在，跳过保存
```

---

## 日志字段说明

### RangeDetector 日志字段

| 字段 | 说明 | 示例值 |
|------|------|--------|
| `total_klines` | 传入的总K线数 | 500 |
| `lookback` | 实际回溯的K线数 | 500 |
| `candidates` | 波动率筛选出的候选区域数 | 12 |
| `detected_ranges` | 通过所有验证的区间数 | 5 |
| `merged_ranges` | 合并重叠后的区间数 | 3 |
| `final_ranges` | 最终返回的区间数（前3个） | 3 |

### filtered 过滤统计

| 字段 | 说明 |
|------|------|
| `too_short` | 区间持续时间太短（<15根） |
| `no_boundaries` | 无法确定支撑阻力边界 |
| `low_density` | 价格密度验证失败（<70%） |
| `invalid` | 最终验证失败（置信度、触碰次数等） |

### results 区间详情

| 字段 | 说明 | 示例 |
|------|------|------|
| `support` | 支撑位价格 | "95800.00" |
| `resistance` | 阻力位价格 | "97200.00" |
| `range_pct` | 区间宽度百分比 | "1.46%" |
| `confidence` | 置信度 | "82.5%" |
| `strength` | 强度评分（0-100） | 85 |
| `touches` | 总触碰次数 | 8 |
| `duration` | 持续K线数 | 45 |

---

## 日志级别说明

- **INFO**: 重要操作和检测结果（每10根K线打印一次）
- **DEBUG**: 详细信息（使用缓存、重复区间等）
- **ERROR**: 错误信息

---

## 查看日志

```bash
# 查看实时日志
npm run dev

# 只看区间检测相关日志
npm run dev | grep "RangeDetector\|SignalManager"

# 只看INFO级别
npm run dev | grep "INFO"
```

---

**更新时间**: 2025-10-09
