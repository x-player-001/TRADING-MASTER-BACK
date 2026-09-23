/**
 * OI数据库优化测试脚本
 *
 * 功能：
 * 1. 自动执行索引优化SQL
 * 2. 测试优化前后的查询性能
 * 3. 生成性能对比报告
 *
 * 使用方法:
 * npx ts-node -r tsconfig-paths/register dev/verify/test_db_optimization.ts
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

// 加载环境变量
dotenv.config();

interface TestResult {
  test_name: string;
  query_time_ms: number;
  rows_scanned: number;
  rows_returned: number;
  using_index: boolean;
  index_name?: string;
}

interface OptimizationResult {
  before: TestResult[];
  after: TestResult[];
  improvement: {
    avg_time_before: number;
    avg_time_after: number;
    speedup: number;
    percentage_improvement: number;
  };
}

/**
 * 数据库连接配置
 * 优先使用SERVER_IP作为远程服务器地址，fallback到MYSQL_HOST
 */
const DB_CONFIG = {
  host: process.env.SERVER_IP || process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'trading_master',
  multipleStatements: true // 允许执行多条SQL
};

/**
 * 创建数据库连接
 */
async function create_connection() {
  try {
    const connection = await mysql.createConnection(DB_CONFIG);
    console.log('✅ 数据库连接成功');
    console.log(`   Host: ${DB_CONFIG.host}:${DB_CONFIG.port}`);
    console.log(`   Database: ${DB_CONFIG.database}`);
    console.log(`   User: ${DB_CONFIG.user}`);
    return connection;
  } catch (error: any) {
    console.error('❌ 数据库连接失败:', error.message);
    throw error;
  }
}

/**
 * 检查数据量
 */
async function check_data_volume(connection: mysql.Connection) {
  console.log('\n📊 检查数据量...');

  // 检查快照表
  const [snapshot_stats] = await connection.execute(`
    SELECT
      COUNT(*) as total_count,
      COUNT(DISTINCT symbol) as symbol_count,
      MIN(snapshot_time) as earliest_time,
      MAX(snapshot_time) as latest_time
    FROM open_interest_snapshots
  `);

  // 检查异动表
  const [anomaly_stats] = await connection.execute(`
    SELECT
      COUNT(*) as total_count,
      COUNT(DISTINCT symbol) as symbol_count,
      MIN(anomaly_time) as earliest_time,
      MAX(anomaly_time) as latest_time
    FROM oi_anomaly_records
  `);

  const snapshot_row: any = (snapshot_stats as any[])[0];
  const anomaly_row: any = (anomaly_stats as any[])[0];

  console.log('\n📈 open_interest_snapshots (OI快照表):');
  console.log(`   总记录数: ${snapshot_row.total_count.toLocaleString()}`);
  console.log(`   币种数量: ${snapshot_row.symbol_count}`);
  console.log(`   数据范围: ${snapshot_row.earliest_time} ~ ${snapshot_row.latest_time}`);

  console.log('\n🚨 oi_anomaly_records (异动记录表):');
  console.log(`   总记录数: ${anomaly_row.total_count.toLocaleString()}`);
  console.log(`   币种数量: ${anomaly_row.symbol_count}`);
  console.log(`   数据范围: ${anomaly_row.earliest_time} ~ ${anomaly_row.latest_time}`);

  return {
    snapshot_count: snapshot_row.total_count,
    anomaly_count: anomaly_row.total_count
  };
}

/**
 * 检查现有索引
 */
async function check_existing_indexes(connection: mysql.Connection) {
  console.log('\n🔍 检查现有索引...');

  const [snapshot_indexes] = await connection.execute(`
    SHOW INDEX FROM open_interest_snapshots
  `);

  const [anomaly_indexes] = await connection.execute(`
    SHOW INDEX FROM oi_anomaly_records
  `);

  console.log('\n📋 open_interest_snapshots 表索引:');
  const snapshot_index_names = new Set();
  (snapshot_indexes as any[]).forEach((idx: any) => {
    snapshot_index_names.add(idx.Key_name);
  });
  snapshot_index_names.forEach(name => console.log(`   - ${name}`));

  console.log('\n📋 oi_anomaly_records 表索引:');
  const anomaly_index_names = new Set();
  (anomaly_indexes as any[]).forEach((idx: any) => {
    anomaly_index_names.add(idx.Key_name);
  });
  anomaly_index_names.forEach(name => console.log(`   - ${name}`));

  return {
    has_time_range_index: snapshot_index_names.has('idx_time_range_query'),
    has_anomaly_time_index: anomaly_index_names.has('idx_anomaly_time_symbol'),
    has_anomaly_date_index: anomaly_index_names.has('idx_anomaly_date_query')
  };
}

/**
 * 执行索引优化
 */
async function apply_index_optimization(connection: mysql.Connection) {
  console.log('\n🔧 执行索引优化...');

  const sql_file = path.join(__dirname, '../database/migrations/optimize_oi_indexes.sql');

  if (!fs.existsSync(sql_file)) {
    console.error('❌ 索引优化SQL文件不存在:', sql_file);
    return false;
  }

  const sql_content = fs.readFileSync(sql_file, 'utf-8');

  try {
    // 执行SQL（忽略某些错误，如索引已存在）
    await connection.query(sql_content);
    console.log('✅ 索引优化SQL执行成功');
    return true;
  } catch (error: any) {
    if (error.message.includes('Duplicate key name')) {
      console.log('⚠️  索引已存在，跳过创建');
      return true;
    }
    console.error('❌ 索引优化执行失败:', error.message);
    return false;
  }
}

/**
 * 测试查询性能
 */
async function test_query_performance(
  connection: mysql.Connection,
  test_name: string,
  sql: string
): Promise<TestResult> {

  // 1. 使用EXPLAIN分析查询
  const [explain_rows] = await connection.execute(`EXPLAIN ${sql}`);
  const explain = explain_rows as any[];

  // 2. 执行实际查询并计时
  const start_time = Date.now();
  const [result_rows] = await connection.execute(sql);
  const query_time = Date.now() - start_time;

  // 3. 分析EXPLAIN结果
  const first_explain = explain[0];
  const using_index = first_explain.Extra?.includes('Using index') || false;
  const index_name = first_explain.key || 'NONE';
  const rows_scanned = first_explain.rows || 0;

  return {
    test_name,
    query_time_ms: query_time,
    rows_scanned,
    rows_returned: (result_rows as any[]).length,
    using_index,
    index_name
  };
}

/**
 * 运行性能测试套件
 */
async function run_performance_tests(connection: mysql.Connection): Promise<TestResult[]> {
  console.log('\n⏱️  执行性能测试...');

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterday_str = yesterday.toISOString().split('T')[0];

  const tests: Array<{name: string, sql: string}> = [
    {
      name: '测试1: 快照数据窗口函数查询',
      sql: `
        SELECT
          symbol,
          open_interest,
          snapshot_time,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY timestamp_ms DESC) as rn_latest
        FROM open_interest_snapshots
        WHERE snapshot_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
          AND snapshot_time <= NOW()
        LIMIT 100
      `
    },
    {
      name: '测试2: 异动记录按时间查询',
      sql: `
        SELECT * FROM oi_anomaly_records
        WHERE anomaly_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
          AND anomaly_time <= NOW()
        ORDER BY anomaly_time DESC
        LIMIT 100
      `
    },
    {
      name: '测试3: 完整统计查询（优化后的SQL）',
      sql: `
        WITH anomaly_symbols AS (
          SELECT DISTINCT symbol
          FROM oi_anomaly_records
          WHERE anomaly_time >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            AND anomaly_time <= NOW()
        )
        SELECT COUNT(*) as count FROM anomaly_symbols
      `
    },
    {
      name: '测试4: 按币种+时间查询快照',
      sql: `
        SELECT * FROM open_interest_snapshots
        WHERE symbol = 'BTCUSDT'
          AND snapshot_time >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        ORDER BY timestamp_ms DESC
        LIMIT 10
      `
    }
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    console.log(`\n   执行: ${test.name}`);
    const result = await test_query_performance(connection, test.name, test.sql);
    console.log(`      查询时间: ${result.query_time_ms}ms`);
    console.log(`      扫描行数: ${result.rows_scanned.toLocaleString()}`);
    console.log(`      返回行数: ${result.rows_returned}`);
    console.log(`      使用索引: ${result.using_index ? '✅' : '❌'} ${result.index_name}`);
    results.push(result);
  }

  return results;
}

/**
 * 生成性能报告
 */
function generate_performance_report(result: OptimizationResult) {
  console.log('\n');
  console.log('═'.repeat(80));
  console.log('📊 性能优化测试报告');
  console.log('═'.repeat(80));

  console.log('\n🔴 优化前性能:');
  console.log('┌────────────────────────────────────────┬──────────┬──────────┬──────────┐');
  console.log('│ 测试名称                                │ 查询时间 │ 扫描行数 │ 使用索引 │');
  console.log('├────────────────────────────────────────┼──────────┼──────────┼──────────┤');

  result.before.forEach(test => {
    const name_padded = test.test_name.padEnd(40);
    const time_padded = `${test.query_time_ms}ms`.padStart(8);
    const rows_padded = test.rows_scanned.toLocaleString().padStart(8);
    const index_status = test.using_index ? '✅ 是' : '❌ 否';
    console.log(`│ ${name_padded} │ ${time_padded} │ ${rows_padded} │ ${index_status.padStart(8)} │`);
  });
  console.log('└────────────────────────────────────────┴──────────┴──────────┴──────────┘');

  console.log('\n🟢 优化后性能:');
  console.log('┌────────────────────────────────────────┬──────────┬──────────┬──────────┐');
  console.log('│ 测试名称                                │ 查询时间 │ 扫描行数 │ 使用索引 │');
  console.log('├────────────────────────────────────────┼──────────┼──────────┼──────────┤');

  result.after.forEach(test => {
    const name_padded = test.test_name.padEnd(40);
    const time_padded = `${test.query_time_ms}ms`.padStart(8);
    const rows_padded = test.rows_scanned.toLocaleString().padStart(8);
    const index_status = test.using_index ? '✅ 是' : '❌ 否';
    console.log(`│ ${name_padded} │ ${time_padded} │ ${rows_padded} │ ${index_status.padStart(8)} │`);
  });
  console.log('└────────────────────────────────────────┴──────────┴──────────┴──────────┘');

  console.log('\n📈 性能提升统计:');
  console.log(`   优化前平均查询时间: ${result.improvement.avg_time_before.toFixed(1)}ms`);
  console.log(`   优化后平均查询时间: ${result.improvement.avg_time_after.toFixed(1)}ms`);
  console.log(`   性能提升倍数: ${result.improvement.speedup.toFixed(2)}x`);
  console.log(`   速度提升百分比: ${result.improvement.percentage_improvement.toFixed(1)}%`);

  if (result.improvement.speedup > 2) {
    console.log('\n✅ 优化效果显著！查询速度提升超过2倍');
  } else if (result.improvement.speedup > 1.5) {
    console.log('\n✅ 优化效果良好！查询速度有明显提升');
  } else if (result.improvement.speedup > 1.1) {
    console.log('\n⚠️  优化效果一般，建议检查数据量和索引使用情况');
  } else {
    console.log('\n❌ 优化效果不明显，可能索引未生效或数据量过小');
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('🚀 OI数据库性能优化测试');
  console.log('═'.repeat(80));

  let connection: mysql.Connection | null = null;

  try {
    // 1. 连接数据库
    connection = await create_connection();

    // 2. 检查数据量
    const data_volume = await check_data_volume(connection);

    if (data_volume.snapshot_count < 1000) {
      console.log('\n⚠️  警告: 数据量太少（<1000条），测试结果可能不准确');
      console.log('   建议: 等待OI轮询服务运行一段时间后再测试');
    }

    // 3. 检查现有索引
    const index_status = await check_existing_indexes(connection);

    // 4. 优化前性能测试
    console.log('\n🔴 步骤1: 优化前性能测试');
    const before_results = await run_performance_tests(connection);

    // 5. 应用索引优化
    console.log('\n🔧 步骤2: 应用索引优化');
    const optimization_success = await apply_index_optimization(connection);

    if (!optimization_success) {
      console.error('❌ 索引优化失败，无法继续测试');
      process.exit(1);
    }

    // 等待1秒让索引生效
    console.log('\n⏳ 等待索引生效...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 6. 优化后性能测试
    console.log('\n🟢 步骤3: 优化后性能测试');
    const after_results = await run_performance_tests(connection);

    // 7. 计算性能提升
    const avg_before = before_results.reduce((sum, r) => sum + r.query_time_ms, 0) / before_results.length;
    const avg_after = after_results.reduce((sum, r) => sum + r.query_time_ms, 0) / after_results.length;
    const speedup = avg_before / avg_after;
    const improvement = ((avg_before - avg_after) / avg_before) * 100;

    const optimization_result: OptimizationResult = {
      before: before_results,
      after: after_results,
      improvement: {
        avg_time_before: avg_before,
        avg_time_after: avg_after,
        speedup,
        percentage_improvement: improvement
      }
    };

    // 8. 生成报告
    generate_performance_report(optimization_result);

    console.log('\n✅ 测试完成！');

  } catch (error: any) {
    console.error('\n❌ 测试失败:', error.message);
    console.error('\n错误详情:', error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n🔌 数据库连接已关闭');
    }
  }
}

// 运行测试
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
