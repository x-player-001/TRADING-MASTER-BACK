/**
 * 支撑阻力位监控启动脚本 (带爆发预测)
 *
 * 功能说明:
 * - WebSocket 订阅所有合约的 15m K线
 * - 实时检测支撑阻力位
 * - 基于多维度特征评估爆发概率
 * - 只有评分达到阈值的信号才会报警，减少噪音
 *
 * SQUEEZE 报警 (均线粘合):
 * - 粘合度 = |EMA20 - EMA60| / price * 100
 * - 粘合度 <= 0.03% 时触发报警 (MA收敛评分 = 100)
 * - 冷却期内如果粘合度比上次更低，也会触发新报警
 * - 24小时涨幅 >= 10% 时显示警告提示
 *
 * 报警前提条件:
 * - 均线多头排列: EMA30 > EMA60 > EMA120 > EMA200
 *
 * 报警类型:
 * - SQUEEZE: 均线粘合预警 (EMA20/EMA60 粘合度 <= 0.03%)
 * - BULLISH_STREAK: 连续阳线预警 (连续5根阳线，至少一根涨幅>=1%)
 * - APPROACHING: 接近支撑阻力位 (距离 < 0.1%，综合评分 >= 70，或24h涨幅>=10%)
 * - TOUCHED: 触碰支撑阻力位 (距离 < 0.05%，综合评分 >= 70，或24h涨幅>=10%)
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
import { Kline15mRepository, Kline15mData } from '../src/database/kline_15m_repository';
import { KlineData } from '../src/analysis/support_resistance_detector';
import { ConfigManager } from '../src/core/config/config_manager';

// ==================== 配置 ====================
const CONFIG = {
  // K线周期
  interval: '15m',

  // 黑名单币种（不监控）
  blacklist: ['USDCUSDT'],

  // K线缓存数量
  kline_cache_size: 200,

  // 报警阈值
  approaching_threshold_pct: 0.1,  // 接近阈值 (收紧到0.1%)
  touched_threshold_pct: 0.05,     // 触碰阈值 (收紧到0.05%)

  // 支撑阻力位检测配置
  sr_config: {
    pivot_left_bars: 5,
    pivot_right_bars: 5,
    cluster_threshold_pct: 0.5,
    min_touch_count: 2,
    min_strength: 25,
    max_levels: 15,
    // 爆发预测评分阈值
    min_breakout_score: 70,        // 最小评分（从60提升到70）
    enable_squeeze_alert: true,     // 启用 SQUEEZE 波动收敛报警
    squeeze_score_threshold: 80,    // SQUEEZE 报警阈值
    // 连续阳线报警
    enable_bullish_streak_alert: true,  // 启用连续阳线报警
    bullish_streak_count: 5,            // 连续5根阳线
    bullish_streak_min_gain_pct: 1.0    // 至少一根涨幅 >= 1%
  },

  // 冷却时间 (毫秒)
  cooldown_ms: 15 * 60 * 1000,  // 15分钟 (从30分钟调整为15分钟)

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
let kline_repository: Kline15mRepository;

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
  kline_repository = new Kline15mRepository();
  console.log('✅ 数据库连接成功');
}

// ==================== K线数据获取 ====================

/**
 * 从数据库加载K线数据
 */
async function load_klines_from_db(symbol: string, limit: number): Promise<KlineData[]> {
  try {
    const now = Date.now();
    const start_time = now - (limit + 10) * 15 * 60 * 1000; // 每根K线15分钟

    const db_rows = await kline_repository.get_klines_by_time_range(symbol, start_time, now);

    return db_rows.map(row => ({
      open_time: typeof row.open_time === 'number' ? row.open_time : Number(row.open_time),
      close_time: typeof row.close_time === 'number' ? row.close_time : Number(row.close_time),
      open: typeof row.open === 'number' ? row.open : parseFloat(String(row.open)),
      high: typeof row.high === 'number' ? row.high : parseFloat(String(row.high)),
      low: typeof row.low === 'number' ? row.low : parseFloat(String(row.low)),
      close: typeof row.close === 'number' ? row.close : parseFloat(String(row.close)),
      volume: typeof row.volume === 'number' ? row.volume : parseFloat(String(row.volume))
    }));
  } catch (error) {
    return [];
  }
}

/**
 * 从API拉取K线数据
 */
async function fetch_klines_from_api(symbol: string, limit: number): Promise<KlineData[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines`;
  const response = await axios.get(url, {
    params: {
      symbol,
      interval: CONFIG.interval,
      limit
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

/**
 * 合并K线数据（去重）
 */
function merge_klines(db_klines: KlineData[], api_klines: KlineData[]): KlineData[] {
  const map = new Map<number, KlineData>();

  for (const k of db_klines) {
    map.set(k.open_time, k);
  }
  for (const k of api_klines) {
    map.set(k.open_time, k);  // API数据优先（更新）
  }

  return Array.from(map.values()).sort((a, b) => a.open_time - b.open_time);
}

/**
 * 加载历史K线（优先数据库，缺失的从API补全）
 */
async function load_historical_klines(symbol: string): Promise<KlineData[]> {
  const required = CONFIG.kline_cache_size;

  // 1. 先从数据库查询
  const db_klines = await load_klines_from_db(symbol, required);

  if (db_klines.length >= required * 0.8) {
    // 数据库数据足够（>=80%），直接使用
    return db_klines.slice(-required);
  }

  // 2. 数据库数据不足，从API拉取
  try {
    const api_klines = await fetch_klines_from_api(symbol, required);

    if (api_klines.length > 0) {
      // 合并数据库和API数据，去重
      const merged = merge_klines(db_klines, api_klines);
      return merged.slice(-required);
    }
  } catch (error) {
    // API失败，静默处理
  }

  // 3. API也失败了，使用数据库已有数据
  if (db_klines.length > 0) {
    return db_klines;
  }

  throw new Error('No kline data available');
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

/**
 * 保存K线到数据库（异步）
 */
function save_kline_to_db(symbol: string, k: any): void {
  const kline_data: Kline15mData = {
    symbol,
    open_time: k.t,
    close_time: k.T,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v)
  };

  // 异步添加到写入缓冲区，不阻塞
  kline_repository.add_kline(kline_data).catch(err => {
    console.error(`Failed to save kline for ${symbol}:`, err.message);
  });
}

// ==================== 核心处理逻辑 ====================
async function process_kline(symbol: string, kline: any, is_final: boolean): Promise<void> {
  // 黑名单过滤
  if (CONFIG.blacklist.includes(symbol)) {
    return;
  }

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
    // 首次收到该币种K线，优先从数据库加载，不足时从API补全
    try {
      cache = await load_historical_klines(symbol);
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

  // 只在K线完结时处理
  if (!is_final) {
    return;
  }

  // 保存完结的K线到数据库（异步，不阻塞）
  save_kline_to_db(symbol, kline);

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

        // 根据报警类型选择图标
        let alert_icon = '📍';
        if (alert.alert_type === 'SQUEEZE') {
          alert_icon = '🔥';
        } else if (alert.alert_type === 'BULLISH_STREAK') {
          alert_icon = '🚀';
        } else if (alert.alert_type === 'TOUCHED') {
          alert_icon = '⚠️';
        }

        // 方向箭头
        const direction_icon = alert.predicted_direction === 'UP' ? '↑' :
                               alert.predicted_direction === 'DOWN' ? '↓' : '?';

        console.log(`\n${alert_icon} [${time_str}] ${symbol} ${direction_icon}`);
        console.log(`   ${type_icon} ${alert.alert_type}: ${alert.description}`);
        console.log(`   📊 评分: ${alert.breakout_score?.toFixed(1) || '-'} | 波动:${alert.volatility_score || '-'} 量能:${alert.volume_score || '-'} 均线:${alert.ma_convergence_score || '-'} 形态:${alert.pattern_score || '-'}`);
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
async function print_status(): Promise<void> {
  const uptime = Math.round((Date.now() - stats.start_time) / 60000);
  const cached_count = kline_cache.size;

  // 获取K线入库统计
  let db_stats = { today_count: 0, today_symbols: 0, buffer_size: 0 };
  try {
    db_stats = await kline_repository.get_statistics();
  } catch {
    // 忽略错误
  }

  console.log(`\n📊 [${get_current_time()}] 状态报告`);
  console.log(`   运行时间: ${uptime} 分钟`);
  console.log(`   监控币种: ${stats.symbols_count}`);
  console.log(`   缓存币种: ${cached_count}`);
  console.log(`   K线接收: ${stats.klines_received}`);
  console.log(`   K线入库: ${db_stats.today_count} (${db_stats.today_symbols}币种, 缓冲${db_stats.buffer_size})`);
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
  console.log('        支撑阻力位监控系统 (带爆发预测)');
  console.log('═'.repeat(70));

  console.log('\n📋 配置说明:');
  console.log(`   - K线周期: ${CONFIG.interval}`);
  console.log(`   - 缓存数据: 最近 ${CONFIG.kline_cache_size} 根K线`);
  console.log(`   - 接近阈值: ${CONFIG.approaching_threshold_pct}%`);
  console.log(`   - 触碰阈值: ${CONFIG.touched_threshold_pct}%`);
  console.log(`   - 最小触碰次数: ${CONFIG.sr_config.min_touch_count}`);
  console.log(`   - 最小强度: ${CONFIG.sr_config.min_strength}`);
  console.log(`   - 冷却时间: ${CONFIG.cooldown_ms / 60000} 分钟`);
  console.log(`   - 黑名单: ${CONFIG.blacklist.length > 0 ? CONFIG.blacklist.join(', ') : '无'}`);
  console.log('\n🎯 爆发预测:');
  console.log(`   - 前提条件: 均线多头排列 (EMA30 > EMA60 > EMA120 > EMA200)`);
  console.log(`   - SQUEEZE报警: MA收敛评分 = 100 (EMA20/60粘合度 <= 0.03%)`);
  console.log(`   - BULLISH_STREAK: 连续${CONFIG.sr_config.bullish_streak_count}根阳线，至少一根涨幅 >= ${CONFIG.sr_config.bullish_streak_min_gain_pct}%`);
  console.log(`   - APPROACHING/TOUCHED: 综合评分 >= ${CONFIG.sr_config.min_breakout_score}，或24h涨幅 >= 10%`);
  console.log(`   - 评分维度: 波动收敛(25%) + 量能萎缩(20%) + 均线收敛(20%) + 位置(20%) + 形态(15%)`);
  console.log(`   - 24小时涨幅 >= 10% 时显示 ⚠️ 提示，且可绕过评分限制`);
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
    // 刷新K线写入缓冲区
    console.log('💾 正在保存缓冲区数据...');
    kline_repository.stop_flush_timer();
    await kline_repository.flush();
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
