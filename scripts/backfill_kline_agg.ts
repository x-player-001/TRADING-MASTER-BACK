/**
 * 1h/4h 聚合K线数据补全脚本
 *
 * 功能:
 * - 从币安API拉取指定周期的K线数据
 * - 写入聚合表 (kline_1h_agg, kline_4h_agg)
 * - 支持断点续传（跳过已有数据）
 *
 * 使用方法:
 * npx ts-node -r tsconfig-paths/register scripts/backfill_kline_agg.ts
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

  // 检查并添加缺失的 interval 字段（兼容旧表结构）
  try {
    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'interval'`,
      [table_name]
    );

    if ((columns as any[]).length === 0) {
      console.log(`   ⚠️ 表 ${table_name} 缺少 interval 字段，正在添加...`);
      await connection.execute(
        `ALTER TABLE ${table_name} ADD COLUMN \`interval\` VARCHAR(10) NOT NULL DEFAULT '' AFTER symbol`
      );
      console.log(`   ✅ 已添加 interval 字段`);
    }
  } catch (error: any) {
    console.error(`   ❌ 检查/添加 interval 字段失败:`, error.message);
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

  // 分批插入
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

// ==================== 检查已有数据量 ====================
async function get_existing_count(
  connection: any,
  table_name: string,
  symbol: string
): Promise<number> {
  try {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) as cnt FROM ${table_name} WHERE symbol = ?`,
      [symbol]
    );
    return (rows as any[])[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

// ==================== 工具函数 ====================
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(70));
  console.log('           1h/4h 聚合K线数据补全工具');
  console.log('═'.repeat(70));

  // 解析参数
  const { intervals, limit, symbols: specified_symbols } = parse_args();

  console.log(`\n📊 补全周期: ${intervals.join(', ')}`);
  console.log(`📈 每币种拉取: ${limit} 根K线`);
  console.log(`⏳ 请求间隔: ${CONFIG.request_delay_ms}ms`);

  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();
  console.log('✅ 配置管理器已初始化');

  const connection = await DatabaseConfig.get_mysql_connection();
  console.log('✅ 数据库连接成功');

  try {
    // 确保表存在
    for (const interval of intervals) {
      const { table_name } = INTERVAL_CONFIG[interval];
      await ensure_table_exists(connection, table_name);
      console.log(`✅ 表 ${table_name} 已就绪`);
    }

    // 获取交易对列表
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

    // 按周期补全
    for (const interval of intervals) {
      console.log(`\n🔄 开始补全 ${interval} K线...`);
      console.log('─'.repeat(70));

      const { table_name } = INTERVAL_CONFIG[interval];

      // 统计
      const stats = {
        processed: 0,
        success: 0,
        skipped: 0,
        failed: 0,
        total_klines: 0,
        start_time: Date.now()
      };

      // 逐个处理交易对
      for (const symbol of symbols) {
        stats.processed++;
        const progress = `[${stats.processed}/${symbols.length}]`;

        try {
          // 检查已有数据
          const existing = await get_existing_count(connection, table_name, symbol);

          // 如果已有超过80%的数据，跳过
          if (existing >= limit * 0.9) {
            stats.skipped++;
            process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ⏭️  已有 ${existing} 根，跳过\n`);
            continue;
          }

          process.stdout.write(`\r${progress} ${symbol.padEnd(12)} 正在拉取...`);

          // 拉取K线数据
          const klines = await fetch_klines(symbol, interval, limit);

          if (klines.length === 0) {
            process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ⚠️ 无数据\n`);
            continue;
          }

          // 写入数据库
          const inserted = await batch_insert_klines(connection, table_name, klines);
          stats.total_klines += inserted;
          stats.success++;

          process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ✅ ${klines.length} 根K线 (新增 ${inserted})\n`);

          // 延迟避免限流
          await sleep(CONFIG.request_delay_ms);

        } catch (error: any) {
          stats.failed++;
          process.stdout.write(`\r${progress} ${symbol.padEnd(12)} ❌ ${error.message}\n`);
        }
      }

      // 打印该周期的统计
      const elapsed = Math.round((Date.now() - stats.start_time) / 1000);
      console.log('─'.repeat(70));
      console.log(`${interval} 完成: 成功=${stats.success}, 跳过=${stats.skipped}, 失败=${stats.failed}, 新增=${stats.total_klines}, 耗时=${elapsed}秒`);
    }

    // 最终统计
    console.log('\n' + '═'.repeat(70));
    console.log('                       补全完成');
    console.log('═'.repeat(70));

    // 显示各表数据量
    for (const interval of intervals) {
      const { table_name } = INTERVAL_CONFIG[interval];
      try {
        const [rows] = await connection.execute(
          `SELECT COUNT(*) as cnt, COUNT(DISTINCT symbol) as symbols FROM ${table_name}`
        );
        const result = (rows as any[])[0];
        console.log(`📊 ${table_name}: ${result.cnt} 条记录, ${result.symbols} 个币种`);
      } catch {
        // 忽略
      }
    }

    console.log('\n✅ 补全完成');

  } finally {
    connection.release();
    process.exit(0);
  }
}

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  console.error('\n❌ 未捕获异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ 未处理的Promise拒绝:', reason);
  process.exit(1);
});

// 运行
main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
