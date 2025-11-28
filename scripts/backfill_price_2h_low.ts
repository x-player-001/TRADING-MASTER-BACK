/**
 * 回填历史异动记录的 price_2h_low 和 price_from_2h_low_pct 字段
 *
 * 优化策略：按天分组处理，预加载每天的 oi_snapshots 数据到内存
 *
 * 运行: npx ts-node -r tsconfig-paths/register scripts/backfill_price_2h_low.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';
import { subHours, format, startOfDay, endOfDay, addDays, subDays } from 'date-fns';

// 初始化配置
ConfigManager.getInstance().initialize();

interface AnomalyRecord {
  id: number;
  symbol: string;
  anomaly_time: Date;
  mark_price: number;
  price_2h_low: number | null;
}

interface OISnapshot {
  symbol: string;
  snapshot_time: Date;
  mark_price: number;
}

// 表名缓存
const existing_tables_cache = new Set<string>();

// 每日OI数据缓存: date_str -> symbol -> [{snapshot_time, mark_price}]
const daily_oi_cache = new Map<string, Map<string, OISnapshot[]>>();

/**
 * 获取日期对应的表名
 */
function get_table_name(date: Date): string {
  return `oi_snapshots_${format(date, 'yyyyMMdd')}`;
}

/**
 * 加载某一天的OI快照数据到缓存
 */
async function load_daily_oi_data(conn: any, date: Date): Promise<void> {
  const date_str = format(date, 'yyyy-MM-dd');

  // 如果已经缓存，跳过
  if (daily_oi_cache.has(date_str)) {
    return;
  }

  const table_name = get_table_name(date);

  // 检查表是否存在
  if (!existing_tables_cache.has(table_name)) {
    try {
      const [rows] = await conn.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
        [table_name]
      );
      if ((rows as any[]).length === 0) {
        // 表不存在，设置空Map
        daily_oi_cache.set(date_str, new Map());
        return;
      }
      existing_tables_cache.add(table_name);
    } catch (err) {
      daily_oi_cache.set(date_str, new Map());
      return;
    }
  }

  // 加载当天所有数据
  console.log(`  📥 加载 ${table_name} 数据...`);
  const start = Date.now();

  try {
    const [rows] = await conn.query(`
      SELECT symbol, snapshot_time, mark_price
      FROM ${table_name}
      WHERE mark_price IS NOT NULL
      ORDER BY symbol, snapshot_time
    `);

    const data = rows as OISnapshot[];
    const symbol_map = new Map<string, OISnapshot[]>();

    for (const row of data) {
      if (!symbol_map.has(row.symbol)) {
        symbol_map.set(row.symbol, []);
      }
      symbol_map.get(row.symbol)!.push({
        symbol: row.symbol,
        snapshot_time: new Date(row.snapshot_time),
        mark_price: parseFloat(row.mark_price as any)
      });
    }

    daily_oi_cache.set(date_str, symbol_map);
    console.log(`  ✅ 加载完成: ${data.length} 条记录, ${symbol_map.size} 个币种, 耗时 ${Date.now() - start}ms`);

  } catch (err: any) {
    console.error(`  ❌ 加载失败: ${err.message}`);
    daily_oi_cache.set(date_str, new Map());
  }
}

/**
 * 从缓存中获取2小时最低价
 */
function get_price_2h_low_from_cache(
  symbol: string,
  anomaly_time: Date
): number | null {
  const start_time = subHours(anomaly_time, 2);

  // 可能需要查询2天的数据（跨天情况）
  const dates_to_check = [
    format(start_time, 'yyyy-MM-dd'),
    format(anomaly_time, 'yyyy-MM-dd')
  ];

  // 去重
  const unique_dates = [...new Set(dates_to_check)];

  let min_price: number | null = null;

  for (const date_str of unique_dates) {
    const day_data = daily_oi_cache.get(date_str);
    if (!day_data) continue;

    const symbol_data = day_data.get(symbol);
    if (!symbol_data) continue;

    for (const snapshot of symbol_data) {
      if (snapshot.snapshot_time >= start_time && snapshot.snapshot_time <= anomaly_time) {
        if (min_price === null || snapshot.mark_price < min_price) {
          min_price = snapshot.mark_price;
        }
      }
    }
  }

  return min_price;
}

/**
 * 按天分组处理：先预加载当天和前一天的OI数据，再批量处理当天的异动记录
 */
async function process_day(conn: any, date: Date): Promise<{updated: number, skipped: number, already_filled: number}> {
  const date_str = format(date, 'yyyy-MM-dd');
  console.log(`\n📅 处理日期: ${date_str}`);

  // 预加载当天和前一天的OI数据（用于计算2小时低点，可能跨天）
  const prev_date = subDays(date, 1);
  await load_daily_oi_data(conn, prev_date);
  await load_daily_oi_data(conn, date);

  // 查询当天的异动记录
  const day_start = startOfDay(date);
  const day_end = endOfDay(date);

  const [records] = await conn.query(`
    SELECT id, symbol, anomaly_time, mark_price, price_2h_low
    FROM oi_anomaly_records
    WHERE anomaly_time >= ? AND anomaly_time <= ?
    ORDER BY id ASC
  `, [day_start, day_end]);

  const anomalies = records as AnomalyRecord[];
  console.log(`  📊 当天异动记录: ${anomalies.length} 条`);

  let updated = 0;
  let skipped = 0;
  let already_filled = 0;

  for (const record of anomalies) {
    const { id, symbol, mark_price, price_2h_low: existing } = record;
    const anomaly_time = new Date(record.anomaly_time);

    // 已有值，跳过
    if (existing !== null) {
      already_filled++;
      continue;
    }

    // 从缓存获取2小时最低价
    const price_2h_low = get_price_2h_low_from_cache(symbol, anomaly_time);

    if (price_2h_low === null) {
      skipped++;
    } else {
      // 计算涨幅
      const price_from_2h_low_pct = ((mark_price - price_2h_low) / price_2h_low) * 100;

      // 更新数据库
      await conn.query(`
        UPDATE oi_anomaly_records
        SET price_2h_low = ?, price_from_2h_low_pct = ?
        WHERE id = ?
      `, [price_2h_low, price_from_2h_low_pct, id]);

      updated++;
    }
  }

  console.log(`  ✅ 完成: 更新 ${updated}, 跳过 ${skipped}, 已存在 ${already_filled}`);

  // 清理前一天的缓存，节省内存
  const prev_date_str = format(prev_date, 'yyyy-MM-dd');
  daily_oi_cache.delete(prev_date_str);

  return { updated, skipped, already_filled };
}

async function main() {
  // 从命令行参数获取天数，默认2天
  const days = parseInt(process.argv[2]) || 2;

  console.log(`开始回填 price_2h_low 数据（最近${days}天）...\n`);
  console.log('策略: 按天分组处理，预加载OI数据到内存，避免重复查询\n');

  console.log('正在连接数据库...');
  const conn = await DatabaseConfig.get_mysql_connection();
  console.log('数据库连接成功');

  try {
    const start_time = Date.now();

    // 获取需要处理的日期范围
    const today = new Date();
    const dates_to_process: Date[] = [];

    for (let i = days - 1; i >= 0; i--) {
      dates_to_process.push(subDays(today, i));
    }

    console.log(`\n📆 需要处理的日期: ${dates_to_process.map(d => format(d, 'MM-dd')).join(', ')}`);

    let total_updated = 0;
    let total_skipped = 0;
    let total_already_filled = 0;

    // 逐天处理
    for (const date of dates_to_process) {
      const result = await process_day(conn, date);
      total_updated += result.updated;
      total_skipped += result.skipped;
      total_already_filled += result.already_filled;
    }

    const elapsed = ((Date.now() - start_time) / 1000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ 全部完成！耗时 ${elapsed} 秒`);
    console.log(`   更新: ${total_updated} 条`);
    console.log(`   跳过: ${total_skipped} 条（无OI数据）`);
    console.log(`   已存在: ${total_already_filled} 条`);
    console.log(`${'='.repeat(60)}`);

  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
