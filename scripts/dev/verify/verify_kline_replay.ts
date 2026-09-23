/**
 * K线回放 + 模拟交易 端到端验证（连真实数据库，需在服务器执行）
 *
 * 覆盖：建会话 → 游标视角K线（防偷看、大周期未收盘K线）→ 按风险下单 → 步进 → 快进到平仓
 *      → 延迟落库（纯推进只改内存、交易/读接口/shutdown 时落库）
 *      → 挂空单等成交 → 结束会话 → 统计；另测跨 5m 数据空洞的步进。
 * 默认跑完删除测试会话，加 --keep 保留。
 *
 * npx ts-node -r tsconfig-paths/register scripts/dev/verify/verify_kline_replay.ts [--symbol BTCUSDT] [--keep]
 */

import dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '@/core/config/config_manager';
ConfigManager.getInstance().initialize();

import { KlineReplayService } from '@/services/kline_replay/kline_replay_service';
import { REPLAY_INTERVALS } from '@/services/kline_replay/replay_types';
import { KlineReplayRepository } from '@/database/kline_replay_repository';

const args = process.argv.slice(2);
const SYMBOL = args.includes('--symbol') ? args[args.indexOf('--symbol') + 1] : 'BTCUSDT';
const KEEP = args.includes('--keep');

let failures = 0;

/** 断言 */
function check(ok: boolean, label: string, detail: unknown = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}`, detail === '' ? '' : detail);
}

/** 北京时间转毫秒 */
function bj(date: string): number {
  return new Date(`${date}+08:00`).getTime();
}

async function main(): Promise<void> {
  const s = KlineReplayService.get_instance();
  await s.init();
  const created: number[] = [];

  try {
    const coverage = await s.get_data_coverage();
    console.log('5m 数据覆盖:', coverage);

    // ---------- 1. 建会话 ----------
    const snap0 = await s.create_session({ symbol: SYMBOL, start_time: bj('2026-09-20T10:02:00'), initial_balance: 10000 });
    const id = snap0.session.id as number;
    created.push(id);
    check(snap0.session.cursor_time === bj('2026-09-20T10:00:00'), '起点对齐到所在 5m K线', snap0.current_bar);

    // ---------- 2. 游标视角K线 ----------
    for (const interval of ['5m', '15m', '1h', '4h']) {
      const bars = await s.get_klines(id, interval, 50);
      const last = bars[bars.length - 1];
      check(bars.length > 0 && last.open_time <= snap0.session.cursor_time, `${interval} 没有游标之后的K线`, {
        count: bars.length, last_open: new Date(last?.open_time).toISOString(), is_closed: last?.is_closed,
      });
      const sorted = bars.every((b, i) => i === 0 || b.open_time - bars[i - 1].open_time >= REPLAY_INTERVALS[interval]);
      check(sorted, `${interval} 升序且无重复`);
    }
    const h1 = await s.get_klines(id, '1h', 2);
    const m5 = await s.get_klines(id, '5m', 1);
    check(h1[h1.length - 1].close === m5[0].close && !h1[h1.length - 1].is_closed, '1h 当前K线未收盘且收盘价=游标5m收盘价');

    // ---------- 3. 按 1% 风险市价开多 ----------
    const price = snap0.current_bar.close;
    const r1 = await s.place_order(id, {
      side: 'buy', order_type: 'market', risk_pct: 1,
      stop_loss: price * 0.99, take_profit: price * 1.02, tags: ['verify'],
    });
    check(r1.order.status === 'filled' && r1.snapshot.position?.direction === 'long', '市价开多成交', {
      qty: r1.order.qty, price: r1.order.filled_price, risk: r1.snapshot.position?.risk_amount,
    });
    check(Math.abs((r1.snapshot.position?.risk_amount ?? 0) - 100) < 1, '计划风险≈权益1%(100U)');

    // ---------- 4. 下一步（带大周期） ----------
    const st1 = await s.step(id, { bars: 1, intervals: ['15m', '1h', '4h'] });
    check(st1.bars.length === 1 && st1.bars[0].open_time === snap0.session.cursor_time + 300000, '下一步揭示 1 根 5m', st1.bars[0]);
    check(['15m', '1h', '4h'].every(i => st1.interval_bars[i]?.length >= 1), '返回大周期当前K线', st1.interval_bars);

    // ---------- 5. 快进直到平仓 ----------
    const st2 = await s.step(id, { bars: 2000, stop_on: 'position_closed' });
    const closed = st2.events.find(e => e.type === 'position_closed');
    check(!!closed, '快进在平仓处停下', closed && (closed as any).position && {
      exit_reason: (closed as any).position.exit_reason, r: (closed as any).position.r_multiple, bars: st2.bars.length,
    });
    check(st2.snapshot.position === null, '平仓后无持仓');

    // ---------- 6. 挂空单（限价高于现价 0.3%）等成交 ----------
    const p2 = st2.snapshot.current_bar.close;
    const r2 = await s.place_order(id, {
      side: 'sell', order_type: 'limit', price: p2 * 1.003, notional: 2000,
      stop_loss: p2 * 1.013, take_profit: p2 * 0.99,
    });
    check(r2.order.status === 'pending', '限价空单挂单中', { price: r2.order.price, qty: r2.order.qty });
    const st3 = await s.step(id, { bars: 2000, stop_on: 'fill' });
    const fill = st3.events.find(e => e.type === 'fill');
    check(!!fill, '空单成交', fill && (fill as any).fill);

    // ---------- 7. 结束会话 + 统计 ----------
    const fin = await s.finish_session(id);
    check(fin.snapshot.session.status === 'finished' && fin.snapshot.position === null, '结束会话：已平仓撤单');
    const stats = await s.get_session_stats(id);
    console.log('会话统计:', stats.overall);
    const fills = await s.list_fills(id);
    check(fills.every(f => f.position_id > 0), '成交都关联到仓位', fills.length);
    const orders = await s.list_orders(id);
    check(orders.filter(o => o.status === 'filled').every(o => (o.position_id ?? 0) > 0), '成交委托都关联到仓位');

    // ---------- 8. 延迟落库 ----------
    const lazy = await s.create_session({ symbol: SYMBOL, start_time: bj('2026-09-21T10:00:00') });
    const lazy_id = lazy.session.id as number;
    created.push(lazy_id);
    const repo = new KlineReplayRepository();

    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await s.step(lazy_id, { bars: 1, intervals: ['1h'] });
    console.log(`   纯推进单步平均耗时: ${((Date.now() - t0) / 50).toFixed(1)} ms`);
    const mem_cursor = (await s.get_snapshot(lazy_id)).session.cursor_time;
    const db_before = await repo.get_session(lazy_id);
    check(db_before!.cursor_time < mem_cursor, '纯推进不立即落库（库里游标落后于内存）', {
      db: db_before!.cursor_time, mem: mem_cursor,
    });

    const r3 = await s.place_order(lazy_id, { side: 'buy', order_type: 'market', qty: 0.01 });
    const db_after_order = await repo.get_session(lazy_id);
    check(db_after_order!.cursor_time === mem_cursor && (await repo.get_open_position(lazy_id)) !== null,
      '下单立即落库（游标 + 仓位）', r3.order.status);

    for (let i = 0; i < 20; i++) await s.step(lazy_id, { bars: 1 });
    await s.list_positions(lazy_id);   // 读接口前会先落库
    const mem2 = await s.get_snapshot(lazy_id);
    const db_pos = await repo.get_open_position(lazy_id);
    check((await repo.get_session(lazy_id))!.cursor_time === mem2.session.cursor_time
      && db_pos!.max_favorable_price === mem2.position!.max_favorable_price,
      '读接口前落库（游标 + MFE 与内存一致）');

    for (let i = 0; i < 10; i++) await s.step(lazy_id, { bars: 1 });
    const mem3 = await s.get_snapshot(lazy_id);
    await s.shutdown();
    const fresh = new (KlineReplayService as any)() as KlineReplayService;   // 模拟进程重启
    const reloaded = await fresh.get_snapshot(lazy_id);
    check(reloaded.session.cursor_time === mem3.session.cursor_time
      && Math.abs(reloaded.equity - mem3.equity) < 1e-6
      && reloaded.position?.id === mem3.position?.id,
      'shutdown 落库后重新加载状态一致', { cursor: reloaded.session.cursor_time, equity: reloaded.equity });

    // ---------- 9. 跨数据空洞 ----------
    const first_gap = coverage.length > 1 ? coverage[0] : null;
    if (first_gap) {
      const end = first_gap.end_date;
      const gap_session = await s.create_session({
        symbol: SYMBOL,
        start_time: bj(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T23:50:00`),
      });
      created.push(gap_session.session.id as number);
      const g = await s.step(gap_session.session.id as number, { bars: 5 });
      const gap = g.events.find(e => e.type === 'gap');
      check(!!gap, `跨空洞步进（${end} 之后）产生 gap 事件`, gap);
    } else {
      console.log('（数据无空洞，跳过空洞测试）');
    }
  } finally {
    if (!KEEP) {
      for (const sid of created) await s.delete_session(sid);
      console.log(`已删除测试会话: ${created.join(', ')}`);
    }
  }

  console.log(failures === 0 ? '\n🎉 全部通过' : `\n⚠️ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
