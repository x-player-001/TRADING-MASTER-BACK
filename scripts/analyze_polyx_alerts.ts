/**
 * 分析 POLYXUSDT 12月22日后的 SQUEEZE 报警信号
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline15mRepository } from '../src/database/kline_15m_repository';
import { SRAlertService } from '../src/services/sr_alert_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { KlineData } from '../src/analysis/support_resistance_detector';

const SYMBOL = 'DFUSDT';
const INTERVAL = '15m';
const KLINE_CACHE_SIZE = 200;

function format_time(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  console.log('═'.repeat(70));
  console.log('          POLYXUSDT 12月22日后报警信号分析');
  console.log('═'.repeat(70));

  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline15mRepository();

  // 获取12月22日到现在的所有K线
  const start_time = new Date('2025-12-22T00:00:00Z').getTime();
  const end_time = Date.now();

  console.log('\n📡 从服务器数据库获取K线数据...');
  const all_klines_raw = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, end_time);
  console.log(`   获取 ${all_klines_raw.length} 根K线`);

  if (all_klines_raw.length < 50) {
    console.log('❌ 数据不足，需要先拉取历史数据');

    // 尝试获取更早的数据
    const earlier_start = new Date('2025-12-20T00:00:00Z').getTime();
    const earlier_klines = await kline_repo.get_klines_by_time_range(SYMBOL, earlier_start, end_time);
    console.log(`   尝试获取更早数据: ${earlier_klines.length} 根`);

    if (earlier_klines.length < 50) {
      console.log('❌ 数据库中没有足够的 POLYXUSDT K线数据');
      process.exit(1);
    }
  }

  // 重新获取足够的数据用于分析
  const full_start = start_time - KLINE_CACHE_SIZE * 15 * 60 * 1000;
  const full_klines_raw = await kline_repo.get_klines_by_time_range(SYMBOL, full_start, end_time);
  console.log(`   包含历史数据共 ${full_klines_raw.length} 根K线`);

  // 转换数据
  const all_klines: KlineData[] = full_klines_raw.map(k => ({
    open_time: k.open_time,
    close_time: k.close_time,
    open: parseFloat(k.open as any),
    high: parseFloat(k.high as any),
    low: parseFloat(k.low as any),
    close: parseFloat(k.close as any),
    volume: parseFloat(k.volume as any)
  }));

  if (all_klines.length < KLINE_CACHE_SIZE) {
    console.log('❌ 数据不足，无法分析');
    process.exit(1);
  }

  // 遍历每根K线，检测是否会触发SQUEEZE报警
  console.log('\n📊 分析每个时间点的报警情况...\n');

  const squeeze_alerts: Array<{
    time: number;
    ma_score: number;
    squeeze_pct: number;
    total_score: number;
    direction: string;
  }> = [];

  // 只分析12月22日之后的K线
  const dec22_start = new Date('2025-12-22T00:00:00Z').getTime();

  for (let i = KLINE_CACHE_SIZE; i < all_klines.length; i++) {
    const current_kline = all_klines[i];

    // 只分析12月22日之后的
    if (current_kline.open_time < dec22_start) {
      continue;
    }

    const klines_slice = all_klines.slice(i - KLINE_CACHE_SIZE + 1, i + 1);

    // 创建服务实例
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
      cooldown_ms: 0  // 禁用冷却，检测所有潜在信号
    });

    // 更新支撑阻力位并获取预测
    alert_service.update_levels(SYMBOL, INTERVAL, klines_slice);
    const prediction = alert_service.get_breakout_prediction(SYMBOL, INTERVAL, klines_slice);

    if (prediction && prediction.feature_scores.ma_convergence_score >= 95) {
      // 计算实际粘合度
      const closes = klines_slice.map(k => k.close);
      const calcMA = (data: number[], period: number) =>
        data.slice(-period).reduce((a, b) => a + b, 0) / period;
      const ma5 = calcMA(closes, 5);
      const ma10 = calcMA(closes, 10);
      const ma20 = calcMA(closes, 20);
      const price = closes[closes.length - 1];
      const squeeze_pct = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / price * 100;

      squeeze_alerts.push({
        time: current_kline.open_time,
        ma_score: prediction.feature_scores.ma_convergence_score,
        squeeze_pct,
        total_score: prediction.total_score,
        direction: prediction.predicted_direction
      });
    }
  }

  // 输出结果
  console.log('═'.repeat(70));
  console.log(`📢 共检测到 ${squeeze_alerts.length} 个 SQUEEZE 报警信号`);
  console.log('═'.repeat(70));

  if (squeeze_alerts.length > 0) {
    console.log('\n时间                  | 粘合度%  | MA评分 | 综合评分 | 方向');
    console.log('-'.repeat(70));

    for (const alert of squeeze_alerts) {
      console.log(
        `${format_time(alert.time)} | ` +
        `${alert.squeeze_pct.toFixed(3).padStart(7)}% | ` +
        `${alert.ma_score.toString().padStart(5)} | ` +
        `${alert.total_score.toFixed(1).padStart(7)} | ` +
        `${alert.direction}`
      );
    }

    // 合并连续信号（30分钟内的算同一个信号）
    console.log('\n' + '═'.repeat(70));
    console.log('📊 合并连续信号 (30分钟内算同一个):');
    console.log('═'.repeat(70));

    const merged: typeof squeeze_alerts = [];
    for (const alert of squeeze_alerts) {
      const last = merged[merged.length - 1];
      if (!last || alert.time - last.time > 30 * 60 * 1000) {
        merged.push(alert);
      }
    }

    console.log(`\n实际独立信号: ${merged.length} 个\n`);
    for (const alert of merged) {
      console.log(
        `${format_time(alert.time)} | 粘合度 ${alert.squeeze_pct.toFixed(3)}% | MA评分 ${alert.ma_score} | 方向 ${alert.direction}`
      );
    }
  } else {
    console.log('\n没有检测到符合条件的 SQUEEZE 信号 (MA收敛评分 >= 95)');
  }

  console.log('\n✅ 分析完成');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
