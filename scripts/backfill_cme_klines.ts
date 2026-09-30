/**
 * CME 期货K线回填（Databento 连续合约 1m → 5m / 15m / 1h / 4h，写入 cme_klines）
 *
 * 首次按 --days 拉取；之后再跑为增量（从最新一根所在的 4h 桶起重拉），重复执行幂等。
 * 不访问币安，本机和服务器都可执行；需 .env 配置 DATABENTO_API_KEY。
 *
 * 用法:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_cme_klines.ts
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_cme_klines.ts --symbols ES,GC --days 365
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_cme_klines.ts --symbols GC --force --max-cost 3
 *
 * 参数:
 *   --symbols   品种根代码，逗号分隔（默认 ES,GC）
 *   --days      首次 / --force 时拉取的天数（默认 365）
 *   --force     忽略已有数据，按 --days 整段重拉
 *   --max-cost  单品种预估费用上限，美元（默认 5）
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { CmeKlineService } from '@/services/cme_kline_service';
import { logger } from '@/utils/logger';

/** 读取命令行参数值 */
function arg_value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 主流程：逐品种回填，最后打印概况 */
async function main(): Promise<void> {
  const symbols = (arg_value('symbols') ?? 'ES,GC').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const options = {
    days: Number(arg_value('days') ?? 365),
    force: process.argv.includes('--force'),
    max_cost: Number(arg_value('max-cost') ?? 5),
  };

  ConfigManager.getInstance().initialize();
  const service = new CmeKlineService();
  await service.init();

  for (const symbol of symbols) {
    try {
      const r = await service.backfill(symbol, options);
      const written = Object.entries(r.written).map(([k, v]) => `${k}=${v}`).join(' ');
      logger.info(`[CmeKline] ${symbol} 完成：1m ${r.bars_1m} 根 → ${written || '无新数据'}，` +
        `费用约 $${r.cost.toFixed(4)}，合约 ${r.contracts.join(',') || '-'}`);
    } catch (error: any) {
      logger.error(`[CmeKline] ${symbol} 回填失败: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }

  for (const s of await service.get_summary()) {
    const fmt = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    logger.info(`[CmeKline] ${s.symbol} ${s.interval.padEnd(3)} ${String(s.count).padStart(6)} 根  ${fmt(s.first_time)} ~ ${fmt(s.last_time)} UTC`);
  }
}

main()
  .catch(error => {
    logger.error('[CmeKline] 任务异常:', error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
