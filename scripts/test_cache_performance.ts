/**
 * 测试缓存优化后的性能
 *
 * 使用方法:
 * npx ts-node -r tsconfig-paths/register scripts/test_cache_performance.ts
 */

import axios from 'axios';

const API_BASE_URL = 'http://localhost:3000';

interface TestResult {
  test_name: string;
  response_time_ms: number;
  cache_hit: boolean;
  data_count: number;
  success: boolean;
  error?: string;
}

/**
 * 发送API请求并测量响应时间
 */
async function test_api_request(url: string, test_name: string): Promise<TestResult> {
  const start_time = Date.now();

  try {
    const response = await axios.get(url);
    const response_time = Date.now() - start_time;

    return {
      test_name,
      response_time_ms: response_time,
      cache_hit: response_time < 100, // 假设<100ms是缓存命中
      data_count: Array.isArray(response.data.data) ? response.data.data.length : 0,
      success: response.data.success
    };
  } catch (error: any) {
    return {
      test_name,
      response_time_ms: Date.now() - start_time,
      cache_hit: false,
      data_count: 0,
      success: false,
      error: error.message
    };
  }
}

/**
 * 清空Redis缓存
 */
async function clear_cache(): Promise<void> {
  console.log('📋 清空Redis缓存以模拟首次请求...');
  // 注意：这需要在后端添加一个清空缓存的API端点
  // 或者手动重启服务
  console.log('⚠️  请手动重启服务或执行: redis-cli FLUSHDB');
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * 执行性能测试
 */
async function run_performance_test(): Promise<void> {
  console.log('🚀 开始OI缓存性能测试\n');

  const today = new Date().toISOString().split('T')[0];
  const results: TestResult[] = [];

  console.log('='.repeat(80));
  console.log('测试1: 查询当天全部数据（首次请求 - 缓存未命中）');
  console.log('='.repeat(80));

  const test1 = await test_api_request(
    `${API_BASE_URL}/api/oi/statistics?date=${today}`,
    '首次请求（无缓存）'
  );
  results.push(test1);
  print_result(test1);

  console.log('\n⏱️  等待2秒...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('='.repeat(80));
  console.log('测试2: 再次查询当天数据（缓存命中）');
  console.log('='.repeat(80));

  const test2 = await test_api_request(
    `${API_BASE_URL}/api/oi/statistics?date=${today}`,
    '第2次请求（应该缓存命中）'
  );
  results.push(test2);
  print_result(test2);

  console.log('\n⏱️  等待2秒...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('='.repeat(80));
  console.log('测试3: 查询特定币种（验证忽略symbol参数）');
  console.log('='.repeat(80));

  const test3 = await test_api_request(
    `${API_BASE_URL}/api/oi/statistics?date=${today}&symbol=BTCUSDT`,
    '查询BTC（应该仍然缓存命中）'
  );
  results.push(test3);
  print_result(test3);

  console.log('\n⏱️  等待2秒...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('='.repeat(80));
  console.log('测试4: 无日期参数（最近24小时数据）');
  console.log('='.repeat(80));

  const test4 = await test_api_request(
    `${API_BASE_URL}/api/oi/statistics`,
    '最近24小时数据'
  );
  results.push(test4);
  print_result(test4);

  console.log('\n⏱️  等待2秒...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('='.repeat(80));
  console.log('测试5: 历史数据查询（不缓存）');
  console.log('='.repeat(80));

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterday_str = yesterday.toISOString().split('T')[0];

  const test5 = await test_api_request(
    `${API_BASE_URL}/api/oi/statistics?date=${yesterday_str}`,
    '查询昨天数据（不缓存）'
  );
  results.push(test5);
  print_result(test5);

  // 汇总报告
  console.log('\n');
  console.log('='.repeat(80));
  console.log('📊 性能测试汇总报告');
  console.log('='.repeat(80));
  console.log();

  console.table(results.map(r => ({
    '测试名称': r.test_name,
    '响应时间(ms)': r.response_time_ms,
    '缓存命中': r.cache_hit ? '✅ 是' : '❌ 否',
    '数据量': r.data_count,
    '状态': r.success ? '✅ 成功' : '❌ 失败'
  })));

  // 性能分析
  const cache_hits = results.filter(r => r.cache_hit).length;
  const avg_cache_time = results
    .filter(r => r.cache_hit)
    .reduce((sum, r) => sum + r.response_time_ms, 0) / cache_hits || 0;

  const cache_misses = results.filter(r => !r.cache_hit).length;
  const avg_no_cache_time = results
    .filter(r => !r.cache_hit)
    .reduce((sum, r) => sum + r.response_time_ms, 0) / cache_misses || 0;

  console.log();
  console.log('📈 性能统计:');
  console.log(`   缓存命中次数: ${cache_hits}/${results.length}`);
  console.log(`   缓存命中平均响应时间: ${avg_cache_time.toFixed(0)}ms`);
  console.log(`   缓存未命中平均响应时间: ${avg_no_cache_time.toFixed(0)}ms`);
  console.log(`   性能提升: ${((avg_no_cache_time / avg_cache_time) || 0).toFixed(1)}x`);

  console.log();
  console.log('✅ 优化建议:');
  if (cache_hits >= 3) {
    console.log('   ✓ 缓存策略工作正常！');
    console.log('   ✓ 前端查询当天数据响应速度已优化到 <100ms');
    console.log('   ✓ 按币种查询也能复用缓存（symbol参数被忽略）');
  } else {
    console.log('   ⚠️  缓存命中率较低，请检查:');
    console.log('      1. 是否已触发OI轮询（自动预热缓存）');
    console.log('      2. Redis服务是否正常运行');
    console.log('      3. 缓存TTL是否过短');
  }

  console.log();
}

/**
 * 打印单个测试结果
 */
function print_result(result: TestResult): void {
  const cache_status = result.cache_hit ? '✅ 缓存命中' : '❌ 缓存未命中';
  const status_icon = result.success ? '✅' : '❌';

  console.log(`${status_icon} ${result.test_name}`);
  console.log(`   响应时间: ${result.response_time_ms}ms`);
  console.log(`   缓存状态: ${cache_status}`);
  console.log(`   数据条数: ${result.data_count}`);
  if (result.error) {
    console.log(`   错误信息: ${result.error}`);
  }
}

/**
 * 检查服务器是否在线
 */
async function check_server(): Promise<boolean> {
  try {
    const response = await axios.get(`${API_BASE_URL}/health`);
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  console.log('🔍 检查服务器状态...');
  const is_online = await check_server();

  if (!is_online) {
    console.error('❌ 服务器未运行！请先启动服务: npm run dev');
    process.exit(1);
  }

  console.log('✅ 服务器在线\n');

  await run_performance_test();

  console.log('\n🎉 测试完成！');
}

// 运行测试
main().catch(error => {
  console.error('❌ 测试失败:', error);
  process.exit(1);
});
