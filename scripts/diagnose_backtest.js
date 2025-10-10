/**
 * 回测问题诊断脚本
 */

const axios = require('axios');

const API_BASE = 'http://localhost:3000';

async function diagnose() {
  console.log('🔍 开始诊断回测问题...\n');

  // 1. 检查数据库K线数据
  console.log('📊 检查1: BTCUSDT 15分钟K线数据');
  console.log('='.repeat(50));

  try {
    const klineRes = await axios.get(`${API_BASE}/api/klines/BTCUSDT/15m`, {
      params: { limit: 1 }
    });

    const klines = klineRes.data.data || [];

    if (klines.length === 0) {
      console.log('❌ 数据库中没有BTCUSDT 15分钟K线数据！');
      console.log('\n💡 解决方案：');
      console.log('运行以下命令补全数据：');
      console.log('curl -X POST http://localhost:3000/api/historical/backfill \\');
      console.log('  -H "Content-Type: application/json" \\');
      console.log('  -d \'{"symbol":"BTCUSDT","interval":"15m","batch_size":1000}\'');
      return;
    }

    console.log(`✅ 找到K线数据，最新一根：`);
    console.log(`   时间: ${new Date(klines[0].open_time).toISOString()}`);
    console.log(`   价格: ${klines[0].close}`);

  } catch (error) {
    console.log('❌ 无法获取K线数据:', error.message);
    return;
  }

  // 2. 检查数据库数据量
  console.log('\n📈 检查2: 数据库K线数量');
  console.log('='.repeat(50));

  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `mysql -u root -p${process.env.DB_PASSWORD || 'your_password'} trading_master -e "SELECT COUNT(*) as count, MIN(FROM_UNIXTIME(open_time/1000)) as earliest, MAX(FROM_UNIXTIME(open_time/1000)) as latest FROM kline_15m WHERE symbol='BTCUSDT';" -s`,
      { encoding: 'utf-8' }
    );

    const lines = result.trim().split('\n');
    const [count, earliest, latest] = lines[1].split('\t');

    console.log(`   总数量: ${count} 根K线`);
    console.log(`   最早时间: ${earliest}`);
    console.log(`   最新时间: ${latest}`);

    if (parseInt(count) < 200) {
      console.log('\n⚠️  警告: K线数据不足200根，无法满足策略lookback_period要求！');
      console.log('💡 建议: 补全至少500根K线数据');
    } else {
      console.log(`\n✅ 数据量充足 (${count} 根)`);
    }

  } catch (error) {
    console.log('⚠️  无法查询数据库，跳过此检查');
  }

  // 3. 检查策略配置
  console.log('\n⚙️  检查3: 策略配置');
  console.log('='.repeat(50));

  try {
    const strategyRes = await axios.get(`${API_BASE}/api/quant/strategies/1`);
    const strategy = strategyRes.data.data;

    console.log(`   策略名称: ${strategy.name}`);
    console.log(`   策略类型: ${strategy.type}`);
    console.log(`   是否启用: ${strategy.enabled ? '是' : '否'}`);
    console.log(`   参数配置:`);
    console.log(JSON.stringify(strategy.parameters, null, 4));

    const params = strategy.parameters;

    // 检查参数是否过严
    let warnings = [];
    if (params.lookback_period > 150) {
      warnings.push(`lookback_period (${params.lookback_period}) 较大，需要更多历史数据`);
    }
    if (params.min_confidence > 0.75) {
      warnings.push(`min_confidence (${params.min_confidence}) 较高，可能导致信号过少`);
    }
    if (params.min_strength > 0.7) {
      warnings.push(`min_strength (${params.min_strength}) 较高，可能导致信号过少`);
    }

    if (warnings.length > 0) {
      console.log('\n⚠️  参数警告:');
      warnings.forEach(w => console.log(`   - ${w}`));
      console.log('\n💡 建议放宽参数：');
      console.log(`curl -X PUT ${API_BASE}/api/quant/strategies/1 \\`);
      console.log('  -H "Content-Type: application/json" \\');
      console.log('  -d \'{"parameters": {"lookback_period": 100, "min_confidence": 0.6, "min_strength": 0.5}}\'');
    } else {
      console.log('\n✅ 参数配置合理');
    }

  } catch (error) {
    console.log('❌ 无法获取策略配置:', error.message);
  }

  // 4. 建议的回测时间范围
  console.log('\n📅 检查4: 回测时间范围建议');
  console.log('='.repeat(50));

  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

  console.log(`   建议开始时间: ${new Date(thirtyDaysAgo).toISOString()}`);
  console.log(`   建议结束时间: ${new Date(now).toISOString()}`);
  console.log(`   时间戳: start_time=${thirtyDaysAgo}, end_time=${now}`);

  console.log('\n' + '='.repeat(50));
  console.log('🎯 诊断完成！');
}

diagnose().catch(console.error);
