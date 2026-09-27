/**
 * 第二波跟随服务 状态机单元测试（纯内存，合成K线）
 */

import { SecondWaveService, SwBar, SwWatchEvent } from '../../src/services/second_wave/second_wave_service';

const H1 = 3600_000;
const T0 = Date.UTC(2026, 5, 1);

/** K线序列构造器：按顺序追加，自动编号时间 */
class Series {
  bars: SwBar[] = [];
  constructor(private volume = 1e6) {}

  /** 追加一根：o→c，影线各延伸 0.2 */
  push(open: number, close: number, volume = this.volume): this {
    this.bars.push({
      open_time: T0 + this.bars.length * H1, open, close,
      high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume,
    });
    return this;
  }

  /** 横盘 n 根 */
  flat(n: number, price: number): this {
    for (let k = 0; k < n; k++) this.push(price, price);
    return this;
  }

  /** 从当前收盘价按每根 step 连续走 n 根 */
  walk(n: number, step: number): this {
    let p = this.bars[this.bars.length - 1].close;
    for (let k = 0; k < n; k++) { this.push(p, p + step); p += step; }
    return this;
  }
}

/** 基础行情：200 根横盘 + 10 根拉升 100 → 130（高点 130.2，起点 99.8） */
function base_with_impulse(volume = 1e6): Series {
  return new Series(volume).flat(200, 100).walk(10, 3);
}

/** 跑完整序列，收集信号与名单事件 */
function run(bars: SwBar[], overrides = {}) {
  const svc = new SecondWaveService(overrides);
  const events: { event: SwWatchEvent; reason?: string }[] = [];
  svc.on_watch_change((_ctx, event, reason) => events.push({ event, reason }));
  const signals = bars.map(b => svc.process_bar('TESTUSDT', b)).filter(s => s !== null);
  return { svc, events, signals };
}

describe('SecondWaveService', () => {
  test('第一波 → 回调 → 突破回调结构：发出唯一信号，止损在回调低点下方', () => {
    const s = base_with_impulse()
      .walk(6, -2)          // 回调到 118（最低 117.8）
      .flat(2, 118.5)
      .push(118.5, 125);    // 收盘 125 > 前 5 根最高 124.2，且低于前高 130.2
    const { signals, events } = run(s.bars);

    expect(signals).toHaveLength(1);
    const sig = signals[0]!;
    expect(sig.entry).toBe(125);
    expect(sig.P).toBeCloseTo(117.8);
    expect(sig.stop).toBeCloseTo(117.8 * 0.997);
    expect(sig.H).toBeCloseTo(130.2);
    expect(sig.retrace).toBeGreaterThan(0.236);
    expect(events.map(e => e.event)).toEqual(expect.arrayContaining(['enter', 'pullback', 'trigger']));
  });

  test('回调阶段静默：只有进入名单事件，没有信号', () => {
    const s = base_with_impulse().walk(6, -2);
    const { signals, svc } = run(s.bars);
    expect(signals).toHaveLength(0);
    expect(svc.get_watchlist()).toHaveLength(1);
    expect(svc.get_watchlist()[0].state).toBe('PULLBACK');
  });

  test('收盘回撤超过 78.6% → 过期，不发信号', () => {
    const s = base_with_impulse().walk(13, -2).push(104, 108);   // 收盘跌到 104，回撤约 86%
    const { signals, events, svc } = run(s.bars);
    expect(signals).toHaveLength(0);
    expect(events.some(e => e.event === 'expire' && /回撤/.test(e.reason ?? ''))).toBe(true);
    expect(svc.get_watchlist()).toHaveLength(0);
  });

  test('高位横盘太久才回撤到位 → 过期（回调拖太久）', () => {
    const s = base_with_impulse().flat(30, 129).walk(5, -3);    // 30 根后才跌进回调区
    const { signals, events } = run(s.bars);
    expect(signals).toHaveLength(0);
    expect(events.some(e => e.event === 'expire' && /拖太久/.test(e.reason ?? ''))).toBe(true);
  });

  test('24h 成交额不足 100M → 不进入观察名单', () => {
    const s = base_with_impulse(1000);   // 100 × 1000 × 24 ≈ 2.4M
    const { events, svc } = run(s.bars.concat(new Series().bars));
    expect(events).toHaveLength(0);
    expect(svc.get_watchlist()).toHaveLength(0);
  });

  test('观察中再创新高：更新第一波高点，回调重新计算', () => {
    const s = base_with_impulse().walk(2, -1).walk(3, 3);      // 小回落后继续新高到 137
    const { svc } = run(s.bars);
    const ctx = svc.get_watchlist()[0];
    expect(ctx.state).toBe('IMPULSE');
    expect(ctx.H).toBeCloseTo(137.2);
    expect(ctx.retrace).toBe(0);
  });

  test('本根创回调新低时不触发', () => {
    const s = base_with_impulse().walk(6, -2).push(117, 125);  // 最低 116.8 创新低，收盘虽高也不触发
    const { signals } = run(s.bars);
    expect(signals).toHaveLength(0);
  });
});
