/**
 * 趋势跟随报警 事后评估器（离线批处理）
 *
 * 目的：给每条 trend_follow_alerts 报警自动打「事后标签」，回答
 *   「这个等级×周期×信号组合的报警，按规则入场后到底赚不赚」。
 *
 * 评估口径（已和使用者确认）：
 *   - 入场价 = 报警 K 线收盘价（current_price）
 *   - 止盈   = 第一波高点（wave_end_price）
 *   - 止损   = 两种口径都算：
 *       low  口径 → 回调最低影线价（优先用报警时记录的 pullback_lowest_price；
 *                   旧记录没有该列时由 pullback_ratio 反推最低收盘价近似）
 *       wave 口径 → 第一波起涨价（wave_start_price）
 *   - 触及判断：逐根 K 线，先到止盈记 win，先到止损记 loss；
 *               同一根内同时穿越止损止盈 → 保守算「止损先到」（loss）。
 *   - 评估窗口：一直评估到触及止盈或止损为止，封顶 N 根（未触及记 open）。
 *     结果为 open 且未达封顶的会随时间推进重复评估，避免幸存者偏差。
 *
 * 同时评估「多周期扳机入场确认」事件（trend_follow_entry_triggers）：
 *   入场 = 5m确认收盘价，止损 = 5m摆动低点，止盈 = 大周期第一波高点，逐根 5m 模拟。
 *   用于对比「5m确认入场 vs 报警收盘直接入场」两种打法的胜率/盈亏比。
 *
 * K线数据来源：本地数据库优先（5m 分表 / 15m·1h·4h 聚合表），
 *             发现缺口（本地根数 < 期望 90%）才回退币安 fapi 补全。
 *
 * 运行：
 *   npx ts-node -r tsconfig-paths/register scripts/evaluate_alert_outcomes.ts
 * 可加参数：
 *   --cap=120      封顶根数 N（默认 120）
 *   --ready-bars=3 报警后至少经过多少根 K 线才纳入评估（默认 3，避免刚报警就评）
 *   --limit=500    单次最多处理多少条报警（默认 500）
 *   --loop         常驻模式，每 10 分钟扫一次
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';

import { ConfigManager } from '@/core/config/config_manager';
import {
  TrendFollowRepository,
  TrendFollowAlertRecord,
} from '@/database/trend_follow_repository';
import { Kline5mRepository } from '@/database/kline_5m_repository';
import { KlineAggregator } from '@/core/data/kline_aggregator';

// ==================== 配置 ====================

/** 各周期一根 K 线的毫秒数 */
const TIMEFRAME_MS: Record<string, number> = {
  '5m':  5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
};

/**
 * low 口径止损缓冲：把止损放在回调最低点「下方」这个比例处。
 * 解决两个问题：
 *   1) 报警常发在回调低点那根，导致 stop≈entry，RR 分母趋零爆成几十万 → 缓冲后 RR 可用
 *   2) 实战里止损要留在结构低点下方一点，否则插针就被扫
 * 同时强制 entry 与 stop 的最小间距不低于此比例，杜绝 RR 爆炸。
 */
const STOP_LOW_BUFFER_PCT = 0.003;  // 0.3%

interface Args {
  cap: number;          // 封顶评估根数 N（报警自身周期）
  trigger_cap: number;  // 扳机评估封顶根数（5m，默认576=48小时）
  ready_bars: number;   // 报警后至少经过几根才评估
  limit: number;        // 单次处理上限
  loop: boolean;        // 常驻模式
}

function parse_args(): Args {
  const get = (name: string, def: number): number => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? Number(a.split('=')[1]) : def;
  };
  return {
    cap: get('cap', 120),
    trigger_cap: get('trigger-cap', 576),
    ready_bars: get('ready-bars', 3),
    limit: get('limit', 500),
    loop: process.argv.includes('--loop'),
  };
}

// ==================== K 线拉取（本地优先，fapi 兜底）====================

interface SimpleKline {
  open_time: number;
  high: number;
  low: number;
  close: number;
}

let kline_5m_repo: Kline5mRepository;
let kline_aggregator: KlineAggregator;

/**
 * 取报警后的 K 线：优先读本地数据库，发现明显缺口才回退 fapi 补全。
 *
 * 缺口判定：本地返回的根数 < 期望根数的 90%。
 * 这样既避免重复打 API（绝大多数走本地），又防止 WebSocket 断连期间的数据空洞
 * 导致 MFE/MAE 和触及判断失真（缺数据比拉不到更危险——会静默给出错误结论）。
 */
async function fetch_klines_after(
  symbol: string,
  interval: string,
  start_time: number,
  limit: number,
): Promise<SimpleKline[]> {
  const tf_ms = TIMEFRAME_MS[interval];
  const end_time = start_time + limit * tf_ms;

  // 1. 本地数据库
  let local: SimpleKline[] = [];
  try {
    if (interval === '5m') {
      const rows = await kline_5m_repo.get_klines_by_time_range(symbol, start_time, end_time);
      local = rows.map(k => ({ open_time: k.open_time, high: k.high, low: k.low, close: k.close }));
    } else {
      const rows = await kline_aggregator.get_klines_from_db(symbol, interval, start_time, end_time);
      local = rows.map(k => ({ open_time: k.open_time, high: k.high, low: k.low, close: k.close }));
    }
  } catch (err: any) {
    console.warn(`  本地读取失败 ${symbol} ${interval}: ${err.message}，转 fapi`);
  }

  // 报警刚发生不久时，期望根数受「现在距报警多久」限制
  const elapsed_bars = Math.floor((Date.now() - start_time) / tf_ms);
  const expected = Math.min(limit, Math.max(0, elapsed_bars));

  // 2. 本地够用就直接返回（无缺口）
  if (expected > 0 && local.length >= expected * 0.9) {
    return local.slice(0, limit);
  }

  // 3. 有缺口 → fapi 兜底补全
  return fetch_klines_from_fapi(symbol, interval, start_time, limit);
}

/** 从币安 U 本位合约 fapi 拉 K 线（兜底用） */
async function fetch_klines_from_fapi(
  symbol: string,
  interval: string,
  start_time: number,
  limit: number,
): Promise<SimpleKline[]> {
  const result: SimpleKline[] = [];
  let cursor = start_time;
  while (result.length < limit) {
    const batch = Math.min(1000, limit - result.length);
    const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval, startTime: cursor, limit: batch },
      timeout: 15000,
    });
    const rows: any[] = resp.data;
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      result.push({
        open_time: r[0],
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
      });
    }
    if (rows.length < batch) break;
    cursor = rows[rows.length - 1][0] + 1;
  }
  return result;
}

// ==================== 单口径模拟 ====================

interface SimOutcome {
  outcome: 'win' | 'loss' | 'open';
  rr: number | null;
  bars_to_exit: number | null;
}

/**
 * 逐根模拟一种止损口径的结果
 * 多头视角：到 target 记 win，到 stop 记 loss，同根都触及算 loss（保守）
 */
function simulate(
  klines: SimpleKline[],
  entry: number,
  target: number,
  stop: number,
): SimOutcome {
  const reward_dist = target - entry;
  const risk_dist = entry - stop;
  // 止损不在入场下方（数据异常）则该口径无意义
  if (risk_dist <= 0 || reward_dist <= 0) {
    return { outcome: 'open', rr: null, bars_to_exit: null };
  }
  const rr = reward_dist / risk_dist;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const hit_stop = k.low <= stop;
    const hit_target = k.high >= target;
    if (hit_stop && hit_target) {
      // 同根同时触及 → 保守算止损先到
      return { outcome: 'loss', rr, bars_to_exit: i + 1 };
    }
    if (hit_stop)   return { outcome: 'loss', rr, bars_to_exit: i + 1 };
    if (hit_target) return { outcome: 'win',  rr, bars_to_exit: i + 1 };
  }
  return { outcome: 'open', rr, bars_to_exit: null };
}

// ==================== 评估单条报警 ====================

async function evaluate_alert(
  repo: TrendFollowRepository,
  alert: TrendFollowAlertRecord,
  cap: number,
): Promise<'done' | 'skip'> {
  const tf_ms = TIMEFRAME_MS[alert.timeframe];
  if (!tf_ms) return 'skip';

  const entry = alert.current_price;
  const target = alert.wave_end_price;
  const stop_wave = alert.wave_start_price;
  // low 口径止损 = 报警时的回调最低影线价（新报警直接存了该列）。
  // 旧记录没有该列时由 pullback_ratio 反推最低收盘价近似：
  //   pullback_ratio = (wave_end - lowest_close) / amplitude
  //   ⇒ lowest_close = wave_end - pullback_ratio * amplitude
  // 注意反推值是收盘价口径，比真实影线低点偏高，会让 low 口径胜率略偏悲观。
  const amplitude = target - stop_wave;
  const raw_stop_low = alert.pullback_lowest_price != null && alert.pullback_lowest_price > 0
    ? alert.pullback_lowest_price
    : (amplitude > 0
      ? target - alert.pullback_ratio * amplitude
      : entry);  // 数据异常时兜底
  // 在回调低点下方留 BUFFER，并强制止损距入场至少 BUFFER（避免 stop≈entry 导致 RR 爆炸）
  const stop_low = Math.min(
    raw_stop_low * (1 - STOP_LOW_BUFFER_PCT),
    entry * (1 - STOP_LOW_BUFFER_PCT),
  );

  // 评估区间：报警 K 线收盘之后开始（下一根起）
  const start = alert.kline_time + tf_ms;
  const klines = await fetch_klines_after(alert.symbol, alert.timeframe, start, cap);
  if (klines.length === 0) return 'skip';

  // MFE / MAE（相对入场价，%）
  let max_high = -Infinity;
  let min_low = Infinity;
  for (const k of klines) {
    if (k.high > max_high) max_high = k.high;
    if (k.low < min_low) min_low = k.low;
  }
  const mfe_pct = (max_high - entry) / entry * 100;
  const mae_pct = (min_low - entry) / entry * 100;  // 负数

  const sim_low = simulate(klines, entry, target, stop_low);
  const sim_wave = simulate(klines, entry, target, stop_wave);

  await repo.upsert_alert_outcome({
    alert_id: alert.id!,
    symbol: alert.symbol,
    timeframe: alert.timeframe,
    alert_level: alert.alert_level,
    volume_shrink: alert.volume_shrink,
    reversal_signal: alert.reversal_signal,
    ema20_support: alert.ema20_support,
    entry_price: entry,
    target_price: target,
    stop_low_price: stop_low,
    stop_wave_price: stop_wave,
    eval_bars: klines.length,
    mfe_pct: round2(mfe_pct),
    mae_pct: round2(mae_pct),
    outcome_low: sim_low.outcome,
    rr_low: sim_low.rr != null ? round2(sim_low.rr) : null,
    bars_to_exit_low: sim_low.bars_to_exit,
    outcome_wave: sim_wave.outcome,
    rr_wave: sim_wave.rr != null ? round2(sim_wave.rr) : null,
    bars_to_exit_wave: sim_wave.bars_to_exit,
  });

  return 'done';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ==================== 主流程 ====================

async function run_once(repo: TrendFollowRepository, args: Args): Promise<void> {
  let done = 0;
  let skipped = 0;

  // 对每个周期分别取「报警后已过 ready_bars 根」的待评估报警
  // 用最小周期(5m)的 ready 间隔作为统一查询门槛，再逐条按各自周期校验
  const min_ready_ms = TIMEFRAME_MS['5m'] * args.ready_bars;
  const pending = await repo.get_alerts_pending_outcome(min_ready_ms, args.limit, args.cap);

  console.log(`📋 待评估报警: ${pending.length} 条`);

  for (const alert of pending) {
    const tf_ms = TIMEFRAME_MS[alert.timeframe];
    if (!tf_ms) { skipped++; continue; }

    // 该周期下，报警后是否已经积累了至少 ready_bars 根
    if (Date.now() - alert.kline_time < tf_ms * args.ready_bars) {
      skipped++;
      continue;
    }

    try {
      const r = await evaluate_alert(repo, alert, args.cap);
      if (r === 'done') {
        done++;
        if (done % 50 === 0) console.log(`  ...已评估 ${done} 条`);
      } else {
        skipped++;
      }
    } catch (err: any) {
      skipped++;
      console.warn(`⚠️  评估失败 alert#${alert.id} ${alert.symbol} ${alert.timeframe}: ${err.message}`);
    }
  }

  console.log(`✅ 报警评估完成: 评估 ${done} 条，跳过 ${skipped} 条`);

  await evaluate_triggers(repo, args);
}

/**
 * 评估扳机入场确认事件：入场=5m确认收盘价，止损=5m摆动低点，止盈=大周期第一波高点
 * outcome 为 open 且未达封顶的会在后续轮次重复评估
 */
async function evaluate_triggers(repo: TrendFollowRepository, args: Args): Promise<void> {
  const ready_ms = TIMEFRAME_MS['5m'] * args.ready_bars;
  const pending = await repo.get_triggers_pending_outcome(ready_ms, args.limit, args.trigger_cap);
  if (pending.length === 0) {
    console.log('📋 待评估扳机事件: 0 条');
    return;
  }

  console.log(`📋 待评估扳机事件: ${pending.length} 条`);
  let done = 0;
  let skipped = 0;

  for (const trig of pending) {
    try {
      const start = trig.kline_time + TIMEFRAME_MS['5m'];
      const klines = await fetch_klines_after(trig.symbol, '5m', start, args.trigger_cap);
      if (klines.length === 0) { skipped++; continue; }

      let max_high = -Infinity;
      let min_low = Infinity;
      for (const k of klines) {
        if (k.high > max_high) max_high = k.high;
        if (k.low < min_low) min_low = k.low;
      }
      const entry = trig.confirm_price;
      const sim = simulate(klines, entry, trig.target_price, trig.trigger_stop);

      await repo.update_trigger_outcome(trig.id!, {
        eval_bars: klines.length,
        mfe_pct: round2((max_high - entry) / entry * 100),
        mae_pct: round2((min_low - entry) / entry * 100),
        outcome: sim.outcome,
        bars_to_exit: sim.bars_to_exit,
      });
      done++;
    } catch (err: any) {
      skipped++;
      console.warn(`⚠️  扳机评估失败 #${trig.id} ${trig.symbol}: ${err.message}`);
    }
  }

  console.log(`✅ 扳机评估完成: 评估 ${done} 条，跳过 ${skipped} 条`);
}

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('       趋势跟随报警 事后评估器');
  console.log('═'.repeat(60));

  const args = parse_args();
  console.log(`参数: cap=${args.cap} trigger_cap=${args.trigger_cap} ready_bars=${args.ready_bars} limit=${args.limit} loop=${args.loop}`);

  ConfigManager.getInstance().initialize();

  const repo = new TrendFollowRepository();
  await repo.init_tables();

  // K线读取依赖（本地优先）
  kline_5m_repo = new Kline5mRepository();
  kline_aggregator = new KlineAggregator();

  if (args.loop) {
    console.log('🔁 常驻模式，每 10 分钟扫一次（Ctrl+C 退出）');
    const tick = async () => {
      try {
        await run_once(repo, args);
      } catch (err: any) {
        console.error('评估轮次出错:', err.message);
      }
    };
    await tick();
    setInterval(tick, 10 * 60 * 1000);
  } else {
    await run_once(repo, args);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
