/**
 * 模拟盘编排（纯内存，无 IO）
 *
 * 每根已收盘 5m K线按顺序执行：
 *   1. 撮合引擎推进该币进行中的交易（挂单只在下一根起生效）
 *   2. 5m 检测器 → 新 setup → 对应策略下单
 *   3. 聚合出完整 15m 时，15m 检测器 → 新 setup → 对应策略下单
 * live=false（启动预热）时只更新指标与撮合续跑，不产生新订单。
 */

import { Bar15mAggregator } from './bar_aggregator';
import { MacdDivergenceDetector } from './macd_divergence_detector';
import { PaperEngine } from './paper_engine';
import { DivergenceDir, DivergenceSetup, PaperBar, PaperStrategyConfig, PaperTimeframe, PaperTrade } from './paper_types';

/** 单根K线的处理结果 */
export interface PaperStepResult {
  changed: PaperTrade[];       // 进行中交易的变化（成交/平仓/撤单/续跑进度）
  submitted: PaperTrade[];     // 新下单（pending）或跳过（skipped）
  setups: DivergenceSetup[];   // 本根产出的全部 setup（含未通过过滤的，便于日志）
}

interface SymbolState {
  detectors: Partial<Record<PaperTimeframe, MacdDivergenceDetector>>;
  agg15: Bar15mAggregator;
  last_open_time: number;
}

export class PaperTradingService {
  private readonly symbols = new Map<string, SymbolState>();
  private readonly tf_dirs: Partial<Record<PaperTimeframe, DivergenceDir[]>> = {};

  constructor(private readonly engine: PaperEngine, private readonly strategies: PaperStrategyConfig[]) {
    for (const s of strategies.filter(x => x.enabled)) {
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
      st = { detectors: {}, agg15: new Bar15mAggregator(), last_open_time: 0 };
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
    const res: PaperStepResult = { changed: [], submitted: [], setups: [] };
    if (bar.open_time <= st.last_open_time) return res;
    st.last_open_time = bar.open_time;

    res.changed = this.engine.on_bar(symbol, bar);

    const collect = (setups: DivergenceSetup[]) => {
      res.setups.push(...setups);
      if (!live) return;
      for (const setup of setups) {
        for (const s of this.strategies) {
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
    return res;
  }
}
