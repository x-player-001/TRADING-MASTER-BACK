/**
 * 检查11月28日的异动信号详情
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../src/database/oi_repository';
import { OIAnomalyRecord } from '../src/types/oi_types';
import { ConfigManager } from '../src/core/config/config_manager';

async function check_nov28_signals() {
  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const repo = new OIRepository();

  console.log('📊 检查最近的异动信号 (最近24小时)...\n');

  // 获取最近24小时的所有异动
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const anomalies = await repo.get_anomaly_records({
    start_time: yesterday,
    end_time: now,
    order: 'DESC'
  });

  console.log(`找到 ${anomalies.length} 条异动记录`);
  console.log(`时间范围: ${yesterday.toISOString()} ~ ${now.toISOString()}\n`);

  if (anomalies.length === 0) {
    console.log('❌ 最近24小时没有任何异动记录!');
    console.log('提示: OI监控服务可能没有运行,或者市场没有明显异动。');
    process.exit(0);
  }

  // 按信号评分分组统计
  const score_distribution = {
    'score_0_3': 0,
    'score_3_5': 0,
    'score_5_7': 0,
    'score_7_plus': 0,
    'no_score': 0
  };

  const signal_details: any[] = [];

  anomalies.forEach((a: OIAnomalyRecord) => {
    const score = a.signal_score || 0;

    if (score === 0) {
      score_distribution.no_score++;
    } else if (score < 3) {
      score_distribution.score_0_3++;
    } else if (score < 5) {
      score_distribution.score_3_5++;
    } else if (score < 7) {
      score_distribution.score_5_7++;
    } else {
      score_distribution.score_7_plus++;
    }

    // 收集详细信息
    signal_details.push({
      symbol: a.symbol,
      time: a.anomaly_time,
      period: `${a.period_seconds / 60}min`,
      oi_change: parseFloat(a.percent_change.toString()).toFixed(2) + '%',
      price_change: a.price_change_percent ? parseFloat(a.price_change_percent.toString()).toFixed(2) + '%' : 'N/A',
      score: score.toFixed(2),
      confidence: a.signal_confidence ? (parseFloat(a.signal_confidence.toString()) * 100).toFixed(1) + '%' : 'N/A',
      strength: 'N/A', // signal_strength字段不存在于OIAnomalyRecord
      trader_ratio: a.top_trader_long_short_ratio ? parseFloat(a.top_trader_long_short_ratio.toString()).toFixed(2) : 'N/A'
    });
  });

  console.log('📈 信号评分分布:');
  console.log('═'.repeat(80));
  console.log(`  无评分(0分):        ${score_distribution.no_score} 条`);
  console.log(`  极低分(0-3分):      ${score_distribution.score_0_3} 条`);
  console.log(`  低分(3-5分):        ${score_distribution.score_3_5} 条`);
  console.log(`  中等(5-7分):        ${score_distribution.score_5_7} 条`);
  console.log(`  高分(≥7分):         ${score_distribution.score_7_plus} 条 ⭐`);
  console.log('═'.repeat(80));

  // 显示≥7分的信号详情
  const high_score_signals = signal_details.filter(s => parseFloat(s.score) >= 7);

  if (high_score_signals.length > 0) {
    console.log(`\n🎯 符合条件的高分信号 (≥7分): ${high_score_signals.length} 条\n`);

    high_score_signals.forEach((s, idx) => {
      console.log(`${idx + 1}. ${s.symbol} [${s.period}] @ ${s.time}`);
      console.log(`   评分: ${s.score} | 置信度: ${s.confidence} | 强度: ${s.strength}`);
      console.log(`   OI变化: ${s.oi_change} | 价格变化: ${s.price_change}`);
      console.log(`   大户多空比: ${s.trader_ratio}`);
      console.log('');
    });
  } else {
    console.log('\n❌ 没有找到≥7分的信号!');
  }

  // 显示5-7分的信号(接近阈值)
  const medium_score_signals = signal_details.filter(s => parseFloat(s.score) >= 5 && parseFloat(s.score) < 7);

  if (medium_score_signals.length > 0) {
    console.log(`\n📊 接近阈值的信号 (5-7分): ${medium_score_signals.length} 条\n`);

    medium_score_signals.slice(0, 10).forEach((s, idx) => {
      console.log(`${idx + 1}. ${s.symbol} [${s.period}] @ ${s.time}`);
      console.log(`   评分: ${s.score} | 置信度: ${s.confidence} | 强度: ${s.strength}`);
      console.log(`   OI变化: ${s.oi_change} | 价格变化: ${s.price_change}`);
      console.log('');
    });

    if (medium_score_signals.length > 10) {
      console.log(`   ... 还有 ${medium_score_signals.length - 10} 条\n`);
    }
  }

  // 分析为什么没有交易
  console.log('\n🔍 未触发交易的可能原因分析:');
  console.log('═'.repeat(80));

  const issues: string[] = [];

  if (score_distribution.score_7_plus === 0) {
    issues.push('❌ 没有≥7分的信号 (min_signal_score: 7)');
  }

  if (high_score_signals.length > 0) {
    // 检查置信度
    const low_confidence = high_score_signals.filter(s => {
      const conf = parseFloat(s.confidence);
      return !isNaN(conf) && conf < 70;
    });

    if (low_confidence.length > 0) {
      issues.push(`⚠️  ${low_confidence.length}/${high_score_signals.length} 个高分信号置信度<70% (突破策略要求≥70%)`);
    }

    // 注意: signal_strength不存在于数据库中,需要通过SignalGenerator推断
    // 根据评分推断: 4-6分=WEAK, 6-8分=MEDIUM, >8分=STRONG
    const weak_signals = high_score_signals.filter(s => {
      const score = parseFloat(s.score);
      return score < 8; // <8分可能被视为WEAK或低端MEDIUM
    });

    if (weak_signals.length > 0) {
      issues.push(`⚠️  ${weak_signals.length}/${high_score_signals.length} 个高分信号评分<8分 (可能被归类为WEAK/低端MEDIUM)`);
    }

    // 检查价格OI背离
    const divergence_signals = high_score_signals.filter(s => {
      if (s.oi_change === 'N/A' || s.price_change === 'N/A') return false;
      const oi = parseFloat(s.oi_change);
      const price = parseFloat(s.price_change);
      return (oi > 0 && price < 0) || (oi < 0 && price > 0);
    });

    if (divergence_signals.length > 0) {
      issues.push(`⚠️  ${divergence_signals.length}/${high_score_signals.length} 个高分信号价格OI反向 (require_price_oi_alignment: true)`);
    }
  }

  if (issues.length === 0 && high_score_signals.length > 0) {
    issues.push('✅ 高分信号看起来符合条件,可能是风险管理器拒绝(仓位限制/余额不足)');
  } else if (issues.length === 0) {
    issues.push('✅ 没有发现明显问题,但也没有符合条件的信号');
  }

  issues.forEach(issue => console.log(`  ${issue}`));
  console.log('═'.repeat(80));

  process.exit(0);
}

check_nov28_signals().catch(error => {
  console.error('❌ 错误:', error);
  process.exit(1);
});
