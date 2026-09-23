/**
 * 检查最近异动记录的情绪数据
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../../../src/database/oi_repository';
import { OIAnomalyRecord } from '../../../src/types/oi_types';

async function check_sentiment() {
  const repo = new OIRepository();

  console.log('📊 检查最近10条异动记录的情绪数据...\n');

  const anomalies = await repo.get_anomaly_records({
    limit: 10
  });

  console.log(`找到 ${anomalies.length} 条记录:\n`);

  anomalies.forEach((a: OIAnomalyRecord, idx: number) => {
    console.log(`${idx + 1}. ${a.symbol} [${a.period_seconds / 60}分钟]`);
    console.log(`   时间: ${a.anomaly_time}`);
    console.log(`   OI变化: ${a.percent_change.toFixed(2)}%`);
    console.log(`   大户多空比: ${a.top_trader_long_short_ratio ?? 'NULL'}`);
    console.log(`   账户多空比: ${a.top_account_long_short_ratio ?? 'NULL'}`);
    console.log(`   全局多空比: ${a.global_long_short_ratio ?? 'NULL'}`);
    console.log(`   主动买卖比: ${a.taker_buy_sell_ratio ?? 'NULL'}`);
    console.log('');
  });

  process.exit(0);
}

check_sentiment().catch(error => {
  console.error('❌ 错误:', error);
  process.exit(1);
});
