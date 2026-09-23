/**
 * 分析 POLYXUSDT 12月22日后的 5m K线报警信号
 * 包括 SQUEEZE 报警和支撑阻力位报警
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline5mRepository } from '../../../src/database/kline_5m_repository';
import { SRAlertService } from '../../../src/services/sr_alert_service';
import { ConfigManager } from '../../../src/core/config/config_manager';
import { KlineData } from '../../../src/analysis/support_resistance_detector';

const SYMBOL = 'POLYXUSDT';
const INTERVAL = '5m';
const KLINE_CACHE_SIZE = 200;

function format_time_utc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

function format_time_beijing(ts: number): string {
  const date = new Date(ts + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

interface AlertRecord {
  time: number;
  type: string;           // SQUEEZE / APPROACHING / TOUCHED
  price: number;
  level_price?: number;
  level_type?: string;    // SUPPORT / RESISTANCE
  distance_pct?: number;
  squeeze_pct?: number;
  total_score: number;
  direction: string;
  gain_24h_pct?: number;  // 24小时涨幅
}

async function main() {
  console.log('═'.repeat(80));
  console.log(`          ${SYMBOL} 12月22日后 5m K线报警信号分析`);
  console.log('═'.repeat(80));

  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline5mRepository();

  // 获取12月21日22:00 UTC (北京时间12月22日06:00)开始的所有K线
  const start_time = new Date('2025-12-21T22:00:00Z').getTime();
  const end_time = Date.now();

  console.log('\n📡 从服务器数据库获取 5m K线数据...');
  const all_klines_raw = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, end_time);
  console.log(`   获取 ${all_klines_raw.length} 根K线`);

  if (all_klines_raw.length < 50) {
    console.log('❌ 数据不足，需要先拉取历史数据');

    const earlier_start = new Date('2025-12-20T00:00:00Z').getTime();
    const earlier_klines = await kline_repo.get_klines_by_time_range(SYMBOL, earlier_start, end_time);
    console.log(`   尝试获取更早数据: ${earlier_klines.length} 根`);

    if (earlier_klines.length < 50) {
      console.log(`❌ 数据库中没有足够的 ${SYMBOL} 5m K线数据`);
      console.log(`   请先运行: npx ts-node -r tsconfig-paths/register scripts/backfill_kline_5m.ts --symbols ${SYMBOL}`);
      process.exit(1);
    }
  }

  // 重新获取足够的数据用于分析
  const full_start = start_time - KLINE_CACHE_SIZE * 5 * 60 * 1000;
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

  console.log('\n📊 分析每个时间点的报警情况...\n');

  const all_alerts: AlertRecord[] = [];
  const dec22_start = new Date('2025-12-21T22:00:00Z').getTime();

  // EMA 计算函数
  const calcEMA = (data: number[], period: number) => {
    if (data.length < period) return data[data.length - 1];
    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }
    return ema;
  };

  // 24小时涨幅计算函数（从 all_klines 中截取到指定索引）
  const calc24hGain = (all_data: KlineData[], end_idx: number): number => {
    const bars_in_24h = 24 * 60 / 5; // 5分钟K线，24小时288根
    const start_idx = Math.max(0, end_idx - bars_in_24h + 1);

    if (end_idx - start_idx < 50) return 0; // 数据太少

    const recent = all_data.slice(start_idx, end_idx + 1);
    const low_24h = Math.min(...recent.map(k => k.low));
    const current_price = recent[recent.length - 1].close;
    return ((current_price - low_24h) / low_24h) * 100;
  };

  for (let i = KLINE_CACHE_SIZE; i < all_klines.length; i++) {
    const current_kline = all_klines[i];

    if (current_kline.open_time < dec22_start) {
      continue;
    }

    const klines_slice = all_klines.slice(i - KLINE_CACHE_SIZE + 1, i + 1);
    const current_price = current_kline.close;

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
      cooldown_ms: 0
    });

    // 更新支撑阻力位
    alert_service.update_levels(SYMBOL, INTERVAL, klines_slice);
    const prediction = alert_service.get_breakout_prediction(SYMBOL, INTERVAL, klines_slice);

    if (!prediction) continue;

    // 计算24小时涨幅（使用完整数据）
    const gain_24h_pct = calc24hGain(all_klines, i);

    // 1. 检查 SQUEEZE 信号
    if (prediction.feature_scores.ma_convergence_score === 100) {
      const closes = klines_slice.map(k => k.close);
      const ema20 = calcEMA(closes, 20);
      const ema60 = calcEMA(closes, 60);
      const squeeze_pct = Math.abs(ema20 - ema60) / current_price * 100;

      all_alerts.push({
        time: current_kline.open_time,
        type: 'SQUEEZE',
        price: current_price,
        squeeze_pct,
        total_score: prediction.total_score,
        direction: prediction.predicted_direction,
        gain_24h_pct
      });
    }

    // 2. 检查支撑阻力位信号 (需要 total_score >= 60)
    if (prediction.total_score >= 60) {
      const levels = alert_service.get_cached_levels(SYMBOL, INTERVAL);

      for (const level of levels) {
        const distance_pct = Math.abs(current_price - level.price) / level.price * 100;

        if (distance_pct <= 0.1) {
          // TOUCHED
          all_alerts.push({
            time: current_kline.open_time,
            type: 'TOUCHED',
            price: current_price,
            level_price: level.price,
            level_type: level.type,
            distance_pct,
            total_score: prediction.total_score,
            direction: prediction.predicted_direction,
            gain_24h_pct
          });
        } else if (distance_pct <= 0.5) {
          // APPROACHING
          all_alerts.push({
            time: current_kline.open_time,
            type: 'APPROACHING',
            price: current_price,
            level_price: level.price,
            level_type: level.type,
            distance_pct,
            total_score: prediction.total_score,
            direction: prediction.predicted_direction,
            gain_24h_pct
          });
        }
      }
    }
  }

  // ==================== 输出 SQUEEZE 信号 ====================
  const squeeze_alerts = all_alerts.filter(a => a.type === 'SQUEEZE');
  console.log('═'.repeat(80));
  console.log(`📢 SQUEEZE 报警信号: ${squeeze_alerts.length} 个`);
  console.log('═'.repeat(80));

  if (squeeze_alerts.length > 0) {
    console.log('\n北京时间              | UTC时间              | 价格       | 粘合度%  | 24h涨幅 | 评分 | 方向');
    console.log('-'.repeat(105));

    for (const alert of squeeze_alerts) {
      const gain_hint = (alert.gain_24h_pct || 0) >= 10 ? '⚠️' : '  ';
      console.log(
        `${format_time_beijing(alert.time)} | ` +
        `${format_time_utc(alert.time)} | ` +
        `${alert.price.toFixed(6).padStart(10)} | ` +
        `${(alert.squeeze_pct || 0).toFixed(3).padStart(7)}% | ` +
        `${gain_hint}${(alert.gain_24h_pct || 0).toFixed(1).padStart(5)}% | ` +
        `${alert.total_score.toFixed(0).padStart(4)} | ` +
        `${alert.direction}`
      );
    }

    // 合并连续信号
    const merged_squeeze: typeof squeeze_alerts = [];
    for (const alert of squeeze_alerts) {
      const last = merged_squeeze[merged_squeeze.length - 1];
      if (!last || alert.time - last.time > 30 * 60 * 1000) {
        merged_squeeze.push(alert);
      }
    }
    console.log(`\n合并后独立信号: ${merged_squeeze.length} 个`);
  }

  // ==================== 输出支撑阻力位信号 ====================
  const sr_alerts = all_alerts.filter(a => a.type === 'TOUCHED' || a.type === 'APPROACHING');
  console.log('\n' + '═'.repeat(80));
  console.log(`📢 支撑阻力位报警信号: ${sr_alerts.length} 个`);
  console.log('═'.repeat(80));

  if (sr_alerts.length > 0) {
    // 按类型分组
    const touched = sr_alerts.filter(a => a.type === 'TOUCHED');
    const approaching = sr_alerts.filter(a => a.type === 'APPROACHING');

    if (touched.length > 0) {
      console.log(`\n🔴 TOUCHED (触碰): ${touched.length} 个`);
      console.log('北京时间              | 类型    | 价格       | 关键位     | 距离%  | 24h涨幅 | 评分 | 方向');
      console.log('-'.repeat(115));

      // 去重（同一时间同一价位只显示一次）
      const unique_touched = touched.filter((alert, idx, arr) =>
        arr.findIndex(a => a.time === alert.time && a.level_price === alert.level_price) === idx
      );

      for (const alert of unique_touched.slice(0, 30)) {
        const level_label = alert.level_type === 'SUPPORT' ? '支撑' : '阻力';
        const gain_hint = (alert.gain_24h_pct || 0) >= 10 ? '⚠️' : '  ';
        console.log(
          `${format_time_beijing(alert.time)} | ` +
          `${level_label.padEnd(6)} | ` +
          `${alert.price.toFixed(6).padStart(10)} | ` +
          `${(alert.level_price || 0).toFixed(6).padStart(10)} | ` +
          `${(alert.distance_pct || 0).toFixed(3).padStart(6)}% | ` +
          `${gain_hint}${(alert.gain_24h_pct || 0).toFixed(1).padStart(5)}% | ` +
          `${alert.total_score.toFixed(0).padStart(4)} | ` +
          `${alert.direction}`
        );
      }
      if (unique_touched.length > 30) {
        console.log(`   ... 还有 ${unique_touched.length - 30} 个`);
      }
    }

    if (approaching.length > 0) {
      console.log(`\n🟡 APPROACHING (接近): ${approaching.length} 个`);
      console.log('北京时间              | 类型    | 价格       | 关键位     | 距离%  | 24h涨幅 | 评分 | 方向');
      console.log('-'.repeat(115));

      // 去重
      const unique_approaching = approaching.filter((alert, idx, arr) =>
        arr.findIndex(a => a.time === alert.time && a.level_price === alert.level_price) === idx
      );

      for (const alert of unique_approaching.slice(0, 30)) {
        const level_label = alert.level_type === 'SUPPORT' ? '支撑' : '阻力';
        const gain_hint = (alert.gain_24h_pct || 0) >= 10 ? '⚠️' : '  ';
        console.log(
          `${format_time_beijing(alert.time)} | ` +
          `${level_label.padEnd(6)} | ` +
          `${alert.price.toFixed(6).padStart(10)} | ` +
          `${(alert.level_price || 0).toFixed(6).padStart(10)} | ` +
          `${(alert.distance_pct || 0).toFixed(3).padStart(6)}% | ` +
          `${gain_hint}${(alert.gain_24h_pct || 0).toFixed(1).padStart(5)}% | ` +
          `${alert.total_score.toFixed(0).padStart(4)} | ` +
          `${alert.direction}`
        );
      }
      if (unique_approaching.length > 30) {
        console.log(`   ... 还有 ${unique_approaching.length - 30} 个`);
      }
    }
  }

  // ==================== 统计摘要 ====================
  console.log('\n' + '═'.repeat(80));
  console.log('📊 统计摘要');
  console.log('═'.repeat(80));
  console.log(`   SQUEEZE 信号: ${squeeze_alerts.length} 个`);
  console.log(`   TOUCHED 信号: ${sr_alerts.filter(a => a.type === 'TOUCHED').length} 个`);
  console.log(`   APPROACHING 信号: ${sr_alerts.filter(a => a.type === 'APPROACHING').length} 个`);
  console.log(`   总计: ${all_alerts.length} 个`);

  console.log('\n✅ 分析完成');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
