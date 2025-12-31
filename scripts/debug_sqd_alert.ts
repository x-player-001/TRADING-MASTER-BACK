/**
 * 分析 SQDUSDT 12.31 16:00 为什么没有报警
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '../src/core/config/config_manager';
import { DatabaseConfig } from '../src/core/config/database';

async function main() {
  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const connection = await DatabaseConfig.get_mysql_connection();

  try {
    console.log('═'.repeat(70));
    console.log('             SQDUSDT 报警分析');
    console.log('═'.repeat(70));

    // 1. 检查监控配置
    console.log('\n📋 1. 监控配置:');
    const [symbols] = await connection.execute(`
      SELECT * FROM volume_monitor_symbols WHERE symbol = 'SQDUSDT'
    `);
    console.log(symbols);

    // 2. 查询 16:00 这根K线数据
    // 16:00 北京时间 = 08:00 UTC
    // 5m K线: 08:00 ~ 08:04:59.999
    const target_time_utc = new Date('2025-12-31T08:00:00.000Z').getTime();
    const target_time_end = new Date('2025-12-31T08:04:59.999Z').getTime();

    console.log(`\n📊 2. 目标K线时间: ${new Date(target_time_utc).toISOString()} (北京时间 16:00)`);

    // 查询5m K线表
    const table_name = 'kline_5m_20251231';
    try {
      const [klines] = await connection.execute(`
        SELECT * FROM ${table_name}
        WHERE symbol = 'SQDUSDT' AND open_time >= ? AND open_time <= ?
        ORDER BY open_time
      `, [target_time_utc - 60 * 60 * 1000, target_time_end]);  // 往前查1小时

      console.log(`\n📊 3. 最近1小时的5m K线数据 (共 ${(klines as any[]).length} 根):`);
      for (const k of klines as any[]) {
        const time_str = new Date(Number(k.open_time)).toISOString();
        const beijing_hour = (new Date(Number(k.open_time)).getUTCHours() + 8) % 24;
        const beijing_min = new Date(Number(k.open_time)).getUTCMinutes();
        console.log(`   ${beijing_hour.toString().padStart(2, '0')}:${beijing_min.toString().padStart(2, '0')} | 成交量: ${parseFloat(k.volume).toFixed(2)} | 收盘: ${parseFloat(k.close).toFixed(4)}`);
      }

      // 4. 分析成交量是否达到放量标准
      if ((klines as any[]).length > 0) {
        const symbol_config = (symbols as any[])[0];
        const lookback_bars = symbol_config?.lookback_bars || 20;
        const volume_multiplier = symbol_config?.volume_multiplier || 2.5;

        console.log(`\n📈 4. 放量判断 (lookback=${lookback_bars}, multiplier=${volume_multiplier}):`);

        // 获取更多历史数据计算平均成交量
        const [history_klines] = await connection.execute(`
          SELECT * FROM ${table_name}
          WHERE symbol = 'SQDUSDT' AND open_time < ?
          ORDER BY open_time DESC
          LIMIT ?
        `, [target_time_utc, lookback_bars + 10]);

        const volumes = (history_klines as any[]).map(k => parseFloat(k.volume)).reverse();
        console.log(`   历史 ${volumes.length} 根K线成交量:`, volumes.map(v => v.toFixed(2)).join(', '));

        if (volumes.length >= lookback_bars) {
          const recent_volumes = volumes.slice(-lookback_bars);
          const avg_volume = recent_volumes.reduce((a, b) => a + b, 0) / recent_volumes.length;
          console.log(`   平均成交量 (最近${lookback_bars}根): ${avg_volume.toFixed(2)}`);

          // 找到16:00这根K线的成交量
          const target_kline = (klines as any[]).find(k => Number(k.open_time) === target_time_utc);
          if (target_kline) {
            const current_volume = parseFloat(target_kline.volume);
            const ratio = current_volume / avg_volume;
            console.log(`   16:00 成交量: ${current_volume.toFixed(2)}`);
            console.log(`   成交量倍数: ${ratio.toFixed(2)}x`);
            console.log(`   触发阈值: ${volume_multiplier}x`);
            console.log(`   是否触发: ${ratio >= volume_multiplier ? '✅ 是' : '❌ 否'}`);
          } else {
            console.log('   ⚠️ 未找到16:00的K线数据');
          }
        }
      }

      // 5. 查询报警记录
      console.log('\n🔔 5. 查询报警记录:');
      const [alerts] = await connection.execute(`
        SELECT * FROM volume_alerts
        WHERE symbol = 'SQDUSDT' AND kline_time >= ? AND kline_time <= ?
        ORDER BY kline_time
      `, [target_time_utc - 2 * 60 * 60 * 1000, target_time_end + 60 * 60 * 1000]);

      if ((alerts as any[]).length === 0) {
        console.log('   无报警记录');
      } else {
        for (const a of alerts as any[]) {
          const time_str = new Date(Number(a.kline_time)).toISOString();
          console.log(`   ${time_str} | 倍数: ${a.volume_ratio}x | 方向: ${a.direction}`);
        }
      }

    } catch (err: any) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        console.log(`   ⚠️ 表 ${table_name} 不存在`);
      } else {
        throw err;
      }
    }

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
