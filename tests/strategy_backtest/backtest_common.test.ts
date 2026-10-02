/**
 * 回测通用组件：离线缓存读取、序列工具、统计
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { iterate_kline_series, beijing_day_start } from '@/services/strategy_backtest/kline_cache_loader';
import { aggregate_series, rolling_sum, ema } from '@/services/strategy_backtest/series_utils';
import { compute_summary, group_stats } from '@/services/strategy_backtest/backtest_stats';

describe('kline_cache_loader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcache-'));
  const d1 = beijing_day_start('20260101'), d2 = beijing_day_start('20260102');
  /** 写一个日文件 */
  const write_day = (day: string, rows: string[]) => fs.writeFileSync(path.join(dir, `${day}.csv.gz`), zlib.gzipSync(rows.join('\n')));
  const rows1: string[] = [], rows2: string[] = [];
  for (let i = 0; i < 288; i++) {
    if (i !== 10) rows1.push(`AAAUSDT,${d1 + i * 300_000},1,1.1,0.9,${1 + i / 1000},100`);   // 第 10 根缺失
    rows2.push(`AAAUSDT,${d2 + i * 300_000},2,2.1,1.9,2,100`);
    if (i >= 200) rows2.push(`BBBUSDT,${d2 + i * 300_000},5,5,5,5,1`);                     // 只有 88 根
  }
  write_day('20260101', rows1.reverse());                                                   // 行序不保证
  write_day('20260102', rows2);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('逐币产出，缺口前向填充，不合格币种跳过', () => {
    const list = [...iterate_kline_series({ cache_dir: dir, from_day: '20260101', to_day: '20260102', batch_size: 1, min_bars: 100 })];
    expect(list.map(s => s.symbol)).toEqual(['AAAUSDT']);
    const a = list[0];
    expect(a.length).toBe(576);
    expect(a.time[0]).toBe(d1);
    expect(a.close[10]).toBeCloseTo(1.009, 6);       // 用前一根收盘填充
    expect(a.quote[10]).toBe(0);
    expect(a.close[11]).toBeCloseTo(1.011, 6);
    expect(a.quote[300]).toBeCloseTo(200, 3);
  });

  test('区间过滤与指定币种', () => {
    const list = [...iterate_kline_series({ cache_dir: dir, from_day: '20260102', to_day: '20260102', symbols: ['BBBUSDT'], min_bars: 50 })];
    expect(list.map(s => [s.symbol, s.length])).toEqual([['BBBUSDT', 88]]);
  });
});

describe('series_utils', () => {
  test('rolling_sum 与 ema', () => {
    expect([...rolling_sum([1, 2, 3, 4], 2)]).toEqual([1, 3, 5, 7]);
    const e = ema([10, 10, 10], 5);
    expect([...e]).toEqual([10, 10, 10]);
  });

  test('聚合到 15m 按整刻钟对齐，丢弃不完整首根', () => {
    const n = 8, mk = () => new Float64Array(n);
    const s = { symbol: 'X', timeframe: '5m' as const, time: mk(), open: mk(), high: mk(), low: mk(), close: mk(), volume: mk(), quote: mk(), length: n };
    for (let i = 0; i < n; i++) { s.time[i] = 600_000 + i * 300_000; s.open[i] = i; s.high[i] = i + 1; s.low[i] = i - 1; s.close[i] = i + 0.5; s.volume[i] = 1; s.quote[i] = 2; }
    const a = aggregate_series(s, '15m');
    expect(a.length).toBe(2);
    expect([...a.time]).toEqual([900_000, 1_800_000]);
    expect([a.open[0], a.high[0], a.low[0], a.close[0], a.volume[0], a.quote[0]]).toEqual([1, 4, 0, 3.5, 3, 6]);
  });
});

describe('backtest_stats', () => {
  const trades = [
    { symbol: 'A', exit_time: 1, exit_reason: 'x', pnl: 2, r_multiple: null },
    { symbol: 'A', exit_time: 2, exit_reason: 'y', pnl: -1, r_multiple: null },
    { symbol: 'B', exit_time: 3, exit_reason: 'y', pnl: -2, r_multiple: null },
    { symbol: 'B', exit_time: 4, exit_reason: 'x', pnl: 4, r_multiple: null },
  ];

  test('汇总', () => {
    const s = compute_summary(trades);
    expect(s.trades).toBe(4);
    expect(s.win_rate).toBe(0.5);
    expect(s.total_pnl).toBe(3);
    expect(s.profit_factor).toBe(2);
    expect(s.max_drawdown).toBe(3);
    expect(s.max_consecutive_losses).toBe(2);
    expect(s.symbols).toBe(2);
    expect(s.avg_r).toBeNull();
  });

  test('分组', () => {
    expect(group_stats(trades, t => t.exit_reason!)).toEqual([
      { key: 'x', trades: 2, win_rate: 1, total_pnl: 6, avg_pnl: 3 },
      { key: 'y', trades: 2, win_rate: 0, total_pnl: -3, avg_pnl: -1.5 },
    ]);
  });
});
