/**
 * 策略回测运行：读离线 5m 缓存 → 逐币运行策略 → 交易（含画图标注）写入 strategy_backtest_* 表，供 /api/strategy-backtest 查询
 *
 * ⚠️ 需在服务器执行（离线缓存在 /root/kline_cache/5m）；全市场约 10 分钟，按币种分批读取控制内存
 *
 * 用法:
 *   nice -n 19 npx ts-node -r tsconfig-paths/register scripts/run_strategy_backtest.ts --strategy=flag_third_push \
 *     [--from=20251214] [--to=20261001] [--symbols=BTCUSDT,ETHUSDT] [--params='{"lows_mode":"flat"}'] \
 *     [--note=说明] [--cache=/root/kline_cache/5m] [--batch=120] [--dry-run]
 *   删除某次运行: --delete-run=<id>
 *   列出可用策略: --list
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { StrategyBacktestRepository } from '@/database/strategy_backtest_repository';
import { iterate_kline_series, list_cache_files, beijing_day_start } from '@/services/strategy_backtest/kline_cache_loader';
import { aggregate_series } from '@/services/strategy_backtest/series_utils';
import { compute_full_stats, StatTrade } from '@/services/strategy_backtest/backtest_stats';
import { get_strategy, list_strategies } from '@/services/strategy_backtest/strategy_registry';
import { BacktestTrade } from '@/services/strategy_backtest/backtest_types';

/** 解析 --key=value 参数 */
function parse_args(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return out;
}

/** 主流程 */
async function main(): Promise<void> {
  const args = parse_args();
  ConfigManager.getInstance().initialize();
  const repo = new StrategyBacktestRepository();

  if (args.list) {
    for (const s of list_strategies()) console.log(`${s.id}  v${s.version}  ${s.timeframe}  ${s.name}`);
    return;
  }
  if (args['delete-run']) {
    await repo.delete_run(Number(args['delete-run']));
    console.log(`已删除运行 ${args['delete-run']}`);
    return;
  }

  const strategy = get_strategy(args.strategy || '');
  if (!strategy) throw new Error(`未知策略 ${args.strategy}，可用: ${list_strategies().map(s => s.id).join(', ')}`);
  const cache_dir = args.cache || '/root/kline_cache/5m';
  const all_files = list_cache_files(cache_dir, '00000000', '99999999');
  if (!all_files.length) throw new Error(`缓存目录无数据: ${cache_dir}`);
  const from_day = args.from || all_files[0].slice(0, 8);
  const to_day = args.to || all_files[all_files.length - 1].slice(0, 8);
  const params = { ...strategy.default_params, ...(args.params ? JSON.parse(args.params) : {}) };
  const dry = args['dry-run'] === 'true';
  const started = Date.now();

  let run_id = 0;
  if (!dry) {
    await repo.init_tables();
    run_id = await repo.create_run({
      strategy_id: strategy.id, strategy_name: strategy.name, strategy_version: strategy.version, timeframe: strategy.timeframe,
      params, data_from: beijing_day_start(from_day), data_to: beijing_day_start(to_day) + 86_400_000 - 1, note: args.note || null,
    });
  }
  console.log(`策略 ${strategy.id} v${strategy.version}  数据 ${from_day}~${to_day}  ${dry ? '（试运行，不写库）' : `运行 #${run_id}`}`);

  const closed: StatTrade[] = [];
  let symbols = 0, signals = 0;
  try {
    const iter = iterate_kline_series({
      cache_dir, from_day, to_day,
      symbols: args.symbols ? args.symbols.split(',').map(s => s.trim().toUpperCase()) : undefined,
      batch_size: args.batch ? Number(args.batch) : undefined,
      on_progress: msg => console.log(`  ${msg}  已处理 ${symbols} 币种 / 信号 ${signals}  ${Math.round((Date.now() - started) / 1000)}s`),
    });
    for (const s5 of iter) {
      const series = aggregate_series(s5, strategy.timeframe);
      const trades: BacktestTrade[] = strategy.run(series, params);
      symbols++;
      signals += trades.length;
      for (const t of trades) {
        if (t.status === 'closed' && t.pnl !== null && t.exit_time !== null) {
          closed.push({ symbol: t.symbol, exit_time: t.exit_time, exit_reason: t.exit_reason, pnl: t.pnl, r_multiple: t.r_multiple });
        }
      }
      if (!dry && trades.length) await repo.insert_trades(run_id, trades);
    }

    const stats = compute_full_stats(closed);
    if (!dry) await repo.finish_run(run_id, { status: 'done', symbols_total: symbols, trade_count: closed.length, signal_count: signals, summary: stats });
    const s = stats.summary;
    console.log(`完成：${symbols} 币种，信号 ${signals}，成交 ${s.trades}，胜率 ${(s.win_rate * 100).toFixed(1)}%，` +
      `每笔 ${s.avg_pnl.toFixed(3)}U，合计 ${s.total_pnl.toFixed(1)}U，t=${s.t_stat}，最大回撤 ${s.max_drawdown.toFixed(1)}U，耗时 ${Math.round((Date.now() - started) / 1000)}s`);
    for (const g of stats.by_exit_reason) console.log(`  ${g.key.padEnd(12)} ${String(g.trades).padStart(5)} 笔  每笔 ${g.avg_pnl.toFixed(3)}U`);
  } catch (error: any) {
    if (!dry) await repo.finish_run(run_id, { status: 'failed', symbols_total: symbols, trade_count: closed.length, signal_count: signals, summary: null, error: String(error?.stack || error) });
    throw error;
  }
}

main()
  .catch(error => {
    console.error('回测失败:', error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
