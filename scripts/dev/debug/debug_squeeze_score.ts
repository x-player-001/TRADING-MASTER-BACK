/**
 * 调试 SQUEEZE 评分
 * 精确模拟实时监控时的评分计算
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline15mRepository } from '../../../src/database/kline_15m_repository';
import { SRAlertService } from '../../../src/services/sr_alert_service';
import { ConfigManager } from '../../../src/core/config/config_manager';
import { KlineData } from '../../../src/analysis/support_resistance_detector';

const SYMBOL = 'DFUSDT';
const INTERVAL = '15m';
const KLINE_CACHE_SIZE = 200; // 与 run_sr_monitor.ts 一致

function format_time(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  console.log('═'.repeat(70));
  console.log('          SQUEEZE 评分调试');
  console.log('═'.repeat(70));

  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline15mRepository();

  // 创建与 run_sr_monitor.ts 相同配置的服务
  const alert_service = new SRAlertService({
    approaching_threshold_pct: 0.5,
    touched_threshold_pct: 0.1,
    pivot_left_bars: 5,
    pivot_right_bars: 5,
    cluster_threshold_pct: 0.5,
    min_touch_count: 2,
    min_strength: 25,
    max_levels: 15,
    min_breakout_score: 60,
    enable_squeeze_alert: true,
    squeeze_score_threshold: 80,
    cooldown_ms: 0  // 禁用冷却，方便测试
  });

  // 获取最新200根K线
  const now = Date.now();
  const start_time = now - KLINE_CACHE_SIZE * 15 * 60 * 1000;

  console.log('\n📡 获取最新K线数据...');
  const raw_klines = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, now);
  console.log(`   获取 ${raw_klines.length} 根K线`);

  if (raw_klines.length < 50) {
    console.log('❌ 数据不足');
    process.exit(1);
  }

  // 转换为 KlineData 格式
  const klines: KlineData[] = raw_klines.map(k => ({
    open_time: k.open_time,
    close_time: k.close_time,
    open: parseFloat(k.open as any),
    high: parseFloat(k.high as any),
    low: parseFloat(k.low as any),
    close: parseFloat(k.close as any),
    volume: parseFloat(k.volume as any)
  }));

  const last_kline = klines[klines.length - 1];
  const current_price = last_kline.close;

  console.log(`\n📍 当前信息:`);
  console.log(`   K线时间: ${format_time(last_kline.open_time)}`);
  console.log(`   当前价格: ${current_price.toFixed(6)}`);

  // 第一步：更新支撑阻力位
  console.log('\n📊 步骤1: 检测支撑阻力位...');
  const sr_levels = alert_service.update_levels(SYMBOL, INTERVAL, klines);
  console.log(`   检测到 ${sr_levels.length} 个支撑阻力位:`);

  for (const level of sr_levels) {
    const dist = ((level.price - current_price) / current_price * 100);
    const dir = dist > 0 ? '↑' : '↓';
    console.log(`   ${dir} ${level.type.padEnd(10)} ${level.price.toFixed(6)} (${dist > 0 ? '+' : ''}${dist.toFixed(2)}%) 强度:${level.strength}`);
  }

  // 第二步：获取爆发预测
  console.log('\n📊 步骤2: 计算爆发预测评分...');
  const prediction = alert_service.get_breakout_prediction(SYMBOL, INTERVAL, klines);

  if (!prediction) {
    console.log('   预测失败');
    process.exit(1);
  }

  console.log(`\n🎯 评分结果:`);
  console.log(`   综合评分: ${prediction.total_score}/100`);
  console.log(`   报警级别: ${prediction.alert_level}`);
  console.log(`   预测方向: ${prediction.predicted_direction}`);

  console.log(`\n📊 各维度评分:`);
  console.log(`   波动收敛: ${prediction.feature_scores.volatility_score}/100`);
  console.log(`   成交量萎缩: ${prediction.feature_scores.volume_score}/100`);
  console.log(`   均线收敛: ${prediction.feature_scores.ma_convergence_score}/100`);
  console.log(`   位置接近: ${prediction.feature_scores.position_score}/100`);
  console.log(`   形态特征: ${prediction.feature_scores.pattern_score}/100`);

  if (prediction.nearest_level) {
    console.log(`\n📍 最近支撑阻力位:`);
    console.log(`   类型: ${prediction.nearest_level.type}`);
    console.log(`   价格: ${prediction.nearest_level.price.toFixed(6)}`);
    console.log(`   距离: ${prediction.distance_to_level_pct.toFixed(2)}%`);
    console.log(`   强度: ${prediction.nearest_level.strength}`);
  }

  console.log(`\n📝 描述: ${prediction.description}`);

  // 第三步：检查是否触发 SQUEEZE 报警
  console.log('\n📊 步骤3: 检查报警触发...');
  const alerts = alert_service.check_alerts_with_prediction(
    SYMBOL, INTERVAL, klines, current_price, last_kline.open_time
  );

  if (alerts.length === 0) {
    console.log(`   ❌ 未触发报警 (阈值: SQUEEZE >= 80, APPROACHING/TOUCHED >= 60)`);
  } else {
    console.log(`   ✅ 触发 ${alerts.length} 个报警:`);
    for (const alert of alerts) {
      console.log(`\n   📢 ${alert.alert_type}:`);
      console.log(`      评分: ${alert.breakout_score}`);
      console.log(`      波动: ${alert.volatility_score}`);
      console.log(`      量能: ${alert.volume_score}`);
      console.log(`      均线: ${alert.ma_convergence_score}`);
      console.log(`      形态: ${alert.pattern_score}`);
      console.log(`      方向: ${alert.predicted_direction}`);
      console.log(`      描述: ${alert.description}`);
    }
  }

  // 对比 12月21日突破前
  console.log('\n' + '═'.repeat(70));
  console.log('📋 12月21日突破前的评分分析');
  console.log('═'.repeat(70));

  // 突破发生在 12:30，分析 04:00 到 12:15 之间每个时间点的评分
  const analysis_times = [
    '2025-12-21 04:00:00',
    '2025-12-21 06:00:00',
    '2025-12-21 08:00:00',
    '2025-12-21 10:00:00',
    '2025-12-21 12:00:00',
    '2025-12-21 12:15:00'
  ];

  console.log('\n📊 突破前各时间点评分:');
  console.log('   时间                | 综合  | 波动  | 量能  | 均线  | 位置  | 形态');
  console.log('   ' + '-'.repeat(75));

  for (const time_str of analysis_times) {
    const time_point = new Date(time_str + ' UTC').getTime();
    const point_klines_raw = await kline_repo.get_klines_by_time_range(
      SYMBOL,
      time_point - KLINE_CACHE_SIZE * 15 * 60 * 1000,
      time_point
    );

    if (point_klines_raw.length < 50) continue;

    const point_klines: KlineData[] = point_klines_raw.map(k => ({
      open_time: k.open_time,
      close_time: k.close_time,
      open: parseFloat(k.open as any),
      high: parseFloat(k.high as any),
      low: parseFloat(k.low as any),
      close: parseFloat(k.close as any),
      volume: parseFloat(k.volume as any)
    }));

    const point_service = new SRAlertService({
      pivot_left_bars: 5,
      pivot_right_bars: 5,
      cluster_threshold_pct: 0.5,
      min_touch_count: 2,
      min_strength: 25,
      max_levels: 15,
      cooldown_ms: 0
    });

    point_service.update_levels(SYMBOL, INTERVAL, point_klines);
    const point_pred = point_service.get_breakout_prediction(SYMBOL, INTERVAL, point_klines);

    if (point_pred) {
      const { feature_scores: fs, total_score } = point_pred;
      const trigger = total_score >= 80 ? '🔔' : total_score >= 60 ? '⚠️' : '  ';
      console.log(`   ${time_str} | ${total_score.toFixed(0).padStart(4)} ${trigger} | ${fs.volatility_score.toString().padStart(4)} | ${fs.volume_score.toString().padStart(4)} | ${fs.ma_convergence_score.toString().padStart(4)} | ${fs.position_score.toString().padStart(4)} | ${fs.pattern_score.toString().padStart(4)}`);
    }
  }

  // 对比数据库中的信号
  console.log('\n' + '═'.repeat(70));
  console.log('📋 数据库中 2025-12-22 13:15 的信号详情');
  console.log('═'.repeat(70));

  // 那个信号的时间
  const signal_time = new Date('2025-12-22 13:15:00 UTC').getTime();

  // 获取那个时间点的K线数据
  const signal_klines_raw = await kline_repo.get_klines_by_time_range(
    SYMBOL,
    signal_time - KLINE_CACHE_SIZE * 15 * 60 * 1000,
    signal_time
  );

  console.log(`\n📡 信号时间点的K线数据: ${signal_klines_raw.length} 根`);

  if (signal_klines_raw.length >= 50) {
    const signal_klines: KlineData[] = signal_klines_raw.map(k => ({
      open_time: k.open_time,
      close_time: k.close_time,
      open: parseFloat(k.open as any),
      high: parseFloat(k.high as any),
      low: parseFloat(k.low as any),
      close: parseFloat(k.close as any),
      volume: parseFloat(k.volume as any)
    }));

    // 创建新的服务实例来避免缓存影响
    const signal_service = new SRAlertService({
      approaching_threshold_pct: 0.5,
      touched_threshold_pct: 0.1,
      pivot_left_bars: 5,
      pivot_right_bars: 5,
      cluster_threshold_pct: 0.5,
      min_touch_count: 2,
      min_strength: 25,
      max_levels: 15,
      min_breakout_score: 60,
      enable_squeeze_alert: true,
      squeeze_score_threshold: 80,
      cooldown_ms: 0
    });

    signal_service.update_levels(SYMBOL, INTERVAL, signal_klines);
    const signal_prediction = signal_service.get_breakout_prediction(SYMBOL, INTERVAL, signal_klines);

    if (signal_prediction) {
      console.log(`\n🎯 重新计算 13:15 时间点的评分:`);
      console.log(`   综合评分: ${signal_prediction.total_score}/100 (数据库记录: 84)`);
      console.log(`   波动收敛: ${signal_prediction.feature_scores.volatility_score}/100 (数据库记录: 83)`);
      console.log(`   成交量萎缩: ${signal_prediction.feature_scores.volume_score}/100 (数据库记录: 84)`);
      console.log(`   均线收敛: ${signal_prediction.feature_scores.ma_convergence_score}/100 (数据库记录: 100)`);
      console.log(`   位置接近: ${signal_prediction.feature_scores.position_score}/100`);
      console.log(`   形态特征: ${signal_prediction.feature_scores.pattern_score}/100 (数据库记录: 69)`);

      const diff = Math.abs(signal_prediction.total_score - 84);
      if (diff > 5) {
        console.log(`\n   ⚠️ 评分差异较大 (${diff.toFixed(1)}分), 可能是数据差异导致`);
      }
    }
  }

  console.log('\n✅ 调试完成');
  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
