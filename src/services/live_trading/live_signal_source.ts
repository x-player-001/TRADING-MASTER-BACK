/**
 * 实盘信号源：与模拟盘 PaperTradingService 相同的背离检测（同一检测器、同一参数、同一顺序）
 *
 * 每根已收盘 5m：先喂 5m 检测器，再聚合 15m 喂 15m 检测器；
 * 产出的 setup 按策略周期 / 方向 / 过滤条件匹配到策略（passes_filters 与模拟盘共用）。
 */

import { Bar15mAggregator } from '@/services/paper_trading/bar_aggregator';
import { MacdDivergenceDetector } from '@/services/paper_trading/macd_divergence_detector';
import { passes_filters } from '@/services/paper_trading/paper_engine';
import { DivergenceDir, DivergenceSetup, DivergenceStrategyConfig, PaperBar, PaperTimeframe } from '@/services/paper_trading/paper_types';

/** 匹配到策略的信号 */
export interface LiveSignal {
  strategy_id: string;
  setup: DivergenceSetup;
}

interface SymbolState {
  detectors: Partial<Record<PaperTimeframe, MacdDivergenceDetector>>;
  agg15: Bar15mAggregator;
  last_open_time: number;
}

export class LiveSignalSource {
  private readonly symbols = new Map<string, SymbolState>();
  private readonly tf_dirs: Partial<Record<PaperTimeframe, DivergenceDir[]>> = {};

  constructor(private readonly strategies: DivergenceStrategyConfig[]) {
    for (const s of strategies.filter(x => x.enabled)) {
      const dirs = this.tf_dirs[s.timeframe] ?? [];
      if (!dirs.includes(s.dir)) dirs.push(s.dir);
      this.tf_dirs[s.timeframe] = dirs;
    }
  }

  /** 某币已处理的最后一根 5m open_time（0 = 未处理） */
  last_open_time(symbol: string): number {
    return this.symbols.get(symbol)?.last_open_time ?? 0;
  }

  get symbol_count(): number {
    return this.symbols.size;
  }

  private state(symbol: string): SymbolState {
    let st = this.symbols.get(symbol);
    if (!st) {
      st = { detectors: {}, agg15: new Bar15mAggregator(), last_open_time: 0 };
      for (const tf of Object.keys(this.tf_dirs) as PaperTimeframe[]) {
        // capacity 与模拟盘一致
        st.detectors[tf] = new MacdDivergenceDetector(symbol, tf, { directions: this.tf_dirs[tf], capacity: 600 });
      }
      this.symbols.set(symbol, st);
    }
    return st;
  }

  /** 处理一根已收盘 5m（同币按时间顺序、不重复），返回通过过滤的信号（5m 在前、15m 在后，与模拟盘一致） */
  process_5m(symbol: string, bar: PaperBar): LiveSignal[] {
    const st = this.state(symbol);
    if (bar.open_time <= st.last_open_time) return [];
    st.last_open_time = bar.open_time;

    const out: LiveSignal[] = [];
    const collect = (setups: DivergenceSetup[]) => {
      for (const setup of setups) {
        for (const s of this.strategies) {
          if (!s.enabled || s.timeframe !== setup.timeframe || s.dir !== setup.dir) continue;
          if (passes_filters(s, setup)) out.push({ strategy_id: s.id, setup });
        }
      }
    };
    if (st.detectors['5m']) collect(st.detectors['5m'].on_bar(bar));
    if (st.detectors['15m']) {
      for (const b15 of st.agg15.push(bar)) collect(st.detectors['15m'].on_bar(b15));
    }
    return out;
  }
}
