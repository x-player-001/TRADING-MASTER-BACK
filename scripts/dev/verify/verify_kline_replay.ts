/**
 * K线回放 + 模拟交易 端到端验证（连真实数据库，需在服务器执行）
 *
 * 模拟前端流程：建会话 → 拉历史K线 → 拉 5m 批量块 → ReplayAccount 本地逐根撮合
 *   → 同步（整份替换 / 过期 revision / 只同步进度）→ 从后端状态恢复账户继续交易 → 结束 → 统计；
 *   另测跨 5m 数据空洞的批量块。默认跑完删除测试会话，加 --keep 保留。
 *
 * npx ts-node -r tsconfig-paths/register scripts/dev/verify/verify_kline_replay.ts [--symbol BTCUSDT] [--keep]
 */

import dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '@/core/config/config_manager';
ConfigManager.getInstance().initialize();

import { KlineReplayService, ReplayError } from '@/services/kline_replay/kline_replay_service';
import { ReplayAccount } from '@/services/kline_replay/replay_account';
import { ReplayBar, REPLAY_BASE_INTERVAL_MS } from '@/services/kline_replay/replay_types';

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

    // ---------- 1. 建会话 + 历史K线 ----------
    const init = await s.create_session({ symbol: SYMBOL, start_time: bj('2026-09-20T10:02:00') });
    const session = init.session;
    const id = session.id as number;
    created.push(id);
    check(session.start_time === bj('2026-09-20T10:00:00') && init.cursor_bar?.open_time === session.start_time, '起点对齐到所在 5m K线');

    for (const interval of ['5m', '15m', '1h', '4h']) {
      const bars = await s.get_klines(id, interval, undefined, 50);
      const last = bars[bars.length - 1];
      check(bars.length > 0 && last.open_time <= session.start_time, `${interval} 历史不含起点之后的K线`, {
        count: bars.length, last_closed: last?.is_closed,
      });
    }

    // ---------- 2. 5m 批量块 ----------
    const chunk = await s.get_bars(id, undefined, 600);
    check(chunk.bars.length === 600 && chunk.bars[0].open_time === session.start_time + REPLAY_BASE_INTERVAL_MS, '批量块从起点下一根开始', {
      count: chunk.bars.length, end_of_data: chunk.end_of_data,
    });
    const next_chunk = await s.get_bars(id, chunk.bars[chunk.bars.length - 1].open_time, 10);
    check(next_chunk.bars[0].open_time > chunk.bars[chunk.bars.length - 1].open_time, '下一块紧接上一块');

    // ---------- 3. 前端本地撮合 ----------
    const account = new ReplayAccount(session);
    let cursor: ReplayBar = init.cursor_bar as ReplayBar;
    let stepped = 0;
    const bars = [...chunk.bars];
    const reveal = (): ReplayBar => {
      const bar = bars.shift() as ReplayBar;
      account.process_bar(bar);
      cursor = bar;
      stepped++;
      return bar;
    };

    // 1% 风险开多
    const stop = cursor.close * 0.99;
    const qty = account.get_equity(cursor.close) * 0.01 / (cursor.close - stop);
    const long = account.submit_order({ side: 'buy', order_type: 'market', qty, stop_loss: stop, take_profit: cursor.close * 1.02, tags: ['verify'] }, cursor);
    check(long.order.status === 'filled', '本地市价开多成交');
    while (account.state.position && bars.length > 0) reveal();
    const first = [...account.positions.values()][0];
    check(first.status === 'closed', '本地逐根推进直到平仓', { exit: first.exit_reason, r: first.r_multiple, bars: stepped });

    // 挂限价空单等成交
    const short = account.submit_order({
      side: 'sell', order_type: 'limit', qty: 2000 / cursor.close, price: cursor.close * 1.003,
      stop_loss: cursor.close * 1.013, take_profit: cursor.close * 0.99,
    }, cursor);
    while (short.order.status === 'pending' && bars.length > 0) reveal();
    check(short.order.status === 'filled', '本地限价空单成交');

    // ---------- 4. 同步 ----------
    const progress = () => ({ cursor_time: cursor.open_time, last_price: cursor.close, bars_stepped: stepped, status: 'active' as const });
    await s.sync(id, account.to_sync_payload(progress(), 1));
    let stale_ok = false;
    try {
      await s.sync(id, account.to_sync_payload(progress(), 1));
    } catch (e) {
      stale_ok = e instanceof ReplayError && e.status_code === 409;
    }
    check(stale_ok, '重复 revision 被拒（409）');

    for (let i = 0; i < 3; i++) reveal();
    await s.sync(id, { revision: 2, progress: { ...progress(), balance: account.state.balance } });   // 只同步进度

    // ---------- 5. 从后端恢复 ----------
    const state = await s.get_state(id);
    check(state.session.cursor_time === cursor.open_time && state.session.sync_revision === 2, '进度已落库', {
      cursor: state.session.cursor_time, revision: state.session.sync_revision,
    });
    check(state.positions.length === account.positions.size && state.fills.length === account.fills.length
      && state.orders.length === account.orders.size, '交易记录条数一致', {
      positions: state.positions.length, orders: state.orders.length, fills: state.fills.length,
    });
    check(state.fills.every(f => f.position_id! > 0) && state.orders.filter(o => o.status === 'filled').every(o => o.position_id! > 0),
      'client_id 关联已换算成数据库 id');

    const restored = new ReplayAccount(state.session, state);
    check(restored.state.position?.client_id === account.state.position?.client_id, '恢复后持仓一致', restored.state.position?.direction);

    // 恢复后继续推进到平仓，然后结束
    while (restored.state.position && bars.length > 0) {
      const bar = bars.shift() as ReplayBar;
      restored.process_bar(bar);
      cursor = bar;
      stepped++;
    }
    restored.finish(cursor);
    await s.sync(id, restored.to_sync_payload({ ...progress(), status: 'finished' }, 3));
    const final = await s.get_state(id);
    check(final.session.status === 'finished' && final.session.finished_at !== null, '结束会话已落库');
    check(final.positions.every(p => p.status === 'closed'), '全部仓位已平');

    // ---------- 6. 统计 ----------
    const stats = await s.get_session_stats(id);
    console.log('会话统计:', {
      trades: stats.overall.trade_count, win_rate: stats.overall.win_rate, avg_r: stats.overall.avg_r,
      net: stats.overall.total_net_pnl, by_tag: Object.keys(stats.by_tag),
    });
    check(stats.overall.trade_count === final.positions.length, '统计回合数一致');
    const overall = await s.get_overall_stats({ session_ids: [id], tag: 'verify' });
    check(overall.overall.trade_count === 1, '跨会话统计按标签过滤', overall.overall.trade_count);

    // ---------- 7. 跨数据空洞 ----------
    if (coverage.length > 1) {
      const end = coverage[0].end_date;
      const gap_session = await s.create_session({
        symbol: SYMBOL,
        start_time: bj(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T23:50:00`),
      });
      created.push(gap_session.session.id as number);
      const g = await s.get_bars(gap_session.session.id as number, undefined, 5);
      // 起点会对齐到空洞前最后一根，空洞可能就在「起点 → 第一根」之间
      const times = [gap_session.session.start_time, ...g.bars.map(b => b.open_time)];
      const jump = times.some((t, i) => i > 0 && t - times[i - 1] > REPLAY_BASE_INTERVAL_MS);
      check(g.bars.length === 5 && jump, `批量块跨过 ${end} 之后的空洞`, times.map(t => new Date(t + 8 * 3600000).toISOString().slice(0, 16)));
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
