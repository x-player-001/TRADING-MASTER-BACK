/**
 * 支撑阻力位监控启动脚本
 *
 * 功能说明:
 * - WebSocket 订阅所有合约的 15m K线
 * - 实时检测支撑阻力位
 * - 价格接近或触碰支撑阻力位时生成报警信号
 *
 * 算法原理 (SupportResistanceDetector):
 * - 局部极值检测 (Swing High/Low)
 * - 价格聚类 (相近的极值点合并为一个价位)
 * - 有效性评分 (触碰次数 + 时间跨度 + 最近性)
 *
 * 报警类型:
 * - APPROACHING: 价格接近支撑阻力位 (距离 < 0.5%)
 * - TOUCHED: 价格触碰支撑阻力位 (距离 < 0.1%)
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_sr_monitor.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import WebSocket from 'ws';
import axios from 'axios';
import { SRAlertService } from '../src/services/sr_alert_service';
import { SRLevelRepository } from '../src/database/sr_level_repository';
import { KlineData } from '../src/analysis/support_resistance_detector';
import { ConfigManager } from '../src/core/config/config_manager';
import { logger } from '../src/utils/logger';

// ==================== 配置 ====================
const CONFIG = {
  // K线周期
  interval: '15m',

  // K线缓存数量
  kline_cache_size: 200,

  // 报警阈值
  approaching_threshold_pct: 0.5,  // 接近阈值
  touched_threshold_pct: 0.1,      // 触碰阈值

  // 支撑阻力位检测配置
  sr_config: {
    pivot_left_bars: 5,
    pivot_right_bars: 5,
    cluster_threshold_pct: 0.5,
    min_touch_count: 2,
    min_strength: 25,
    max_levels: 15
  },

  // 冷却时间 (毫秒)
  cooldown_ms: 30 * 60 * 1000,  // 30分钟

  // 状态打印间隔
  status_interval_ms: 60000,  // 1分钟

  // 支撑阻力位刷新间隔（K线数）
  // 每收到 N 根完结K线后重新计算支撑阻力位
  refresh_interval_klines: 4  // 每4根K线（1小时）刷新一次
};

// ==================== 全局变量 ====================
let ws: WebSocket | null = null;
let alert_service: SRAlertService;
let sr_repository: SRLevelRepository;

// K线缓存: symbol -> klines[]
const kline_cache: Map<string, KlineData[]> = new Map();

// 刷新计数: symbol -> count
const refresh_counter: Map<string, number> = new Map();

// 统计
const stats = {
  start_time: Date.now(),
  symbols_count: 0,
  klines_received: 0,
  alerts_generated: 0,
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

// ==================== 数据库操作 ====================
async function init_database(): Promise<void> {
  // 初始化配置管理器（数据库连接必需）
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  sr_repository = new SRLevelRepository();
  console.log('✅ 数据库连接成功');
}

// ==================== K线数据获取 ====================
async function fetch_historical_klines(symbol: string): Promise<KlineData[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines`;
  const response = await axios.get(url, {
    params: {
      symbol,
      interval: CONFIG.interval,
      limit: CONFIG.kline_cache_size
    }
  });

  return response.data.map((k: any[]) => ({
    open_time: k[0],
    close_time: k[6],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

async function get_all_symbols(): Promise<string[]> {
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  const response = await axios.get(url);
  return response.data.symbols
    .filter((s: any) =>
      s.status === 'TRADING' &&
      s.contractType === 'PERPETUAL' &&
      s.symbol.endsWith('USDT')  // 只监控 USDT 交易对，排除 USDC
    )
    .map((s: any) => s.symbol);
}

// ==================== 核心处理逻辑 ====================
async function process_kline(symbol: string, kline: any, is_final: boolean): Promise<void> {
  const kline_data: KlineData = {
    open_time: kline.t,
    close_time: kline.T,
    open: parseFloat(kline.o),
    high: parseFloat(kline.h),
    low: parseFloat(kline.l),
    close: parseFloat(kline.c),
    volume: parseFloat(kline.v)
  };

  // 获取或初始化缓存
  let cache = kline_cache.get(symbol);
  if (!cache) {
    // 首次收到该币种K线，从币安API拉取历史数据
    try {
      cache = await fetch_historical_klines(symbol);
      kline_cache.set(symbol, cache);
    } catch (error) {
      // 静默失败，不打印日志
      return;
    }
  }

  // 更新缓存
  if (cache.length > 0 && cache[cache.length - 1].open_time === kline_data.open_time) {
    // 更新最后一根K线
    cache[cache.length - 1] = kline_data;
  } else {
    // 新K线
    cache.push(kline_data);
    if (cache.length > CONFIG.kline_cache_size) {
      cache.shift();
    }
  }

  stats.klines_received++;
  stats.last_kline_time = kline_data.open_time;

  // 只在K线完结时处理报警逻辑
  if (!is_final) {
    return;
  }

  // 检查是否需要刷新支撑阻力位
  const counter = (refresh_counter.get(symbol) || 0) + 1;
  refresh_counter.set(symbol, counter);

  if (counter >= CONFIG.refresh_interval_klines || counter === 1) {
    refresh_counter.set(symbol, 0);

    // 更新支撑阻力位并检查报警
    const current_price = kline_data.close;
    const alerts = await alert_service.process(
      symbol,
      CONFIG.interval,
      cache,
      current_price,
      kline_data.open_time,
      sr_repository
    );

    if (alerts.length > 0) {
      for (const alert of alerts) {
        stats.alerts_generated++;

        // 打印报警
        const time_str = format_beijing_time(alert.kline_time);
        const type_icon = alert.level_type === 'SUPPORT' ? '🟢' : '🔴';
        const alert_icon = alert.alert_type === 'TOUCHED' ? '⚠️' : '📍';

        console.log(`\n${alert_icon} [${time_str}] ${symbol}`);
        console.log(`   ${type_icon} ${alert.alert_type}: ${alert.description}`);
        console.log(`   💪 强度: ${alert.level_strength}  📏 距离: ${alert.distance_pct.toFixed(3)}%`);
      }
    }
  }
}

// ==================== WebSocket ====================
async function start_websocket(): Promise<void> {
  const symbols = await get_all_symbols();
  stats.symbols_count = symbols.length;

  console.log(`\n📡 正在订阅 ${symbols.length} 个合约的 ${CONFIG.interval} K线...`);

  // 构建订阅流
  const streams = symbols.map(s => `${s.toLowerCase()}@kline_${CONFIG.interval}`).join('/');
  const ws_url = `wss://fstream.binance.com/stream?streams=${streams}`;

  ws = new WebSocket(ws_url);

  ws.on('open', () => {
    console.log('✅ WebSocket 连接成功');
  });

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.data && msg.data.e === 'kline') {
        const symbol = msg.data.s;
        const kline = msg.data.k;
        const is_final = kline.x;

        await process_kline(symbol, kline, is_final);
      }
    } catch (error) {
      console.error('处理消息失败:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket 错误:', error);
  });

  ws.on('close', () => {
    console.log('⚠️ WebSocket 连接断开，5秒后重连...');
    setTimeout(start_websocket, 5000);
  });
}

// ==================== 状态打印 ====================
function print_status(): void {
  const uptime = Math.round((Date.now() - stats.start_time) / 60000);
  const cached_count = kline_cache.size;

  console.log(`\n📊 [${get_current_time()}] 状态报告`);
  console.log(`   运行时间: ${uptime} 分钟`);
  console.log(`   监控币种: ${stats.symbols_count}`);
  console.log(`   缓存币种: ${cached_count}`);
  console.log(`   K线接收: ${stats.klines_received}`);
  console.log(`   报警信号: ${stats.alerts_generated}`);

  // 打印几个有支撑阻力位的币种摘要
  let sr_count = 0;
  const samples: string[] = [];
  for (const [symbol] of kline_cache) {
    const levels = alert_service.get_cached_levels(symbol, CONFIG.interval);
    if (levels.length > 0) {
      sr_count++;
      if (samples.length < 3) {
        const cache = kline_cache.get(symbol);
        if (cache && cache.length > 0) {
          const price = cache[cache.length - 1].close;
          const nearby = alert_service.get_nearby_levels(symbol, CONFIG.interval, price, 3);
          const support = nearby.supports[0];
          const resistance = nearby.resistances[0];
          samples.push(
            `   ${symbol}: 支撑${support ? support.price.toFixed(4) : '-'} / 阻力${resistance ? resistance.price.toFixed(4) : '-'}`
          );
        }
      }
    }
  }

  console.log(`   有SR位币种: ${sr_count}`);
  if (samples.length > 0) {
    console.log('   示例:');
    for (const s of samples) {
      console.log(s);
    }
  }
}

// ==================== 主函数 ====================
async function main() {
  console.log('═'.repeat(70));
  console.log('           支撑阻力位监控系统');
  console.log('═'.repeat(70));

  console.log('\n📋 配置说明:');
  console.log(`   - K线周期: ${CONFIG.interval}`);
  console.log(`   - 缓存数据: 最近 ${CONFIG.kline_cache_size} 根K线`);
  console.log(`   - 接近阈值: ${CONFIG.approaching_threshold_pct}%`);
  console.log(`   - 触碰阈值: ${CONFIG.touched_threshold_pct}%`);
  console.log(`   - 最小触碰次数: ${CONFIG.sr_config.min_touch_count}`);
  console.log(`   - 最小强度: ${CONFIG.sr_config.min_strength}`);
  console.log(`   - 冷却时间: ${CONFIG.cooldown_ms / 60000} 分钟`);
  console.log('═'.repeat(70));

  // 初始化数据库
  await init_database();

  // 初始化报警服务
  alert_service = new SRAlertService({
    approaching_threshold_pct: CONFIG.approaching_threshold_pct,
    touched_threshold_pct: CONFIG.touched_threshold_pct,
    ...CONFIG.sr_config,
    cooldown_ms: CONFIG.cooldown_ms
  });

  // 启动 WebSocket
  await start_websocket();

  // 定期打印状态
  setInterval(print_status, CONFIG.status_interval_ms);

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n\n⏹️  收到退出信号，正在停止...');
    if (ws) {
      ws.close();
    }
    console.log('👋 服务已停止');
    process.exit(0);
  });

  console.log('\n📡 正在监控所有合约的支撑阻力位...');
  console.log('   按 Ctrl+C 停止服务\n');
}

// 运行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
