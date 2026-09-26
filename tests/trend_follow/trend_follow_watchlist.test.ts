/**
 * 趋势跟随合并观察列表 单元测试（纯内存）
 */

import { build_watchlist } from '../../src/services/trend_follow_watchlist';
import { TrendFollowWatchContextRecord } from '../../src/database/trend_follow_repository';

let next_id = 1;

/** 构造一条观察区记录：第一波 100 → 200，默认回调 3 根、未缩量 */
function ctx(over: Partial<TrendFollowWatchContextRecord>): TrendFollowWatchContextRecord {
  return {
    id: next_id++, symbol: 'AUSDT', timeframe: '1h', state: 'WATCHING',
    wave_start_price: 100, wave_end_price: 200, wave_amplitude_pct: 100, wave_bar_count: 6,
    wave_avg_volume: 1000, wave_end_time: 0, pullback_lowest_price: 150, pullback_bar_count: 3,
    pullback_avg_volume: 800, current_price: 190, quote_volume_24h: 2e8, last_alert_level: null,
    watch_start_time: 0, remark: null, updated_at: new Date(1000), ...over,
  };
}

describe('build_watchlist', () => {
  test('同一币种多周期合并为一行，最大周期为主，大周期在前', () => {
    const list = build_watchlist([
      ctx({ timeframe: '15m' }), ctx({ timeframe: '4h' }), ctx({ timeframe: '1h' }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].timeframes).toEqual(['4h', '1h', '15m']);
    expect(list[0].primary_timeframe).toBe('4h');
    expect(list[0].tf_count).toBe(3);
    expect(list[0].score_tags).toContain('多周期×3');
  });

  test('默认不纳入 5m，可通过参数纳入', () => {
    const recs = [ctx({ timeframe: '5m', symbol: 'BUSDT' })];
    expect(build_watchlist(recs)).toHaveLength(0);
    expect(build_watchlist(recs, ['5m'])).toHaveLength(1);
  });

  test('只合并活跃状态', () => {
    const list = build_watchlist([
      ctx({ state: 'ABANDONED' }), ctx({ state: 'BREAKTHROUGH', symbol: 'CUSDT' }), ctx({ state: 'ALERTED', symbol: 'DUSDT' }),
    ]);
    expect(list.map(i => i.symbol)).toEqual(['DUSDT']);
  });

  test('按当前价算回撤阶段：回撤到位 + 缩量排最前，过深排后面', () => {
    const list = build_watchlist([
      ctx({ symbol: 'ZONE', current_price: 150, pullback_avg_volume: 300 }),   // 回撤 50%，缩量
      ctx({ symbol: 'HIGH', current_price: 190 }),                             // 回撤 10%
      ctx({ symbol: 'DEEP', current_price: 130 }),                             // 回撤 70%
    ]);
    expect(list.map(i => i.symbol)).toEqual(['ZONE', 'HIGH', 'DEEP']);
    expect(list[0].stage).toBe('IN_ZONE');
    expect(list[0].retrace_now).toBeCloseTo(0.5);
    expect(list[0].score_tags).toEqual(expect.arrayContaining(['回撤到位', '缩量']));
    expect(list[2].stage).toBe('DEEP');
    expect(list[2].score_tags).toContain('回撤过深');
  });

  test('现价取最近更新的一条，并用它统一计算各周期回撤', () => {
    const list = build_watchlist([
      ctx({ timeframe: '4h', current_price: 190, updated_at: new Date(1000) }),
      ctx({ timeframe: '1h', current_price: 160, updated_at: new Date(5000) }),
    ]);
    expect(list[0].current_price).toBe(160);
    expect(list[0].details.every(d => Math.abs(d.retrace_now - 0.4) < 1e-9)).toBe(true);
  });

  test('临近超时：4h 回调根数达到上限 18 根的 70%', () => {
    const [item] = build_watchlist([ctx({ timeframe: '4h', pullback_bar_count: 13 })]);
    expect(item.details[0].max_pullback_bars).toBe(18);
    expect(item.stale).toBe(true);
    expect(item.score_tags).toContain('临近超时');
  });

  test('回调不足 2 根时不判缩量', () => {
    const [item] = build_watchlist([ctx({ pullback_bar_count: 1, pullback_avg_volume: 10 })]);
    expect(item.details[0].volume_ratio).toBeNull();
    expect(item.volume_shrink).toBe(false);
  });
});
