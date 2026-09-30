/**
 * 由库中 5m 生成 15m / 1h / 4h 聚合K线（补数据空洞后用）
 *
 * 读 kline_5m_YYYYMMDD，按时间顺序喂给 KlineAggregator.process_5m_kline，
 * 与线上 WS 落库走同一聚合逻辑，写入 kline_15m_agg_YYYYMMDD / kline_1h_agg / kline_4h_agg（INSERT IGNORE，可重复执行）。
 * 只访问数据库，本机和服务器都可执行。先用 backfill_kline_5m.ts 补好 5m 再跑本脚本。
 *
 * 用法:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_kline_agg_from_5m.ts \
 *     --start 2026-02-08 --end 2026-05-26 --symbols BTCUSDT,ETHUSDT
 *
 * 参数:
 *   --start / --end  UTC 日期（含两端），起点按 UTC 零点对齐，保证 4h 桶完整
 *   --symbols        币种，逗号分隔（必填）
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { Kline5mRepository } from '@/database/kline_5m_repository';
import { KlineAggregator } from '@/core/data/kline_aggregator';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 读取命令行参数值 */
function arg_value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 主流程：逐币种逐天读 5m → 聚合 → 刷盘 */
async function main(): Promise<void> {
  const start_arg = arg_value('start');
  const end_arg = arg_value('end');
  const symbols = (arg_value('symbols') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!start_arg || !end_arg || symbols.length === 0) {
    throw new Error('需要 --start、--end、--symbols');
  }
  const start = Date.parse(`${start_arg}T00:00:00Z`);
  const end = Date.parse(`${end_arg}T00:00:00Z`) + ONE_DAY_MS - 1;

  ConfigManager.getInstance().initialize();
  const repo = new Kline5mRepository();
  repo.stop_flush_timer();
  const aggregator = new KlineAggregator();
  aggregator.stop_flush_timer();

  for (const symbol of symbols) {
    const counts: Record<string, number> = { '5m': 0, '15m': 0, '1h': 0, '4h': 0 };
    for (let day = start; day <= end; day += ONE_DAY_MS) {
      const bars = await repo.get_klines_by_time_range(symbol, day, Math.min(day + ONE_DAY_MS - 1, end));
      for (const bar of bars) {
        for (const agg of aggregator.process_5m_kline(bar)) counts[agg.interval]++;
      }
      counts['5m'] += bars.length;
    }
    await aggregator.flush();
    console.log(`${symbol.padEnd(12)} 5m ${counts['5m']} → 15m ${counts['15m']} / 1h ${counts['1h']} / 4h ${counts['4h']}`);
  }
}

main()
  .catch(error => {
    console.error('❌ 失败:', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
