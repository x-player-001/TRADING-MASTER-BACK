/**
 * K线回放 CME 期货（ES / GC）端到端验证
 *
 * 走 KlineReplayService 全流程：建会话（周末起点对齐）→ 历史K线 → 前向 5m 批量（跨周末、换月）
 * → 未收盘大周期聚合与入库K线一致 → 本地撮合 1 手 → 同步 → 统计 → 删除会话。
 * 不访问币安，本机可跑（写入并删除一个临时会话）。
 *
 *   npx ts-node -r tsconfig-paths/register scripts/dev/verify/verify_kline_replay_cme.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { CME_CONTRACTS } from '@/core/config/cme_contracts';
import { CmeKlineRepository } from '@/database/cme_kline_repository';
import { KlineReplayService } from '@/services/kline_replay/kline_replay_service';
import { ReplayAccount } from '@/services/kline_replay/replay_account';

let failures = 0;

/** 断言 */
function check(ok: boolean, message: string): void {
  console.log(`${ok ? '✅' : '❌'} ${message}`);
  if (!ok) failures++;
}

/** UTC 时间 */
function fmt(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

async function main(): Promise<void> {
  ConfigManager.getInstance().initialize();
  const service = KlineReplayService.get_instance();
  await service.init();
  const cme_repo = new CmeKlineRepository();

  const contracts = await service.list_cme_contracts();
  check(contracts.length === 2 && contracts.every(c => c.first_time !== null), `cme-contracts: ${contracts.map(c => `${c.symbol}(${c.first_time && fmt(c.first_time)}~)`).join(' ')}`);
  const coverage = await service.get_data_coverage('ES');
  check(coverage.length === 1, `data-coverage ES: ${JSON.stringify(coverage)}`);

  // 周六起点 → 对齐到周五最后一根
  const state = await service.create_session({ symbol: 'es', start_time: Date.parse('2026-03-14T12:00:00Z'), name: 'verify-cme' });
  const session = state.session;
  const id = session.id as number;
  try {
    check(new Date(session.start_time).getUTCDay() === 5, `起点对齐到周五: ${fmt(session.start_time)}，合约 ${state.cursor_bar?.contract}`);
    check(session.leverage === CME_CONTRACTS.ES.default_leverage && session.taker_fee_rate === CME_CONTRACTS.ES.default_fee_rate && session.initial_balance === CME_CONTRACTS.ES.default_balance,
      `默认资金 ${session.initial_balance}、杠杆 ${session.leverage}、费率 ${session.taker_fee_rate}`);

    // 历史K线：按根数取满（跨休市/周末）
    for (const interval of ['5m', '15m', '1h', '4h']) {
      const bars = await service.get_klines(id, interval, undefined, 300);
      const sorted = bars.every((b, i) => i === 0 || b.open_time > bars[i - 1].open_time);
      check(bars.length === 300 && sorted, `klines ${interval}: ${bars.length} 根，${fmt(bars[0].open_time)} ~ ${fmt(bars[bars.length - 1].open_time)}`);
    }

    // 前向 5m：跨周末 + 换月（ESH6 → ESM6 在 2026-03-18）
    const { bars, end_of_data } = await service.get_bars(id, undefined, 2000);
    const max_gap_h = Math.max(...bars.slice(1).map((b, i) => b.open_time - bars[i].open_time)) / 3600_000;
    const rolls = bars.slice(1).filter((b, i) => b.contract !== bars[i].contract).map(b => `${fmt(b.open_time)} → ${b.contract}`);
    check(bars.length === 2000 && !end_of_data && bars[0].open_time > session.start_time, `bars: ${bars.length} 根，首根 ${fmt(bars[0].open_time)}，最大间隔 ${max_gap_h.toFixed(1)}h`);
    check(rolls.length === 1 && rolls[0].includes('ESM6'), `换月: ${rolls.join(', ')}`);

    // 游标在某小时最后一根 5m：未收盘聚合出的 1h 应已收盘且与入库 1h 一致
    const hour_last = bars.find(b => new Date(b.open_time).getUTCMinutes() === 55 && b.open_time > bars[300].open_time)!;
    const live = (await service.get_klines(id, '1h', hour_last.open_time, 3)).pop()!;
    const [stored] = await cme_repo.get_klines('ES', '1h', live.open_time, live.open_time);
    check(live.is_closed && stored && live.open === stored.open && live.high === stored.high && live.low === stored.low
      && live.close === stored.close && live.volume === stored.volume, `5m 聚合 1h 与入库一致 @ ${fmt(live.open_time)}`);
    const mid = bars.find(b => new Date(b.open_time).getUTCMinutes() === 20)!;
    check((await service.get_klines(id, '1h', mid.open_time, 2)).pop()!.is_closed === false, `小时中途的 1h 标记为未收盘 @ ${fmt(mid.open_time)}`);

    // 本地撮合：买 1 手（qty = 乘数），推进 100 根后平仓，盈亏 = 价差 × 50
    const account = new ReplayAccount(session, { positions: [], orders: [], fills: [] });
    let cursor = state.cursor_bar!;
    account.submit_order({ side: 'buy', order_type: 'market', qty: CME_CONTRACTS.ES.multiplier, stop_loss: cursor.close - 50 }, cursor);
    for (const bar of bars.slice(0, 100)) {
      account.process_bar(bar);
      cursor = bar;
    }
    if (account.state.position) account.close_position(cursor);
    const order = [...account.orders.values()][0];
    check(order.status === 'filled', `开仓单状态 ${order.status}${order.reject_reason ? '：' + order.reject_reason : ''}`);
    const pos = [...account.positions.values()][0];
    const expected = ((pos.avg_exit_price as number) - pos.avg_entry_price) * CME_CONTRACTS.ES.multiplier;
    check(Math.abs(pos.realized_pnl - expected) < 1e-6, `1 手 ES：${pos.avg_entry_price} → ${pos.avg_exit_price}（${pos.exit_reason}），毛盈亏 $${pos.realized_pnl.toFixed(2)}，手续费 $${pos.fee_total.toFixed(2)}`);

    await service.sync(id, account.to_sync_payload(
      { cursor_time: cursor.open_time, last_price: cursor.close, bars_stepped: 100, status: 'active' }, 1));
    const stats = await service.get_session_stats(id);
    check(stats.overall.trade_count === 1 && Math.abs(stats.overall.total_net_pnl - pos.net_pnl) < 1e-4, `同步 + 统计：净盈亏 $${stats.overall.total_net_pnl.toFixed(2)}`);
  } finally {
    await service.delete_session(id);
    console.log(`已删除临时会话 #${id}`);
  }
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
}

main()
  .catch(error => {
    console.error(error);
    failures++;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit(failures ? 1 : 0)));
