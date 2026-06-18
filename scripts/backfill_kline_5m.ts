/**
 * 5m K线数据补全脚本
 *
 * 功能:
 * - 从币安API拉取指定日期范围的5m K线数据
 * - 批量写入数据库（按日期分表）
 * - 支持断点续传（跳过已有数据）
 *
 * 使用方法:
 * npx ts-node -r tsconfig-paths/register scripts/backfill_kline_5m.ts
 *
 * 可选参数:
 * --start 2024-12-20   起始日期（默认：3天前）
 * --end 2024-12-22     结束日期（默认：今天）
 * --symbols BTCUSDT,ETHUSDT  指定币种（默认：所有USDT永续合约）
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { ConfigManager } from '../src/core/config/config_manager';
import { Kline5mRepository, Kline5mData } from '../src/database/kline_5m_repository';

// ==================== 配置 ====================
const CONFIG = {
  interval: '5m',
  interval_ms: 5 * 60 * 1000,
  batch_size: 1000,
  request_delay_ms: 300,          // 单任务请求间隔（并发5时约1500权重/分钟）
  retry_delay_ms: 30000,
  max_retries: 3,
  concurrency: 5,
};

// ==================== 解析命令行参数 ====================
function parse_args(): { start_date: Date; end_date: Date; symbols: string[] | null; force: boolean } {
  const args = process.argv.slice(2);
  let start_date: Date | null = null;
  let end_date: Date | null = null;
  let symbols: string[] | null = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      start_date = new Date(args[i + 1] + 'T00:00:00Z');
      i++;
    } else if (args[i] === '--end' && args[i + 1]) {
      // 如果指定的是今天，使用当前时间；否则使用当天结束时间
      const end_date_str = args[i + 1];
      const today_str = new Date().toISOString().slice(0, 10);
      if (end_date_str === today_str) {
        end_date = new Date();  // 使用当前时间
      } else {
        end_date = new Date(end_date_str + 'T23:59:59Z');
      }
      i++;
    } else if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map(s => s.trim().toUpperCase());
      i++;
    } else if (args[i] === '--force') {
      // 强制模式：跳过"末尾续传"判断，直接拉取整个区间（INSERT IGNORE 去重，
      // 可补中间空洞——例如服务中断导致的内部缺口）
      force = true;
    }
  }

  // 默认值：3天前到今天
  if (!start_date) {
    start_date = new Date();
    start_date.setUTCDate(start_date.getUTCDate() - 3);
    start_date.setUTCHours(0, 0, 0, 0);
  }

  if (!end_date) {
    end_date = new Date();
  }

  return { start_date, end_date, symbols, force };
}

// ==================== 获取所有交易对 ====================
async function get_all_symbols(): Promise<string[]> {
  // 从币安API获取所有USDT永续合约
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  const response = await axios.get(url);
  return response.data.symbols
    .filter((s: any) =>
      s.status === 'TRADING' &&
      s.contractType === 'PERPETUAL' &&
      s.symbol.endsWith('USDT')
    )
    .map((s: any) => s.symbol);
}

// ==================== 从API拉取K线数据 ====================
async function fetch_klines(
  symbol: string,
  start_time: number,
  end_time: number
): Promise<Kline5mData[]> {
  const klines: Kline5mData[] = [];
  let current_start = start_time;

  while (current_start < end_time) {
    const url = 'https://fapi.binance.com/fapi/v1/klines';

    for (let retry = 0; retry < CONFIG.max_retries; retry++) {
      try {
        const response = await axios.get(url, {
          params: {
            symbol,
            interval: CONFIG.interval,
            startTime: current_start,
            endTime: end_time,
            limit: CONFIG.batch_size
          }
        });

        const data = response.data;
        if (data.length === 0) {
          current_start = end_time; // 没有更多数据
          break;
        }

        for (const k of data) {
          klines.push({
            symbol,
            open_time: k[0],
            close_time: k[6],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
          });
        }

        // 移动到下一批
        const last_close_time = data[data.length - 1][6];
        current_start = last_close_time + 1;

        // 延迟避免限流
        await sleep(CONFIG.request_delay_ms);
        break; // 成功，跳出重试循环

      } catch (error: any) {
        const is_rate_limit = error.response?.status === 429;
        if (retry < CONFIG.max_retries - 1) {
          const delay = is_rate_limit ? CONFIG.retry_delay_ms : 1000 * (retry + 1);
          console.error(`   ⚠️ ${symbol} ${is_rate_limit ? '限流' : '请求失败'}，${delay/1000}秒后重试 ${retry + 1}/${CONFIG.max_retries}`);
          await sleep(delay);
        } else {
          console.error(`   ❌ ${symbol} 请求失败: ${error.message}`);
          return klines; // 返回已获取的数据
        }
      }
    }
  }

  return klines;
}

// ==================== 工具函数 ====================
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function format_date(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ==================== 检查币种是否已有足够数据 ====================
async function check_existing_data(
  kline_repository: Kline5mRepository,
  symbol: string,
  start_ts: number,
  end_ts: number,
  expected_count: number
): Promise<{ has_data: boolean; existing_count: number }> {
  try {
    const klines = await kline_repository.get_klines_by_time_range(symbol, start_ts, end_ts);
    const existing_count = klines.length;
    // 如果已有数据超过预期的80%，认为已有足够数据
    const has_data = existing_count >= expected_count * 0.8;
    return { has_data, existing_count };
  } catch {
    return { has_data: false, existing_count: 0 };
  }
}

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(70));
  console.log('              5m K线数据补全工具');
  console.log('═'.repeat(70));

  // 解析参数
  const { start_date, end_date, symbols: specified_symbols, force } = parse_args();

  console.log(`\n📅 补全范围: ${format_date(start_date)} ~ ${format_date(end_date)}`);
  console.log(`⏱️  K线周期: ${CONFIG.interval}`);
  console.log(`⏳ 请求间隔: ${CONFIG.request_delay_ms}ms`);
  if (force) console.log(`🔁 强制模式: 全区间拉取，补中间空洞（INSERT IGNORE 去重）`);

  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();
  console.log('✅ 配置管理器已初始化');

  const kline_repository = new Kline5mRepository();
  console.log('✅ 数据库连接成功');

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

  // 计算时间范围
  const start_ts = start_date.getTime();
  const end_ts = end_date.getTime();
  const expected_klines_per_symbol = Math.ceil((end_ts - start_ts) / CONFIG.interval_ms);

  console.log(`📊 预计每个币种约 ${expected_klines_per_symbol} 根K线`);
  console.log('═'.repeat(70));

  // 统计
  const stats = {
    total_symbols: symbols.length,
    processed: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    total_klines: 0,
    start_time: Date.now()
  };

  // 并发处理
  const queue = [...symbols];

  async function worker(): Promise<void> {
    const repo = new Kline5mRepository();
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (!symbol) break;
      stats.processed++;
      const progress = `[${stats.processed}/${stats.total_symbols}]`;
      try {
        // 强制模式：拉取整个区间（补中间空洞）；
        // 普通模式：从库里最新一根之后续传（仅补末尾缺口）
        let actual_start = start_ts;
        if (!force) {
          const latest_klines = await repo.get_recent_klines(symbol, 1);
          const latest_ts = latest_klines.length > 0 ? latest_klines[0].open_time : 0;
          actual_start = latest_ts > start_ts ? latest_ts + CONFIG.interval_ms : start_ts;
          if (actual_start >= end_ts) {
            stats.skipped++;
            console.log(`${progress} ${symbol.padEnd(12)} ⏭️  已最新，跳过`);
            continue;
          }
        }
        const klines = await fetch_klines(symbol, actual_start, end_ts);
        if (klines.length === 0) continue;
        await repo.add_klines(klines);
        stats.total_klines += klines.length;
        stats.success++;
        console.log(`${progress} ${symbol.padEnd(12)} ✅ +${klines.length}根`);
      } catch (error: any) {
        stats.failed++;
        console.error(`${progress} ${symbol.padEnd(12)} ❌ ${error.message}`);
      }
    }
    repo.stop_flush_timer();
    await repo.flush();
  }

  await Promise.all(Array.from({ length: CONFIG.concurrency }, () => worker()));

  // 打印统计
  const elapsed = Math.round((Date.now() - stats.start_time) / 1000);
  console.log('\n' + '═'.repeat(70));
  console.log('                       完成统计');
  console.log('═'.repeat(70));
  console.log(`   处理币种: ${stats.processed}`);
  console.log(`   成功拉取: ${stats.success}`);
  console.log(`   已有跳过: ${stats.skipped}`);
  console.log(`   失败: ${stats.failed}`);
  console.log(`   新增K线: ${stats.total_klines}`);
  console.log(`   耗时: ${elapsed} 秒`);
  console.log('═'.repeat(70));

  // 显示数据库统计
  try {
    const db_stats = await kline_repository.get_statistics();
    console.log(`\n📊 数据库今日统计: ${db_stats.today_count} 条记录, ${db_stats.today_symbols} 个币种`);
  } catch {
    // 忽略
  }

  console.log('\n✅ 补全完成');
  process.exit(0);
}

// 运行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
