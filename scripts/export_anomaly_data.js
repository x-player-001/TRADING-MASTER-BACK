/**
 * 导出异动数据分析脚本
 * 用途：导出异动记录及后续价格走势，用于挖掘交易因子
 * 运行命令: node scripts/export_anomaly_data.js
 */

require('dotenv').config({ override: true });

// ============================================================================
// 📋 导出配置
// ============================================================================
const EXPORT_CONFIG = {
  // 时间范围
  days_back: 7,                           // 导出最近N天的数据

  // 价格跟踪时长
  follow_minutes: 120,                    // 异动后跟踪价格的时长（分钟）

  // 过滤条件（可选，设为null则导出所有）
  min_oi_change: null,                    // 最小OI变化（如：3 表示3%）
  severity_filter: null,                  // 严重程度过滤（'high', 'medium', 'low' 或 null）
  symbols_filter: null,                   // 币种过滤（如：['BTCUSDT', 'ETHUSDT'] 或 null）

  // 输出格式
  output_format: 'json',                  // 输出格式：'json' 或 'csv'
  include_price_detail: true,             // 是否包含详细价格数据
};

// ============================================================================
// 📊 主程序
// ============================================================================

async function export_data() {
  console.log('\n' + '='.repeat(80));
  console.log('📦 异动数据导出工具');
  console.log('='.repeat(80));
  console.log('');

  // 加载依赖
  console.log('⏳ 加载模块...');

  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs' }
  });

  require('tsconfig-paths').register({
    baseUrl: './src',
    paths: {
      '@/*': ['*'],
      '@/types/*': ['types/*'],
      '@/core/*': ['core/*'],
      '@/utils/*': ['utils/*']
    }
  });

  const { ConfigManager } = require('../src/core/config/config_manager');
  const { OIRepository } = require('../src/database/oi_repository');
  const fs = require('fs');
  const path = require('path');

  try {
    // 初始化配置
    console.log('🔧 初始化配置...');
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();
    console.log('✅ 配置初始化完成\n');

    // 创建仓库实例
    const oi_repo = new OIRepository();

    // 计算时间范围
    const end_date = new Date();
    const start_date = new Date(Date.now() - EXPORT_CONFIG.days_back * 24 * 60 * 60 * 1000);

    console.log('📅 数据范围:');
    console.log(`  开始时间: ${start_date.toISOString()}`);
    console.log(`  结束时间: ${end_date.toISOString()}`);
    console.log(`  跨度天数: ${EXPORT_CONFIG.days_back} 天`);
    console.log(`  价格跟踪: ${EXPORT_CONFIG.follow_minutes} 分钟\n`);

    // 第一步：加载异动记录
    console.log('📊 步骤 1/3: 加载异动记录...');
    const anomalies = await oi_repo.get_anomaly_records({
      start_time: start_date,
      end_time: end_date,
      include_price_extremes: true
    });

    let filtered_anomalies = anomalies;

    // 应用过滤条件
    if (EXPORT_CONFIG.min_oi_change) {
      const before = filtered_anomalies.length;
      filtered_anomalies = filtered_anomalies.filter(a =>
        Math.abs(parseFloat(a.percent_change.toString())) >= EXPORT_CONFIG.min_oi_change
      );
      console.log(`  - 过滤OI变化 < ${EXPORT_CONFIG.min_oi_change}%: ${before} → ${filtered_anomalies.length}`);
    }

    if (EXPORT_CONFIG.severity_filter) {
      const before = filtered_anomalies.length;
      filtered_anomalies = filtered_anomalies.filter(a =>
        a.severity === EXPORT_CONFIG.severity_filter
      );
      console.log(`  - 过滤严重程度 = ${EXPORT_CONFIG.severity_filter}: ${before} → ${filtered_anomalies.length}`);
    }

    if (EXPORT_CONFIG.symbols_filter && EXPORT_CONFIG.symbols_filter.length > 0) {
      const before = filtered_anomalies.length;
      filtered_anomalies = filtered_anomalies.filter(a =>
        EXPORT_CONFIG.symbols_filter.includes(a.symbol)
      );
      console.log(`  - 过滤币种: ${before} → ${filtered_anomalies.length}`);
    }

    console.log(`✅ 加载完成: ${filtered_anomalies.length} 条异动记录\n`);

    if (filtered_anomalies.length === 0) {
      console.log('⚠️  没有符合条件的异动记录，退出');
      process.exit(0);
    }

    // 第二步：加载后续价格数据
    console.log('📈 步骤 2/3: 加载后续价格数据...');

    const export_data = [];
    const total = filtered_anomalies.length;
    let processed = 0;
    let price_found = 0;

    for (const anomaly of filtered_anomalies) {
      processed++;

      if (processed % 50 === 0) {
        process.stdout.write(`  处理进度: ${processed}/${total} (${(processed/total*100).toFixed(1)}%)\r`);
      }

      // 计算查询时间范围
      const anomaly_time = new Date(anomaly.anomaly_time);
      const follow_end_time = new Date(anomaly_time.getTime() + EXPORT_CONFIG.follow_minutes * 60 * 1000);

      // 查询后续价格（直接使用OI快照表的价格数据）
      let price_data = null;

      if (EXPORT_CONFIG.include_price_detail) {
        try {
          // 查询后续的OI快照（每分钟一条，包含价格）
          const snapshots = await oi_repo.get_snapshots_in_range(
            anomaly.symbol,
            anomaly_time,
            follow_end_time
          );

          if (snapshots && snapshots.length > 0) {
            price_found++;

            // 提取价格数据
            const prices = snapshots.map(s => s.mark_price || 0).filter(p => p > 0);

            if (prices.length > 0) {
              const entry_price = parseFloat(anomaly.current_price?.toString() || prices[0].toString());

              // 辅助函数：获取指定分钟后的价格
              const getPriceAtMinute = (minutes) => {
                const targetTime = new Date(anomaly_time.getTime() + minutes * 60 * 1000);
                const snapshot = snapshots.find(s =>
                  Math.abs(new Date(s.timestamp).getTime() - targetTime.getTime()) < 90000 // 1.5分钟容差
                );
                return snapshot?.mark_price || null;
              };

              price_data = {
                // 时间节点价格
                price_5min: getPriceAtMinute(5),
                price_15min: getPriceAtMinute(15),
                price_30min: getPriceAtMinute(30),
                price_60min: getPriceAtMinute(60),
                price_120min: getPriceAtMinute(120),

                // 涨跌幅
                change_5min: getPriceAtMinute(5) ? ((getPriceAtMinute(5) - entry_price) / entry_price * 100) : null,
                change_15min: getPriceAtMinute(15) ? ((getPriceAtMinute(15) - entry_price) / entry_price * 100) : null,
                change_30min: getPriceAtMinute(30) ? ((getPriceAtMinute(30) - entry_price) / entry_price * 100) : null,
                change_60min: getPriceAtMinute(60) ? ((getPriceAtMinute(60) - entry_price) / entry_price * 100) : null,
                change_120min: getPriceAtMinute(120) ? ((getPriceAtMinute(120) - entry_price) / entry_price * 100) : null,

                // 极值统计
                max_price: Math.max(...prices),
                min_price: Math.min(...prices),
                max_gain_pct: (Math.max(...prices) - entry_price) / entry_price * 100,
                max_loss_pct: (Math.min(...prices) - entry_price) / entry_price * 100,

                // 时间统计
                minutes_to_highest: prices.indexOf(Math.max(...prices)) + 1,
                minutes_to_lowest: prices.indexOf(Math.min(...prices)) + 1,

                // 快照数量
                snapshot_count: snapshots.length,

                // 详细快照数据（可选）
                snapshot_details: snapshots.slice(0, 120).map(s => ({
                  time: s.timestamp,
                  price: s.mark_price,
                  oi_value: parseFloat(s.oi_value?.toString() || '0')
                }))
              };
            }
          }
        } catch (error) {
          console.error(`\n  ❌ 获取 ${anomaly.symbol} 价格数据失败:`, error.message);
        }
      }

      // 构建导出记录
      export_data.push({
        // 异动基础信息
        id: anomaly.id,
        symbol: anomaly.symbol,
        anomaly_time: anomaly.anomaly_time.toISOString(),

        // OI信息
        oi_value: parseFloat(anomaly.oi_value?.toString() || '0'),
        oi_change_pct: parseFloat(anomaly.percent_change.toString()),
        period_seconds: anomaly.period_seconds,
        severity: anomaly.severity,

        // 价格信息
        entry_price: parseFloat(anomaly.current_price?.toString() || '0'),
        price_change_pct: anomaly.price_change_percent ? parseFloat(anomaly.price_change_percent.toString()) : null,

        // 价格极值
        daily_high: anomaly.daily_price_high ? parseFloat(anomaly.daily_price_high.toString()) : null,
        daily_low: anomaly.daily_price_low ? parseFloat(anomaly.daily_price_low.toString()) : null,
        price_from_low_pct: anomaly.price_from_low_pct,
        price_from_high_pct: anomaly.price_from_high_pct,

        // 市场情绪
        top_trader_ratio: anomaly.top_trader_long_short_ratio ? parseFloat(anomaly.top_trader_long_short_ratio.toString()) : null,
        global_ratio: anomaly.global_long_short_ratio ? parseFloat(anomaly.global_long_short_ratio.toString()) : null,
        taker_ratio: anomaly.taker_buy_sell_ratio ? parseFloat(anomaly.taker_buy_sell_ratio.toString()) : null,
        funding_rate: anomaly.funding_rate ? parseFloat(anomaly.funding_rate.toString()) : null,

        // 后续价格数据
        price_follow: price_data
      });
    }

    console.log(`\n✅ 价格数据加载完成: ${price_found}/${filtered_anomalies.length} 条有价格数据\n`);

    // 第三步：保存数据
    console.log('💾 步骤 3/3: 保存数据...');

    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const export_dir = path.join(process.cwd(), 'data_exports');

    if (!fs.existsSync(export_dir)) {
      fs.mkdirSync(export_dir, { recursive: true });
    }

    if (EXPORT_CONFIG.output_format === 'json') {
      // JSON格式
      const json_file = path.join(export_dir, `anomaly_analysis_${timestamp}.json`);

      const output = {
        export_info: {
          export_time: new Date().toISOString(),
          data_range: {
            start: start_date.toISOString(),
            end: end_date.toISOString(),
            days: EXPORT_CONFIG.days_back
          },
          config: EXPORT_CONFIG,
          total_records: export_data.length,
          records_with_price: price_found
        },
        data: export_data
      };

      fs.writeFileSync(json_file, JSON.stringify(output, null, 2));
      console.log(`✅ JSON 文件已保存: ${json_file}`);
      console.log(`   文件大小: ${(fs.statSync(json_file).size / 1024 / 1024).toFixed(2)} MB`);

    } else if (EXPORT_CONFIG.output_format === 'csv') {
      // CSV格式
      const csv_file = path.join(export_dir, `anomaly_analysis_${timestamp}.csv`);

      const csv_headers = [
        'id', 'symbol', 'anomaly_time', 'oi_change_pct', 'severity',
        'entry_price', 'price_change_pct', 'price_from_low_pct', 'price_from_high_pct',
        'top_trader_ratio', 'global_ratio', 'funding_rate',
        'change_5min', 'change_15min', 'change_30min', 'change_60min', 'change_120min',
        'max_gain_pct', 'max_loss_pct', 'minutes_to_highest', 'minutes_to_lowest'
      ].join(',');

      const csv_rows = export_data.map(d => [
        d.id,
        d.symbol,
        d.anomaly_time,
        d.oi_change_pct,
        d.severity,
        d.entry_price,
        d.price_change_pct || '',
        d.price_from_low_pct || '',
        d.price_from_high_pct || '',
        d.top_trader_ratio || '',
        d.global_ratio || '',
        d.funding_rate || '',
        d.price_follow?.change_5min?.toFixed(2) || '',
        d.price_follow?.change_15min?.toFixed(2) || '',
        d.price_follow?.change_30min?.toFixed(2) || '',
        d.price_follow?.change_60min?.toFixed(2) || '',
        d.price_follow?.change_120min?.toFixed(2) || '',
        d.price_follow?.max_gain_pct?.toFixed(2) || '',
        d.price_follow?.max_loss_pct?.toFixed(2) || '',
        d.price_follow?.minutes_to_highest || '',
        d.price_follow?.minutes_to_lowest || ''
      ].join(','));

      fs.writeFileSync(csv_file, csv_headers + '\n' + csv_rows.join('\n'));
      console.log(`✅ CSV 文件已保存: ${csv_file}`);
      console.log(`   文件大小: ${(fs.statSync(csv_file).size / 1024 / 1024).toFixed(2)} MB`);
    }

    // 统计摘要
    console.log('\n' + '='.repeat(80));
    console.log('📊 数据统计摘要');
    console.log('='.repeat(80));

    // 计算统计
    const with_price = export_data.filter(d => d.price_follow);

    if (with_price.length > 0) {
      const avg_5min = with_price.filter(d => d.price_follow.change_5min !== null).reduce((sum, d) => sum + d.price_follow.change_5min, 0) / with_price.length;
      const avg_15min = with_price.filter(d => d.price_follow.change_15min !== null).reduce((sum, d) => sum + d.price_follow.change_15min, 0) / with_price.length;
      const avg_30min = with_price.filter(d => d.price_follow.change_30min !== null).reduce((sum, d) => sum + d.price_follow.change_30min, 0) / with_price.length;
      const avg_60min = with_price.filter(d => d.price_follow.change_60min !== null).reduce((sum, d) => sum + d.price_follow.change_60min, 0) / with_price.length;

      const avg_max_gain = with_price.reduce((sum, d) => sum + d.price_follow.max_gain_pct, 0) / with_price.length;
      const avg_max_loss = with_price.reduce((sum, d) => sum + d.price_follow.max_loss_pct, 0) / with_price.length;

      console.log('\n平均涨跌幅:');
      console.log(`  5分钟后:   ${avg_5min >= 0 ? '+' : ''}${avg_5min.toFixed(2)}%`);
      console.log(`  15分钟后:  ${avg_15min >= 0 ? '+' : ''}${avg_15min.toFixed(2)}%`);
      console.log(`  30分钟后:  ${avg_30min >= 0 ? '+' : ''}${avg_30min.toFixed(2)}%`);
      console.log(`  60分钟后:  ${avg_60min >= 0 ? '+' : ''}${avg_60min.toFixed(2)}%`);

      console.log('\n极值统计:');
      console.log(`  平均最大涨幅: +${avg_max_gain.toFixed(2)}%`);
      console.log(`  平均最大跌幅: ${avg_max_loss.toFixed(2)}%`);

      const win_rate = with_price.filter(d => d.price_follow.change_60min > 0).length / with_price.length * 100;
      console.log(`  60分钟胜率: ${win_rate.toFixed(2)}%`);
    }

    console.log('\n💡 下一步:');
    console.log('  1. 使用 Excel/Python/R 打开导出的文件进行分析');
    console.log('  2. 分析不同因子组合的效果');
    console.log('  3. 找出最优交易因子');
    console.log('');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ 导出失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行导出
export_data();
