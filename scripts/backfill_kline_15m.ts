/**
 * 15m K线数据补全脚本
 *
 * 功能:
 * - 从币安API拉取15m K线数据
 * - 写入分表 kline_15m_agg_YYYYMMDD
 * - 支持断点续传（跳过已有数据）
 *
 * 使用方法:
 * npx ts-node -r tsconfig-paths/register scripts/backfill_kline_15m.ts
 *
 * 可选参数:
 * --start 2026-06-04      起始日期（默认：3天前）
 * --end 2026-06-05        结束日期（默认：今天）
 * --symbols BTCUSDT,ETHUSDT  指定币种（默认：所有USDT永续合约）
 * --limit 200             每个币种拉取的K线数量（默认200）
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';

const CONFIG = {
  interval: '15m',
  interval_ms: 15 * 60 * 1000,
  batch_size: 1000,
  request_delay_ms: 300,          // 单任务请求间隔（并发5时约1500权重/分钟）
  retry_delay_ms: 30000,
  max_retries: 3,
  concurrency: 5,                 // 并发数
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function get_table_name(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `kline_15m_agg_${y}${m}${day}`;
}

function parse_args(): { start_time: number; end_time: number; symbols: string[] | null; limit: number; force: boolean } {
  const args = process.argv.slice(2);
  let start_time = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let end_time = Date.now();
  let symbols: string[] | null = null;
  let limit = 200;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      start_time = new Date(args[i + 1] + 'T00:00:00Z').getTime(); i++;
    } else if (args[i] === '--end' && args[i + 1]) {
      const s = args[i + 1], today = new Date().toISOString().slice(0, 10);
      end_time = s === today ? Date.now() : new Date(s + 'T23:59:59Z').getTime(); i++;
    } else if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map(s => s.trim().toUpperCase()); i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]); i++;
    } else if (args[i] === '--force') {
      // 强制模式：跳过"末尾续传"判断，直接拉取整个区间（INSERT IGNORE 去重，补中间空洞）
      force = true;
    }
  }
  return { start_time, end_time, symbols, limit, force };
}

async function get_all_symbols(): Promise<string[]> {
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
  return resp.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol as string);
}

async function ensure_table(conn: any, table: string): Promise<void> {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      open_time BIGINT NOT NULL,
      close_time BIGINT NOT NULL,
      open DECIMAL(20,8) NOT NULL,
      high DECIMAL(20,8) NOT NULL,
      low DECIMAL(20,8) NOT NULL,
      close DECIMAL(20,8) NOT NULL,
      volume DECIMAL(30,8) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_symbol_time (symbol, open_time),
      INDEX idx_open_time (open_time),
      INDEX idx_symbol (symbol)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function get_latest_15m_time(symbol: string, conn: any): Promise<number> {
  // 查今天和昨天分表的最新时间
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  for (const d of [today, yesterday]) {
    try {
      const [r] = await conn.execute(`SELECT MAX(open_time) t FROM kline_15m_agg_${d} WHERE symbol=?`, [symbol]);
      if (r[0].t) return Number(r[0].t);
    } catch (e) {}
  }
  return 0;
}

async function backfill_symbol(
  symbol: string,
  start_time: number,
  end_time: number,
  conn: any,
  force: boolean
): Promise<{ fetched: number; inserted: number }> {
  // 强制模式：拉取整个区间（补中间空洞）；普通模式：从库里最新时间续传（仅补末尾）
  let actual_start = start_time;
  if (!force) {
    const latest = await get_latest_15m_time(symbol, conn);
    actual_start = latest > start_time ? latest + CONFIG.interval_ms : start_time;
    if (actual_start >= end_time) return { fetched: -1, inserted: 0 }; // fetched=-1 表示跳过
  }
  let current = actual_start;
  let fetched = 0;     // 从 API 拉取的总根数
  let inserted = 0;    // 实际入库的总行数（去重后）

  while (current < end_time) {
    for (let retry = 0; retry < CONFIG.max_retries; retry++) {
      try {
        const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
          params: { symbol, interval: CONFIG.interval, startTime: current, endTime: end_time, limit: CONFIG.batch_size }
        });
        const data = resp.data;
        if (data.length === 0) { current = end_time; break; }

        // 按日期分组写入不同分表
        const by_table: Map<string, any[]> = new Map();
        for (const k of data) {
          const tbl = get_table_name(k[0]);
          if (!by_table.has(tbl)) by_table.set(tbl, []);
          by_table.get(tbl)!.push(k);
        }

        for (const [tbl, klines] of by_table) {
          await ensure_table(conn, tbl);
          const placeholders = klines.map(() => '(?,?,?,?,?,?,?,?)').join(',');
          const values: any[] = [];
          for (const k of klines) {
            values.push(symbol, k[0], k[6], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5]));
          }
          const [result] = await conn.execute(
            `INSERT IGNORE INTO ${tbl} (symbol,open_time,close_time,open,high,low,close,volume) VALUES ${placeholders}`,
            values
          );
          fetched += klines.length;
          // INSERT IGNORE 的 affectedRows 只统计实际插入的行（被去重忽略的不计）
          inserted += (result as any).affectedRows || 0;
        }

        current = data[data.length - 1][6] + 1;
        await sleep(CONFIG.request_delay_ms);
        break;
      } catch (err: any) {
        if (err.response?.status === 429) {
          console.warn(`  [限流] ${symbol} 等待 ${CONFIG.retry_delay_ms / 1000}s...`);
          await sleep(CONFIG.retry_delay_ms);
        } else if (retry === CONFIG.max_retries - 1) {
          throw err;
        } else {
          await sleep(2000);
        }
      }
    }
  }
  return { fetched, inserted };
}

async function main() {
  const { start_time, end_time, symbols: arg_symbols, force } = parse_args();

  ConfigManager.getInstance().initialize();

  const start_str = new Date(start_time).toISOString().slice(0, 16);
  const end_str   = new Date(end_time).toISOString().slice(0, 16);
  console.log(`\n📦 15m K线补全: ${start_str} ~ ${end_str}  并发=${CONFIG.concurrency}`);
  if (force) console.log(`🔁 强制模式: 全区间拉取，补中间空洞（INSERT IGNORE 去重）`);

  const symbols = arg_symbols ?? await get_all_symbols();
  console.log(`📋 共 ${symbols.length} 个合约\n`);

  let done = 0, skipped = 0, failed = 0, total_fetched = 0, total_inserted = 0;
  let processed = 0;
  const start_ts = Date.now();

  const queue = [...symbols];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (!symbol) break;
      const conn = await DatabaseConfig.get_mysql_connection();
      try {
        const { fetched, inserted } = await backfill_symbol(symbol, start_time, end_time, conn, force);
        processed++;
        if (fetched === -1) {
          skipped++;
        } else {
          done++;
          total_fetched += fetched;
          total_inserted += inserted;
          if (fetched > 0) {
            const dup = fetched - inserted;
            const dup_note = dup > 0 ? ` (去重${dup})` : '';
            console.log(`✅ [${processed}/${symbols.length}] ${symbol.padEnd(12)} 拉取${fetched} / 新增${inserted}${dup_note}`);
          }
        }
      } catch (err: any) {
        processed++;
        failed++;
        console.error(`❌ ${symbol}: ${err.message}`);
      } finally {
        conn.release();
      }
    }
  }

  // 启动并发工作线程
  const workers = Array.from({ length: CONFIG.concurrency }, () => worker());
  await Promise.all(workers);

  const elapsed = Math.round((Date.now() - start_ts) / 1000);
  console.log(`\n完成: 处理 ${done} 个，跳过 ${skipped} 个，失败 ${failed} 个 | API拉取 ${total_fetched} 根，实际入库 ${total_inserted} 根 (去重 ${total_fetched - total_inserted})，耗时 ${elapsed}s`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
