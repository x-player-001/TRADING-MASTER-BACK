/**
 * 测试 BANANAUSDT 的回调企稳报警逻辑
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';
import { SRAlertService } from '../src/services/sr_alert_service';
import { KlineData } from '../src/analysis/support_resistance_detector';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  console.log('═'.repeat(70));
  console.log('       测试 BANANAUSDT 回调企稳报警逻辑');
  console.log('═'.repeat(70));

  // 获取更多K线数据 (需要至少200根来计算EMA200)
  // 15m周期，200根 = 50小时 = 约2天
  // 拉取 12.20 - 12.26 的数据
  const [rows] = await conn.execute<any[]>(`
    SELECT open_time, open, high, low, close, volume FROM (
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251220 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251221 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251222 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251223 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251224 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251225 WHERE symbol = 'BANANAUSDT'
      UNION ALL
      SELECT open_time, open, high, low, close, volume
      FROM kline_15m_20251226 WHERE symbol = 'BANANAUSDT'
    ) t
    ORDER BY open_time ASC
  `);

  console.log('\n总共加载 ' + rows.length + ' 根K线');

  // 转换为 KlineData 格式
  const all_klines: KlineData[] = rows.map(r => ({
    open_time: parseInt(r.open_time),
    close_time: parseInt(r.open_time) + 15 * 60 * 1000 - 1,  // 15分钟K线
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume)
  }));

  // 初始化报警服务 (只启用回调企稳)
  const alert_service = new SRAlertService({
    enable_squeeze_alert: false,
    enable_bullish_streak_alert: false,
    enable_pullback_alert: true,
    enable_approaching_alert: false,  // 禁用接近/触碰报警
    pullback_min_surge_pct: 5.0,
    pullback_max_retrace: 0.618,
    pullback_min_retrace: 0,  // 取消最小回撤限制
    pullback_stabilize_bars: 3,
    cooldown_ms: 0  // 禁用冷却，测试所有信号
  });

  console.log('\n配置:');
  console.log('  - 主升浪最小涨幅: 5%');
  console.log('  - 回撤范围: 0% - 61.8% (只要低于高点就算回调)');
  console.log('  - 企稳确认: 3根K线');
  console.log('  - 冷却时间: 15分钟');

  console.log('\n═'.repeat(70));
  console.log('                    模拟逐根K线检测');
  console.log('═'.repeat(70));

  const alerts_found: any[] = [];

  // 从第30根K线开始模拟（需要足够历史数据）
  for (let i = 30; i < all_klines.length; i++) {
    const klines_so_far = all_klines.slice(0, i + 1);
    const current = klines_so_far[klines_so_far.length - 1];

    // 先更新支撑阻力位
    alert_service.update_levels('BANANAUSDT', '15m', klines_so_far);

    // 检查报警
    const alerts = alert_service.check_alerts_with_prediction(
      'BANANAUSDT',
      '15m',
      klines_so_far,
      current.close,
      current.open_time
    );

    if (alerts.length > 0) {
      for (const alert of alerts) {
        const date = new Date(current.open_time + 8 * 3600 * 1000);
        const dateStr = date.toISOString().replace('T', ' ').slice(0, 16);

        console.log('\n📈 [' + dateStr + '] PULLBACK_READY');
        console.log('   ' + alert.description);
        console.log('   价格: ' + current.close.toFixed(4));

        alerts_found.push({
          time: dateStr,
          price: current.close,
          description: alert.description
        });
      }
    }
  }

  console.log('\n═'.repeat(70));
  console.log('                    报警汇总');
  console.log('═'.repeat(70));

  if (alerts_found.length === 0) {
    console.log('\n❌ 未检测到任何回调企稳信号');
    console.log('\n可能原因:');
    console.log('  1. 均线未多头排列 (EMA30 > EMA60 > EMA120 > EMA200)');
    console.log('  2. 主升浪涨幅 < 5%');
    console.log('  3. 回撤超出 0.236-0.618 范围');
    console.log('  4. 未检测到企稳信号 (连续阳线/放量突破/锤子线/低点抬升)');
  } else {
    console.log('\n✅ 共检测到 ' + alerts_found.length + ' 个回调企稳信号:');
    for (const a of alerts_found) {
      console.log('   ' + a.time + ' @ ' + a.price.toFixed(4));
    }
  }

  // 额外分析：检查为什么没有报警
  console.log('\n═'.repeat(70));
  console.log('                    诊断分析');
  console.log('═'.repeat(70));

  // 检查均线排列
  const closes = all_klines.map(k => k.close);
  if (closes.length >= 200) {
    const calc_ema = (data: number[], period: number): number => {
      const k = 2 / (period + 1);
      let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * k + ema;
      }
      return ema;
    };

    const ema30 = calc_ema(closes, 30);
    const ema60 = calc_ema(closes, 60);
    const ema120 = calc_ema(closes, 120);
    const ema200 = calc_ema(closes, 200);

    console.log('\n最新均线状态:');
    console.log('  EMA30:  ' + ema30.toFixed(4));
    console.log('  EMA60:  ' + ema60.toFixed(4));
    console.log('  EMA120: ' + ema120.toFixed(4));
    console.log('  EMA200: ' + ema200.toFixed(4));

    const is_bullish = ema30 > ema60 && ema60 > ema120 && ema120 > ema200;
    console.log('  多头排列: ' + (is_bullish ? '✅ 是' : '❌ 否'));

    if (!is_bullish) {
      if (ema30 <= ema60) console.log('    - EMA30 <= EMA60');
      if (ema60 <= ema120) console.log('    - EMA60 <= EMA120');
      if (ema120 <= ema200) console.log('    - EMA120 <= EMA200');
    }
  } else {
    console.log('\n⚠️ K线数量不足200根，无法检查均线排列');
  }

  // 查找波段高低点
  console.log('\n波段分析:');
  const highs: { idx: number; price: number; time: string }[] = [];
  const lows: { idx: number; price: number; time: string }[] = [];

  for (let i = 5; i < all_klines.length - 5; i++) {
    const current = all_klines[i];
    let is_high = true;
    let is_low = true;

    for (let j = i - 5; j <= i + 5; j++) {
      if (j !== i) {
        if (all_klines[j].high >= current.high) is_high = false;
        if (all_klines[j].low <= current.low) is_low = false;
      }
    }

    if (is_high) {
      const date = new Date(current.open_time + 8 * 3600 * 1000);
      highs.push({ idx: i, price: current.high, time: date.toISOString().slice(0, 16).replace('T', ' ') });
    }
    if (is_low) {
      const date = new Date(current.open_time + 8 * 3600 * 1000);
      lows.push({ idx: i, price: current.low, time: date.toISOString().slice(0, 16).replace('T', ' ') });
    }
  }

  console.log('  波段高点 (最近3个):');
  for (const h of highs.slice(-3)) {
    console.log('    ' + h.time + ' @ ' + h.price.toFixed(4));
  }

  console.log('  波段低点 (最近3个):');
  for (const l of lows.slice(-3)) {
    console.log('    ' + l.time + ' @ ' + l.price.toFixed(4));
  }

  // 分析最近的上涨波段
  if (highs.length > 0 && lows.length > 0) {
    const recent_high = highs[highs.length - 1];
    let valid_low = null;

    for (let i = lows.length - 1; i >= 0; i--) {
      if (lows[i].idx < recent_high.idx) {
        valid_low = lows[i];
        break;
      }
    }

    if (valid_low) {
      const surge = ((recent_high.price - valid_low.price) / valid_low.price) * 100;
      console.log('\n  最近上涨波段:');
      console.log('    低点: ' + valid_low.time + ' @ ' + valid_low.price.toFixed(4));
      console.log('    高点: ' + recent_high.time + ' @ ' + recent_high.price.toFixed(4));
      console.log('    涨幅: ' + surge.toFixed(2) + '%' + (surge >= 5 ? ' ✅' : ' ❌ (需>=5%)'));

      // 检查当前回撤位置
      const current_price = all_klines[all_klines.length - 1].close;
      if (current_price < recent_high.price && current_price > valid_low.price) {
        const range = recent_high.price - valid_low.price;
        const retrace = (recent_high.price - current_price) / range;
        console.log('\n  当前回撤:');
        console.log('    当前价: ' + current_price.toFixed(4));
        console.log('    回撤比: ' + (retrace * 100).toFixed(1) + '%');

        if (retrace >= 0.236 && retrace <= 0.618) {
          console.log('    位置: ✅ 在0.236-0.618范围内');
        } else if (retrace < 0.236) {
          console.log('    位置: ❌ 回撤不足0.236');
        } else {
          console.log('    位置: ❌ 回撤超过0.618');
        }
      }
    }
  }

  await conn.end();
  console.log('\n✅ 测试完成');
}

main().catch(console.error);
