/**
 * 日线趋势线突破检测器 单元测试（纯内存，合成日线）
 */

import { DailyBar, detect_trendline_breakouts, find_pivot_highs } from '../../src/analysis/trendline_breakout_detector';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/**
 * 按折线路径生成日线：相邻路标间收盘价线性插值，
 * 影线上下各 0.5%（高点 = max(开,收) × 1.005）
 */
function build_bars(waypoints: [number, number][], volume_at?: (day: number) => number): DailyBar[] {
  const bars: DailyBar[] = [];
  let prev = waypoints[0][1];
  for (let w = 1; w < waypoints.length; w++) {
    const [d0, p0] = waypoints[w - 1];
    const [d1, p1] = waypoints[w];
    for (let d = w === 1 ? d0 : d0 + 1; d <= d1; d++) {
      const close = p0 + (p1 - p0) * (d - d0) / (d1 - d0);
      bars.push({
        open_time: T0 + d * DAY,
        open: prev,
        close,
        high: Math.max(prev, close) * 1.005,
        low: Math.min(prev, close) * 0.995,
        volume: volume_at ? volume_at(d) : 1000,
      });
      prev = close;
    }
  }
  return bars;
}

const day_of = (t: number) => Math.round((t - T0) / DAY);
const ALL = { max_breakout_age_days: Infinity };

/** 下降趋势线：高点 100 → 92 → 84（每天 -0.2），第 120 天收盘站上 */
const DESCENDING_BASE: [number, number][] = [
  [0, 80], [10, 100], [30, 70], [50, 92], [70, 65], [90, 84], [110, 60], [125, 92],
];

describe('find_pivot_highs', () => {
  it('识别路径上的局部高点', () => {
    const bars = build_bars(DESCENDING_BASE);
    expect(find_pivot_highs(bars, 5).map(i => day_of(bars[i].open_time))).toEqual([10, 50, 90]);
  });
});

describe('detect_trendline_breakouts', () => {
  it('下降趋势线：连上 3 个触点，突破后回踩', () => {
    const bars = build_bars([...DESCENDING_BASE, [135, 77], [150, 85]]);
    const [r, ...rest] = detect_trendline_breakouts(bars, ALL);

    expect(rest).toHaveLength(0);
    expect(r.line_type).toBe('descending');
    expect(r.touch_count).toBe(3);
    expect(r.touches.map(t => day_of(t.time))).toEqual([10, 50, 90]);
    expect(day_of(r.breakout_time)).toBe(120);
    expect(r.breakout_pct).toBeGreaterThan(1);
    expect(r.status).toBe('retest');
    expect(day_of(r.retest_time!)).toBeGreaterThan(125);
  });

  it('突破后收盘跌破线 → failed', () => {
    const bars = build_bars([...DESCENDING_BASE, [140, 55]]);
    const [r] = detect_trendline_breakouts(bars, ALL);
    expect(r.status).toBe('failed');
    expect(r.fail_time).not.toBeNull();
  });

  it('盘整上沿：水平高点突破', () => {
    const bars = build_bars([
      [0, 80], [10, 100], [30, 85], [50, 100], [70, 82], [90, 100], [110, 86], [125, 110], [135, 102], [150, 115],
    ]);
    const [r] = detect_trendline_breakouts(bars, ALL);
    expect(r.line_type).toBe('horizontal');
    expect(r.touch_count).toBe(3);
    expect(r.status).toBe('retest');
  });

  it('上升趋势的高点连线不输出', () => {
    const bars = build_bars([[0, 80], [10, 100], [30, 90], [50, 110], [70, 100], [90, 120], [110, 108], [130, 140]]);
    expect(detect_trendline_breakouts(bars, ALL)).toHaveLength(0);
  });

  it('数据空洞不影响连线（x 轴按真实时间）', () => {
    const full = build_bars([...DESCENDING_BASE, [135, 77], [150, 85]]);
    const holed = full.filter(b => { const d = day_of(b.open_time); return d < 60 || d > 80; });
    const [a] = detect_trendline_breakouts(full, ALL);
    const [b] = detect_trendline_breakouts(holed, ALL);
    expect(b.touches).toEqual(a.touches);
    expect(b.breakout_time).toBe(a.breakout_time);
  });

  it('突破窗口外的历史突破不输出', () => {
    const bars = build_bars([...DESCENDING_BASE, [135, 79], [200, 85]]);
    expect(detect_trendline_breakouts(bars, { max_breakout_age_days: 30 })).toHaveLength(0);
  });

  it('突破量比 = 突破日量 / 前 N 日均量', () => {
    const bars = build_bars(DESCENDING_BASE, d => (d >= 118 ? 3000 : 1000));
    const [r] = detect_trendline_breakouts(bars, ALL);
    // 突破日第 120 天，前 20 日含 2 天 3000 量 → 均量 1200，量比 2.5
    expect(r.breakout_volume_ratio).toBeCloseTo(2.5);
  });
});

describe('max_touch_gap_days', () => {
  it('相邻触点间隔超限的线丢弃', () => {
    // 高点 10 / 50 / 90 相邻间隔 40 天
    const bars = build_bars([...DESCENDING_BASE, [135, 77], [150, 85]]);
    expect(detect_trendline_breakouts(bars, { ...ALL, max_touch_gap_days: 40 })).toHaveLength(1);
    expect(detect_trendline_breakouts(bars, { ...ALL, max_touch_gap_days: 39 })).toHaveLength(0);
  });
});

describe('max_wick_breaks', () => {
  /** 盘整区间（上沿 100）中间插一根长上影：高 120、收盘回到区间 */
  function range_with_spike(): DailyBar[] {
    const bars = build_bars([
      [0, 80], [10, 100], [30, 85], [50, 100], [70, 82], [90, 100], [110, 86], [125, 110], [135, 102], [150, 115],
    ]);
    const spike = bars[60];
    spike.high = 120;
    return bars;
  }

  it('单根插针不废掉盘整上沿', () => {
    const [r] = detect_trendline_breakouts(range_with_spike(), ALL);
    expect(r.line_type).toBe('horizontal');
    expect(r.touch_count).toBe(3);
  });

  it('插针超过允许根数 → 上沿作废', () => {
    const results = detect_trendline_breakouts(range_with_spike(), { ...ALL, max_wick_breaks: 0 });
    expect(results.every(r => r.line_type !== 'horizontal' || r.touch_count < 3)).toBe(true);
  });
});

describe('extended', () => {
  it('突破后回踩过、但最新收盘离线过远 → extended', () => {
    // 回踩后一路拉升到 130，远离线（约 73）
    const bars = build_bars([...DESCENDING_BASE, [135, 77], [160, 130]]);
    const [r] = detect_trendline_breakouts(bars, ALL);
    expect(r.retest_time).not.toBeNull();
    expect(r.status).toBe('extended');
    expect(r.last_distance_pct).toBeGreaterThan(20);
  });

  it('离线未超阈值仍为 retest', () => {
    const bars = build_bars([...DESCENDING_BASE, [135, 77], [150, 85]]);
    expect(detect_trendline_breakouts(bars, { ...ALL, extended_pct: 30 })[0].status).toBe('retest');
  });
});

describe('breakout_new_high_days', () => {
  it('价格深跌后底部横盘，线自己降下来横着穿过 → 不算突破', () => {
    // 高点 100 → 92 → 84 的下降线；第 90 天后跌到 40 横盘，线约在第 ~300 天降到 40 附近
    const bars = build_bars([...DESCENDING_BASE.slice(0, 7), [110, 40], [400, 40.4]]);
    expect(detect_trendline_breakouts(bars, ALL)).toHaveLength(0);
  });

  it('同样的底部横盘，放量拉出新高穿线 → 算突破', () => {
    const bars = build_bars([...DESCENDING_BASE.slice(0, 7), [110, 40], [250, 40.4], [260, 70]]);
    const [r] = detect_trendline_breakouts(bars, ALL);
    expect(r).toBeDefined();
    expect(day_of(r.breakout_time)).toBeGreaterThan(250);
  });
});
