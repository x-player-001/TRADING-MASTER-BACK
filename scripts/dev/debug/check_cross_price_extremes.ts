/**
 * 检查CROSSUSDT异动是否有价格极值字段
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../../../src/database/oi_repository';
import { ConfigManager } from '../../../src/core/config/config_manager';

async function check_price_extremes() {
  console.log('🔍 检查CROSSUSDT价格极值字段...\n');

  try {
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    const oi_repo = new OIRepository();

    // 获取11月26日的CROSSUSDT异动
    const start_date = new Date('2025-11-26T00:00:00Z');
    const end_date = new Date('2025-11-26T23:59:59Z');

    const anomalies = await oi_repo.get_anomaly_records({
      start_time: start_date,
      end_time: end_date,
      symbol: 'CROSSUSDT',
      order: 'ASC'
    });

    console.log(`找到 ${anomalies.length} 条11月26日的CROSSUSDT异动\n`);

    if (anomalies.length === 0) {
      console.log('❌ 11月26日没有CROSSUSDT的异动记录！');
      process.exit(0);
    }

    console.log('═'.repeat(130));
    console.log(
      '异动时间'.padEnd(25) +
      'daily_price_low'.padEnd(20) +
      'daily_price_high'.padEnd(20) +
      'price_from_low_pct'.padEnd(22) +
      'price_from_high_pct'.padEnd(22)
    );
    console.log('═'.repeat(130));

    let has_complete_fields = 0;
    let missing_fields = 0;

    for (const anomaly of anomalies) {
      const time = new Date(anomaly.anomaly_time).toISOString().substring(0, 19).replace('T', ' ');
      const daily_low = anomaly.daily_price_low || 'NULL';
      const daily_high = anomaly.daily_price_high || 'NULL';
      const from_low = anomaly.price_from_low_pct || 'NULL';
      const from_high = anomaly.price_from_high_pct || 'NULL';

      const is_complete = anomaly.daily_price_low && anomaly.daily_price_high &&
                         anomaly.price_from_low_pct && anomaly.price_from_high_pct;

      if (is_complete) {
        has_complete_fields++;
      } else {
        missing_fields++;
      }

      const status = is_complete ? '✅' : '❌';

      console.log(
        `${status} ${time.padEnd(23)} ` +
        String(daily_low).padEnd(20) +
        String(daily_high).padEnd(20) +
        String(from_low).padEnd(22) +
        String(from_high).padEnd(22)
      );
    }

    console.log('═'.repeat(130));
    console.log(`\n统计:`);
    console.log(`  完整字段: ${has_complete_fields} 条 ✅`);
    console.log(`  缺失字段: ${missing_fields} 条 ❌`);

    if (missing_fields > 0) {
      console.log(`\n⚠️  回测引擎会过滤掉没有价格极值字段的异动！`);
      console.log(`   这就是为什么CROSSUSDT在回测中没有交易。`);
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ 检查失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
    }
    process.exit(1);
  }
}

check_price_extremes();
