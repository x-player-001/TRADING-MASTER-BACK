/**
 * 日线趋势线突破 每日任务（pm2 daily-breakout，cron 每天 08:10 北京时间 = 00:10 UTC）
 *
 * 币安日线 00:00 UTC 收盘后：
 *   1. 增量回填 kline_1d_agg（每币种只补最新几根，含成交额）
 *   2. 全市场扫描近 30 天突破，替换 daily_trendline_breakouts 窗口内事件
 *
 * 跑完即退出（pm2 autorestart=false，由 cron_restart 定时拉起）；重复执行幂等。
 *
 * ⚠️ 需在服务器执行（本机无法访问币安 API）
 *
 * 手动运行:
 *   npx ts-node -r tsconfig-paths/register scripts/run_daily_breakout_job.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { DailyBreakoutService } from '@/services/daily_breakout_service';
import { logger } from '@/utils/logger';

/** 主流程：回填 → 扫描入库 */
async function main(): Promise<void> {
  const started = Date.now();
  ConfigManager.getInstance().initialize();
  const service = new DailyBreakoutService();
  await service.init();

  logger.info('[DailyBreakoutJob] 开始增量回填日线');
  const backfill = await service.backfill_daily_klines();
  logger.info(`[DailyBreakoutJob] 回填完成: ${backfill.symbols} 币种，写入 ${backfill.rows} 根，失败 ${backfill.failed.length}` +
    (backfill.failed.length ? `（${backfill.failed.join(',')}）` : ''));

  logger.info('[DailyBreakoutJob] 开始扫描突破');
  const scan = await service.scan_breakouts({ save: true });
  const c = scan.counts;
  logger.info(`[DailyBreakoutJob] 扫描完成: ${scan.symbols} 币种，命中 ${scan.symbols_hit}，` +
    `已突破 ${c.breakout} / 回踩中 ${c.retest} / 已远离 ${c.extended} / 失败 ${c.failed}，扫描失败 ${scan.failed.length}，` +
    `耗时 ${Math.round((Date.now() - started) / 1000)} 秒`);
}

main()
  .catch(error => {
    logger.error('[DailyBreakoutJob] 任务异常:', error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
