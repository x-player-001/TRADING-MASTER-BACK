/**
 * 模拟盘运行器（pm2: paper）
 *
 * 流程:
 *   1. 恢复进行中的模拟交易（pending/open）
 *   2. 预热：按日表顺序读取最近 N 天全市场 5m（每表一次扫描），喂给检测器/撮合引擎续跑，不产生新订单
 *   3. 独立订阅全市场 5m K线 WS（看门狗自动重连）；同币串行处理，发现缺K线时先用 REST 补齐
 *   4. 每根收盘 5m：撮合 → 5m 检测 → 聚合 15m 检测 → 新订单/状态变化入库
 *
 * 策略与账户参数见 src/services/paper_trading/paper_strategies.ts
 *
 * 运行:
 *   npx ts-node -r tsconfig-paths/register scripts/run_paper_trading.ts
 *   PAPER_DRY_RUN=1 ...   只打印不写库（不建表、不恢复交易），用于上线前试跑
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import WebSocket from 'ws';
import axios from 'axios';

import { ConfigManager } from '@/core/config/config_manager';
import { Kline5mRepository } from '@/database/kline_5m_repository';
import { PaperTradingRepository } from '@/database/paper_trading_repository';
import { PaperEngine } from '@/services/paper_trading/paper_engine';
import { PaperTradingService } from '@/services/paper_trading/paper_trading_service';
import { PAPER_ACCOUNT, PAPER_STRATEGIES } from '@/services/paper_trading/paper_strategies';
import { PaperBar, PaperTrade } from '@/services/paper_trading/paper_types';

// ==================== 配置 ====================

const CONFIG = {
  preload_days: 4,                    // 预热天数（15m 约 384 根，足够 MACD 收敛与峰识别）
  preload_table_pause_ms: 1500,       // 每读一张日表后暂停，避免连续扫表
  blacklist: new Set(['USDCUSDT']),
  status_interval_ms: 5 * 60_000,
  ws_silence_timeout_ms: 60_000,
  gap_fill_max_bars: 1000,            // 单次 REST 补齐上限（limit≤1000 → 权重 5）
  heartbeat_interval_ms: 60_000,      // 运行状态写库间隔（供前端展示）
};

const M5 = 5 * 60_000;
const DRY_RUN = process.env.PAPER_DRY_RUN === '1';

// ==================== 全局 ====================

let repo: PaperTradingRepository;
let service: PaperTradingService;
let engine: PaperEngine;
const symbol_chains = new Map<string, Promise<void>>();

const stats = {
  start_time: Date.now(),
  bars: 0,
  last_bar_time: 0,
  ws_connected: false,
  symbols: 0,
  gap_filled: 0,
  signals: 0,
  orders: 0,
  fills: 0,
  closes: 0,
  pnl: 0,
};

// ==================== 工具 ====================

/** 北京时间 MM-DD HH:mm */
function bj(ts: number): string {
  return new Date(ts + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}

/** 价格格式化（保留 6 位有效数字） */
function px(v: number | null): string {
  return v === null ? '-' : String(+v.toPrecision(6));
}

/** 币安 REST K线 → PaperBar */
function rest_to_bar(k: any[]): PaperBar {
  const close = parseFloat(k[4]), volume = parseFloat(k[5]);
  return {
    open_time: k[0], close_time: k[6],
    open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close,
    volume, quote_volume: close * volume,
  };
}

// ==================== 交易事件日志与入库 ====================

/** 打印交易状态变化 */
function log_trade(t: PaperTrade, prev_status: string | null): void {
  const tag = `[${t.strategy_id}] ${t.symbol}`;
  if (prev_status === null) {
    if (t.status === 'skipped') {
      console.log(`⏭️  ${tag} 信号跳过（${t.cancel_reason}）反转K线 ${bj(t.setup_time)}`);
      return;
    }
    const f = t.features;
    console.log(`\n📝 ${tag} 挂单 ${t.side === 'short' ? '做空' : '做多'}  触发价 ${px(t.entry_trigger)}  止损 ${px(t.stop_price)}  ` +
      `反转K线 ${bj(t.setup_time)}  DIF比 ${f.dif_ratio.toFixed(2)} 红柱比 ${f.hist_ratio.toFixed(2)} 前波 ${f.imp_pct.toFixed(1)}% 末段 ${f.leg_pct.toFixed(1)}%`);
    return;
  }
  if (prev_status === t.status) return;
  if (t.status === 'open') {
    console.log(`\n🎯 ${tag} 成交 ${px(t.fill_price)}  止损 ${px(t.stop_price)}  止盈 ${px(t.take_profit)}  数量 ${px(t.qty)}  名义 ${t.notional?.toFixed(0)}U`);
  } else if (t.status === 'closed') {
    const emoji = (t.pnl ?? 0) >= 0 ? '✅' : '❌';
    console.log(`\n${emoji} ${tag} 平仓(${t.exit_reason}) ${px(t.exit_price)}  盈亏 ${t.pnl?.toFixed(2)}U  ${t.r_multiple?.toFixed(2)}R`);
  } else {
    console.log(`⚪ ${tag} ${t.status}（${t.cancel_reason}）`);
  }
}

/** 入库（失败只记日志，下次状态变化会再次 upsert） */
async function persist(t: PaperTrade): Promise<void> {
  if (DRY_RUN) return;
  try {
    await repo.upsert_trade(t);
  } catch (err: any) {
    console.error(`❌ 写入模拟交易失败 ${t.symbol}: ${err.message}`);
  }
}

/** 处理一根 5m 并落库 */
async function handle_bar(symbol: string, bar: PaperBar, live: boolean): Promise<void> {
  const before = new Map(engine.get_active().filter(t => t.symbol === symbol).map(t => [t, t.status as string]));
  const res = service.process_5m(symbol, bar, live);
  stats.bars++;
  if (bar.open_time > stats.last_bar_time) stats.last_bar_time = bar.open_time;
  if (live) stats.signals += res.setups.length;

  for (const t of res.changed) {
    const prev = before.get(t) ?? null;
    if (prev !== t.status) {
      if (t.status === 'open') stats.fills++;
      if (t.status === 'closed') { stats.closes++; stats.pnl += t.pnl ?? 0; }
      log_trade(t, prev);
    }
    await persist(t);
  }
  for (const t of res.submitted) {
    if (t.status === 'pending') stats.orders++;
    log_trade(t, null);
    await persist(t);
  }
}

// ==================== 预热 ====================

/** 按日表读取最近 N 天全市场 5m，喂给检测器并让恢复的交易续跑 */
async function preload(symbols: Set<string>): Promise<void> {
  const kline_repo = new Kline5mRepository();
  kline_repo.stop_flush_timer();
  const now = Date.now();
  const since = Math.floor((now - CONFIG.preload_days * 86_400_000) / (15 * 60_000)) * (15 * 60_000);
  console.log(`\n📦 预热：读取 ${bj(since)} 起的 5m 日表...`);

  // 每个本地日期一张表（与 Kline5mRepository 分表规则一致），按日期升序读取
  const day_points: number[] = [];
  const seen_dates = new Set<string>();
  for (let d = since; ; d += 86_400_000) {
    const ts = Math.min(d, now);
    const key = new Date(ts).toDateString();
    if (!seen_dates.has(key)) { seen_dates.add(key); day_points.push(ts); }
    if (ts === now) break;
  }

  for (const [idx, ts] of day_points.entries()) {
    const t0 = Date.now();
    const rows = await kline_repo.get_day_klines(ts, since);
    for (const r of rows) {
      if (!symbols.has(r.symbol)) continue;
      await handle_bar(r.symbol, {
        open_time: r.open_time, close_time: r.close_time,
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volume, quote_volume: r.close * r.volume,
      }, false);
    }
    console.log(`   ${new Date(ts).toDateString()} 表 ${rows.length} 行，用时 ${Date.now() - t0}ms`);
    if (idx < day_points.length - 1) await new Promise(r => setTimeout(r, CONFIG.preload_table_pause_ms));
  }
  console.log(`✅ 预热完成：${service.symbol_count} 个币种`);
}

// ==================== 缺口补齐 ====================

/** 用 REST 补齐 [from, to] 区间的 5m（含端点） */
async function fetch_gap(symbol: string, from: number, to: number): Promise<PaperBar[]> {
  const limit = Math.min(CONFIG.gap_fill_max_bars, Math.floor((to - from) / M5) + 1);
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '5m', startTime: from, endTime: to, limit },
    timeout: 10_000,
  });
  return (resp.data as any[]).map(rest_to_bar).filter(b => b.close_time < Date.now());
}

/** 处理一根 WS 收盘K线：同币串行，先补缺口 */
function enqueue_live_bar(symbol: string, bar: PaperBar): void {
  const prev = symbol_chains.get(symbol) ?? Promise.resolve();
  const next = prev.then(async () => {
    const last = service.last_open_time(symbol);
    if (bar.open_time <= last) return;
    if (last > 0 && bar.open_time > last + M5) {
      try {
        const gap = await fetch_gap(symbol, last + M5, bar.open_time - M5);
        for (const g of gap) await handle_bar(symbol, g, true);
        stats.gap_filled += gap.length;
      } catch (err: any) {
        console.warn(`⚠️  ${symbol} 补齐缺口失败: ${err.message}`);
      }
    }
    await handle_bar(symbol, bar, true);
  }).catch(err => console.error(`处理 ${symbol} K线失败:`, err));
  symbol_chains.set(symbol, next);
}

// ==================== WebSocket ====================

let ws: WebSocket | null = null;
let last_ws_message = Date.now();

async function get_all_symbols(): Promise<string[]> {
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', { timeout: 15_000 });
  return resp.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol as string)
    .filter((s: string) => !CONFIG.blacklist.has(s));
}

function start_ws(symbols: string[]): void {
  const streams = symbols.map(s => `${s.toLowerCase()}@kline_5m`).join('/');
  last_ws_message = Date.now();
  ws = new WebSocket(`wss://fstream.binance.com/market/stream?streams=${streams}`);
  ws.on('open', () => { console.log(`✅ WebSocket 已连接（${symbols.length} 个流）`); last_ws_message = Date.now(); stats.ws_connected = true; });
  ws.on('message', (data: Buffer) => {
    last_ws_message = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      const k = msg.data?.k;
      if (msg.data?.e !== 'kline' || !k?.x) return;
      const close = parseFloat(k.c), volume = parseFloat(k.v);
      enqueue_live_bar(msg.data.s, {
        open_time: k.t, close_time: k.T,
        open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close,
        volume, quote_volume: close * volume,
      });
    } catch (err) {
      console.error('WS 消息处理失败:', err);
    }
  });
  ws.on('error', err => console.error('WebSocket 错误:', err.message));
  ws.on('close', () => {
    stats.ws_connected = false;
    console.log('⚠️  WebSocket 断开，5 秒后重连...');
    setTimeout(() => start_ws(symbols), 5000);
  });
}

/** 看门狗：长时间无消息（半开连接）强制重连 */
function start_watchdog(): void {
  setInterval(() => {
    if (ws && Date.now() - last_ws_message > CONFIG.ws_silence_timeout_ms) {
      console.warn('⚠️  WebSocket 无消息超时，强制重连');
      last_ws_message = Date.now();
      ws.terminate();
    }
  }, 30_000);
}

// ==================== 状态 ====================

function print_status(): void {
  const active = engine.get_active();
  const pending = active.filter(t => t.status === 'pending').length;
  const open = active.filter(t => t.status === 'open');
  const mins = Math.round((Date.now() - stats.start_time) / 60_000);
  console.log(`\n📊 [${bj(Date.now())}] 运行 ${mins} 分钟 | K线 ${stats.bars}（补齐 ${stats.gap_filled}）| ` +
    `信号 ${stats.signals} 挂单 ${stats.orders} 成交 ${stats.fills} 平仓 ${stats.closes} 本次盈亏 ${stats.pnl.toFixed(2)}U | ` +
    `挂单中 ${pending} 持仓 ${open.length}${open.length ? '：' + open.map(t => t.symbol).join(',') : ''}`);
}

/** 写入运行状态心跳（失败只记日志） */
async function heartbeat(): Promise<void> {
  if (DRY_RUN) return;
  const active = engine.get_active();
  try {
    await repo.save_runtime_status({
      started_at: stats.start_time,
      heartbeat_at: Date.now(),
      last_bar_time: stats.last_bar_time,
      ws_connected: stats.ws_connected,
      symbols: stats.symbols,
      bars_processed: stats.bars,
      gap_filled: stats.gap_filled,
      pending: active.filter(t => t.status === 'pending').length,
      open_positions: active.filter(t => t.status === 'open').length,
    });
  } catch (err: any) {
    console.error(`❌ 写入运行状态失败: ${err.message}`);
  }
}

// ==================== 主函数 ====================

async function main(): Promise<void> {
  console.log('═'.repeat(65));
  console.log('            模拟盘（MACD 顶背离 + 反转K线）');
  console.log('═'.repeat(65));
  for (const s of PAPER_STRATEGIES) {
    console.log(`   ${s.enabled ? '✅' : '⏸️ '} ${s.id}: ${s.name}  止损缓冲 ${s.stop_atr_buffer}ATR  止盈 ${s.take_profit_r}R  持仓上限 ${s.max_hold_bars} 根`);
  }
  console.log(`   每笔风险 ${PAPER_ACCOUNT.risk_per_trade_usdt}U  单边手续费 ${PAPER_ACCOUNT.fee_rate * 100}%  单币单仓 ${PAPER_ACCOUNT.one_position_per_symbol}`);

  ConfigManager.getInstance().initialize();
  repo = new PaperTradingRepository();
  engine = new PaperEngine(PAPER_ACCOUNT, PAPER_STRATEGIES);
  if (DRY_RUN) {
    console.log('\n🧪 DRY RUN：不建表、不恢复、不写库');
  } else {
    await repo.init_tables();
    const active = await repo.get_active_trades();
    engine.restore(active);
    console.log(`\n♻️  恢复进行中交易 ${active.length} 笔`);
  }

  const symbols = await get_all_symbols();
  stats.symbols = symbols.length;
  console.log(`✅ 合约 ${symbols.length} 个`);
  await heartbeat();

  service = new PaperTradingService(engine, PAPER_STRATEGIES);
  await preload(new Set(symbols));

  start_ws(symbols);
  start_watchdog();
  setInterval(print_status, CONFIG.status_interval_ms);
  await heartbeat();
  setInterval(heartbeat, CONFIG.heartbeat_interval_ms);

  process.on('SIGINT', () => { console.log('\n⏹️  停止'); ws?.removeAllListeners('close'); ws?.close(); process.exit(0); });
  console.log('\n📡 模拟盘运行中\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
