/**
 * 1h/4h 聚合K线数据补全脚本 V2
 *
 * 功能:
 * - 从币安API拉取指定周期的K线数据
 * - 写入聚合表 (kline_1h_agg, kline_4h_agg)
 * - 支持断点续传（智能检查指定时间范围内的数据是否已存在）
 *
 * 改进点:
 * - V1 版本只检查表中该币种的总记录数，如果历史数据很多但最近缺失，会误判为已存在。
 * - V2 版本根据 limit 和 interval 计算时间范围，检查该范围内的数据量。
 *
 * 使用方法:
 * npx ts-node -r tsconfig-paths/register scripts/backfill_kline_agg_v2.ts
 *
 * 可选参数:
 * --interval 1h          K线周期（1h 或 4h，默认两个都补）
 * --limit 300            每个币种拉取的K线数量（默认300）
 * --symbols BTCUSDT,ETHUSDT  指定币种（默认：所有USDT永续合约）
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';

// ==================== 配置 ====================
const CONFIG = {
  request_delay_ms: 600,          // 请求间隔，避免限流 (600ms，每分钟约100次请求)
  retry_delay_ms: 30000,          // 429错误后等待时间 (30秒)
  max_retries: 3,                 // 最大重试次数
  batch_insert_size: 500          // 批量插入大小
};

// 周期配置
const INTERVAL_CONFIG: Record<string, { table_name: string; interval_ms: number }> = {
  '1h': { table_name: 'kline_1h_agg', interval_ms: 60 * 60 * 1000 },
  '4h': { table_name: 'kline_4h_agg', interval_ms: 4 * 60 * 60 * 1000 }
};

// K线数据结构
interface AggKline {
  symbol: string;
  interval: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ==================== 解析命令行参数 ====================
function parse_args(): { intervals: string[]; limit: number; symbols: string[] | null } {
  const args = process.argv.slice(2);
  let intervals: string[] = ['1h', '4h'];  // 默认两个都补
  let limit = 300;
  let symbols: string[] | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      const interval = args[i + 1];
      if (interval === '1h' || interval === '4h') {
        intervals = [interval];
      }
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]) || 300;
      i++;
    } else if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map(s => s.trim().toUpperCase());
      i++;
    }
  }

  return { intervals, limit, symbols };
}

// 请求头配置（绕过418错误）
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

// ==================== 获取所有交易对 ====================
async function get_all_symbols(): Promise<string[]> {
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

  for (let retry = 0; retry < 3; retry++) {
    try {
      console.log(`   正在请求币安API... (尝试 ${retry + 1}/3)`);
      const response = await axios.get(url, { timeout: 30000, headers: REQUEST_HEADERS });
      const symbols = response.data.symbols
        .filter((s: any) =>
          s.status === 'TRADING' &&
          s.contractType === 'PERPETUAL' &&
          s.symbol.endsWith('USDT')
        )
        .map((s: any) => s.symbol);
      console.log(`   ✅ 获取成功`);
      return symbols;
    } catch (error: any) {
      console.error(`   ❌ 请求失败: ${error.message}`);
      if (retry < 2) {
        console.log(`   等待 5 秒后重试...`);
        await sleep(5000);
      }
    }
  }

  throw new Error('无法获取交易对列表');
}

// ==================== 确保表存在 ====================
async function ensure_table_exists(connection: any, table_name: string): Promise<void> {
  const create_sql = `
    CREATE TABLE IF NOT EXISTS ${table_name} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      \`interval\` VARCHAR(10) NOT NULL,
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='聚合K线数据'
  `;

  try {
    await connection.execute(create_sql);
  } catch (error: any) {
    if (!error.message?.includes('already exists')) {
      throw error;
    }
  }
}

// ==================== 从API拉取K线数据 ====================
async function fetch_klines(
  symbol: string,
  interval: string,
  limit: number
): Promise<AggKline[]> {
  const url = 'https://fapi.binance.com/fapi/v1/klines';

  for (let retry = 0; retry < CONFIG.max_retries; retry++) {
    try {
      const response = await axios.get(url, {
        params: { symbol, interval, limit },
        headers: REQUEST_HEADERS,
        timeout: 30000
      });

      return response.data.map((k: any[]) => ({
        symbol,
        interval,
        open_time: k[0],
        close_time: k[6],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));

    } catch (error: any) {
      const is_rate_limit = error.response?.status === 429;
      if (retry < CONFIG.max_retries - 1) {
        const delay = is_rate_limit ? CONFIG.retry_delay_ms : 1000 * (retry + 1);
        console.error(`   ⚠️ ${symbol} ${is_rate_limit ? '限流' : '请求失败'}，${delay/1000}秒后重试`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }

  return [];
}

// ==================== 批量插入K线 ====================
async function batch_insert_klines(
  connection: any,
  table_name: string,
  klines: AggKline[]
): Promise<number> {
  if (klines.length === 0) return 0;

  let inserted = 0;

  for (let i = 0; i < klines.length; i += CONFIG.batch_insert_size) {
    const batch = klines.slice(i, i + CONFIG.batch_insert_size);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values: any[] = [];

    for (const k of batch) {
      values.push(k.symbol, k.interval, k.open_time, k.close_time, k.open, k.high, k.low, k.close, k.volume);
    }

    const sql = `
      INSERT IGNORE INTO ${table_name}
      (symbol, \`interval\`, open_time, close_time, open, high, low, close, volume)
      VALUES ${placeholders}
    `;

    const [result] = await connection.execute(sql, values);
    inserted += (result as any).affectedRows || 0;
  }

  return inserted;
}

// ==================== 检查最近数据完整性 (V2新增) ====================
async function check_recent_data_completeness(
  connection: any,
  table_name: string,
  symbol: string,
  interval_ms: number,
  limit: number
): Promise<{ is_complete: boolean; count: number }> {
  try {
    // 计算需要检查的时间范围
    // 假设我们需要最近 limit 根K线，我们检查从 (now - limit * interval) 开始的数据量
    const now = Date.now();
    const start_time = now - (limit * interval_ms);

    const [rows] = await connection.execute(
      `SELECT COUNT(*) as cnt FROM ${table_name} WHERE symbol = ? AND open_time >= ?`,
      [symbol, start_time]
    );
    const count = (rows as any[])[0]?.cnt || 0;

    // 如果已有数据量达到预期的 90%，认为数据完整
    return {
      is_complete: count >= limit * 0.95,
      count
    };
  } catch (error) {
    return { is_complete: false, count: 0 };
  }
}

// ==================== 工具函数 ====================
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(70));
  console.log('           1h/4h 聚合K线数据补全工具 V2');
  console.log('═'.repeat(70));

  const { intervals, limit, symbols: specified_symbols } = parse_args();

  console.log(`\n📊 补全周期: ${intervals.join(', ')}`);
  console.log(`📈 每币种拉取: ${limit} 根K线`);
  console.log(`⏳ 请求间隔: ${CONFIG.request_delay_ms}ms`);

  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();
  console.log('✅ 配置管理器已初始化');

  const connection = await DatabaseConfig.get_mysql_connection();
  console.log('✅ 数据库连接成功');

  try {
    for (const interval of intervals) {
      const { table_name } = INTERVAL_CONFIG[interval];
      await ensure_table_exists(connection, table_name);
    }

    let symbols: string[];
    if (specified_symbols) {
      symbols = specified_symbols;
      console.log(`\n📋 指定币种: ${symbols.length} 个`);
    } else {
      console.log('\n📡 正在获取所有交易对...');
      symbols = await get_all_symbols();
      console.log(`📋 共 ${symbols.length} 个交易对`);
    }

    console.log('═'.repeat(70));

    for (const interval of intervals) {
      console.log(`\n🔄 开始补全 ${interval} K线...`);
      console.log('─'.repeat(70));

      const { table_name, interval_ms } = INTERVAL_CONFIG[interval];
      const stats = { processed: 0, success: 0, skipped: 0, failed: 0, total_klines: 0, start_time: Date.now() };

      for (const symbol of symbols) {
        stats.processed++;
        const progress = `[${stats.processed}/${symbols.length}]`;

        try {
          // V2: 检查最近时间段内的数据完整性
          const { is_complete, count } = await check_recent_data_completeness(
            connection, table_name, symbol, interval_ms, limit
          );

          if (is_complete) {
            stats.skipped++;
            process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ⏭️  最近已有 ${count}/${limit} 根，跳过\n`);
            continue;
          }

          process.stdout.write(`\r${progress} ${symbol.padEnd(12)} 正在拉取...`);

          const klines = await fetch_klines(symbol, interval, limit);

          if (klines.length === 0) {
            process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ⚠️ 无数据\n`);
            continue;
          }

          const inserted = await batch_insert_klines(connection, table_name, klines);
          stats.total_klines += inserted;
          stats.success++;

          process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ✅ ${klines.length} 根K线 (新增 ${inserted})\n`);
          await sleep(CONFIG.request_delay_ms);

        } catch (error: any) {
          stats.failed++;
          process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ❌ ${error.message}\n`);
        }
      }

      const elapsed = Math.round((Date.now() - stats.start_time) / 1000);
      console.log('─'.repeat(70));
      console.log(`${interval} 完成: 成功=${stats.success}, 跳过=${stats.skipped}, 失败=${stats.failed}, 新增=${stats.total_klines}, 耗时=${elapsed}秒`);
    }

    console.log('\n✅ 补全完成');

  } finally {
    connection.release();
    process.exit(0);
  }
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});