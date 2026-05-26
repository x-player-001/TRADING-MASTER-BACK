/**
 * 趋势跟随监控脚本
 *
 * 功能:
 * 1. WebSocket 订阅所有 USDT 永续合约的 5m K线
 * 2. 5m K线聚合为 15m / 1h / 4h
 * 3. 四个级别同时监控趋势第二波入场机会:
 *    - 识别强势第一波（连续阳线 + 实体占比高 + 幅度超均）
 *    - 进入观察区后按回调幅度/时间/成交量分级报警：
 *        Lv1 轻度回调（< 38.2%，缩量）
 *        Lv2 黄金回调（38.2%~50%，缩量+止跌形态）
 *        Lv3 深度回调（50%~61.8%，谨慎）
 *    - 超过 61.8% / 连续大阴线 / 时间超限 → 废弃
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_trend_follow_monitor.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import WebSocket from 'ws';
import axios from 'axios';

import { ConfigManager } from '@/core/config/config_manager';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { KlineAggregator } from '@/core/data/kline_aggregator';
import {
  TrendFollowService,
  TrendAlert,
  AbandonEvent,
  UnifiedKline,
  Timeframe,
} from '@/services/trend_follow_service';
import { TrendFollowRepository } from '@/database/trend_follow_repository';

// ==================== 配置 ====================

const CONFIG = {
  interval: '5m' as const,
  blacklist: new Set(['USDCUSDT']),
  status_interval_ms: 60_000,      // 状态打印间隔
  preload_bars: 150,               // 预加载历史K线根数（用于冷启动）
};

// ==================== 全局变量 ====================

let kline_5m_repository: Kline5mRepository;
let kline_aggregator: KlineAggregator;
let trend_service: TrendFollowService;
let trend_follow_repository: TrendFollowRepository;

const stats = {
  start_time: Date.now(),
  symbols_count: 0,
  klines_received: 0,
  alerts_lv1: 0,
  alerts_lv2: 0,
  alerts_lv3: 0,
  abandoned: 0,
};

// ==================== 工具函数 ====================

function beijing_time(ts: number): string {
  const d = new Date(ts);
  const h = String((d.getUTCHours() + 8) % 24).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function now_str(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

// ==================== 报警打印 ====================

function print_alert(alert: TrendAlert): void {
  const level_emoji = ['', '🟡', '🟢', '🔴'][alert.alert_level];
  const tf_label = alert.timeframe.toUpperCase();
  const time_str = beijing_time(alert.kline_time);
  const shrink_str = alert.volume_shrink ? '缩量✅' : '未缩量';
  const reversal_str = alert.reversal_signal ? ' 止跌形态✅' : '';

  console.log(
    `\n${level_emoji} [Lv${alert.alert_level}] [${tf_label}] [${time_str}] ${alert.symbol}  第二波入场机会`
  );
  console.log(`   第一波: ${alert.wave.start_price.toFixed(4)} → ${alert.wave.end_price.toFixed(4)}` +
    `  幅度 ${((alert.wave.amplitude / alert.wave.start_price) * 100).toFixed(2)}%  ${alert.wave.bar_count}根K线`);
  console.log(`   回调区间: ${alert.fib_zone}  ${shrink_str}${reversal_str}`);
  console.log(`   当前价: ${alert.current_price.toFixed(4)}`);
}

function print_abandon(event: AbandonEvent): void {
  const tf_label = event.timeframe.toUpperCase();
  console.log(
    `\n⚫ [废弃] [${tf_label}] ${event.symbol}  ${event.reason}`
  );
}

// ==================== K线处理 ====================

async function process_kline(symbol: string, kline_raw: any): Promise<void> {
  if (CONFIG.blacklist.has(symbol)) return;

  stats.klines_received++;

  const kline_data: Kline5mData = {
    symbol,
    open_time: kline_raw.t,
    close_time: kline_raw.T,
    open: parseFloat(kline_raw.o),
    high: parseFloat(kline_raw.h),
    low: parseFloat(kline_raw.l),
    close: parseFloat(kline_raw.c),
    volume: parseFloat(kline_raw.v),
  };

  // 1. 趋势监控：5m 级别
  trend_service.process_5m_kline(kline_data);

  // 2. 存入数据库（异步，不阻塞）
  kline_5m_repository.add_kline(kline_data).catch(err => {
    console.error(`DB write error ${symbol}:`, err.message);
  });

  // 3. 聚合 → 15m / 1h / 4h
  const aggregated = kline_aggregator.process_5m_kline(kline_data);
  for (const agg of aggregated) {
    trend_service.process_aggregated_kline(agg);
  }
}

// ==================== WebSocket ====================

async function get_all_symbols(): Promise<string[]> {
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
  return resp.data.symbols
    .filter((s: any) =>
      s.status === 'TRADING' &&
      s.contractType === 'PERPETUAL' &&
      s.symbol.endsWith('USDT')
    )
    .map((s: any) => s.symbol as string);
}

let ws_kline: WebSocket | null = null;

async function start_kline_websocket(symbols: string[]): Promise<void> {
  console.log(`\n📡 订阅 ${symbols.length} 个合约的 ${CONFIG.interval} K线...`);

  const streams = symbols.map(s => `${s.toLowerCase()}@kline_${CONFIG.interval}`).join('/');
  const ws_url = `wss://fstream.binance.com/market/stream?streams=${streams}`;

  ws_kline = new WebSocket(ws_url);

  ws_kline.on('open', () => {
    console.log(`✅ K线 WebSocket 连接成功 (${symbols.length} 个流)`);
  });

  ws_kline.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.data?.e === 'kline' && msg.data.k?.x === true) {
        await process_kline(msg.data.s, msg.data.k);
      }
    } catch (err) {
      console.error('消息处理失败:', err);
    }
  });

  ws_kline.on('error', (err) => {
    console.error('WebSocket 错误:', err);
  });

  ws_kline.on('close', () => {
    console.log('⚠️ WebSocket 断开，5 秒后重连...');
    setTimeout(() => start_kline_websocket(symbols), 5000);
  });
}

// ==================== 预加载历史K线 ====================

async function preload_history(symbols: string[]): Promise<void> {
  console.log(`\n📦 预加载历史 5m K线（每币种 ${CONFIG.preload_bars} 根）...`);
  let loaded = 0;
  let failed = 0;

  for (const symbol of symbols) {
    if (CONFIG.blacklist.has(symbol)) continue;
    try {
      const klines = await kline_5m_repository.get_recent_klines(symbol, CONFIG.preload_bars);
      if (klines.length === 0) continue;

      // 初始化 5m 缓存
      const unified_5m: UnifiedKline[] = klines.map(k => ({
        symbol: k.symbol,
        timeframe: '5m' as Timeframe,
        open_time: k.open_time,
        close_time: k.close_time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      }));
      trend_service.init_cache(symbol, '5m', unified_5m);

      // 同时初始化聚合器缓存，并把聚合结果写入 trend_service 缓存
      await kline_aggregator.init_cache(symbol, klines);

      for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
        const agg_klines = kline_aggregator.get_aggregated_klines(symbol, tf);
        if (agg_klines.length > 0) {
          const unified: UnifiedKline[] = agg_klines.map(k => ({
            symbol: k.symbol,
            timeframe: tf,
            open_time: k.open_time,
            close_time: k.close_time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume,
          }));
          trend_service.init_cache(symbol, tf, unified);
        }
      }

      loaded++;
    } catch (err: any) {
      failed++;
      if (failed <= 3) console.warn(`预加载失败 ${symbol}: ${err.message}`);
    }
  }

  console.log(`✅ 预加载完成: ${loaded} 个币种已加载，${failed} 个失败`);
}

// ==================== 状态打印 ====================

function print_status(): void {
  const uptime = Math.round((Date.now() - stats.start_time) / 60_000);
  const svc_stats = trend_service.get_statistics();

  console.log(`\n📊 [${now_str()}] 状态报告`);
  console.log(`   运行时间: ${uptime} 分钟`);
  console.log(`   订阅币种: ${stats.symbols_count}`);
  console.log(`   K线接收: ${stats.klines_received}`);
  console.log(`   观察中: ${svc_stats.total_watching}  已废弃(本轮): ${svc_stats.total_abandoned}`);
  console.log(`   报警统计: Lv1=${stats.alerts_lv1}  Lv2=${stats.alerts_lv2}  Lv3=${stats.alerts_lv3}`);
  console.log(`   已废弃事件: ${stats.abandoned}`);
}

// ==================== 主函数 ====================

async function main(): Promise<void> {
  console.log('═'.repeat(65));
  console.log('         趋势跟随监控系统  (第二波入场)');
  console.log('═'.repeat(65));
  console.log('\n📋 监控逻辑:');
  console.log('   · 订阅所有合约 5m K线，聚合为 15m / 1h / 4h');
  console.log('   · 强势第一波条件: 连续阳线≥4根 + 实体占比≥80%(75%根数满足)');
  console.log('     + 波内平均实体 ≥ 前25根平均实体 × 1.5');
  console.log('     + 波内涨幅 ≥ 5%');
  console.log('   · 进入观察区后分级报警:');
  console.log('     🟡 Lv1 轻度回调 < 38.2%  缩量');
  console.log('     🟢 Lv2 黄金回调 38.2%~50%  缩量+止跌形态');
  console.log('     🔴 Lv3 深度回调 50%~61.8%  谨慎');
  console.log('   · 废弃条件: 回调>61.8%');
  console.log('═'.repeat(65));

  // 初始化配置
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  // 初始化服务
  kline_5m_repository = new Kline5mRepository();
  kline_aggregator = new KlineAggregator();
  trend_service = new TrendFollowService();
  trend_follow_repository = new TrendFollowRepository();
  await trend_follow_repository.init_tables();

  // 注册回调
  trend_service.on_alert((alert) => {
    if (alert.alert_level === 1) stats.alerts_lv1++;
    else if (alert.alert_level === 2) stats.alerts_lv2++;
    else if (alert.alert_level === 3) stats.alerts_lv3++;
    print_alert(alert);

    // 异步写库，不阻塞主流程
    trend_follow_repository.save_alert({
      symbol:             alert.symbol,
      timeframe:          alert.timeframe,
      alert_level:        alert.alert_level,
      kline_time:         alert.kline_time,
      current_price:      alert.current_price,
      wave_start_price:   alert.wave.start_price,
      wave_end_price:     alert.wave.end_price,
      wave_amplitude_pct: (alert.wave.amplitude / alert.wave.start_price) * 100,
      wave_bar_count:     alert.wave.bar_count,
      pullback_ratio:     alert.pullback_ratio,
      fib_zone:           alert.fib_zone,
      volume_shrink:      alert.volume_shrink,
      reversal_signal:    alert.reversal_signal,
    }).catch(err => console.error(`DB write alert error:`, err.message));
  });

  trend_service.on_abandon((event) => {
    stats.abandoned++;
    print_abandon(event);
  });

  trend_service.on_context_change((ctx) => {
    if (!ctx.wave || !ctx.pullback) return;
    const record = {
      symbol:               ctx.symbol,
      timeframe:            ctx.timeframe,
      state:                ctx.state,
      wave_start_price:     ctx.wave.start_price,
      wave_end_price:       ctx.wave.end_price,
      wave_amplitude_pct:   (ctx.wave.amplitude / ctx.wave.start_price) * 100,
      wave_bar_count:       ctx.wave.bar_count,
      wave_avg_volume:      ctx.wave.avg_volume,
      wave_end_time:        ctx.wave.end_time,
      pullback_lowest_price: ctx.pullback.lowest_price,
      pullback_bar_count:   ctx.pullback.bar_count,
      pullback_avg_volume:  ctx.pullback.avg_volume,
      last_alert_level:     ctx.last_alert_level ?? null,
      watch_start_time:     ctx.watch_start_time ?? Date.now(),
      abandoned_reason:     ctx.abandoned_reason ?? null,
    };
    trend_follow_repository.upsert_watch_context(record).catch(err =>
      console.error(`DB write context error:`, err.message)
    );
  });

  // 获取所有币种
  const symbols = await get_all_symbols();
  stats.symbols_count = symbols.length;
  console.log(`\n✅ 获取到 ${symbols.length} 个合约`);

  // 预加载历史K线
  await preload_history(symbols);

  // 启动 WebSocket
  await start_kline_websocket(symbols);

  // 定期状态打印
  setInterval(print_status, CONFIG.status_interval_ms);

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n\n⏹️  停止服务...');
    ws_kline?.close();
    kline_aggregator.stop_flush_timer();
    kline_5m_repository.stop_flush_timer();
    console.log('💾 刷新缓冲区...');
    await kline_5m_repository.flush();
    await kline_aggregator.flush();
    console.log('👋 已停止');
    process.exit(0);
  });

  console.log('\n📡 监控中，按 Ctrl+C 停止\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
