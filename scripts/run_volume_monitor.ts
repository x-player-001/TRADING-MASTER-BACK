/**
 * 成交量监控脚本
 *
 * 功能:
 * 1. WebSocket 订阅所有合约的 5m K线
 * 2. 5m K线聚合为 15m/1h/4h 并存储
 * 3. 监控所有币种成交量:
 *    - 完结K线：放量≥5x + 阳线 + 上影线<50%，≥10x标记为重要
 *    - 未完结K线(上涨)：放量≥10x 递进报警（10x→15x→20x），上影线<50%，都标记为重要
 *    - 未完结K线(下跌)：放量≥20x，无递进报警，标记为重要
 * 4. 倒锤头穿越EMA120形态检测（仅完结K线）：下影线>50%，上影线<20%，最低价<EMA120<收盘价，前20根K线最低价都在EMA120之上
 * 5. 完美倒锤头形态检测（独立于EMA，仅完结K线）：阳线 + 下影线>=70% + 上影线<=5%
 *
 * 注意:
 * - API 接口已集成到主服务 (api_server.ts): /api/volume-monitor/*, /api/pattern-scan/*
 * - 订单簿监控已移至主服务 (api_server.ts): /api/orderbook/*
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_volume_monitor.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import WebSocket from 'ws';
import axios from 'axios';

import { ConfigManager } from '@/core/config/config_manager';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import { VolumeMonitorService, VolumeCheckResult, HammerCrossResult, PerfectHammerResult } from '@/services/volume_monitor_service';

// ==================== 配置 ====================
const CONFIG = {
  // K线周期
  interval: '5m',

  // 黑名单币种（不监控）
  blacklist: ['USDCUSDT'],

  // 状态打印间隔
  status_interval_ms: 60000,  // 1分钟

  // K线缓存数量（用于初始化）
  kline_cache_size: 100
};

// ==================== 全局变量 ====================
let ws_kline: WebSocket | null = null;
let kline_5m_repository: Kline5mRepository;
let kline_aggregator: KlineAggregator;
let volume_monitor_service: VolumeMonitorService;

// 统计
const stats = {
  start_time: Date.now(),
  symbols_count: 0,
  klines_received: 0,
  volume_alerts: 0,
  hammer_alerts: 0,
  perfect_hammer_alerts: 0,
  aggregated_15m: 0,
  aggregated_1h: 0,
  aggregated_4h: 0,
  last_kline_time: 0
};

// ==================== 工具函数 ====================
function format_beijing_time(ts: number): string {
  const date = new Date(ts);
  const beijing_hours = (date.getUTCHours() + 8) % 24;
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${beijing_hours.toString().padStart(2, '0')}:${minutes}`;
}

function get_current_time(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// ==================== 初始化 ====================
async function init_services(): Promise<void> {
  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  // 初始化各服务
  kline_5m_repository = new Kline5mRepository();
  kline_aggregator = new KlineAggregator();
  volume_monitor_service = new VolumeMonitorService();

  // 初始化服务
  await volume_monitor_service.init();

  console.log('✅ 所有服务初始化完成');
}

// ==================== K线处理 ====================
async function process_kline(symbol: string, kline: any, is_final: boolean): Promise<void> {
  // 黑名单过滤
  if (CONFIG.blacklist.includes(symbol)) {
    return;
  }

  const kline_data: Kline5mData = {
    symbol,
    open_time: kline.t,
    close_time: kline.T,
    open: parseFloat(kline.o),
    high: parseFloat(kline.h),
    low: parseFloat(kline.l),
    close: parseFloat(kline.c),
    volume: parseFloat(kline.v)
  };

  stats.klines_received++;
  stats.last_kline_time = kline_data.open_time;

  // 1. 检查成交量激增（完结和未完结K线都检查）
  const volume_result = await volume_monitor_service.process_kline(kline_data, is_final);
  if (volume_result && volume_result.is_surge) {
    stats.volume_alerts++;
    print_volume_alert(volume_result);
  }

  // 只处理完结的K线进行存储和聚合
  if (!is_final) {
    return;
  }

  // 2. 检测完美倒锤头形态（只在K线完结时检查，独立于EMA）
  const perfect_hammer_result = volume_monitor_service.check_perfect_hammer(kline_data, is_final);
  if (perfect_hammer_result) {
    stats.perfect_hammer_alerts++;
    print_perfect_hammer_alert(perfect_hammer_result, is_final);
  }

  // 3. 检测倒锤头穿越EMA120形态（只在K线完结时检查）
  const hammer_result = volume_monitor_service.check_hammer_cross_ema(kline_data, is_final);
  if (hammer_result) {
    stats.hammer_alerts++;
    print_hammer_alert(hammer_result, is_final);
  }

  // 2. 保存5m K线到数据库
  kline_5m_repository.add_kline(kline_data).catch(err => {
    console.error(`Failed to save 5m kline for ${symbol}:`, err.message);
  });

  // 3. 聚合K线
  const aggregated = kline_aggregator.process_5m_kline(kline_data);
  for (const agg of aggregated) {
    if (agg.interval === '15m') stats.aggregated_15m++;
    else if (agg.interval === '1h') stats.aggregated_1h++;
    else if (agg.interval === '4h') stats.aggregated_4h++;
  }
}

// ==================== 报警打印 ====================
function print_volume_alert(result: VolumeCheckResult): void {
  const time_str = format_beijing_time(result.kline_time);
  const change_str = result.price_change_pct >= 0
    ? `+${result.price_change_pct.toFixed(2)}%`
    : `${result.price_change_pct.toFixed(2)}%`;

  // 根据涨跌方向显示不同颜色
  const direction_emoji = result.direction === 'UP' ? '🟢' : '🔴';
  const direction_text = result.direction === 'UP' ? '放量上涨' : '放量下跌';

  // 显示报警级别和是否完结
  const level_str = result.alert_level ? `Lv${result.alert_level}` : '';
  const final_str = result.is_final ? '✅' : '⏳';
  const important_str = result.is_important ? '⭐ 重要' : '';

  console.log(`\n🔊 [${time_str}] ${result.symbol} ${direction_text} ${direction_emoji} ${final_str} ${level_str} ${important_str}`);
  console.log(`   📊 成交量: ${result.current_volume.toFixed(2)} (${result.volume_ratio.toFixed(1)}x)`);
  console.log(`   💰 价格: ${result.current_price.toFixed(4)} (${change_str})`);
}

// ==================== 倒锤头报警打印 ====================
function print_hammer_alert(result: HammerCrossResult, is_final: boolean): void {
  const time_str = format_beijing_time(result.kline_time);
  const change_str = result.price_change_pct >= 0
    ? `+${result.price_change_pct.toFixed(2)}%`
    : `${result.price_change_pct.toFixed(2)}%`;

  const final_str = is_final ? '✅' : '⏳';

  console.log(`\n🔨 [${time_str}] ${result.symbol} 倒锤头穿越EMA120 🟢 ${final_str} ⭐ 重要`);
  console.log(`   📈 EMA120: ${result.ema120.toFixed(4)}`);
  console.log(`   📊 下影线: ${result.lower_shadow_pct.toFixed(1)}% | 上影线: ${result.upper_shadow_pct.toFixed(1)}%`);
  console.log(`   💰 价格: ${result.current_price.toFixed(4)} (${change_str})`);
}

// ==================== 完美倒锤头报警打印 ====================
function print_perfect_hammer_alert(result: PerfectHammerResult, is_final: boolean): void {
  const time_str = format_beijing_time(result.kline_time);
  const change_str = result.price_change_pct >= 0
    ? `+${result.price_change_pct.toFixed(2)}%`
    : `${result.price_change_pct.toFixed(2)}%`;

  const final_str = is_final ? '✅' : '⏳';

  console.log(`\n⭐🔨 [${time_str}] ${result.symbol} 完美倒锤头 🟢 ${final_str} ⭐ 重要`);
  console.log(`   📊 下影线: ${result.lower_shadow_pct.toFixed(1)}% | 上影线: ${result.upper_shadow_pct.toFixed(1)}%`);
  console.log(`   💰 价格: ${result.current_price.toFixed(4)} (${change_str})`);
}


// ==================== WebSocket ====================
async function get_all_symbols(): Promise<string[]> {
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  const response = await axios.get(url);
  return response.data.symbols
    .filter((s: any) =>
      s.status === 'TRADING' &&
      s.contractType === 'PERPETUAL' &&
      s.symbol.endsWith('USDT')
    )
    .map((s: any) => s.symbol);
}

async function start_kline_websocket(symbols: string[]): Promise<void> {
  console.log(`\n📡 正在订阅 ${symbols.length} 个合约的 ${CONFIG.interval} K线...`);

  // 构建订阅流
  const streams = symbols.map(s => `${s.toLowerCase()}@kline_${CONFIG.interval}`).join('/');
  const ws_url = `wss://fstream.binance.com/stream?streams=${streams}`;

  ws_kline = new WebSocket(ws_url);

  ws_kline.on('open', () => {
    console.log('✅ K线 WebSocket 连接成功');
  });

  ws_kline.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.data && msg.data.e === 'kline') {
        const symbol = msg.data.s;
        const kline = msg.data.k;
        const is_final = kline.x;

        await process_kline(symbol, kline, is_final);
      }
    } catch (error) {
      console.error('处理K线消息失败:', error);
    }
  });

  ws_kline.on('error', (error) => {
    console.error('K线 WebSocket 错误:', error);
  });

  ws_kline.on('close', () => {
    console.log('⚠️ K线 WebSocket 连接断开，5秒后重连...');
    setTimeout(() => start_kline_websocket(symbols), 5000);
  });
}

// ==================== 状态打印 ====================
async function print_status(): Promise<void> {
  const uptime = Math.round((Date.now() - stats.start_time) / 60000);
  const monitor_stats = volume_monitor_service.get_statistics();

  // 获取5m K线入库统计
  let db_stats = { today_count: 0, today_symbols: 0, buffer_size: 0 };
  try {
    db_stats = await kline_5m_repository.get_statistics();
  } catch {
    // 忽略错误
  }

  // 清理过期的未完结报警记录
  volume_monitor_service.cleanup_pending_alerts();
  volume_monitor_service.cleanup_hammer_alerts();
  volume_monitor_service.cleanup_perfect_hammer_alerts();

  console.log(`\n📊 [${get_current_time()}] 状态报告`);
  console.log(`   运行时间: ${uptime} 分钟`);
  console.log(`   订阅币种: ${stats.symbols_count}`);
  console.log(`   K线接收: ${stats.klines_received}`);
  console.log(`   K线入库: ${db_stats.today_count} (${db_stats.today_symbols}币种)`);
  console.log(`   聚合K线: 15m=${stats.aggregated_15m}, 1h=${stats.aggregated_1h}, 4h=${stats.aggregated_4h}`);
  console.log(`   放量报警: ${stats.volume_alerts} | 倒锤头报警: ${stats.hammer_alerts} | 完美倒锤头: ${stats.perfect_hammer_alerts}`);
}

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(70));
  console.log('        成交量监控系统');
  console.log('═'.repeat(70));

  console.log('\n📋 功能说明:');
  console.log(`   - K线周期: ${CONFIG.interval}`);
  console.log(`   - K线聚合: 5m → 15m/1h/4h`);
  console.log('   - 成交量监控:');
  console.log('     · 完结K线: 放量≥5x + 阳线 + 上影线<50%，≥10x标记⭐重要');
  console.log('     · 未完结K线(上涨): 放量≥10x 递进报警 10x→15x→20x，上影线<50%，标记⭐重要');
  console.log('     · 未完结K线(下跌): 放量≥20x，无递进报警，标记⭐重要');
  console.log('   - 倒锤头形态监控（仅完结K线）:');
  console.log('     · 下影线≥50%，上影线<20%');
  console.log('     · 穿越EMA120：最低价<EMA120<收盘价');
  console.log('     · 前20根K线最低价都在EMA120之上（首次下探）');
  console.log('   - ⭐完美倒锤头形态监控（仅完结K线，独立于EMA）:');
  console.log('     · 阳线 + 下影线≥70% + 上影线≤5%');
  console.log('   - API已集成到主服务 (端口3000)');
  console.log('   - 订单簿监控已移至主服务');
  console.log('═'.repeat(70));

  // 初始化服务
  await init_services();

  // 获取所有币种
  const symbols = await get_all_symbols();
  stats.symbols_count = symbols.length;

  // 从数据库预加载历史K线（解决冷启动问题）
  console.log(`\n📦 正在从数据库预加载历史K线...`);
  const preload_result = await volume_monitor_service.preload_klines_from_db(symbols);
  console.log(`✅ 预加载完成: ${preload_result.loaded} 个币种已加载历史数据`);

  // 启动 K线 WebSocket 连接
  await start_kline_websocket(symbols);

  // 定期打印状态
  setInterval(print_status, CONFIG.status_interval_ms);

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n\n⏹️  收到退出信号，正在停止...');

    if (ws_kline) {
      ws_kline.close();
    }

    // 停止服务
    volume_monitor_service.stop();
    kline_aggregator.stop_flush_timer();
    kline_5m_repository.stop_flush_timer();

    // 刷新缓冲区
    console.log('💾 正在保存缓冲区数据...');
    await kline_5m_repository.flush();
    await kline_aggregator.flush();

    console.log('👋 服务已停止');
    process.exit(0);
  });

  console.log('\n📡 正在监控所有合约...');
  console.log('   按 Ctrl+C 停止服务\n');
}

// 运行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
