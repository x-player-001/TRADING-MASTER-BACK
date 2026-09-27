/**
 * 日线K线回填脚本（写入 kline_1d_agg，供日线趋势线突破扫描使用）
 *
 * - 无数据的币种：拉取 --limit 根（默认 1000，约 2.7 年，权重 5）
 * - 已有数据的币种：只拉最近若干根增量（limit < 100，权重 1）
 * - --full：忽略已有数据，每个币种都拉 --limit 根（补历史字段用，如 quote_volume）
 * - 只写已收盘日线，已存在则覆盖
 * - 限速：并发 2 + 请求间隔 500ms，全市场首次回填约 1200 权重/分钟
 *
 * ⚠️ 需在服务器执行（本机无法访问币安 API）
 *
 * 使用:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_kline_1d.ts
 *   npx ts-node -r tsconfig-paths/register scripts/backfill_kline_1d.ts --symbols RUNEUSDT,QNTUSDT --limit 1500
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { DailyBreakoutRepository, DailyKlineRow } from '@/database/daily_breakout_repository';

const DAY_MS = 86_400_000;

const CONFIG = {
  concurrency: 2,
  request_delay_ms: 500,
  retry_delay_ms: 30_000,   // 429 后等待
  max_retries: 3,
};

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

/** 解析命令行参数 */
function parse_args(): { symbols: string[] | null; limit: number; full: boolean } {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    symbols: get('--symbols')?.split(',').map(s => s.trim().toUpperCase()) ?? null,
    limit: Math.min(1500, Math.max(1, Number(get('--limit') ?? 1000))),
    full: argv.includes('--full'),
  };
}

/** 获取所有交易中的 USDT 永续合约 */
async function get_all_symbols(): Promise<string[]> {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', { timeout: 30_000, headers: REQUEST_HEADERS });
  return res.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol);
}

/** 拉取日线（带重试），只返回已收盘的K线 */
async function fetch_daily_klines(symbol: string, limit: number): Promise<DailyKlineRow[]> {
  for (let retry = 0; ; retry++) {
    try {
      const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol, interval: '1d', limit },
        headers: REQUEST_HEADERS,
        timeout: 30_000,
      });
      const now = Date.now();
      return res.data
        .filter((k: any[]) => k[6] < now)
        .map((k: any[]) => ({
          symbol,
          open_time: k[0],
          close_time: k[6],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          quote_volume: parseFloat(k[7]),
        }));
    } catch (error: any) {
      if (retry >= CONFIG.max_retries - 1) throw error;
      const is_rate_limit = error.response?.status === 429 || error.response?.status === 418;
      await sleep(is_rate_limit ? CONFIG.retry_delay_ms : 1000 * (retry + 1));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 主流程 */
async function main(): Promise<void> {
  const { symbols: specified, limit, full } = parse_args();
  ConfigManager.getInstance().initialize();
  const repo = new DailyBreakoutRepository();
  await repo.init_tables();

  const symbols = specified ?? await get_all_symbols();
  console.log(`日线回填: ${symbols.length} 个币种，首次拉取 ${limit} 根`);

  const stats = { done: 0, rows: 0, failed: 0 };
  const queue = [...symbols];

  /** 单个并发 worker：取队列逐个回填 */
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const symbol = queue.shift()!;
      const progress = `[${++stats.done}/${symbols.length}]`;
      try {
        const latest = full ? null : await repo.get_latest_daily_time(symbol);
        // 增量：从最新一根（可能是之前的未收盘数据）起补齐，多拉 2 根冗余
        const n = latest === null ? limit : Math.min(limit, Math.ceil((Date.now() - latest) / DAY_MS) + 2);
        const rows = await fetch_daily_klines(symbol, n);
        await repo.upsert_daily_klines(rows);
        stats.rows += rows.length;
        console.log(`${progress} ${symbol.padEnd(14)} ${rows.length} 根${latest === null ? '（首次）' : ''}`);
      } catch (error: any) {
        stats.failed++;
        console.error(`${progress} ${symbol.padEnd(14)} 失败: ${error.message}`);
      }
      await sleep(CONFIG.request_delay_ms);
    }
  }

  await Promise.all(Array.from({ length: CONFIG.concurrency }, () => worker()));
  console.log(`完成: 写入 ${stats.rows} 根，失败 ${stats.failed} 个币种`);
}

main()
  .catch(error => {
    console.error('日线回填异常:', error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
