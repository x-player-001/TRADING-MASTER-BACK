/**
 * 导出原始数据脚本
 * 用途：导出异动记录和OI快照数据到本地，用于数据分析
 * 运行命令: node scripts/export_raw_data.js
 */

require('dotenv').config({ override: true });

// ============================================================================
// 📋 导出配置
// ============================================================================
const EXPORT_CONFIG = {
  days_back: 5,                           // 导出最近N天的数据
  output_dir: 'data_exports',             // 输出目录
};

// ============================================================================
// 📊 主程序
// ============================================================================

async function export_raw_data() {
  console.log('\n' + '='.repeat(80));
  console.log('📦 原始数据导出工具');
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
    console.log(`  跨度天数: ${EXPORT_CONFIG.days_back} 天\n`);

    // 创建输出目录
    const output_dir = path.join(process.cwd(), EXPORT_CONFIG.output_dir);
    if (!fs.existsSync(output_dir)) {
      fs.mkdirSync(output_dir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];

    // ==========================================================================
    // 第一步：导出异动记录
    // ==========================================================================
    console.log('📊 步骤 1/2: 导出异动记录...');

    const anomalies = await oi_repo.get_anomaly_records({
      start_time: start_date,
      end_time: end_date,
      include_price_extremes: true
    });

    console.log(`  ✅ 加载完成: ${anomalies.length} 条异动记录`);

    // 转换为纯JSON格式
    const anomalies_data = anomalies.map(a => ({
      id: a.id,
      symbol: a.symbol,
      anomaly_time: a.anomaly_time.toISOString(),
      period_seconds: a.period_seconds,

      // OI数据
      oi_value: a.oi_value ? parseFloat(a.oi_value.toString()) : null,
      oi_change_pct: parseFloat(a.percent_change.toString()),
      severity: a.severity,

      // 价格数据
      current_price: a.current_price ? parseFloat(a.current_price.toString()) : null,
      price_change_pct: a.price_change_percent ? parseFloat(a.price_change_percent.toString()) : null,

      // 价格极值
      daily_high: a.daily_price_high ? parseFloat(a.daily_price_high.toString()) : null,
      daily_low: a.daily_price_low ? parseFloat(a.daily_price_low.toString()) : null,
      price_from_low_pct: a.price_from_low_pct,
      price_from_high_pct: a.price_from_high_pct,

      // 市场情绪
      top_trader_long_short_ratio: a.top_trader_long_short_ratio ? parseFloat(a.top_trader_long_short_ratio.toString()) : null,
      global_long_short_ratio: a.global_long_short_ratio ? parseFloat(a.global_long_short_ratio.toString()) : null,
      taker_buy_sell_ratio: a.taker_buy_sell_ratio ? parseFloat(a.taker_buy_sell_ratio.toString()) : null,
      funding_rate: a.funding_rate ? parseFloat(a.funding_rate.toString()) : null,
    }));

    // 保存异动记录
    const anomalies_file = path.join(output_dir, `anomalies_${timestamp}.json`);
    fs.writeFileSync(anomalies_file, JSON.stringify({
      export_info: {
        export_time: new Date().toISOString(),
        data_range: {
          start: start_date.toISOString(),
          end: end_date.toISOString(),
          days: EXPORT_CONFIG.days_back
        },
        total_records: anomalies_data.length
      },
      data: anomalies_data
    }, null, 2));

    console.log(`  💾 异动记录已保存: ${anomalies_file}`);
    console.log(`  📏 文件大小: ${(fs.statSync(anomalies_file).size / 1024 / 1024).toFixed(2)} MB\n`);

    // ==========================================================================
    // 第二步：导出快照数据（按币种分批）
    // ==========================================================================
    console.log('📈 步骤 2/2: 导出OI快照数据...');

    // 获取所有币种
    const symbols = [...new Set(anomalies.map(a => a.symbol))];
    console.log(`  发现 ${symbols.length} 个币种\n`);

    let total_snapshots = 0;
    const snapshots_data = [];

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];

      process.stdout.write(`  处理进度: ${i + 1}/${symbols.length} - ${symbol}\r`);

      try {
        // 查询该币种的所有快照
        const snapshots = await oi_repo.get_snapshots_in_range(
          symbol,
          start_date,
          end_date
        );

        if (snapshots && snapshots.length > 0) {
          // 转换为纯JSON格式
          const symbol_snapshots = snapshots.map(s => ({
            symbol: symbol,
            timestamp: s.snapshot_time instanceof Date
              ? s.snapshot_time.toISOString()
              : new Date(s.timestamp_ms).toISOString(),
            oi_value: s.open_interest ? parseFloat(s.open_interest.toString()) : null,
            mark_price: s.mark_price ? parseFloat(s.mark_price.toString()) : null
          }));

          snapshots_data.push(...symbol_snapshots);
          total_snapshots += snapshots.length;
        }
      } catch (error) {
        console.error(`\n  ❌ ${symbol} 快照数据获取失败: ${error.message}`);
      }
    }

    console.log(`\n  ✅ 快照数据加载完成: ${total_snapshots} 条记录`);

    // 保存快照数据
    const snapshots_file = path.join(output_dir, `snapshots_${timestamp}.json`);
    fs.writeFileSync(snapshots_file, JSON.stringify({
      export_info: {
        export_time: new Date().toISOString(),
        data_range: {
          start: start_date.toISOString(),
          end: end_date.toISOString(),
          days: EXPORT_CONFIG.days_back
        },
        total_symbols: symbols.length,
        total_snapshots: total_snapshots
      },
      data: snapshots_data
    }, null, 2));

    console.log(`  💾 快照数据已保存: ${snapshots_file}`);
    console.log(`  📏 文件大小: ${(fs.statSync(snapshots_file).size / 1024 / 1024).toFixed(2)} MB\n`);

    // ==========================================================================
    // 统计摘要
    // ==========================================================================
    console.log('='.repeat(80));
    console.log('📊 导出完成统计');
    console.log('='.repeat(80));
    console.log('');

    console.log('📋 异动记录:');
    console.log(`  总数量: ${anomalies_data.length} 条`);
    console.log(`  文件路径: ${anomalies_file}`);
    console.log('');

    console.log('📈 OI快照:');
    console.log(`  总数量: ${total_snapshots} 条`);
    console.log(`  币种数: ${symbols.length} 个`);
    console.log(`  文件路径: ${snapshots_file}`);
    console.log('');

    // 异动统计
    const severity_counts = {
      high: anomalies_data.filter(a => a.severity === 'high').length,
      medium: anomalies_data.filter(a => a.severity === 'medium').length,
      low: anomalies_data.filter(a => a.severity === 'low').length
    };

    console.log('📊 异动严重程度分布:');
    console.log(`  High:   ${severity_counts.high} 条 (${(severity_counts.high / anomalies_data.length * 100).toFixed(1)}%)`);
    console.log(`  Medium: ${severity_counts.medium} 条 (${(severity_counts.medium / anomalies_data.length * 100).toFixed(1)}%)`);
    console.log(`  Low:    ${severity_counts.low} 条 (${(severity_counts.low / anomalies_data.length * 100).toFixed(1)}%)`);
    console.log('');

    // OI变化统计
    const oi_changes = anomalies_data.map(a => a.oi_change_pct);
    const avg_oi_change = oi_changes.reduce((sum, v) => sum + Math.abs(v), 0) / oi_changes.length;
    const max_oi_change = Math.max(...oi_changes.map(v => Math.abs(v)));

    console.log('📈 OI变化统计:');
    console.log(`  平均变化: ${avg_oi_change.toFixed(2)}%`);
    console.log(`  最大变化: ${max_oi_change.toFixed(2)}%`);
    console.log('');

    console.log('💡 下一步建议:');
    console.log('  1. 使用 Python/R/Excel 分析异动记录');
    console.log('  2. 关联快照数据查看后续价格走势');
    console.log('  3. 挖掘有效的交易因子');
    console.log('');

    // 创建快速导入脚本（Python示例）
    const python_script = `#!/usr/bin/env python3
"""
快速数据分析脚本
用法: python analyze_data.py
"""

import json
import pandas as pd
from datetime import datetime

# 加载异动数据
print("📊 加载异动数据...")
with open('${path.basename(anomalies_file)}', 'r') as f:
    anomalies_json = json.load(f)
anomalies_df = pd.DataFrame(anomalies_json['data'])
anomalies_df['anomaly_time'] = pd.to_datetime(anomalies_df['anomaly_time'])
print(f"  加载完成: {len(anomalies_df)} 条记录")

# 加载快照数据
print("📈 加载快照数据...")
with open('${path.basename(snapshots_file)}', 'r') as f:
    snapshots_json = json.load(f)
snapshots_df = pd.DataFrame(snapshots_json['data'])
snapshots_df['timestamp'] = pd.to_datetime(snapshots_df['timestamp'])
print(f"  加载完成: {len(snapshots_df)} 条记录")

# 示例分析：异动后价格走势
def analyze_price_change(anomaly_row, minutes=60):
    """分析异动后N分钟的价格变化"""
    symbol = anomaly_row['symbol']
    anomaly_time = anomaly_row['anomaly_time']
    entry_price = anomaly_row['current_price']

    if entry_price is None or entry_price == 0:
        return None

    # 查找后续快照
    end_time = anomaly_time + pd.Timedelta(minutes=minutes)
    symbol_snapshots = snapshots_df[
        (snapshots_df['symbol'] == symbol) &
        (snapshots_df['timestamp'] >= anomaly_time) &
        (snapshots_df['timestamp'] <= end_time)
    ]

    if len(symbol_snapshots) == 0:
        return None

    # 计算价格变化
    prices = symbol_snapshots['mark_price'].dropna()
    if len(prices) == 0:
        return None

    max_price = prices.max()
    min_price = prices.min()
    final_price = prices.iloc[-1]

    return {
        'max_gain_pct': (max_price - entry_price) / entry_price * 100,
        'max_loss_pct': (min_price - entry_price) / entry_price * 100,
        'final_change_pct': (final_price - entry_price) / entry_price * 100,
        'snapshot_count': len(symbol_snapshots)
    }

print("\\n🔍 示例分析：前5条异动的60分钟价格走势")
for idx, row in anomalies_df.head(5).iterrows():
    result = analyze_price_change(row, minutes=60)
    if result:
        print(f"  {row['symbol']} ({row['anomaly_time'].strftime('%m-%d %H:%M')})")
        print(f"    最大涨幅: {result['max_gain_pct']:+.2f}%")
        print(f"    最大跌幅: {result['max_loss_pct']:+.2f}%")
        print(f"    最终涨跌: {result['final_change_pct']:+.2f}%")
        print()

print("✨ 数据加载完成，可以开始分析了！")
print("\\n示例代码:")
print("  # 查看异动分布")
print("  anomalies_df['severity'].value_counts()")
print("  ")
print("  # 查看OI变化分布")
print("  anomalies_df['oi_change_pct'].describe()")
print("  ")
print("  # 分析价格位置")
print("  anomalies_df['price_from_low_pct'].hist(bins=20)")
`;

    const python_file = path.join(output_dir, 'analyze_data.py');
    fs.writeFileSync(python_file, python_script);
    console.log(`📝 Python分析脚本已生成: ${python_file}`);
    console.log('   运行方式: cd data_exports && python analyze_data.py\n');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ 导出失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行导出
export_raw_data();
