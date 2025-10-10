/**
 * 批量获取BTCUSDT历史K线数据
 * 用于回测准备
 */

const axios = require('axios');

const API_BASE = 'http://localhost:3000';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '15m'; // 可改为 1h, 4h, 1d
const START_DATE = '2025-01-01'; // 今年1月1日
const BATCH_SIZE = 1000; // 每批1000根K线

// 时间转换
const start_time = new Date(START_DATE).getTime();
const end_time = Date.now();

// 15分钟 = 900000ms
const interval_ms = 15 * 60 * 1000;

async function fetch_historical_data() {
  console.log(`📊 开始获取 ${SYMBOL} 历史数据`);
  console.log(`时间范围: ${START_DATE} 至 ${new Date().toISOString()}`);
  console.log(`周期: ${INTERVAL}`);
  console.log('='.repeat(50));

  let current_time = start_time;
  let batch_count = 0;
  let total_fetched = 0;

  while (current_time < end_time) {
    batch_count++;

    try {
      console.log(`\n📥 批次 ${batch_count}: 获取从 ${new Date(current_time).toISOString()} 开始的数据...`);

      const response = await axios.get(`${API_BASE}/api/klines/${SYMBOL}/${INTERVAL}`, {
        params: {
          start_time: current_time,
          limit: BATCH_SIZE
        }
      });

      const klines = response.data.data || [];
      total_fetched += klines.length;

      console.log(`✅ 成功获取 ${klines.length} 根K线`);
      console.log(`   时间范围: ${new Date(klines[0]?.open_time).toISOString()} - ${new Date(klines[klines.length-1]?.open_time).toISOString()}`);
      console.log(`   累计: ${total_fetched} 根`);

      // 如果返回的数据少于BATCH_SIZE，说明已经到最新数据
      if (klines.length < BATCH_SIZE) {
        console.log('\n🎉 已获取所有数据！');
        break;
      }

      // 更新下次获取的起始时间
      const last_kline = klines[klines.length - 1];
      current_time = last_kline.close_time + 1;

      // 延迟避免API限流
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error(`❌ 批次 ${batch_count} 失败:`, error.response?.data || error.message);

      // 如果是数据不足，尝试从币安API获取
      if (error.response?.status === 404) {
        console.log('⚠️  本地数据不足，尝试从币安API获取...');

        try {
          const binance_response = await axios.post(`${API_BASE}/api/historical/klines`, {
            symbol: SYMBOL,
            interval: INTERVAL,
            start_time: current_time,
            limit: BATCH_SIZE
          });

          console.log(`✅ 从币安获取并存储 ${binance_response.data.count} 根K线`);
          total_fetched += binance_response.data.count;

          // 更新时间
          current_time += BATCH_SIZE * interval_ms;

        } catch (binance_error) {
          console.error('❌ 币安API也失败:', binance_error.message);
          break;
        }
      } else {
        break;
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`🏁 数据获取完成！`);
  console.log(`   总批次: ${batch_count}`);
  console.log(`   总K线数: ${total_fetched}`);
  console.log(`   时间跨度: ${((end_time - start_time) / (24 * 60 * 60 * 1000)).toFixed(1)} 天`);
}

// 执行
fetch_historical_data()
  .then(() => {
    console.log('\n✅ 脚本执行完成');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ 脚本执行失败:', error);
    process.exit(1);
  });
