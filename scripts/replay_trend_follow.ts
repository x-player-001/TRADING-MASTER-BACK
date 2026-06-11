/**
 * 趋势跟随规则离线回放器
 *
 * 目的：不只评估现有报警规则，而是把历史 5m K线按时间顺序喂给多个
 *       不同配置的 TrendFollowService 实例，对比各规则变体产生的
 *       报警/扳机信号质量，寻找更优的报警规则。
 *
 * 原理：TrendFollowService 是纯内存状态机，把历史K线当实时K线逐根喂入，
 *       行为与当时实盘完全一致。每个变体独立实例、独立统计。
 *
 * 评估口径（与 evaluate_alert_outcomes 一致，但用 5m 精度做触及判断）：
 *   报警信号：入场 = 报警收盘价；止盈 = 第一波高点；
 *             止损双口径：low = 回调最低影线价 / wave = 第一波起涨价
 *   扳机信号：入场 = 5m确认价；止损 = 5m摆动低点；止盈 = 父级第一波高点
 *   同一根 5m 内同时触及止损止盈 → 保守算止损先到（loss）
 *   期望R：win 计 +RR（按各自盈亏距离），loss 计 -1，open 不计入
 *
 * K线来源：本地 5m 日分表优先，覆盖率 < 90% 时回退币安 fapi 补全。
 *
 * 运行：
 *   npx ts-node -r tsconfig-paths/register scripts/replay_trend_follow.ts --days=30 --top=50
 * 参数：
 *   --days=30        回放窗口天数（默认 30）
 *   --top=50         按24h成交额取前N个USDT永续（默认 50，与 --symbols 二选一）
 *   --symbols=A,B    指定币种列表（优先于 --top）
 *   --cap=120        报警评估封顶根数（按报警自身周期计，默认 120）
 *   --trigger-cap=576 扳机评估封顶根数（5m，默认 576 = 48小时）
 *   --variants=a,b   只跑指定变体（默认全部）
 *   --detail         输出每个变体的 周期×等级 明细
 *   --out=file.json  完整统计写入 JSON 文件
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import axios from 'axios';

// 注意：axios 对 HTTPS_PROXY 环境变量的处理有缺陷（向 HTTPS 端口发明文 HTTP），
// 本脚本需在能直连币安 fapi 的环境运行（服务器）；本地数据足够时不会发起 fapi 请求
const http_client = axios;

import { ConfigManager } from '@/core/config/config_manager';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import {
  TrendFollowService,
  TrendFollowConfig,
  TrendAlert,
  EntryTriggerEvent,
} from '@/services/trend_follow_service';
import { AggregatedKline } from '@/core/data/kline_aggregator';

// ==================== 配置变体 ====================

interface Variant {
  name: string;
  description: string;
  overrides: Partial<TrendFollowConfig>;
}

/** 待对比的规则变体（可自行增删，overrides 为对默认配置的覆盖） */
const VARIANTS: Variant[] = [
  {
    name: 'baseline',
    description: '线上现行规则',
    overrides: {},
  },
  {
    name: 'recent5_vol',
    description: '缩量判断改用最近5根均量',
    overrides: { volume_shrink_recent_bars: 5 },
  },
  {
    name: 'in_zone',
    description: '在位约束：报警时价格须仍在低点附近',
    overrides: { require_price_in_zone: true },
  },
  {
    name: 'lv0_fast',
    description: 'Lv0 不受等待期限制（捕捉高位紧旗形）',
    overrides: { lv0_ignore_min_alert_bars: true },
  },
  {
    name: 'lv3_strict',
    description: 'Lv3 需止跌形态才报',
    overrides: { lv3_require_reversal: true },
  },
  {
    name: 'more_reversal',
    description: '吞没+扫低收回(spring)计入止跌形态',
    overrides: { reversal_allow_engulfing: true, reversal_allow_spring: true },
  },
  {
    name: 'half_wait',
    description: '报警等待期减半',
    overrides: { min_alert_bars_multiplier: 0.5 },
  },
  {
    name: 'combo',
    description: '组合：近5根缩量+在位+Lv0快速+吞没/spring',
    overrides: {
      volume_shrink_recent_bars: 5,
      require_price_in_zone: true,
      lv0_ignore_min_alert_bars: true,
      reversal_allow_engulfing: true,
      reversal_allow_spring: true,
    },
  },
];

// ==================== 参数解析 ====================

interface Args {
  days: number;
  top: number;
  symbols: string[] | null;
  cap: number;
  trigger_cap: number;
  variants: string[] | null;
  detail: boolean;
  out: string | null;
}

function parse_args(): Args {
  const get_num = (name: string, def: number): number => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? Number(a.split('=')[1]) : def;
  };
  const get_str = (name: string): string | null => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : null;
  };
  const symbols_str = get_str('symbols');
  const variants_str = get_str('variants');
  return {
    days: get_num('days', 30),
    top: get_num('top', 50),
    symbols: symbols_str ? symbols_str.split(',').map(s => s.trim().toUpperCase()) : null,
    cap: get_num('cap', 120),
    trigger_cap: get_num('trigger-cap', 576),
    variants: variants_str ? variants_str.split(',').map(s => s.trim()) : null,
    detail: process.argv.includes('--detail'),
    out: get_str('out'),
  };
}

// ==================== K线数据加载（本地优先，fapi 兜底）====================

const TF_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

let kline_5m_repo: Kline5mRepository;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 从币安 fapi 分页拉取 5m K线 */
async function fetch_5m_from_fapi(symbol: string, start: number, end: number): Promise<Kline5mData[]> {
  const result: Kline5mData[] = [];
  let cursor = start;
  while (cursor < end) {
    const resp = await http_client.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval: '5m', startTime: cursor, endTime: end, limit: 1000 },
      timeout: 15000,
    });
    const rows: any[] = resp.data;
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      result.push({
        symbol,
        open_time: r[0],
        close_time: r[6],
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
      });
    }
    cursor = rows[rows.length - 1][0] + TF_MS['5m'];
    if (rows.length < 1000) break;
    await sleep(250);   // 限速，避免触发 fapi 权重限制
  }
  return result;
}

/** 加载某币种回放窗口的 5m K线：本地覆盖率 ≥ 90% 用本地，否则 fapi 全量拉取 */
async function load_5m_klines(symbol: string, start: number, end: number): Promise<{ klines: Kline5mData[]; source: string }> {
  let local: Kline5mData[] = [];
  try {
    local = await kline_5m_repo.get_klines_by_time_range(symbol, start, end);
  } catch { /* 本地读取失败直接走 fapi */ }

  const expected = Math.floor((end - start) / TF_MS['5m']);
  if (expected > 0 && local.length >= expected * 0.9) {
    return { klines: local, source: 'local' };
  }
  const remote = await fetch_5m_from_fapi(symbol, start, end);
  return { klines: remote, source: `fapi(本地${local.length}/${expected})` };
}

/** 取24h成交额前N的 USDT 永续合约 */
async function get_top_symbols(top: number): Promise<string[]> {
  const [info_resp, ticker_resp] = await Promise.all([
    http_client.get('https://fapi.binance.com/fapi/v1/exchangeInfo', { timeout: 15000 }),
    http_client.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000 }),
  ]);
  const valid = new Set<string>(
    info_resp.data.symbols
      .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
      .map((s: any) => s.symbol)
  );
  return (ticker_resp.data as any[])
    .filter(t => valid.has(t.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, top)
    .map(t => t.symbol);
}

// ==================== 事件流构建（5m → 15m/1h/4h 聚合）====================

type ReplayEvent =
  | { type: '5m'; k: Kline5mData }
  | { type: 'agg'; k: AggregatedKline };

/**
 * 把 5m K线序列展开为按时间顺序的事件流：
 * 聚合K线在「下一个周期桶的第一根 5m 到来时」完结并先于该 5m 事件发出
 * （与实盘聚合器相差一根 5m 的延迟，对统计无实质影响）；末尾未完结的桶丢弃。
 */
function build_events(symbol: string, klines: Kline5mData[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const agg_tfs = ['15m', '1h', '4h'] as const;

  interface Bucket { start: number; open: number; high: number; low: number; close: number; volume: number; close_time: number; }
  const buckets: Record<string, Bucket | null> = { '15m': null, '1h': null, '4h': null };

  for (const k of klines) {
    for (const tf of agg_tfs) {
      const tf_ms = TF_MS[tf];
      const bucket_start = Math.floor(k.open_time / tf_ms) * tf_ms;
      const cur = buckets[tf];
      if (cur && cur.start !== bucket_start) {
        // 旧桶完结，先于本根 5m 发出
        events.push({
          type: 'agg',
          k: {
            symbol, interval: tf,
            open_time: cur.start, close_time: cur.close_time,
            open: cur.open, high: cur.high, low: cur.low, close: cur.close, volume: cur.volume,
          },
        });
        buckets[tf] = null;
      }
      if (!buckets[tf]) {
        buckets[tf] = {
          start: bucket_start,
          open: k.open, high: k.high, low: k.low, close: k.close,
          volume: k.volume, close_time: k.close_time,
        };
      } else {
        const b = buckets[tf]!;
        b.high = Math.max(b.high, k.high);
        b.low = Math.min(b.low, k.low);
        b.close = k.close;
        b.volume += k.volume;
        b.close_time = k.close_time;
      }
    }
    events.push({ type: '5m', k });
  }
  return events;
}

// ==================== 在线评估 ====================

interface PendingEval {
  kind: 'alert' | 'trigger';
  timeframe: string;        // 报警自身周期 / 扳机父周期
  level: number;
  entry: number;
  target: number;
  stop_low: number;         // alert: 回调最低影线价；trigger: 5m摆动低点
  stop_wave: number | null; // alert: 第一波起涨价；trigger: null
  remaining: number;        // 剩余可评估 5m 根数
  mfe: number;              // 最高价
  mae: number;              // 最低价
  outcome_low: 'win' | 'loss' | null;
  outcome_wave: 'win' | 'loss' | null;
  done: boolean;
}

interface CellStats {
  samples: number;
  // low 口径
  wins_low: number; losses_low: number; opens_low: number; sum_r_low: number;
  // wave 口径（trigger 无此口径）
  wins_wave: number; losses_wave: number; opens_wave: number; sum_r_wave: number;
  sum_mfe_pct: number; sum_mae_pct: number;
}

function new_cell(): CellStats {
  return {
    samples: 0,
    wins_low: 0, losses_low: 0, opens_low: 0, sum_r_low: 0,
    wins_wave: 0, losses_wave: 0, opens_wave: 0, sum_r_wave: 0,
    sum_mfe_pct: 0, sum_mae_pct: 0,
  };
}

/** key: `${kind}|${timeframe}|${level}` → CellStats */
type VariantStats = Map<string, CellStats>;

/** 单根 5m 更新一条在途评估，双口径独立判定 */
function update_eval(p: PendingEval, k: Kline5mData): void {
  if (p.done) return;
  p.mfe = Math.max(p.mfe, k.high);
  p.mae = Math.min(p.mae, k.low);

  const hit_target = k.high >= p.target;

  if (p.outcome_low === null) {
    const hit_stop = k.low <= p.stop_low;
    if (hit_stop) p.outcome_low = 'loss';            // 同根双触保守算 loss
    else if (hit_target) p.outcome_low = 'win';
  }
  if (p.stop_wave !== null && p.outcome_wave === null) {
    const hit_stop = k.low <= p.stop_wave;
    if (hit_stop) p.outcome_wave = 'loss';
    else if (hit_target) p.outcome_wave = 'win';
  }

  p.remaining--;
  const low_done = p.outcome_low !== null;
  const wave_done = p.stop_wave === null || p.outcome_wave !== null;
  if ((low_done && wave_done) || p.remaining <= 0) p.done = true;
}

/** 评估结束（或回放结束强制收尾），结果并入统计 */
function finalize_eval(p: PendingEval, stats: VariantStats): void {
  const key = `${p.kind}|${p.timeframe}|${p.level}`;
  let cell = stats.get(key);
  if (!cell) { cell = new_cell(); stats.set(key, cell); }

  cell.samples++;
  cell.sum_mfe_pct += (p.mfe - p.entry) / p.entry * 100;
  cell.sum_mae_pct += (p.mae - p.entry) / p.entry * 100;

  // low 口径
  const rr_low = (p.target - p.entry) / (p.entry - p.stop_low);
  if (p.outcome_low === 'win') { cell.wins_low++; cell.sum_r_low += rr_low; }
  else if (p.outcome_low === 'loss') { cell.losses_low++; cell.sum_r_low -= 1; }
  else cell.opens_low++;

  // wave 口径
  if (p.stop_wave !== null) {
    const rr_wave = (p.target - p.entry) / (p.entry - p.stop_wave);
    if (p.outcome_wave === 'win') { cell.wins_wave++; cell.sum_r_wave += rr_wave; }
    else if (p.outcome_wave === 'loss') { cell.losses_wave++; cell.sum_r_wave -= 1; }
    else cell.opens_wave++;
  }
}

// ==================== 单币种回放 ====================

function replay_symbol_variant(
  symbol: string,
  events: ReplayEvent[],
  variant: Variant,
  args: Args,
  stats: VariantStats,
): void {
  const svc = new TrendFollowService(variant.overrides);
  const pending: PendingEval[] = [];

  svc.on_alert((alert: TrendAlert) => {
    const entry = alert.current_price;
    const target = alert.wave.end_price;
    const stop_low = alert.pullback.lowest_price;
    const stop_wave = alert.wave.start_price;
    // 盈利/止损距离非正的异常样本跳过
    if (target <= entry || stop_low >= entry) return;
    pending.push({
      kind: 'alert',
      timeframe: alert.timeframe,
      level: alert.alert_level,
      entry, target, stop_low,
      stop_wave: stop_wave < entry ? stop_wave : null,
      remaining: args.cap * (TF_MS[alert.timeframe] / TF_MS['5m']),
      mfe: entry, mae: entry,
      outcome_low: null, outcome_wave: null,
      done: false,
    });
  });

  svc.on_entry_trigger((ev: EntryTriggerEvent) => {
    if (ev.target_price <= ev.confirm_price || ev.trigger_stop >= ev.confirm_price) return;
    pending.push({
      kind: 'trigger',
      timeframe: ev.parent_timeframe,
      level: ev.parent_alert_level,
      entry: ev.confirm_price,
      target: ev.target_price,
      stop_low: ev.trigger_stop,
      stop_wave: null,
      remaining: args.trigger_cap,
      mfe: ev.confirm_price, mae: ev.confirm_price,
      outcome_low: null, outcome_wave: null,
      done: false,
    });
  });

  for (const ev of events) {
    if (ev.type === '5m') {
      // 先用本根更新在途评估（报警在喂入后才产生，自动从下一根开始评估）
      for (const p of pending) update_eval(p, ev.k);
      // 收割已完结的
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].done) {
          finalize_eval(pending[i], stats);
          pending.splice(i, 1);
        }
      }
      svc.process_5m_kline(ev.k);
    } else {
      svc.process_aggregated_kline(ev.k);
    }
  }

  // 回放结束，剩余在途的按 open 收尾
  for (const p of pending) finalize_eval(p, stats);
}

// ==================== 输出 ====================

function pct(n: number, d: number): string {
  return d > 0 ? (n / d * 100).toFixed(1) : '-';
}

function pad(s: string, w: number): string {
  // 中文占两列的近似对齐
  let width = 0;
  for (const ch of s) width += /[一-鿿，。：（）]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, w - width));
}

interface VariantSummary {
  name: string;
  description: string;
  alerts: number; decided_low: number; win_rate_low: string; exp_r_low: string;
  decided_wave: number; win_rate_wave: string; exp_r_wave: string;
  triggers: number; trig_decided: number; trig_win_rate: string; trig_exp_r: string;
}

function summarize(variant: Variant, stats: VariantStats): VariantSummary {
  let alerts = 0, wins_low = 0, losses_low = 0, sum_r_low = 0;
  let wins_wave = 0, losses_wave = 0, sum_r_wave = 0;
  let triggers = 0, t_wins = 0, t_losses = 0, t_sum_r = 0;

  for (const [key, c] of stats) {
    if (key.startsWith('alert|')) {
      alerts += c.samples;
      wins_low += c.wins_low; losses_low += c.losses_low; sum_r_low += c.sum_r_low;
      wins_wave += c.wins_wave; losses_wave += c.losses_wave; sum_r_wave += c.sum_r_wave;
    } else {
      triggers += c.samples;
      t_wins += c.wins_low; t_losses += c.losses_low; t_sum_r += c.sum_r_low;
    }
  }

  const dl = wins_low + losses_low;
  const dw = wins_wave + losses_wave;
  const td = t_wins + t_losses;
  return {
    name: variant.name,
    description: variant.description,
    alerts,
    decided_low: dl,
    win_rate_low: pct(wins_low, dl),
    exp_r_low: dl > 0 ? (sum_r_low / dl).toFixed(2) : '-',
    decided_wave: dw,
    win_rate_wave: pct(wins_wave, dw),
    exp_r_wave: dw > 0 ? (sum_r_wave / dw).toFixed(2) : '-',
    triggers,
    trig_decided: td,
    trig_win_rate: pct(t_wins, td),
    trig_exp_r: td > 0 ? (t_sum_r / td).toFixed(2) : '-',
  };
}

function print_summary_table(summaries: VariantSummary[]): void {
  console.log('\n' + '═'.repeat(110));
  console.log('  变体对比总表（报警按收盘价入场模拟；期望R：win=+RR，loss=-1，open不计）');
  console.log('═'.repeat(110));
  console.log(
    pad('变体', 16) + pad('报警数', 8) + pad('分胜负', 8) +
    pad('胜率low%', 10) + pad('期望R-low', 11) +
    pad('胜率wave%', 11) + pad('期望R-wave', 12) +
    pad('扳机数', 8) + pad('扳机胜率%', 11) + pad('扳机期望R', 10)
  );
  console.log('─'.repeat(110));
  for (const s of summaries) {
    console.log(
      pad(s.name, 16) + pad(String(s.alerts), 8) + pad(String(s.decided_low), 8) +
      pad(s.win_rate_low, 10) + pad(s.exp_r_low, 11) +
      pad(s.win_rate_wave, 11) + pad(s.exp_r_wave, 12) +
      pad(String(s.triggers), 8) + pad(s.trig_win_rate, 11) + pad(s.trig_exp_r, 10)
    );
  }
  console.log('─'.repeat(110));
  for (const s of summaries) {
    console.log(`  ${pad(s.name, 16)} ${s.description}`);
  }
}

function print_detail(variant: Variant, stats: VariantStats): void {
  console.log(`\n── ${variant.name}（${variant.description}）明细 ──`);
  console.log(
    pad('类型', 9) + pad('周期', 6) + pad('等级', 6) + pad('样本', 7) +
    pad('win', 6) + pad('loss', 6) + pad('open', 6) +
    pad('胜率low%', 10) + pad('期望R', 8) + pad('MFE%', 8) + pad('MAE%', 8)
  );
  const keys = Array.from(stats.keys()).sort();
  for (const key of keys) {
    const [kind, tf, level] = key.split('|');
    const c = stats.get(key)!;
    const decided = c.wins_low + c.losses_low;
    console.log(
      pad(kind, 9) + pad(tf, 6) + pad(`Lv${level}`, 6) + pad(String(c.samples), 7) +
      pad(String(c.wins_low), 6) + pad(String(c.losses_low), 6) + pad(String(c.opens_low), 6) +
      pad(pct(c.wins_low, decided), 10) +
      pad(decided > 0 ? (c.sum_r_low / decided).toFixed(2) : '-', 8) +
      pad(c.samples > 0 ? (c.sum_mfe_pct / c.samples).toFixed(2) : '-', 8) +
      pad(c.samples > 0 ? (c.sum_mae_pct / c.samples).toFixed(2) : '-', 8)
    );
  }
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('       趋势跟随规则离线回放器');
  console.log('═'.repeat(60));

  const args = parse_args();
  const active_variants = args.variants
    ? VARIANTS.filter(v => args.variants!.includes(v.name))
    : VARIANTS;
  if (active_variants.length === 0) {
    console.error(`未匹配到变体，可用: ${VARIANTS.map(v => v.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`参数: days=${args.days} cap=${args.cap} trigger_cap=${args.trigger_cap}`);
  console.log(`变体: ${active_variants.map(v => v.name).join(', ')}`);

  ConfigManager.getInstance().initialize();
  kline_5m_repo = new Kline5mRepository();
  kline_5m_repo.stop_flush_timer();   // 回放只读，不需要写入定时器

  // 币种列表
  const symbols = args.symbols ?? await get_top_symbols(args.top);
  console.log(`币种: ${symbols.length} 个${args.symbols ? '（指定）' : `（24h成交额 TOP${args.top}）`}`);

  const end = Date.now();
  const start = end - args.days * 24 * 60 * 60 * 1000;

  // 每个变体一份累计统计
  const all_stats = new Map<string, VariantStats>();
  for (const v of active_variants) all_stats.set(v.name, new Map());

  let processed = 0;
  let skipped = 0;
  for (const symbol of symbols) {
    try {
      const { klines, source } = await load_5m_klines(symbol, start, end);
      if (klines.length < 500) {
        skipped++;
        console.log(`  [${++processed}/${symbols.length}] ${symbol} 数据不足(${klines.length}根)，跳过`);
        continue;
      }
      const events = build_events(symbol, klines);
      for (const variant of active_variants) {
        replay_symbol_variant(symbol, events, variant, args, all_stats.get(variant.name)!);
      }
      console.log(`  [${++processed}/${symbols.length}] ${symbol} ${klines.length}根5m [${source}] 完成`);
    } catch (err: any) {
      skipped++;
      console.warn(`  [${++processed}/${symbols.length}] ${symbol} 失败: ${err.message}`);
    }
  }

  console.log(`\n回放完成: ${processed - skipped} 个币种，跳过 ${skipped} 个`);

  // 输出
  const summaries = active_variants.map(v => summarize(v, all_stats.get(v.name)!));
  print_summary_table(summaries);

  if (args.detail) {
    for (const v of active_variants) print_detail(v, all_stats.get(v.name)!);
  }

  if (args.out) {
    const dump = {
      generated_at: new Date().toISOString(),
      args: { days: args.days, cap: args.cap, trigger_cap: args.trigger_cap, symbols },
      summaries,
      detail: Object.fromEntries(
        active_variants.map(v => [v.name, Object.fromEntries(all_stats.get(v.name)!)])
      ),
    };
    fs.writeFileSync(args.out, JSON.stringify(dump, null, 2));
    console.log(`\n完整统计已写入 ${args.out}`);
  }

  console.log('\n提示: 对比期望R(每笔平均盈亏的R倍数)比单看胜率更可靠；');
  console.log('      样本 < 100 的差异不要当结论；建议换不同 --days 窗口交叉验证。');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
