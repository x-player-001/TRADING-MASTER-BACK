/**
 * 分析 DFUSDT K线数据
 * 对比 12月21日04:00 的收敛形态和最新的收敛形态
 * 使用 BreakoutPredictor 的算法进行评分
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { Kline15mRepository } from '../src/database/kline_15m_repository';
import { SRLevelRepository } from '../src/database/sr_level_repository';
import { ConfigManager } from '../src/core/config/config_manager';
import { BreakoutPredictor, KlineData } from '../src/analysis/breakout_predictor';

const SYMBOL = 'DFUSDT';

// ==================== 工具函数 ====================

function format_time(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

function calc_atr(klines: any[], period: number = 14): number {
  if (klines.length < period + 1) return 0;

  let tr_sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prev_close = klines[i - 1]?.close || klines[i].open;
    const tr = Math.max(high - low, Math.abs(high - prev_close), Math.abs(low - prev_close));
    tr_sum += tr;
  }
  return tr_sum / period;
}

function calc_ma(klines: any[], period: number): number {
  if (klines.length < period) return 0;
  const recent = klines.slice(-period);
  return recent.reduce((sum, k) => sum + k.close, 0) / period;
}

function calc_volatility_ratio(klines: any[], short_period: number = 5, long_period: number = 20): number {
  const short_atr = calc_atr(klines, short_period);
  const long_atr = calc_atr(klines, long_period);
  return long_atr > 0 ? short_atr / long_atr : 1;
}

function calc_volume_ratio(klines: any[], short_period: number = 5, long_period: number = 20): number {
  if (klines.length < long_period) return 1;

  const short_vol = klines.slice(-short_period).reduce((sum, k) => sum + k.volume, 0) / short_period;
  const long_vol = klines.slice(-long_period).reduce((sum, k) => sum + k.volume, 0) / long_period;

  return long_vol > 0 ? short_vol / long_vol : 1;
}

function calc_ma_convergence(klines: any[]): { convergence_pct: number; ma5: number; ma10: number; ma20: number } {
  const ma5 = calc_ma(klines, 5);
  const ma10 = calc_ma(klines, 10);
  const ma20 = calc_ma(klines, 20);

  const price = klines[klines.length - 1]?.close || 0;
  if (price === 0) return { convergence_pct: 0, ma5, ma10, ma20 };

  const max_ma = Math.max(ma5, ma10, ma20);
  const min_ma = Math.min(ma5, ma10, ma20);
  const convergence_pct = ((max_ma - min_ma) / price) * 100;

  return { convergence_pct, ma5, ma10, ma20 };
}

function calc_price_range_ratio(klines: any[], period: number = 20): number {
  if (klines.length < period) return 0;

  const recent = klines.slice(-period);
  const high = Math.max(...recent.map(k => k.high));
  const low = Math.min(...recent.map(k => k.low));
  const price = recent[recent.length - 1].close;

  // 最近5根K线的振幅
  const recent5 = klines.slice(-5);
  const recent_high = Math.max(...recent5.map(k => k.high));
  const recent_low = Math.min(...recent5.map(k => k.low));

  const full_range = (high - low) / price * 100;
  const recent_range = (recent_high - recent_low) / price * 100;

  return full_range > 0 ? recent_range / full_range : 1;
}

function analyze_klines(klines: any[], label: string): void {
  if (klines.length < 20) {
    console.log(`\n${label}: 数据不足 (${klines.length} 根)`);
    return;
  }

  // 转换数值类型
  klines = klines.map(k => ({
    ...k,
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    volume: parseFloat(k.volume)
  }));

  const last = klines[klines.length - 1];
  const price = last.close;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${label}`);
  console.log('═'.repeat(70));

  console.log(`\n📍 基本信息:`);
  console.log(`   K线数量: ${klines.length}`);
  console.log(`   时间范围: ${format_time(klines[0].open_time)} ~ ${format_time(last.open_time)}`);
  console.log(`   当前价格: ${price.toFixed(6)}`);

  // 波动率分析
  const volatility_ratio = calc_volatility_ratio(klines, 5, 20);
  const atr5 = calc_atr(klines, 5);
  const atr20 = calc_atr(klines, 20);

  console.log(`\n📉 波动率分析:`);
  console.log(`   ATR(5):  ${atr5.toFixed(6)} (${(atr5/price*100).toFixed(3)}%)`);
  console.log(`   ATR(20): ${atr20.toFixed(6)} (${(atr20/price*100).toFixed(3)}%)`);
  console.log(`   波动率比: ${volatility_ratio.toFixed(3)} ${volatility_ratio < 0.7 ? '✅ 收敛' : volatility_ratio < 0.9 ? '⚠️ 轻微收敛' : '❌ 未收敛'}`);

  // 成交量分析
  const volume_ratio = calc_volume_ratio(klines, 5, 20);
  const vol5 = klines.slice(-5).reduce((sum, k) => sum + k.volume, 0) / 5;
  const vol20 = klines.slice(-20).reduce((sum, k) => sum + k.volume, 0) / 20;

  console.log(`\n📊 成交量分析:`);
  console.log(`   成交量(5):  ${vol5.toFixed(2)}`);
  console.log(`   成交量(20): ${vol20.toFixed(2)}`);
  console.log(`   成交量比: ${volume_ratio.toFixed(3)} ${volume_ratio < 0.6 ? '✅ 明显萎缩' : volume_ratio < 0.8 ? '⚠️ 轻微萎缩' : '❌ 未萎缩'}`);

  // 均线分析
  const { convergence_pct, ma5, ma10, ma20 } = calc_ma_convergence(klines);

  console.log(`\n📈 均线分析:`);
  console.log(`   MA5:  ${ma5.toFixed(6)}`);
  console.log(`   MA10: ${ma10.toFixed(6)}`);
  console.log(`   MA20: ${ma20.toFixed(6)}`);
  console.log(`   均线收敛度: ${convergence_pct.toFixed(3)}% ${convergence_pct < 1 ? '✅ 收敛' : convergence_pct < 2 ? '⚠️ 轻微收敛' : '❌ 未收敛'}`);

  // 价格区间分析
  const price_range_ratio = calc_price_range_ratio(klines, 20);
  const recent5 = klines.slice(-5);
  const recent20 = klines.slice(-20);
  const h20 = Math.max(...recent20.map(k => k.high));
  const l20 = Math.min(...recent20.map(k => k.low));
  const h5 = Math.max(...recent5.map(k => k.high));
  const l5 = Math.min(...recent5.map(k => k.low));

  console.log(`\n📏 价格区间分析:`);
  console.log(`   20根区间: ${l20.toFixed(6)} ~ ${h20.toFixed(6)} (${((h20-l20)/price*100).toFixed(2)}%)`);
  console.log(`   5根区间:  ${l5.toFixed(6)} ~ ${h5.toFixed(6)} (${((h5-l5)/price*100).toFixed(2)}%)`);
  console.log(`   区间收缩比: ${price_range_ratio.toFixed(3)} ${price_range_ratio < 0.4 ? '✅ 明显收缩' : price_range_ratio < 0.6 ? '⚠️ 轻微收缩' : '❌ 未收缩'}`);

  // 综合评分
  let convergence_score = 0;
  if (volatility_ratio < 0.7) convergence_score += 25;
  else if (volatility_ratio < 0.9) convergence_score += 10;

  if (volume_ratio < 0.6) convergence_score += 25;
  else if (volume_ratio < 0.8) convergence_score += 10;

  if (convergence_pct < 1) convergence_score += 25;
  else if (convergence_pct < 2) convergence_score += 10;

  if (price_range_ratio < 0.4) convergence_score += 25;
  else if (price_range_ratio < 0.6) convergence_score += 10;

  console.log(`\n🎯 综合收敛评分: ${convergence_score}/100`);
  if (convergence_score >= 80) {
    console.log('   ✅ 强收敛形态，可能即将爆发');
  } else if (convergence_score >= 50) {
    console.log('   ⚠️ 中等收敛，需继续观察');
  } else {
    console.log('   ❌ 未形成明显收敛');
  }

  // 显示最近5根K线
  console.log(`\n📋 最近5根K线:`);
  console.log('   时间                  | 开盘      | 最高      | 最低      | 收盘      | 成交量');
  console.log('   ' + '-'.repeat(90));
  for (const k of recent5) {
    const change = ((k.close - k.open) / k.open * 100).toFixed(2);
    const dir = k.close >= k.open ? '🟢' : '🔴';
    console.log(`   ${format_time(k.open_time)} | ${k.open.toFixed(6).padStart(9)} | ${k.high.toFixed(6).padStart(9)} | ${k.low.toFixed(6).padStart(9)} | ${k.close.toFixed(6).padStart(9)} | ${k.volume.toFixed(2).padStart(10)} ${dir} ${change}%`);
  }
}

// ==================== 使用 BreakoutPredictor 评分 ====================

function analyze_with_predictor(klines: any[], label: string): void {
  if (klines.length < 30) {
    console.log(`\n${label}: 数据不足 (${klines.length} 根)`);
    return;
  }

  // 转换为 KlineData 格式
  const kline_data: KlineData[] = klines.map(k => ({
    open_time: k.open_time,
    close_time: k.close_time,
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    volume: parseFloat(k.volume)
  }));

  const predictor = new BreakoutPredictor();
  const result = predictor.predict(SYMBOL, kline_data, []);

  if (!result) {
    console.log(`\n${label}: 预测失败`);
    return;
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${label} - BreakoutPredictor 评分`);
  console.log('═'.repeat(70));

  console.log(`\n🎯 综合评分: ${result.total_score}/100  级别: ${result.alert_level}`);
  console.log(`   预测方向: ${result.predicted_direction}`);

  console.log(`\n📊 各维度评分:`);
  console.log(`   波动收敛: ${result.feature_scores.volatility_score}/100`);
  console.log(`   成交量萎缩: ${result.feature_scores.volume_score}/100`);
  console.log(`   均线收敛: ${result.feature_scores.ma_convergence_score}/100`);
  console.log(`   位置接近: ${result.feature_scores.position_score}/100`);
  console.log(`   形态特征: ${result.feature_scores.pattern_score}/100`);

  console.log(`\n📝 描述: ${result.description}`);
}

// ==================== 主函数 ====================

async function main() {
  console.log('═'.repeat(70));
  console.log('          DFUSDT K线收敛形态分析');
  console.log('═'.repeat(70));

  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const kline_repo = new Kline15mRepository();
  const sr_repo = new SRLevelRepository();

  // 获取 12月20日到22日的所有数据来找到真正的突破点
  const start_time = new Date('2025-12-20T00:00:00Z').getTime();
  const end_time = new Date('2025-12-22T23:59:59Z').getTime();

  console.log('\n📡 正在从数据库获取 12/20-12/22 所有K线数据...');
  const all_klines = await kline_repo.get_klines_by_time_range(SYMBOL, start_time, end_time);
  console.log(`   获取 ${all_klines.length} 根K线`);

  if (all_klines.length === 0) {
    console.log('❌ 没有找到数据');
    process.exit(1);
  }

  // 转换数值类型
  const klines = all_klines.map(k => ({
    ...k,
    open: parseFloat(k.open as any),
    high: parseFloat(k.high as any),
    low: parseFloat(k.low as any),
    close: parseFloat(k.close as any),
    volume: parseFloat(k.volume as any)
  }));

  // 找到价格变化最大的时间点（突破点）
  console.log('\n📉 寻找突破点...');
  let max_drop = 0;
  let max_drop_idx = 0;
  for (let i = 1; i < klines.length; i++) {
    const change = (klines[i].close - klines[i - 1].close) / klines[i - 1].close;
    if (change < max_drop) {
      max_drop = change;
      max_drop_idx = i;
    }
  }

  const breakout_kline = klines[max_drop_idx];
  console.log(`   最大跌幅: ${(max_drop * 100).toFixed(2)}%`);
  console.log(`   突破时间: ${format_time(breakout_kline.open_time)}`);
  console.log(`   突破价格: ${klines[max_drop_idx - 1].close.toFixed(6)} -> ${breakout_kline.close.toFixed(6)}`);

  // 分析突破前的数据（往前50根K线）
  const pre_breakout_end = max_drop_idx;
  const pre_breakout_start = Math.max(0, max_drop_idx - 100);
  const pre_breakout_klines = klines.slice(pre_breakout_start, pre_breakout_end);

  console.log(`\n   突破前数据: ${format_time(pre_breakout_klines[0].open_time)} ~ ${format_time(pre_breakout_klines[pre_breakout_klines.length - 1].open_time)}`);

  // 使用 BreakoutPredictor 分析突破前的形态
  analyze_with_predictor(pre_breakout_klines, `突破前 (${format_time(breakout_kline.open_time)} 之前)`);

  // 分析最新数据
  const now = Date.now();
  const recent_start = now - 100 * 15 * 60 * 1000;
  const recent_klines = await kline_repo.get_klines_by_time_range(SYMBOL, recent_start, now);
  console.log(`\n📡 获取最新 ${recent_klines.length} 根K线`);

  analyze_with_predictor(recent_klines, '最新数据');

  // 对比我的简单分析和 BreakoutPredictor 的分析
  console.log(`\n${'═'.repeat(70)}`);
  console.log('📋 简单指标对比');
  console.log('═'.repeat(70));

  analyze_klines(pre_breakout_klines, `突破前形态`);
  analyze_klines(recent_klines.map(k => ({
    ...k,
    open: parseFloat(k.open as any),
    high: parseFloat(k.high as any),
    low: parseFloat(k.low as any),
    close: parseFloat(k.close as any),
    volume: parseFloat(k.volume as any)
  })), `最新形态`);

  // 获取信号记录
  console.log(`\n${'═'.repeat(70)}`);
  console.log('📋 DFUSDT 最近的 SQUEEZE 信号记录');
  console.log('═'.repeat(70));

  const alerts = await sr_repo.get_recent_alerts(SYMBOL, '15m', 50);
  const squeeze_alerts = alerts.filter(a => a.alert_type === 'SQUEEZE');

  if (squeeze_alerts.length === 0) {
    console.log('   没有找到 SQUEEZE 信号');
  } else {
    console.log(`\n   共 ${squeeze_alerts.length} 条 SQUEEZE 信号:\n`);
    console.log('   时间                  | 评分  | 波动  | 量能  | 均线  | 形态  | 方向');
    console.log('   ' + '-'.repeat(80));
    for (const alert of squeeze_alerts.slice(0, 15)) {
      const time_str = format_time(alert.kline_time);
      console.log(`   ${time_str} | ${(alert.breakout_score || 0).toFixed(0).padStart(4)} | ${(alert.volatility_score || 0).toFixed(0).padStart(4)} | ${(alert.volume_score || 0).toFixed(0).padStart(4)} | ${(alert.ma_convergence_score || 0).toFixed(0).padStart(4)} | ${(alert.pattern_score || 0).toFixed(0).padStart(4)} | ${alert.predicted_direction || 'N/A'}`);
    }
  }

  console.log('\n✅ 分析完成');
  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
