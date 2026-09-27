/**
 * 日线K线回填脚本（写入 kline_1d_agg，供日线趋势线突破扫描使用）
 *
 * - 无数据的币种：拉取 --limit 根（默认 1000，约 2.7 年，权重 5）
 * - 已有数据的币种：只拉最近若干根增量（limit < 100，权重 1）
 * - --full：忽略已有数据，每个币种都拉 --limit 根（补历史字段用，如 quote_volume）
 * - 只写已收盘日线，已存在则覆盖
 * - 限速：并发 2 + 请求间隔 500ms，全市场首次回填约 1200 权重/分钟
 *
 * 每日例行回填已由 scripts/run_daily_breakout_job.ts（pm2 daily-breakout）完成，本脚本用于手动补数
 *
 * ⚠️ 需在服务器执行（本机无法访问币安 API）
 *
 * 使用:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_kline_1d.ts
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_kline_1d.ts --symbols RUNEUSDT,QNTUSDT --limit 1500
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { DailyBreakoutService } from '@/services/daily_breakout_service';

/** 解析命令行参数 */
function parse_args(): { symbols: string[] | null; limit: number; full: boolean } {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    symbols: get('--symbols')?.split(',').map(s => s.trim().toUpperCase()) ?? null,
    limit: Number(get('--limit') ?? 1000),
    full: argv.includes('--full'),
  };
}

/** 主流程 */
async function main(): Promise<void> {
  const args = parse_args();
  ConfigManager.getInstance().initialize();
  const service = new DailyBreakoutService();
  await service.init();

  console.log(`日线回填: 首次拉取 ${args.limit} 根${args.full ? '（--full 全部重拉）' : ''}`);
  const result = await service.backfill_daily_klines({ ...args, on_progress: line => console.log(line) });
  console.log(`完成: ${result.symbols} 个币种，写入 ${result.rows} 根，失败 ${result.failed.length} 个币种` +
    (result.failed.length ? `（${result.failed.join(',')}）` : ''));
}

main()
  .catch(error => {
    console.error('日线回填异常:', error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
