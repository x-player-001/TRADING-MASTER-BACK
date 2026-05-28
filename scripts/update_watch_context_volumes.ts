/**
 * 更新观察区活跃币种的 24h 成交额
 *
 * 查询当前 WATCHING / ALERTED 状态的观察区记录，
 * 逐个调用币安 ticker/24hr 接口刷新 quote_volume_24h 字段。
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/update_watch_context_volumes.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { TrendFollowRepository } from '@/database/trend_follow_repository';

async function fetch_quote_volume(symbol: string): Promise<number | null> {
  try {
    const resp = await axios.get(
      `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`
    );
    return parseFloat(resp.data.quoteVolume) || null;
  } catch (err: any) {
    console.warn(`⚠️  ${symbol} 查询失败: ${err.message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const repo = new TrendFollowRepository();

  // 查询所有活跃观察区记录（WATCHING + ALERTED）
  const watching = await repo.get_watch_contexts({ state: 'WATCHING', limit: 1000 });
  const alerted  = await repo.get_watch_contexts({ state: 'ALERTED',  limit: 1000 });
  const contexts = [...watching, ...alerted];

  if (contexts.length === 0) {
    console.log('当前无活跃观察区记录');
    return;
  }

  console.log(`共 ${contexts.length} 条活跃记录，开始更新 24h 成交额...\n`);

  let updated = 0;
  let failed  = 0;

  for (const ctx of contexts) {
    if (!ctx.id) continue;

    const volume = await fetch_quote_volume(ctx.symbol);
    if (volume === null) {
      failed++;
      continue;
    }

    // 只更新 quote_volume_24h，其他字段保持不变
    await repo.update_watch_context(ctx.id, {
      symbol:               ctx.symbol,
      timeframe:            ctx.timeframe,
      state:                ctx.state,
      wave_start_price:     ctx.wave_start_price,
      wave_end_price:       ctx.wave_end_price,
      wave_amplitude_pct:   ctx.wave_amplitude_pct,
      wave_bar_count:       ctx.wave_bar_count,
      wave_avg_volume:      ctx.wave_avg_volume,
      wave_end_time:        ctx.wave_end_time,
      pullback_lowest_price: ctx.pullback_lowest_price,
      pullback_bar_count:   ctx.pullback_bar_count,
      pullback_avg_volume:  ctx.pullback_avg_volume,
      current_price:        ctx.current_price,
      quote_volume_24h:     volume,
      last_alert_level:     ctx.last_alert_level,
      watch_start_time:     ctx.watch_start_time,
      abandoned_reason:     ctx.abandoned_reason ?? null,
    });

    const vol_str = (volume / 1e6).toFixed(1) + 'M';
    console.log(`✅ ${ctx.symbol.padEnd(12)} ${ctx.timeframe.padEnd(4)} ${vol_str}`);
    updated++;

    // 避免触发频率限制，每次请求间隔 100ms
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n完成: 更新 ${updated} 条，失败 ${failed} 条`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
