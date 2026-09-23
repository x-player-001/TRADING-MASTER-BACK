/**
 * 深入分析 SQDUSDT 12.31 16:00 为什么没有报警
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '../../../src/core/config/config_manager';
import { DatabaseConfig } from '../../../src/core/config/database';

async function main() {
  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const connection = await DatabaseConfig.get_mysql_connection();

  try {
    console.log('═'.repeat(70));
    console.log('             SQDUSDT 报警深度分析');
    console.log('═'.repeat(70));

    // 1. 检查监控配置 - 显示原始时间戳
    console.log('\n📋 1. 监控配置详情:');
    const [symbols] = await connection.execute(`
      SELECT *, UNIX_TIMESTAMP(created_at) * 1000 as created_ts FROM volume_monitor_symbols WHERE symbol = 'SQDUSDT'
    `);
    const config = (symbols as any[])[0];
    if (config) {
      console.log(`   symbol: ${config.symbol}`);
      console.log(`   enabled: ${config.enabled}`);
      console.log(`   volume_multiplier: ${config.volume_multiplier}`);
      console.log(`   lookback_bars: ${config.lookback_bars}`);
      console.log(`   created_at (raw): ${config.created_at}`);
      console.log(`   created_ts (ms): ${config.created_ts}`);

      // MySQL TIMESTAMP 存储的是 UTC 时间，显示时会转换为连接时区
      const created_date = new Date(Number(config.created_ts));
      console.log(`   created_at (UTC): ${created_date.toISOString()}`);
      console.log(`   created_at (北京): ${created_date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    }

    // 2. 16:00 K线的时间
    // 北京时间 16:00 = UTC 08:00
    const target_time_beijing = '2025-12-31 16:00:00';
    const target_time_utc = new Date('2025-12-31T08:00:00.000Z').getTime();

    console.log(`\n📊 2. 目标K线时间分析:`);
    console.log(`   北京时间: ${target_time_beijing}`);
    console.log(`   UTC时间: ${new Date(target_time_utc).toISOString()}`);
    console.log(`   时间戳(ms): ${target_time_utc}`);

    // 3. 对比时间
    if (config) {
      const config_time = Number(config.created_ts);
      console.log(`\n📅 3. 时间对比:`);
      console.log(`   监控配置创建时间戳: ${config_time}`);
      console.log(`   16:00 K线时间戳: ${target_time_utc}`);
      console.log(`   差值: ${(config_time - target_time_utc) / 1000 / 60} 分钟`);

      if (config_time < target_time_utc) {
        console.log(`   ✅ 监控配置在K线之前创建`);
      } else {
        console.log(`   ❌ 监控配置在K线之后创建`);
      }
    }

    // 4. 查询16:00这根K线
    const table_name = 'kline_5m_20251231';
    console.log(`\n📊 4. 查询16:00 K线数据:`);
    try {
      const [klines] = await connection.execute(`
        SELECT * FROM ${table_name}
        WHERE symbol = 'SQDUSDT' AND open_time = ?
      `, [target_time_utc]);

      if ((klines as any[]).length > 0) {
        const k = (klines as any[])[0];
        console.log(`   open_time: ${k.open_time} (${new Date(Number(k.open_time)).toISOString()})`);
        console.log(`   volume: ${parseFloat(k.volume).toFixed(2)}`);
        console.log(`   close: ${parseFloat(k.close)}`);
      } else {
        console.log(`   ⚠️ 未找到16:00的K线`);
      }
    } catch (err: any) {
      console.log(`   Error: ${err.message}`);
    }

    // 5. 检查 run_volume_monitor 脚本是否在运行
    console.log(`\n🔍 5. 排查可能的原因:`);
    console.log(`   a) run_volume_monitor.ts 脚本是否在服务器上运行?`);
    console.log(`   b) 脚本启动时间是否在16:00之前?`);
    console.log(`   c) 配置刷新间隔是1分钟，添加后需要等待刷新`);

    // 6. 查看成交量监控服务的K线缓存逻辑
    console.log(`\n📈 6. 成交量判断逻辑分析:`);

    // 获取16:00之前的20根K线用于计算平均值
    try {
      const [history] = await connection.execute(`
        SELECT open_time, volume FROM ${table_name}
        WHERE symbol = 'SQDUSDT' AND open_time < ?
        ORDER BY open_time DESC
        LIMIT 25
      `, [target_time_utc]);

      const volumes = (history as any[]).map(k => parseFloat(k.volume)).reverse();
      console.log(`   历史K线数量: ${volumes.length}`);

      if (volumes.length >= 20) {
        const lookback = 20;
        const recent = volumes.slice(-lookback);
        const avg = recent.reduce((a, b) => a + b, 0) / lookback;
        console.log(`   最近${lookback}根平均成交量: ${avg.toFixed(2)}`);

        // 16:00的成交量
        const [target_kline] = await connection.execute(`
          SELECT volume FROM ${table_name}
          WHERE symbol = 'SQDUSDT' AND open_time = ?
        `, [target_time_utc]);

        if ((target_kline as any[]).length > 0) {
          const current_vol = parseFloat((target_kline as any[])[0].volume);
          const ratio = current_vol / avg;
          console.log(`   16:00 成交量: ${current_vol.toFixed(2)}`);
          console.log(`   成交量倍数: ${ratio.toFixed(2)}x`);
          console.log(`   阈值: 2.5x`);
          console.log(`   是否应该触发: ${ratio >= 2.5 ? '✅ 是' : '❌ 否'}`);
        }
      } else {
        console.log(`   ⚠️ 历史K线不足20根，无法计算平均值`);
        console.log(`   这可能是没有报警的原因！脚本刚启动时缓存为空`);
      }
    } catch (err: any) {
      console.log(`   Error: ${err.message}`);
    }

    // 7. 检查volume_alerts表中所有SQDUSDT的记录
    console.log(`\n🔔 7. SQDUSDT 所有报警记录:`);
    try {
      const [alerts] = await connection.execute(`
        SELECT * FROM volume_alerts WHERE symbol = 'SQDUSDT' ORDER BY kline_time DESC LIMIT 10
      `);
      if ((alerts as any[]).length === 0) {
        console.log(`   无任何报警记录`);
      } else {
        for (const a of alerts as any[]) {
          console.log(`   ${new Date(Number(a.kline_time)).toISOString()} | ratio: ${a.volume_ratio}x`);
        }
      }
    } catch (err: any) {
      console.log(`   Error: ${err.message}`);
    }

    // 8. 检查脚本的K线缓存情况
    console.log(`\n💡 8. 关键问题检查:`);
    console.log(`   VolumeMonitorService 在处理K线时需要从缓存中获取历史K线`);
    console.log(`   如果缓存中的K线数量不足 lookback_bars(20)，则无法计算平均值`);
    console.log(`   脚本启动后需要等待至少20根K线(100分钟)才能开始判断`);

    console.log('\n' + '═'.repeat(70));

  } finally {
    connection.release();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
