/**
 * 实盘运行器（pm2: live）—— MACD 顶背离 S1（15m）+ S2（5m）
 *
 * 流程:
 *   1. 启动自检（live 模式）：密钥、校时、单向持仓、非联合保证金、余额
 *   2. 恢复进行中交易，逐笔与交易所同步；账户对账（非本程序持仓告警、残留挂单清理）
 *   3. 用户数据流（成交 / 条件单事件 → 唤醒对应币种同步）
 *   4. 预热：按日表读最近 4 天全市场 5m 喂检测器（不下单），进行中交易批量追赶
 *   5. 订阅全市场 5m K线（看门狗重连、缺口 REST 补齐）；每根收盘：执行器推进 → 检测信号 → 下单
 *   6. 定时：兜底（30s）、账户对账（60s）、控制开关（15s）、心跳（60s）、交易规则刷新（1h）
 *
 * 运行模式：环境变量 LIVE_TRADING_MODE=live 才真实下单，否则为影子模式（只算计划、写 status=shadow）
 * 密钥：LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET（只开合约交易权限，禁止提现，绑定服务器 IP）
 * 控制：npx ts-node -r tsconfig-paths/register scripts/live_control.ts --mode=paused|running|flatten
 *
 *   npx ts-node -r tsconfig-paths/register scripts/run_live_trader.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import WebSocket from 'ws';
import axios from 'axios';

import { ConfigManager } from '@/core/config/config_manager';
import { Kline5mRepository } from '@/database/kline_5m_repository';
import { LiveTradingRepository } from '@/database/live_trading_repository';
import { BinanceLiveClient, fetch_exchange_rules } from '@/api/binance_live_client';
import { LiveExecutor, LiveNotifier, err_text } from '@/services/live_trading/live_executor';
import { LIVE_CONFIG, live_run_mode, live_strategies } from '@/services/live_trading/live_config';
import { LiveSignalSource } from '@/services/live_trading/live_signal_source';
import { UserDataStream } from '@/services/live_trading/user_data_stream';
import { LiveControlMode, SymbolRules } from '@/services/live_trading/live_types';
import { PaperBar } from '@/services/paper_trading/paper_types';
import { telegram, MessagePriority } from '@/services/telegram_service';

// ==================== 配置 ====================

const CONFIG = {
  preload_days: 4,
  preload_table_pause_ms: 1500,
  blacklist: new Set(['USDCUSDT']),
  ws_silence_timeout_ms: 60_000,
  gap_fill_max_bars: 1000,
  safety_interval_ms: 30_000,
  reconcile_interval_ms: 60_000,
  control_interval_ms: 15_000,
  heartbeat_interval_ms: 60_000,
  rules_refresh_ms: 3600_000,
  orphan_alert_interval_ms: 3600_000,
  user_event_debounce_ms: 300,
};

const M5 = 5 * 60_000;
const MODE = live_run_mode();

// ==================== 全局 ====================

let repo: LiveTradingRepository;
let client: BinanceLiveClient | null = null;
let executor: LiveExecutor;
let signals: LiveSignalSource;
let user_stream: UserDataStream | null = null;
let rules = new Map<string, SymbolRules>();
let control: LiveControlMode = 'paused';
let ready = false;                          // 预热完成前不处理实时K线
const symbol_chains = new Map<string, Promise<void>>();
const debounce_timers = new Map<string, NodeJS.Timeout>();
const orphan_alerted = new Map<string, number>();

const stats = { start_time: Date.now(), last_bar_time: 0, market_ws: false, bars: 0, signals: 0 };

// ==================== 通知 ====================

const notifier: LiveNotifier = {
  info: (msg: string) => {
    console.log(`${bj(Date.now())} ${msg}`);
    void telegram.send_text(`【实盘${MODE === 'shadow' ? '·影子' : ''}】${msg}`, MessagePriority.NORMAL);
  },
  alert: (msg: string) => {
    console.warn(`${bj(Date.now())} ${msg}`);
    void telegram.send_text(`【实盘${MODE === 'shadow' ? '·影子' : ''}】${msg}`, MessagePriority.HIGH);
  },
};

/** 北京时间 MM-DD HH:mm:ss */
function bj(ts: number): string {
  return new Date(ts + 8 * 3600_000).toISOString().slice(5, 19).replace('T', ' ');
}

// ==================== K线处理 ====================

/** 处理一批已收盘 5m（同一币种、时间升序）：执行器先推进已有交易，再检测信号下单（与模拟盘顺序一致） */
async function handle_bars(symbol: string, bars: PaperBar[]): Promise<void> {
  if (!bars.length) return;
  await executor.on_bars(symbol, bars);
  for (const bar of bars) {
    stats.bars++;
    if (bar.open_time > stats.last_bar_time) stats.last_bar_time = bar.open_time;
    for (const sig of signals.process_5m(symbol, bar)) {
      stats.signals++;
      try {
        const t = await executor.submit_setup(sig.strategy_id, sig.setup);
        if (t && t.status === 'skipped') console.log(`${bj(Date.now())} ⏭️  [${sig.strategy_id}] ${symbol} 信号跳过（${t.cancel_reason}）`);
      } catch (err) {
        notifier.alert(`❌ [${sig.strategy_id}] ${symbol} 处理信号失败: ${err_text(err)}`);
      }
    }
  }
}

/** REST 补齐 [from, to] 的 5m */
async function fetch_gap(symbol: string, from: number, to: number): Promise<PaperBar[]> {
  const limit = Math.min(CONFIG.gap_fill_max_bars, Math.floor((to - from) / M5) + 1);
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '5m', startTime: from, endTime: to, limit }, timeout: 10_000,
  });
  return (resp.data as any[]).map(k => {
    const close = parseFloat(k[4]), volume = parseFloat(k[5]);
    return {
      open_time: k[0], close_time: k[6], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]),
      close, volume, quote_volume: close * volume,
    };
  }).filter(b => b.close_time < Date.now());
}

/** 实时K线入队：同币串行，先补缺口 */
function enqueue_live_bar(symbol: string, bar: PaperBar): void {
  if (!ready) return;
  const prev = symbol_chains.get(symbol) ?? Promise.resolve();
  const next = prev.then(async () => {
    const last = signals.last_open_time(symbol);
    if (bar.open_time <= last) return;
    let batch: PaperBar[] = [];
    if (last > 0 && bar.open_time > last + M5) {
      try {
        batch = await fetch_gap(symbol, last + M5, bar.open_time - M5);
      } catch (err: any) {
        console.warn(`⚠️  ${symbol} 补齐缺口失败: ${err.message}`);
      }
    }
    batch.push(bar);
    await handle_bars(symbol, batch);
  }).catch(err => console.error(`处理 ${symbol} K线失败:`, err));
  symbol_chains.set(symbol, next);
}

// ==================== 预热 ====================

/** 按日表读取最近 N 天全市场 5m 喂检测器；进行中交易的K线收集起来最后批量追赶 */
async function preload(symbols: Set<string>): Promise<void> {
  const kline_repo = new Kline5mRepository();
  kline_repo.stop_flush_timer();
  const now = Date.now();
  const since = Math.floor((now - CONFIG.preload_days * 86_400_000) / (15 * 60_000)) * (15 * 60_000);
  console.log(`\n📦 预热：读取 ${bj(since)} 起的 5m 日表...`);

  const active_symbols = new Set(executor.get_active().map(t => t.symbol));
  const catch_up = new Map<string, PaperBar[]>();

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
      const bar: PaperBar = {
        open_time: r.open_time, close_time: r.close_time, open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volume, quote_volume: r.close * r.volume,
      };
      signals.process_5m(r.symbol, bar);   // 预热不下单
      if (bar.open_time > stats.last_bar_time) stats.last_bar_time = bar.open_time;
      if (active_symbols.has(r.symbol)) {
        const arr = catch_up.get(r.symbol) ?? [];
        arr.push(bar);
        catch_up.set(r.symbol, arr);
      }
    }
    console.log(`   ${new Date(ts).toDateString()} 表 ${rows.length} 行，用时 ${Date.now() - t0}ms`);
    if (idx < day_points.length - 1) await new Promise(r => setTimeout(r, CONFIG.preload_table_pause_ms));
  }
  for (const [symbol, bars] of catch_up) await executor.on_bars(symbol, bars);
  console.log(`✅ 预热完成：${signals.symbol_count} 个币种，追赶进行中交易 ${catch_up.size} 个币`);
}

// ==================== 行情 WebSocket ====================

let market_ws: WebSocket | null = null;
let last_ws_message = Date.now();

function start_market_ws(symbols: string[]): void {
  const streams = symbols.map(s => `${s.toLowerCase()}@kline_5m`).join('/');
  last_ws_message = Date.now();
  market_ws = new WebSocket(`wss://fstream.binance.com/market/stream?streams=${streams}`);
  market_ws.on('open', () => { console.log(`✅ 行情 WebSocket 已连接（${symbols.length} 个流）`); last_ws_message = Date.now(); stats.market_ws = true; });
  market_ws.on('message', (data: Buffer) => {
    last_ws_message = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      const k = msg.data?.k;
      if (msg.data?.e !== 'kline' || !k?.x) return;
      const close = parseFloat(k.c), volume = parseFloat(k.v);
      enqueue_live_bar(msg.data.s, {
        open_time: k.t, close_time: k.T, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l),
        close, volume, quote_volume: close * volume,
      });
    } catch (err) {
      console.error('行情消息处理失败:', err);
    }
  });
  market_ws.on('error', err => console.error('行情 WebSocket 错误:', err.message));
  market_ws.on('close', () => {
    stats.market_ws = false;
    console.log('⚠️  行情 WebSocket 断开，5 秒后重连...');
    setTimeout(() => start_market_ws(symbols), 5000);
  });
}

function start_market_watchdog(): void {
  setInterval(() => {
    if (market_ws && Date.now() - last_ws_message > CONFIG.ws_silence_timeout_ms) {
      console.warn('⚠️  行情 WebSocket 无消息超时，强制重连');
      last_ws_message = Date.now();
      market_ws.terminate();
    }
  }, 30_000);
}

// ==================== 定时任务 ====================

/** 不重叠执行的定时任务 */
function every(ms: number, name: string, fn: () => Promise<void>): void {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { console.error(`❌ 定时任务 ${name} 失败: ${err_text(err)}`); } finally { running = false; }
  }, ms);
}

/** 读取控制开关；flatten 完成（无进行中交易）后自动转 paused */
async function refresh_control(): Promise<void> {
  const next = await repo.get_control();
  if (next !== control) notifier.info(`🎛️ 控制开关：${control} → ${next}`);
  control = next;
  if (control === 'flatten' && executor.get_active().length === 0) {
    await repo.set_control('paused', 'flatten 完成自动暂停');
    control = 'paused';
    notifier.info('🎛️ 一键平仓完成，已暂停开新仓');
  }
}

/** 账户对账 + 非本程序持仓告警（每币每小时一次） */
async function reconcile(): Promise<void> {
  const orphans = await executor.reconcile_account();
  const now = Date.now();
  for (const s of orphans) {
    if (now - (orphan_alerted.get(s) ?? 0) < CONFIG.orphan_alert_interval_ms) continue;
    orphan_alerted.set(s, now);
    notifier.alert(`⚠️ 发现非本程序管理的持仓：${s}（不会自动处理，请人工确认）`);
  }
}

/** 心跳写库 */
async function heartbeat(): Promise<void> {
  let balance: number | null = null, available: number | null = null;
  if (client) {
    try { const b = await client.get_usdt_balance(); balance = b.balance; available = b.available; } catch { /* 心跳不因余额失败中断 */ }
  }
  await repo.save_runtime_status({
    started_at: stats.start_time, heartbeat_at: Date.now(), mode: MODE, control,
    market_ws: stats.market_ws, user_ws: user_stream?.connected ?? false, last_bar_time: stats.last_bar_time,
    balance, available, active_trades: executor.get_active().length, error_trades: executor.get_errors().length,
  });
}

/** 用户数据流事件 → 防抖后同步对应币种 */
function on_user_symbols(symbols: string[]): void {
  for (const s of symbols) {
    const prev = debounce_timers.get(s);
    if (prev) clearTimeout(prev);
    debounce_timers.set(s, setTimeout(() => {
      debounce_timers.delete(s);
      executor.sync_symbol(s).catch(err => console.error(`同步 ${s} 失败: ${err_text(err)}`));
    }, CONFIG.user_event_debounce_ms));
  }
}

// ==================== 启动自检 ====================

async function preflight(c: BinanceLiveClient): Promise<void> {
  await c.sync_time();
  if (await c.is_hedge_mode()) throw new Error('账户为双向持仓模式，请在币安合约设置中改为单向持仓后再启动');
  if (await c.is_multi_assets_mode()) throw new Error('账户为联合保证金模式（不支持逐仓），请改为单币保证金模式后再启动');
  const b = await c.get_usdt_balance();
  console.log(`✅ 账户：单向持仓、单币保证金；USDT 余额 ${b.balance.toFixed(2)}，可用 ${b.available.toFixed(2)}`);
  if (b.available < LIVE_CONFIG.margin_buffer_usdt) throw new Error(`可用余额 ${b.available} 过低`);
}

// ==================== 主函数 ====================

async function main(): Promise<void> {
  const strategies = live_strategies();
  console.log('═'.repeat(65));
  console.log(`       实盘交易 MACD 顶背离（${MODE === 'live' ? '🔴 LIVE 真实下单' : '👻 SHADOW 影子模式'}）`);
  console.log('═'.repeat(65));
  for (const s of strategies) {
    console.log(`   ${s.id}: ${s.name}  止损缓冲 ${s.stop_atr_buffer}ATR  止盈 ${s.take_profit_r}R  持仓上限 ${s.max_hold_bars} 根  条件单 ${s.order_valid_bars} 根`);
  }
  const c = LIVE_CONFIG;
  console.log(`   每笔风险 ${c.risk_per_trade_usdt}U  名义上限 ${c.max_notional_usdt}U  杠杆上限 ${c.max_leverage}x  ` +
    `同时 ${c.max_active_trades} 笔  日亏损上限 ${c.daily_loss_limit_usdt}U  滑点上限 ${c.entry_slippage_mult}R`);

  ConfigManager.getInstance().initialize();
  repo = new LiveTradingRepository();
  await repo.init_tables();
  control = await repo.get_control();
  console.log(`🎛️ 控制开关：${control}`);

  if (MODE === 'live') {
    client = BinanceLiveClient.from_env();
    await preflight(client);
  }

  rules = await fetch_exchange_rules();
  const symbols = [...rules.values()].filter(r => r.status === 'TRADING' && !CONFIG.blacklist.has(r.symbol)).map(r => r.symbol);
  console.log(`✅ 合约 ${symbols.length} 个`);

  executor = new LiveExecutor({
    mode: MODE, gateway: client, store: repo, notifier, config: LIVE_CONFIG, strategies,
    rules: s => rules.get(s) ?? null, control: () => control,
  });
  signals = new LiveSignalSource(strategies);

  // 恢复 + 同步 + 对账
  const recoverable = await repo.get_recoverable_trades();
  executor.restore(recoverable);
  console.log(`♻️  恢复进行中交易 ${executor.get_active().length} 笔，待人工处理 ${executor.get_errors().length} 笔`);
  if (executor.get_errors().length) notifier.alert(`🚨 有 ${executor.get_errors().length} 笔交易待人工处理，开新仓已禁止`);
  await executor.sync_all();
  await reconcile();

  if (client) {
    user_stream = new UserDataStream(client, {
      on_symbols: syms => on_user_symbols(syms),
      on_connected: () => { console.log('✅ 用户数据流已连接'); void executor.sync_all(); },
      on_error: msg => console.warn(`⚠️  ${msg}`),
    });
    await user_stream.start();
  }

  // 定时任务先启动（预热期间也要兜底）
  every(CONFIG.safety_interval_ms, 'safety', () => executor.safety_tick());
  every(CONFIG.reconcile_interval_ms, 'reconcile', reconcile);
  every(CONFIG.control_interval_ms, 'control', refresh_control);
  every(CONFIG.heartbeat_interval_ms, 'heartbeat', heartbeat);
  every(CONFIG.rules_refresh_ms, 'rules', async () => { rules = await fetch_exchange_rules(); });
  await heartbeat();

  await preload(new Set(symbols));
  ready = true;
  start_market_ws(symbols);
  start_market_watchdog();

  const shutdown = (sig: string) => {
    console.log(`\n⏹️  收到 ${sig}，停止（交易所侧止损止盈保持有效）`);
    user_stream?.stop();
    market_ws?.removeAllListeners('close');
    market_ws?.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', err => console.error('unhandledRejection:', err));

  notifier.info(`🚀 实盘进程启动（${MODE}，控制 ${control}，进行中 ${executor.get_active().length} 笔）`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  void telegram.send_text(`【实盘】🚨 启动失败：${err_text(err)}`, MessagePriority.HIGH);
  setTimeout(() => process.exit(1), 2000);
});
