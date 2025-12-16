/**
 * K线重叠区间突破监控启动脚本 (v2)
 *
 * 功能说明:
 * - WebSocket 订阅所有合约的 5m K线
 * - K线完结时分析是否突破盘整区间
 * - 突破信号保存到数据库
 *
 * 区间检测算法 (OverlapRangeDetector):
 * - 基于 K线重叠度识别盘整区间（而非收盘价聚类）
 * - 滑动窗口扫描，自动检测多个时间尺度的区间
 * - 趋势过滤：使用线性回归 R² 排除趋势区段
 * - 评分体系：重叠度(30分) + 边界触碰(25分) + 持续时间(20分) + 成交量(15分) + 形态(10分)
 *
 * 突破确认 (多维度):
 * - 幅度确认：突破幅度 >= 区间宽度的30%
 * - 成交量确认：突破K线成交量 >= 平均成交量 × 1.5
 * - 连续K线确认：后续K线收盘维持在突破方向
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_kline_breakout_monitor.ts
 */

// 加载环境变量
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { KlineBreakoutService } from '../src/services/kline_breakout_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { logger } from '../src/utils/logger';

/**
 * 格式化时间戳为北京时间 (UTC+8)
 */
function format_beijing_time(ts: number): string {
  const date = new Date(ts);
  const beijing_hours = (date.getUTCHours() + 8) % 24;
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${beijing_hours.toString().padStart(2, '0')}:${minutes}`;
}

// ==================== 配置 ====================
const CONFIG = {
  // K线缓存数量（用于区间检测，建议100根约8小时数据）
  kline_cache_size: 100,

  // 信号冷却时间（分钟）
  signal_cooldown_minutes: 30,

  // 只监控向上突破（做多），还是双向
  // ['UP'] = 只做多
  // ['DOWN'] = 只做空
  // ['UP', 'DOWN'] = 双向
  allowed_directions: ['UP', 'DOWN'] as ('UP' | 'DOWN')[],

  // 状态打印间隔（毫秒）
  status_interval_ms: 60000,  // 每分钟打印一次状态

  // 区间检测配置
  detector_config: {
    // 窗口设置
    min_window_size: 12,    // 最小窗口 12 根 K线（1小时）
    max_window_size: 60,    // 最大窗口 60 根 K线（5小时）

    // 最低分数阈值（0-100）
    min_total_score: 50,

    // 趋势过滤配置（过滤掉趋势区段，避免误报）
    trend_filter: {
      enabled: true,
      min_r_squared: 0.45,          // R² >= 0.45 认为有趋势
      min_price_change_pct: 0.5,    // 价格变化 >= 0.5% 认为有趋势
      min_slope_per_bar_pct: 0.01   // 每根K线斜率 >= 0.01%
    },

    // 区间分割配置（按价格跳空分割）
    segment_split: {
      enabled: true,
      price_gap_pct: 0.5,   // 价格跳空 >= 0.5% 时分割
      time_gap_bars: 6      // 时间间隔 >= 6 根 K线时分割
    }
  }
};

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(80));
  console.log('              K线重叠区间突破监控系统 (v2)');
  console.log('═'.repeat(80));

  console.log('\n📋 配置说明:');
  console.log(`   - K线周期: 5m`);
  console.log(`   - 缓存数据: 最近 ${CONFIG.kline_cache_size} 根K线（约${Math.round(CONFIG.kline_cache_size * 5 / 60)}小时）`);
  console.log(`   - 算法: K线重叠度检测 + 趋势过滤 (OverlapRangeDetector v2)`);
  console.log(`   - 窗口范围: ${CONFIG.detector_config.min_window_size}-${CONFIG.detector_config.max_window_size} 根K线`);
  console.log(`   - 最低区间分数: ${CONFIG.detector_config.min_total_score} 分`);
  console.log(`   - 趋势过滤: R² >= ${CONFIG.detector_config.trend_filter.min_r_squared}`);
  console.log(`   - 突破确认: 幅度 + 成交量(1.5x) + 连续K线`);
  console.log(`   - 监控方向: ${CONFIG.allowed_directions.join(', ')}`);
  console.log(`   - 信号冷却: ${CONFIG.signal_cooldown_minutes} 分钟`);
  console.log('═'.repeat(80));

  // 初始化配置管理器（数据库连接必需）
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();
  console.log('\n✅ 配置管理器已初始化');

  // 创建服务
  const service = new KlineBreakoutService({
    kline_cache_size: CONFIG.kline_cache_size,
    signal_cooldown_minutes: CONFIG.signal_cooldown_minutes,
    allowed_directions: CONFIG.allowed_directions,
    detector_config: CONFIG.detector_config
  });

  // 监听突破信号
  service.on('breakout_signal', (signal) => {
    // 信号已在 service 内部打印，这里可以添加额外处理
    // 例如：推送通知、触发交易等
  });

  // 启动服务
  console.log('\n🚀 正在启动服务...\n');

  try {
    await service.start();
    console.log('\n✅ 服务启动成功');
  } catch (error) {
    console.error('❌ 服务启动失败:', error);
    process.exit(1);
  }

  // 定期打印状态
  setInterval(async () => {
    const status = service.get_status();
    const uptime = Math.round((Date.now() - status.stats.start_time) / 60000);

    // 获取数据库统计
    let db_stats = { today_count: 0, today_symbols: 0, buffer_size: 0 };
    try {
      db_stats = await service.get_kline_db_statistics();
    } catch {
      // 忽略错误
    }

    console.log('\n📊 [状态报告]');
    console.log(`   运行时间: ${uptime} 分钟`);
    console.log(`   WebSocket 连接: ${status.connections.filter(c => c.connected).length}/${status.connections.length}`);
    console.log(`   监控币种: ${status.symbols_count}`);
    console.log(`   缓存币种: ${status.cached_symbols}`);
    console.log(`   K线接收: ${status.stats.total_klines_received}`);
    console.log(`   K线入库: ${db_stats.today_count} (${db_stats.today_symbols}币种, 缓冲${db_stats.buffer_size})`);
    console.log(`   突破信号: ${status.stats.total_signals} (UP: ${status.stats.up_signals}, DOWN: ${status.stats.down_signals})`);

    // 每5分钟打印一次区间检测摘要
    if (uptime % 5 === 0 && uptime > 0) {
      try {
        const range_summary = service.debug_get_range_summary();
        console.log('\n🔍 [区间检测摘要]');
        console.log(`   检测币种: ${range_summary.total_symbols}`);
        console.log(`   有区间的币种: ${range_summary.symbols_with_ranges}`);
        console.log(`   总区间数: ${range_summary.total_ranges}`);

        // 打印 Top 5 区间的详细信息
        if (range_summary.top_symbols.length > 0) {
          console.log('\n   📋 Top 5 高分区间详情:');
          for (const item of range_summary.top_symbols.slice(0, 5)) {
            const detail = service.debug_get_ranges(item.symbol);
            if (detail && detail.ranges.length > 0) {
              const best_range = detail.ranges.reduce((a, b) =>
                a.score.total_score > b.score.total_score ? a : b
              );
              const start_time = format_beijing_time(best_range.start_time);
              const end_time = format_beijing_time(best_range.end_time);
              const current_price = detail.current_price;
              const dist_up = ((best_range.extended_high - current_price) / current_price * 100).toFixed(3);
              const dist_down = ((current_price - best_range.extended_low) / current_price * 100).toFixed(3);

              // 判断当前价格位置
              let position = '区间内';
              if (current_price > best_range.extended_high) {
                position = `已突破上沿 +${((current_price - best_range.extended_high) / best_range.extended_high * 100).toFixed(3)}%`;
              } else if (current_price < best_range.extended_low) {
                position = `已跌破下沿 -${((best_range.extended_low - current_price) / best_range.extended_low * 100).toFixed(3)}%`;
              }

              console.log(`\n   ▸ ${item.symbol} (得分: ${item.best_score})`);
              console.log(`     时间: ${start_time} - ${end_time} (${best_range.kline_count}根K线)`);
              console.log(`     区间: ${best_range.lower_bound.toFixed(6)} - ${best_range.upper_bound.toFixed(6)} (宽度${best_range.range_width_pct.toFixed(2)}%)`);
              console.log(`     扩展边界: ${best_range.extended_low.toFixed(6)} - ${best_range.extended_high.toFixed(6)}`);
              console.log(`     覆盖度: ${(best_range.kline_coverage * 100).toFixed(1)}% | 触碰: 上${best_range.boundary_touches.upper_touches}次 下${best_range.boundary_touches.lower_touches}次`);
              console.log(`     当前价: ${current_price.toFixed(6)} | 位置: ${position}`);
              console.log(`     距上沿: ${dist_up}% | 距下沿: ${dist_down}%`);
            }
          }
        }
      } catch (err) {
        console.error('   区间检测摘要出错:', err);
      }
    }
  }, CONFIG.status_interval_ms);

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n\n⏹️  收到退出信号，正在停止服务...');
    await service.stop();
    console.log('👋 服务已停止');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n⏹️  收到终止信号，正在停止服务...');
    await service.stop();
    process.exit(0);
  });

  // 保持进程运行
  console.log('\n📡 正在监控所有合约的 5m K线...');
  console.log('   按 Ctrl+C 停止服务\n');
}

// 运行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
