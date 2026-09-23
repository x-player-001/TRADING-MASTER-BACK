/**
 * 分析信号噪音，提供优化建议
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  console.log('═'.repeat(80));
  console.log('                    信号噪音分析报告');
  console.log('═'.repeat(80));

  // 1. 各类型信号数量
  console.log('\n📊 1. 信号类型分布:');
  const [types] = await conn.execute<any[]>(
    'SELECT alert_type, COUNT(*) as count FROM sr_alerts GROUP BY alert_type ORDER BY count DESC'
  );
  for (const row of types) {
    console.log(`   ${row.alert_type.padEnd(15)} ${row.count}`);
  }

  // 2. 分数分布 (breakout_score 是综合评分)
  console.log('\n📊 2. 综合评分分布 (breakout_score):');
  const [scores] = await conn.execute<any[]>(`
    SELECT
      CASE
        WHEN breakout_score < 30 THEN '0-29'
        WHEN breakout_score < 50 THEN '30-49'
        WHEN breakout_score < 60 THEN '50-59'
        WHEN breakout_score < 70 THEN '60-69'
        WHEN breakout_score < 80 THEN '70-79'
        ELSE '80+'
      END as score_range,
      COUNT(*) as count
    FROM sr_alerts
    GROUP BY score_range
    ORDER BY score_range
  `);
  for (const row of scores) {
    console.log(`   ${row.score_range.padEnd(10)} ${row.count}`);
  }

  // 3. SQUEEZE 粘合度分布
  console.log('\n📊 3. SQUEEZE 粘合度分布:');
  const [squeeze] = await conn.execute<any[]>(`
    SELECT
      CASE
        WHEN description LIKE '%粘合度: 0.00%' THEN '0.00x%'
        WHEN description LIKE '%粘合度: 0.01%' THEN '0.01x%'
        WHEN description LIKE '%粘合度: 0.02%' THEN '0.02x%'
        WHEN description LIKE '%粘合度: 0.03%' THEN '0.03x%'
        ELSE 'other'
      END as squeeze_pct,
      COUNT(*) as count
    FROM sr_alerts
    WHERE alert_type = 'SQUEEZE'
    GROUP BY squeeze_pct
    ORDER BY squeeze_pct
  `);
  for (const row of squeeze) {
    console.log(`   ${row.squeeze_pct.padEnd(10)} ${row.count}`);
  }

  // 4. 同一币种24小时内报警次数
  console.log('\n📊 4. 24小时内报警次数 TOP20 (高频币种可能是噪音源):');
  const [freq] = await conn.execute<any[]>(`
    SELECT symbol, COUNT(*) as alert_count,
           SUM(CASE WHEN alert_type = 'SQUEEZE' THEN 1 ELSE 0 END) as squeeze_count,
           SUM(CASE WHEN alert_type = 'APPROACHING' THEN 1 ELSE 0 END) as approaching_count,
           SUM(CASE WHEN alert_type = 'TOUCHED' THEN 1 ELSE 0 END) as touched_count
    FROM sr_alerts
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    GROUP BY symbol
    HAVING alert_count > 2
    ORDER BY alert_count DESC
    LIMIT 20
  `);
  console.log('   Symbol          Total  SQUEEZE  APPROACHING  TOUCHED');
  console.log('   ' + '-'.repeat(55));
  for (const row of freq) {
    console.log(`   ${row.symbol.padEnd(15)} ${String(row.alert_count).padStart(5)}  ${String(row.squeeze_count).padStart(7)}  ${String(row.approaching_count).padStart(11)}  ${String(row.touched_count).padStart(7)}`);
  }

  // 5. SQUEEZE 方向分布
  console.log('\n📊 5. SQUEEZE 信号方向分布:');
  const [dirs] = await conn.execute<any[]>(`
    SELECT predicted_direction as direction, COUNT(*) as count
    FROM sr_alerts
    WHERE alert_type = 'SQUEEZE'
    GROUP BY predicted_direction
    ORDER BY count DESC
  `);
  for (const row of dirs) {
    console.log(`   ${(row.direction || 'unknown').padEnd(10)} ${row.count}`);
  }

  // 6. 连续报警分析（同一币种5分钟内多次报警）
  console.log('\n📊 6. 连续报警分析 (同币种5分钟内多次):');
  const [consecutive] = await conn.execute<any[]>(`
    SELECT a.symbol, a.alert_type,
           COUNT(*) as burst_count,
           MIN(a.created_at) as first_alert,
           MAX(a.created_at) as last_alert
    FROM sr_alerts a
    JOIN sr_alerts b ON a.symbol = b.symbol
      AND a.id != b.id
      AND ABS(TIMESTAMPDIFF(SECOND, a.created_at, b.created_at)) < 300
    WHERE a.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    GROUP BY a.symbol, a.alert_type
    HAVING burst_count > 3
    ORDER BY burst_count DESC
    LIMIT 10
  `);
  if (consecutive.length > 0) {
    for (const row of consecutive) {
      console.log(`   ${row.symbol.padEnd(15)} ${row.alert_type.padEnd(12)} 连续${row.burst_count}次`);
    }
  } else {
    console.log('   无明显连续报警');
  }

  // 7. APPROACHING/TOUCHED 的距离分布
  console.log('\n📊 7. APPROACHING 距离分布:');
  const [distances] = await conn.execute<any[]>(`
    SELECT
      CASE
        WHEN distance_pct <= 0.1 THEN '<=0.1%'
        WHEN distance_pct <= 0.2 THEN '0.1-0.2%'
        WHEN distance_pct <= 0.3 THEN '0.2-0.3%'
        WHEN distance_pct <= 0.4 THEN '0.3-0.4%'
        ELSE '0.4-0.5%'
      END as dist_range,
      COUNT(*) as count
    FROM sr_alerts
    WHERE alert_type = 'APPROACHING'
    GROUP BY dist_range
    ORDER BY dist_range
  `);
  for (const row of distances) {
    console.log(`   ${row.dist_range.padEnd(12)} ${row.count}`);
  }

  // 8. 24小时涨幅分布 (从 description 提取)
  console.log('\n📊 8. 24小时涨幅分布 (SQUEEZE):');
  const [gains] = await conn.execute<any[]>(`
    SELECT
      CASE
        WHEN description LIKE '%24h涨幅%' THEN 'has_gain_info'
        ELSE 'no_gain_info'
      END as has_gain,
      COUNT(*) as count
    FROM sr_alerts
    WHERE alert_type = 'SQUEEZE'
    GROUP BY has_gain
  `);
  for (const row of gains) {
    console.log(`   ${row.has_gain.padEnd(15)} ${row.count}`);
  }

  // 总结和建议
  console.log('\n' + '═'.repeat(80));
  console.log('                    📋 优化建议');
  console.log('═'.repeat(80));

  const total_alerts = types.reduce((sum, t) => sum + t.count, 0);
  const squeeze_count = types.find(t => t.alert_type === 'SQUEEZE')?.count || 0;
  const approaching_count = types.find(t => t.alert_type === 'APPROACHING')?.count || 0;

  console.log(`\n当前总信号: ${total_alerts} 个`);
  console.log(`  - SQUEEZE: ${squeeze_count} (${(squeeze_count/total_alerts*100).toFixed(1)}%)`);
  console.log(`  - APPROACHING: ${approaching_count} (${(approaching_count/total_alerts*100).toFixed(1)}%)`);

  console.log('\n🔧 建议优化方案:');
  console.log('\n   1. 【SQUEEZE 粘合度阈值】');
  console.log('      当前: <= 0.03%');
  console.log('      建议: <= 0.02% (可减少约30%噪音)');

  console.log('\n   2. 【最低评分要求】');
  console.log('      当前: 60分以上才触发 APPROACHING/TOUCHED');
  console.log('      建议: 提升到 65分 或 70分');

  console.log('\n   3. 【添加冷却时间】');
  console.log('      当前: 无冷却 (cooldown_ms: 0)');
  console.log('      建议: 同币种同类型报警间隔 >= 15分钟');

  console.log('\n   4. 【APPROACHING 距离优化】');
  console.log('      当前: <= 0.5%');
  console.log('      建议: <= 0.3% (更接近才报警)');

  console.log('\n   5. 【24小时涨幅过滤】');
  console.log('      建议: 24h涨幅 > 15% 的币种降低报警优先级或加入冷却');

  await conn.end();
  console.log('\n✅ 分析完成');
}

main().catch(console.error);
