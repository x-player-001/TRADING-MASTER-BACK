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
  request_delay_ms: 500,
  retry_delay_ms: 30000,
  max_retries: 3,
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function get_table_name(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `kline_15m_agg_${y}${m}${day}`;
}

function parse_args(): { start_time: number; end_time: number; symbols: string[] | null; limit: number } {
  const args = process.argv.slice(2);
  let start_time = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let end_time = Date.now();
  let symbols: string[] | null = null;
  let limit = 200;

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
    }
  }
  return { start_time, end_time, symbols, limit };
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

async function backfill_symbol(
  symbol: string,
  start_time: number,
  end_time: number,
  limit: number,
  conn: any
): Promise<number> {
  // 计算实际起始时间：从 end_time 往前推 limit 根
  const actual_start = Math.max(start_time, end_time - limit * CONFIG.interval_ms);
  let current = actual_start;
  let total = 0;

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
          await conn.execute(
            `INSERT IGNORE INTO ${tbl} (symbol,open_time,close_time,open,high,low,close,volume) VALUES ${placeholders}`,
            values
          );
          total += klines.length;
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
  return total;
}

async function main() {
  const { start_time, end_time, symbols: arg_symbols, limit } = parse_args();

  ConfigManager.getInstance().initialize();
  const connection = await DatabaseConfig.get_mysql_connection();

  const start_str = new Date(start_time).toISOString().slice(0, 16);
  const end_str   = new Date(end_time).toISOString().slice(0, 16);
  console.log(`\n📦 15m K线补全: ${start_str} ~ ${end_str}  limit=${limit}`);

  const symbols = arg_symbols ?? await get_all_symbols();
  console.log(`📋 共 ${symbols.length} 个合约\n`);

  let done = 0, failed = 0;
  for (const symbol of symbols) {
    try {
      const n = await backfill_symbol(symbol, start_time, end_time, limit, connection);
      done++;
      if (n > 0) process.stdout.write(`✅ ${symbol} +${n}根\n`);
    } catch (err: any) {
      failed++;
      console.error(`❌ ${symbol}: ${err.message}`);
    }
    if (done % 50 === 0) console.log(`进度: ${done}/${symbols.length}`);
  }

  connection.release();
  console.log(`\n完成: 成功 ${done} 个，失败 ${failed} 个`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
