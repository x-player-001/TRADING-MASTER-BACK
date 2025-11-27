/**
 * 检查CROSSUSDT的异动记录和评分
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../src/database/oi_repository';
import { SignalGenerator } from '../src/trading/signal_generator';
import { ConfigManager } from '../src/core/config/config_manager';

async function check_cross_anomalies() {
  console.log('🔍 检查CROSSUSDT异动记录...\n');

  try {
    // 初始化配置管理器
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    const oi_repo = new OIRepository();
    const signal_generator = new SignalGenerator();

    // 获取最近7天的CROSSUSDT异动
    const start_date = new Date('2025-11-19T00:00:00Z');
    const end_date = new Date('2025-11-26T23:59:59Z');

    const anomalies = await oi_repo.get_anomaly_records({
      start_time: start_date,
      end_time: end_date,
      symbol: 'CROSSUSDT',
      order: 'ASC'
    });

    console.log(`找到 ${anomalies.length} 条CROSSUSDT异动记录\n`);

    if (anomalies.length === 0) {
      console.log('❌ 该时间段内没有CROSSUSDT的异动记录！');
      process.exit(0);
    }

    console.log('═'.repeat(120));
    console.log('异动时间'.padEnd(25) + 'OI变化'.padEnd(12) + '价格变化'.padEnd(12) + '大户持仓'.padEnd(12) + '大户账户'.padEnd(12) + '资金费率'.padEnd(12) + '评分');
    console.log('═'.repeat(120));

    for (const anomaly of anomalies) {
      // 生成信号和评分
      const signal = signal_generator.generate_signal(anomaly);

      const anomaly_time = new Date(anomaly.anomaly_time).toISOString().substring(0, 19).replace('T', ' ');
      const oi_change = `${parseFloat(anomaly.percent_change.toString()).toFixed(2)}%`;
      const price_change = anomaly.price_change_percent
        ? `${parseFloat(anomaly.price_change_percent.toString()).toFixed(2)}%`
        : 'N/A';
      const trader_ratio = anomaly.top_trader_long_short_ratio
        ? parseFloat(anomaly.top_trader_long_short_ratio.toString()).toFixed(2)
        : 'N/A';
      const account_ratio = anomaly.top_account_long_short_ratio
        ? parseFloat(anomaly.top_account_long_short_ratio.toString()).toFixed(2)
        : 'N/A';
      const funding_rate = anomaly.funding_rate_after
        ? `${(parseFloat(anomaly.funding_rate_after.toString()) * 100).toFixed(4)}%`
        : 'N/A';
      const score = signal ? signal.score.toFixed(2) : 'N/A';

      console.log(
        anomaly_time.padEnd(25) +
        oi_change.padEnd(12) +
        price_change.padEnd(12) +
        trader_ratio.padEnd(12) +
        account_ratio.padEnd(12) +
        funding_rate.padEnd(12) +
        score
      );
    }

    console.log('═'.repeat(120));

    // 统计评分分布
    const signals_with_scores = anomalies
      .map(a => ({ anomaly: a, signal: signal_generator.generate_signal(a) }))
      .filter(s => s.signal !== null);

    const score_ranges = {
      '9-10分': 0,
      '8-9分': 0,
      '7-8分': 0,
      '6-7分': 0,
      '5-6分': 0,
      '0-5分': 0
    };

    signals_with_scores.forEach(({ signal }) => {
      const score = signal!.score;
      if (score >= 9) score_ranges['9-10分']++;
      else if (score >= 8) score_ranges['8-9分']++;
      else if (score >= 7) score_ranges['7-8分']++;
      else if (score >= 6) score_ranges['6-7分']++;
      else if (score >= 5) score_ranges['5-6分']++;
      else score_ranges['0-5分']++;
    });

    console.log('\n📊 评分分布统计:');
    Object.entries(score_ranges).forEach(([range, count]) => {
      if (count > 0) {
        console.log(`  ${range}: ${count} 个`);
      }
    });

    const score7_plus = signals_with_scores.filter(s => s.signal!.score >= 7).length;
    console.log(`\n✅ 评分 ≥7分 的信号: ${score7_plus} 个`);

    if (score7_plus === 0) {
      console.log('\n⚠️  这就是为什么CROSSUSDT没有交易 - 所有信号评分都 <7分！');
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ 检查失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('堆栈:', error.stack);
    }
    process.exit(1);
  }
}

check_cross_anomalies();
