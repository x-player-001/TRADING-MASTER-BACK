# 缠论分析API使用指南

## 📋 概述

本文档介绍如何使用缠论分析API获取分型、笔、中枢数据，并在前端图表中进行可视化展示。

## 🎯 核心概念

### 缠论三要素

1. **分型 (Fractal)** - K线的局部高点/低点
   - 顶分型: 中间K线高点最高
   - 底分型: 中间K线低点最低

2. **笔 (Stroke)** - 相邻分型之间的连线
   - 向上笔: 从底分型到顶分型
   - 向下笔: 从顶分型到底分型

3. **中枢 (Center)** - 至少3笔价格重叠区域
   - 横盘整理的核心标志
   - 支撑阻力位的理论基础

---

## 📡 API接口

### **获取缠论分析数据**

```http
GET /api/structure/chan-analysis/:symbol/:interval
```

#### 路径参数

| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| symbol | string | ✅ | 交易对符号 | BTCUSDT |
| interval | string | ✅ | K线周期 | 15m |

**支持的周期**: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`

#### 查询参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| lookback | number | ❌ | 200 | 回溯K线数量 (50-1000) |

#### 请求示例

```bash
# 获取BTC 15分钟周期缠论数据
curl http://localhost:3000/api/structure/chan-analysis/BTCUSDT/15m?lookback=500

# 获取ETH 1小时周期缠论数据
curl http://localhost:3000/api/structure/chan-analysis/ETHUSDT/1h?lookback=300
```

---

## 📊 返回数据结构

### 完整响应示例

```json
{
  "success": true,
  "data": {
    "symbol": "BTCUSDT",
    "interval": "15m",
    "analysis_time": 1704723600000,
    "kline_count": 500,

    "fractals": [
      {
        "type": "top",
        "kline_index": 10,
        "price": 43250.5,
        "time": 1704723600000,
        "strength": 0.85,
        "is_confirmed": true
      },
      {
        "type": "bottom",
        "kline_index": 25,
        "price": 42800.3,
        "time": 1704737400000,
        "strength": 0.72,
        "is_confirmed": true
      }
    ],

    "strokes": [
      {
        "id": "stroke_BTCUSDT_10_25",
        "direction": "down",
        "start": {
          "index": 10,
          "price": 43250.5,
          "time": 1704723600000
        },
        "end": {
          "index": 25,
          "price": 42800.3,
          "time": 1704737400000
        },
        "amplitude_percent": 1.04,
        "duration_bars": 15,
        "is_valid": true
      }
    ],

    "centers": [
      {
        "id": "center_BTCUSDT_30",
        "high": 43900,
        "low": 43500,
        "middle": 43700,
        "height_percent": 0.91,
        "start_time": 1704740000000,
        "end_time": 1704780000000,
        "start_index": 30,
        "end_index": 60,
        "duration_bars": 30,
        "strength": 75,
        "stroke_count": 5,
        "is_active": true,
        "is_extending": false,
        "extension_count": 2
      }
    ],

    "current_state": {
      "in_center": true,
      "center_id": "center_BTCUSDT_30",
      "last_stroke_direction": "up",
      "last_fractal_type": "top"
    },

    "statistics": {
      "total_fractals": 120,
      "valid_fractals": 98,
      "total_strokes": 45,
      "valid_strokes": 42,
      "total_centers": 8,
      "valid_centers": 7
    }
  }
}
```

### 数据字段说明

#### 1. 分型数据 (fractals)

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 分型类型: `top` (顶分型) / `bottom` (底分型) |
| kline_index | number | K线数组索引位置 |
| price | number | 分型价格 (顶取high, 底取low) |
| time | number | 时间戳 (毫秒) |
| strength | number | 分型强度 (0-1), 越大越可靠 |
| is_confirmed | boolean | 是否已确认 (后续K线未破坏) |

#### 2. 笔数据 (strokes)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 笔的唯一标识 |
| direction | string | 笔方向: `up` (向上) / `down` (向下) |
| start | object | 起点 {index, price, time} |
| end | object | 终点 {index, price, time} |
| amplitude_percent | number | 振幅百分比 |
| duration_bars | number | 持续K线数 |
| is_valid | boolean | 是否有效笔 (满足振幅/持续时间要求) |

#### 3. 中枢数据 (centers)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 中枢唯一标识 |
| high | number | 中枢上沿价格 (阻力位) |
| low | number | 中枢下沿价格 (支撑位) |
| middle | number | 中枢中轴价格 |
| height_percent | number | 中枢高度百分比 |
| start_time | number | 开始时间戳 (毫秒) |
| end_time | number | 结束时间戳 (毫秒) |
| start_index | number | 开始K线索引 |
| end_index | number | 结束K线索引 |
| duration_bars | number | 持续K线数 |
| strength | number | 中枢强度 (0-100) |
| stroke_count | number | 组成笔数量 |
| is_active | boolean | 是否当前活跃 (未完成) |
| is_extending | boolean | 是否在扩展中 |
| extension_count | number | 扩展次数 (最多9次) |

#### 4. 当前状态 (current_state)

| 字段 | 类型 | 说明 |
|------|------|------|
| in_center | boolean | 当前是否处于中枢震荡 |
| center_id | string | 当前活跃中枢ID |
| last_stroke_direction | string | 最新笔方向 |
| last_fractal_type | string | 最新分型类型 |

---

## 🎨 前端可视化实现

### 方案一: TradingView Lightweight Charts

#### 1. 绘制分型标记

```typescript
import { createChart } from 'lightweight-charts';

// 获取缠论数据
const response = await fetch('/api/structure/chan-analysis/BTCUSDT/15m?lookback=500');
const { data } = await response.json();

// 绘制分型
data.fractals.forEach(fractal => {
  const marker = {
    time: fractal.time / 1000, // 转为秒级时间戳
    position: fractal.type === 'top' ? 'aboveBar' : 'belowBar',
    color: fractal.type === 'top' ? '#ef5350' : '#26a69a',
    shape: fractal.type === 'top' ? 'arrowDown' : 'arrowUp',
    text: fractal.type === 'top' ? '顶分型' : '底分型',
    size: 1
  };

  candlestickSeries.setMarkers([...existingMarkers, marker]);
});
```

#### 2. 绘制笔的连线

```typescript
// 为每笔创建趋势线
data.strokes.forEach(stroke => {
  const line = chart.createLineSeries({
    color: stroke.direction === 'up' ? '#26a69a' : '#ef5350',
    lineWidth: 2,
    lineStyle: stroke.is_valid ? 0 : 2, // 0=实线, 2=虚线
    priceLineVisible: false,
    lastValueVisible: false
  });

  line.setData([
    { time: stroke.start.time / 1000, value: stroke.start.price },
    { time: stroke.end.time / 1000, value: stroke.end.price }
  ]);
});
```

#### 3. 绘制中枢矩形区域

```typescript
// 使用价格线或自定义插件绘制矩形
data.centers.forEach(center => {
  // 方法1: 使用水平线近似
  const upperLine = chart.createPriceLine({
    price: center.high,
    color: center.is_active ? '#ffc107' : '#607d8b',
    lineWidth: 2,
    lineStyle: 0,
    axisLabelVisible: true,
    title: `中枢上沿 (${center.stroke_count}笔)`
  });

  const lowerLine = chart.createPriceLine({
    price: center.low,
    color: center.is_active ? '#ffc107' : '#607d8b',
    lineWidth: 2,
    lineStyle: 0,
    axisLabelVisible: true,
    title: '中枢下沿'
  });

  // 方法2: 使用自定义插件绘制填充矩形
  // (需要实现自定义插件)
});
```

### 方案二: ECharts

```typescript
// 使用 markPoint + markLine + markArea
const option = {
  series: [{
    type: 'candlestick',
    data: klineData,

    // 分型标记
    markPoint: {
      symbol: 'pin',
      symbolSize: 50,
      data: data.fractals.map(f => ({
        coord: [f.time, f.price],
        value: f.type === 'top' ? '顶' : '底',
        itemStyle: {
          color: f.type === 'top' ? '#ef5350' : '#26a69a'
        }
      }))
    },

    // 笔的连线
    markLine: {
      symbol: 'none',
      lineStyle: { type: 'solid', width: 2 },
      data: data.strokes.map(s => [
        { coord: [s.start.time, s.start.price] },
        { coord: [s.end.time, s.end.price] }
      ])
    },

    // 中枢矩形
    markArea: {
      data: data.centers.map(c => [
        {
          name: `中枢(${c.stroke_count}笔)`,
          xAxis: c.start_time,
          yAxis: c.high,
          itemStyle: {
            color: c.is_active
              ? 'rgba(255, 193, 7, 0.2)'
              : 'rgba(96, 125, 139, 0.1)'
          }
        },
        {
          xAxis: c.end_time,
          yAxis: c.low
        }
      ])
    }
  }]
};
```

---

## 💡 使用场景示例

### 场景1: 判断当前是否适合交易

```typescript
const { data } = await fetch('/api/structure/chan-analysis/BTCUSDT/15m').then(r => r.json());

if (data.current_state.in_center) {
  console.log('当前处于中枢震荡，适合区间交易');
  console.log('支撑位:', data.centers.find(c => c.is_active)?.low);
  console.log('阻力位:', data.centers.find(c => c.is_active)?.high);
} else {
  console.log('当前处于趋势行进，适合趋势交易');
  console.log('最新笔方向:', data.current_state.last_stroke_direction);
}
```

### 场景2: 识别支撑阻力位

```typescript
const active_center = data.centers.find(c => c.is_active);

if (active_center) {
  console.log('=== 当前关键价位 ===');
  console.log('强阻力位:', active_center.high);
  console.log('强支撑位:', active_center.low);
  console.log('中轴价位:', active_center.middle);
  console.log('中枢强度:', active_center.strength, '/100');
  console.log('持续时间:', active_center.duration_bars, '根K线');
}
```

### 场景3: 检测突破信号

```typescript
const current_price = 43850; // 当前价格
const active_center = data.centers.find(c => c.is_active);

if (active_center) {
  const breakout_threshold_up = active_center.high * 1.02; // 向上突破2%
  const breakout_threshold_down = active_center.low * 0.98; // 向下突破2%

  if (current_price > breakout_threshold_up) {
    console.log('✅ 向上突破中枢！');
    console.log('突破价位:', active_center.high);
    console.log('当前价格:', current_price);
  } else if (current_price < breakout_threshold_down) {
    console.log('❌ 向下突破中枢！');
    console.log('突破价位:', active_center.low);
    console.log('当前价格:', current_price);
  }
}
```

### 场景4: 分析笔的趋势强度

```typescript
// 统计最近5笔的方向
const recent_strokes = data.strokes.slice(-5);
const up_count = recent_strokes.filter(s => s.direction === 'up').length;
const down_count = recent_strokes.filter(s => s.direction === 'down').length;

if (up_count > down_count * 2) {
  console.log('📈 强势上涨趋势');
} else if (down_count > up_count * 2) {
  console.log('📉 强势下跌趋势');
} else {
  console.log('📊 震荡整理');
}

// 计算平均振幅
const avg_amplitude = recent_strokes.reduce((sum, s) => sum + s.amplitude_percent, 0) / recent_strokes.length;
console.log('近期平均笔振幅:', avg_amplitude.toFixed(2), '%');
```

---

## ⚙️ 配置参数说明

### 分型识别配置

缠论分析默认使用以下配置 (在后端 `ChanAnalyzer` 中可调整):

```typescript
fractal_config = {
  strict_mode: true,           // 严格模式
  min_gap_percent: 0.3,        // 最小价格差异 0.3%
  allow_equal: false,          // 不允许相等K线
  merge_nearby: true,          // 合并相邻分型
  merge_distance: 5            // 合并距离 5根K线
}
```

### 笔构建配置

```typescript
stroke_config = {
  min_amplitude: 1.5,          // 最小振幅 1.5%
  min_klines: 5,               // 最少 5根K线
  max_retracement: 0.3,        // 最大回撤 30%
  require_volume_confirm: false // 不需要成交量确认
}
```

### 中枢识别配置

```typescript
center_config = {
  min_strokes: 3,              // 最少 3笔
  overlap_threshold: 0.7,      // 重叠度 70%
  max_duration: 100,           // 最大持续 100根K线
  min_height_percent: 1.0,     // 最小高度 1%
  extension_mode: 'strict',    // 严格扩展模式
  max_extensions: 9            // 最多扩展 9次
}
```

---

## 🔍 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| 分析速度 | ~20ms | 500根K线全量分析 |
| 内存占用 | ~5MB | 单次分析 |
| 并发支持 | ✅ | 无状态设计 |
| 缓存建议 | 前端缓存5分钟 | 减少重复请求 |

---

## ❓ 常见问题

### Q1: 为什么返回的数据为空？

**A**: 检查以下几点:
- K线数据是否足够 (至少50根)
- 市场是否有明显的分型结构 (极端单边行情可能无分型)
- 调整 `lookback` 参数增加数据量

### Q2: 分型/笔/中枢数量过多怎么办？

**A**: 可以通过以下方式过滤:
```typescript
// 只保留已确认的分型
const confirmed_fractals = data.fractals.filter(f => f.is_confirmed);

// 只保留有效笔
const valid_strokes = data.strokes.filter(s => s.is_valid);

// 只保留强度高的中枢
const strong_centers = data.centers.filter(c => c.strength > 60);
```

### Q3: 如何实时更新缠论数据？

**A**: 两种方案:
1. **轮询**: 每30秒调用一次API (简单)
2. **WebSocket**: 监听K线更新后重新分析 (高效)

```typescript
// 方案1: 轮询
setInterval(async () => {
  const { data } = await fetch('/api/structure/chan-analysis/BTCUSDT/15m');
  updateChart(data);
}, 30000);

// 方案2: WebSocket (需要后端支持)
socket.on('kline_update', async () => {
  const { data } = await fetch('/api/structure/chan-analysis/BTCUSDT/15m');
  updateChart(data);
});
```

### Q4: 不同周期的缠论数据差异很大？

**A**: 这是正常现象:
- **短周期** (1m/5m): 分型多、笔多、中枢小而短暂
- **长周期** (1h/4h): 分型少、笔少、中枢大而持久

建议根据交易风格选择:
- 日内交易 → 15m/1h
- 波段交易 → 4h/1d

---

## 📚 相关文档

- [缠论理论基础](./STRUCTURE_PATTERN_GUIDE.md)
- [API总览](./API_REFERENCE.md)
- [系统架构](../CLAUDE.md)

---

## 📞 技术支持

如有问题，请查看:
- GitHub Issues: [trading-master-back/issues](https://github.com/your-repo/issues)
- 系统日志: `logs/app.log`

---

**文档版本**: v1.0
**最后更新**: 2025-10-09
**适用版本**: Trading Master Backend v1.0+
