/**
 * 实盘控制开关 / 状态查看
 *
 *   查看:      npx ts-node -r tsconfig-paths/register scripts/live_control.ts
 *   暂停开仓:  ... --mode=paused     （已有持仓照常管理：止损止盈、到时平仓）
 *   恢复:      ... --mode=running
 *   一键平仓:  ... --mode=flatten    （撤全部入场单、市价平全部持仓，完成后自动转 paused）
 *   人工处理完 error 交易后标记结束: ... --resolve=<id> --as=closed|cancelled --note="说明"
 *
 * live 进程每 15 秒读取一次开关。
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { LiveTradingRepository } from '@/database/live_trading_repository';
import { LiveControlMode } from '@/services/live_trading/live_types';

function arg(name: string): string | undefined {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  ConfigManager.getInstance().initialize();
  const repo = new LiveTradingRepository();
  await repo.init_tables();

  const mode = arg('mode');
  if (mode) {
    if (!['running', 'paused', 'flatten'].includes(mode)) throw new Error(`无效 mode: ${mode}`);
    await repo.set_control(mode as LiveControlMode, arg('note') ?? 'cli');
    console.log(`✅ 控制开关已设为 ${mode}（live 进程 15 秒内生效）`);
  }

  const resolve = arg('resolve');
  if (resolve) {
    const as = arg('as');
    if (as !== 'closed' && as !== 'cancelled') throw new Error('--as 必须为 closed 或 cancelled');
    const n = await repo.resolve_error_trade(Number(resolve), as, arg('note') ?? 'manual');
    console.log(n ? `✅ 交易 #${resolve} 已标记为 ${as}（重启 live 进程后解除开仓禁止）` : `⚠️ 交易 #${resolve} 不是 error 状态`);
  }

  const control = await repo.get_control();
  const status = await repo.get_runtime_status();
  const active = await repo.list_trades({ status: ['placing', 'pending', 'entering', 'open', 'closing', 'error'], limit: 50 });
  const recent = await repo.list_trades({ status: ['closed'], limit: 10 });
  const bj = (ts: number | null) => ts ? new Date(ts + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : '-';

  console.log(`\n控制开关: ${control}`);
  if (status) {
    const age = Math.round((Date.now() - status.heartbeat_at) / 1000);
    console.log(`进程: ${status.mode}  心跳 ${age}s 前  行情WS ${status.market_ws ? '✅' : '❌'}  用户流 ${status.user_ws ? '✅' : '❌'}  ` +
      `余额 ${status.balance?.toFixed(2) ?? '-'}  可用 ${status.available?.toFixed(2) ?? '-'}  进行中 ${status.active_trades}  待处理 ${status.error_trades}`);
  }
  console.log(`\n进行中 / 待处理（${active.total}）:`);
  for (const t of active.rows) {
    console.log(`  #${t.id} ${t.strategy_id} ${t.symbol} ${t.status}  触发 ${t.entry_trigger} 止损 ${t.stop_price} 止盈 ${t.take_profit ?? '-'}  ` +
      `成交 ${t.filled_qty ?? '-'} @ ${t.fill_price ?? '-'}  ${t.error_msg ?? ''}`);
  }
  console.log(`\n最近平仓:`);
  for (const t of recent.rows) {
    console.log(`  #${t.id} ${t.strategy_id} ${t.symbol} ${bj(t.exit_time)} ${t.exit_reason}  净 ${t.pnl?.toFixed(2)}U  ${t.r_multiple?.toFixed(2)}R  手续费 ${t.fees?.toFixed(3)}`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
