/**
 * 日线趋势线突破服务（独立于趋势跟随）
 *
 * - backfill_daily_klines：币安日线 → kline_1d_agg（首次全量、之后增量）
 * - scan_breakouts：逐币检测突破并替换扫描窗口内的事件
 *
 * 由 scripts/run_daily_breakout_job.ts 每日定时调用，也供回填/研究脚本复用
 */

import { DailyBreakoutRepository } from '@/database/daily_breakout_repository';
import { fetch_daily_klines, fetch_usdt_perpetual_symbols } from '@/api/binance_daily_kline_api';
import {
  detect_trendline_breakouts, DEFAULT_TRENDLINE_CONFIG, TrendlineBreakout, TrendlineBreakoutConfig,
} from '@/analysis/trendline_breakout_detector';
import { logger } from '@/utils/logger';

const DAY_MS = 86_400_000;

export interface BackfillOptions {
  symbols?: string[] | null;   // 默认：所有交易中的 USDT 永续
  limit?: number;              // 首次（或 full）拉取根数，默认 1000
  full?: boolean;              // 忽略已有数据，每个币种都拉 limit 根
  concurrency?: number;        // 默认 2
  request_delay_ms?: number;   // 默认 500（全市场首次约 1200 权重/分钟）
  on_progress?: (line: string) => void;
}

export interface BackfillResult {
  symbols: number;
  rows: number;
  failed: string[];
}

export interface ScanOptions {
  symbols?: string[] | null;   // 默认：日线表全部币种
  from?: string | null;        // 从该币种（含）起按字母序续扫
  source?: '1d' | '4h';        // 4h：由 kline_4h_agg 聚合（本机验证用）
  save?: boolean;              // 替换 daily_trendline_breakouts 中扫描窗口内的事件
  config?: Partial<TrendlineBreakoutConfig>;
  on_result?: (symbol: string, result: TrendlineBreakout) => void;
}

export interface ScanResult {
  symbols: number;
  symbols_hit: number;
  counts: Record<TrendlineBreakout['status'], number>;
  failed: string[];
}

export class DailyBreakoutService {
  constructor(private readonly repository = new DailyBreakoutRepository()) {}

  /** 建表（幂等） */
  async init(): Promise<void> {
    await this.repository.init_tables();
  }

  /** 回填日线：已有数据的币种只补最新一根之后（多拉 2 根冗余覆盖） */
  async backfill_daily_klines(options: BackfillOptions = {}): Promise<BackfillResult> {
    const limit = Math.min(1500, Math.max(1, options.limit ?? 1000));
    const concurrency = options.concurrency ?? 2;
    const delay = options.request_delay_ms ?? 500;
    const symbols = options.symbols ?? await fetch_usdt_perpetual_symbols();
    const result: BackfillResult = { symbols: symbols.length, rows: 0, failed: [] };
    const queue = [...symbols];
    let done = 0;

    /** 单个 worker：取队列逐个回填 */
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const symbol = queue.shift()!;
        const progress = `[${++done}/${symbols.length}] ${symbol.padEnd(14)}`;
        try {
          const latest = options.full ? null : await this.repository.get_latest_daily_time(symbol);
          const n = latest === null ? limit : Math.min(limit, Math.ceil((Date.now() - latest) / DAY_MS) + 2);
          const rows = await fetch_daily_klines(symbol, n);
          await this.repository.upsert_daily_klines(rows);
          result.rows += rows.length;
          options.on_progress?.(`${progress} ${rows.length} 根${latest === null ? '（首次）' : ''}`);
        } catch (error: any) {
          result.failed.push(symbol);
          logger.error(`[DailyBreakout] 回填 ${symbol} 失败: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return result;
  }

  /** 逐币串行扫描（控制对线上库的压力），可选入库 */
  async scan_breakouts(options: ScanOptions = {}): Promise<ScanResult> {
    const cfg = { ...DEFAULT_TRENDLINE_CONFIG, ...options.config };
    const all_symbols = options.symbols
      ?? (options.source === '4h' ? await this.repository.get_4h_symbols() : await this.repository.get_daily_symbols());
    const symbols = options.from ? all_symbols.filter(s => s >= options.from!) : all_symbols;
    const since = Date.now() - (cfg.max_lookback_days + 60) * DAY_MS;

    const result: ScanResult = {
      symbols: symbols.length, symbols_hit: 0, failed: [],
      counts: { breakout: 0, retest: 0, extended: 0, failed: 0 },
    };

    for (const symbol of symbols) {
      try {
        const bars = options.source === '4h'
          ? await this.repository.get_daily_klines_from_4h(symbol, since)
          : await this.repository.get_daily_klines(symbol, since);
        const breakouts = detect_trendline_breakouts(bars, options.config);

        if (options.save && bars.length > 0) {
          const window_start = bars[bars.length - 1].open_time - cfg.max_breakout_age_days * DAY_MS;
          await this.repository.replace_breakouts(symbol, Number.isFinite(window_start) ? window_start : 0, breakouts);
        }
        if (breakouts.length > 0) result.symbols_hit++;
        for (const b of breakouts) {
          result.counts[b.status]++;
          options.on_result?.(symbol, b);
        }
      } catch (error: any) {
        result.failed.push(symbol);
        logger.error(`[DailyBreakout] 扫描 ${symbol} 失败: ${error.message}`);
      }
    }
    return result;
  }
}
