const mysql = require('mysql2/promise');

async function query() {
  const conn = await mysql.createConnection({
    host: '45.249.246.109',
    port: 3306,
    user: 'navicatuser',
    password: 'navicatuser',
    database: 'trading_master'
  });

  console.log('=== 查询 DEGENUSDT id=8312 的K线 ===\n');

  const table_name = 'kline_5m_20260104';

  // 1. 查询指定的K线
  const [target] = await conn.execute(`
    SELECT
      id,
      symbol,
      open_time,
      DATE_FORMAT(FROM_UNIXTIME(open_time/1000 + 8*3600), '%Y-%m-%d %H:%i') as time_bj,
      open, high, low, close,
      volume,
      ROUND(volume * close, 2) as volume_usdt,
      CASE WHEN close > open THEN '阳' ELSE '阴' END as type
    FROM ${table_name}
    WHERE symbol = 'DEGENUSDT' AND id = 8312
  `);

  if (target.length === 0) {
    console.log('未找到该K线');
    await conn.end();
    return;
  }

  const kline = target[0];
  console.log('目标K线:');
  console.log('  ID:', kline.id);
  console.log('  时间(北京):', kline.time_bj);
  console.log('  open_time:', kline.open_time);
  console.log('  开盘价:', kline.open);
  console.log('  最高价:', kline.high);
  console.log('  最低价:', kline.low);
  console.log('  收盘价:', kline.close);
  console.log('  成交量:', parseFloat(kline.volume).toFixed(2));
  console.log('  成交额:', kline.volume_usdt, 'USDT');
  console.log('  类型:', kline.type);

  // 2. 获取前20根K线计算平均成交量
  console.log('\n=== 获取前20根K线 ===');
  const [prev_klines] = await conn.execute(`
    SELECT id, open_time, DATE_FORMAT(FROM_UNIXTIME(open_time/1000 + 8*3600), '%H:%i') as time_bj, volume
    FROM ${table_name}
    WHERE symbol = 'DEGENUSDT' AND open_time < ?
    ORDER BY open_time DESC
    LIMIT 20
  `, [kline.open_time]);

  console.log('找到', prev_klines.length, '根前置K线:');
  for (const k of prev_klines.reverse()) {
    console.log('  ', k.time_bj, '| 成交量:', parseFloat(k.volume).toFixed(2));
  }

  if (prev_klines.length >= 20) {
    const avg_volume = prev_klines.reduce((sum, k) => sum + parseFloat(k.volume), 0) / prev_klines.length;
    const current_volume = parseFloat(kline.volume);
    const volume_ratio = current_volume / avg_volume;
    const volume_usdt = parseFloat(kline.volume_usdt);
    const price_change_pct = ((parseFloat(kline.close) - parseFloat(kline.open)) / parseFloat(kline.open)) * 100;
    const is_bullish = parseFloat(kline.close) > parseFloat(kline.open);

    // 计算上影线
    const body_top = Math.max(parseFloat(kline.open), parseFloat(kline.close));
    const upper_shadow = parseFloat(kline.high) - body_top;
    const total_range = parseFloat(kline.high) - parseFloat(kline.low);
    const upper_shadow_pct = total_range > 0 ? (upper_shadow / total_range) * 100 : 0;

    console.log('\n=== 分析该K线 ===');
    console.log('成交量:', current_volume.toFixed(2));
    console.log('前20根平均成交量:', avg_volume.toFixed(2));
    console.log('放量倍数:', volume_ratio.toFixed(2) + 'x');
    console.log('成交额:', volume_usdt.toFixed(2), 'USDT');
    console.log('涨跌幅:', price_change_pct.toFixed(2) + '%');
    console.log('是否阳线:', is_bullish ? '是' : '否');
    console.log('上影线比例:', upper_shadow_pct.toFixed(2) + '%');

    console.log('\n=== 报警条件检查 (完结K线) ===');
    console.log('1. 成交额 >= 180K USDT:', volume_usdt >= 180000 ? '✓' : '✗', '(' + volume_usdt.toFixed(2) + ')');
    console.log('2. 放量倍数 >= 5x:', volume_ratio >= 5 ? '✓' : '✗', '(' + volume_ratio.toFixed(2) + 'x)');
    console.log('3. 阳线:', is_bullish ? '✓' : '✗');
    console.log('4. 上影线 < 50%:', upper_shadow_pct < 50 ? '✓' : '✗', '(' + upper_shadow_pct.toFixed(2) + '%)');

    const should_alert = volume_usdt >= 180000 && volume_ratio >= 5 && is_bullish && upper_shadow_pct < 50;
    console.log('\n综合结果:', should_alert ? '应该报警' : '不满足报警条件');

    if (!should_alert) {
      console.log('\n未报警原因:');
      if (volume_usdt < 180000) console.log('  - 成交额不足 180K USDT (' + volume_usdt.toFixed(2) + ')');
      if (volume_ratio < 5) console.log('  - 放量倍数不足 5x (' + volume_ratio.toFixed(2) + 'x)');
      if (!is_bullish) console.log('  - 不是阳线 (阴线)');
      if (upper_shadow_pct >= 50) console.log('  - 上影线比例 >= 50% (' + upper_shadow_pct.toFixed(2) + '%)');
    }
  } else {
    console.log('\n历史K线不足20根，无法计算放量倍数');
    console.log('这就是没有报警的原因：该币种的历史K线缓存不足20根');
  }

  // 3. 查询该时间点的报警记录
  console.log('\n=== 查询报警记录 ===');
  const [alerts] = await conn.execute(`
    SELECT * FROM volume_alerts
    WHERE symbol = 'DEGENUSDT' AND kline_time = ?
  `, [kline.open_time]);

  if (alerts.length === 0) {
    console.log('该K线无报警记录');
  } else {
    console.log('有报警记录:', alerts[0]);
  }

  await conn.end();
}

query().catch(console.error);
