/**
 * 模拟盘编排（纯内存，无 IO）
 *
 * 每根已收盘 5m K线按顺序执行：
 *   1. 第三推识别核心喂入本根（更新 MACD 等指标，可能产生第三推确认事件）
 *   2. 撮合引擎推进该币进行中的交易（挂单只在下一根起生效；第三推持仓用本根与上一根 MACD 柱）
 *   3. 5m 背离检测器 → 新 setup → 对应策略下单
 *   4. 聚合出完整 15m 时，15m 检测器 → 新 setup → 对应策略下单
 *   5. 第三推确认事件 → 各第三推策略按自身参数过滤 → 收盘价直接开仓
 * live=false（启动预热）时只更新指标与撮合续跑，不产生新订单。
 */

import { Bar15mAggregator } from './bar_aggregator';
import { MacdDivergenceDetector } from './macd_divergence_detector';
import { PaperEngine } from './paper_engine';
import {
  DivergenceDir, DivergenceSetup, DivergenceStrategyConfig, FlagStrategyConfig, PaperBar, PaperStrategyConfig,
  PaperTimeframe, PaperTrade, is_flag_strategy,
} from './paper_types';
import { FlagThirdPushCore, ThirdPushEvent } from '@/services/strategy_backtest/strategies/flag_third_push_core';

/** 第三推识别核心保留的 5m 根数（覆盖 24h 成交额、推动波回溯与整理期，留足余量） */
const FLAG_CORE_KEEP_BARS = 1500;

/** 单根K线的处理结果 */
export interface PaperStepResult {
  changed: PaperTrade[];       // 进行中交易的变化（成交/平仓/撤单/续跑进度）
  submitted: PaperTrade[];     // 新下单（pending / 第三推直接 open）或跳过（skipped）
  setups: DivergenceSetup[];   // 本根产出的全部背离 setup（含未通过过滤的，便于日志）
  flag_events: ThirdPushEvent[];   // 本根第三推确认事件（含未通过过滤的）
}

interface SymbolState {
  detectors: Partial<Record<PaperTimeframe, MacdDivergenceDetector>>;
  agg15: Bar15mAggregator;
  flag: FlagThirdPushCore | null;
  last_open_time: number;
}

export class PaperTradingService {
  private readonly symbols = new Map<string, SymbolState>();
  private readonly tf_dirs: Partial<Record<PaperTimeframe, DivergenceDir[]>> = {};
  private readonly div_strategies: DivergenceStrategyConfig[];
  private readonly flag_strategies: FlagStrategyConfig[];

  constructor(private readonly engine: PaperEngine, strategies: PaperStrategyConfig[]) {
    this.div_strategies = strategies.filter((s): s is DivergenceStrategyConfig => !is_flag_strategy(s));
    this.flag_strategies = strategies.filter(is_flag_strategy).filter(s => s.enabled);
    for (const s of this.div_strategies.filter(x => x.enabled)) {
      const dirs = this.tf_dirs[s.timeframe] ?? [];
      if (!dirs.includes(s.dir)) dirs.push(s.dir);
      this.tf_dirs[s.timeframe] = dirs;
    }
  }

  /** 某币已处理的最后一根 5m open_time（0 = 未处理过） */
  last_open_time(symbol: string): number {
    return this.symbols.get(symbol)?.last_open_time ?? 0;
  }

  /** 已跟踪的币种数 */
  get symbol_count(): number {
    return this.symbols.size;
  }

  private state(symbol: string): SymbolState {
    let st = this.symbols.get(symbol);
    if (!st) {
      // 各第三推策略只在过滤参数上不同，识别状态机参数相同，共用一个核心
      const flag = this.flag_strategies.length ? new FlagThirdPushCore(this.flag_strategies[0].params, 288, FLAG_CORE_KEEP_BARS) : null;
      st = { detectors: {}, agg15: new Bar15mAggregator(), flag, last_open_time: 0 };
      for (const tf of Object.keys(this.tf_dirs) as PaperTimeframe[]) {
        st.detectors[tf] = new MacdDivergenceDetector(symbol, tf, { directions: this.tf_dirs[tf], capacity: 600 });
      }
      this.symbols.set(symbol, st);
    }
    return st;
  }

  /** 处理一根已收盘 5m（同币必须按时间顺序、不重复调用） */
  process_5m(symbol: string, bar: PaperBar, live: boolean): PaperStepResult {
    const st = this.state(symbol);
    const res: PaperStepResult = { changed: [], submitted: [], setups: [], flag_events: [] };
    if (bar.open_time <= st.last_open_time) return res;
    st.last_open_time = bar.open_time;

    const flag_ev = st.flag
      ? st.flag.push({ time: bar.open_time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, quote: bar.quote_volume })
      : null;
    const ctx = st.flag ? { hist: st.flag.hist_at(st.flag.length - 1), hist_prev: st.flag.hist_at(st.flag.length - 2) } : undefined;
    res.changed = this.engine.on_bar(symbol, bar, ctx);

    const collect = (setups: DivergenceSetup[]) => {
      res.setups.push(...setups);
      if (!live) return;
      for (const setup of setups) {
        for (const s of this.div_strategies) {
          if (s.timeframe !== setup.timeframe || s.dir !== setup.dir) continue;
          const t = this.engine.submit(s.id, setup);
          if (t) res.submitted.push(t);
        }
      }
    };

    if (st.detectors['5m']) collect(st.detectors['5m'].on_bar(bar));
    if (st.detectors['15m']) {
      for (const b15 of st.agg15.push(bar)) collect(st.detectors['15m'].on_bar(b15));
    }

    if (flag_ev) {
      res.flag_events.push(flag_ev);
      if (live) {
        for (const s of this.flag_strategies) {
          const t = this.engine.submit_flag(s.id, symbol, flag_ev);
          if (t) res.submitted.push(t);
        }
      }
    }
    return res;
  }
}
