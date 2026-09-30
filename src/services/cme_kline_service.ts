/**
 * CME 期货K线服务（ES / GC 等）
 *
 * 从 Databento 拉连续合约 1m，聚合成 5m / 15m / 1h / 4h 写入 cme_klines。
 *   - 首次：拉最近 N 天
 *   - 增量：从库里最新 5m 所在的 4h 桶起点重拉，保证最后一个（可能未收盘的）桶被完整重算
 *   - 下载前先估价，超过上限直接中止（Databento 按量计费）
 *
 * 分桶按 UTC 对齐（与币安K线、回放模块一致）；换月发生在 UTC 零点，不会出现一个桶跨两个合约。
 */

import {
  DatabentoBar,
  continuous_symbol,
  estimate_cost,
  fetch_ohlcv_1m,
  get_available_end,
  resolve_contract_names,
} from '@/api/databento_api';
import { CmeKlineRepository, CmeKlineRow } from '@/database/cme_kline_repository';
import { logger } from '@/utils/logger';

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** 单次请求的时间跨度（控制响应体大小） */
const FETCH_CHUNK_MS = 30 * ONE_DAY_MS;

/** 聚合的目标周期 */
export const CME_INTERVALS: Record<string, number> = {
  '5m': 5 * ONE_MINUTE_MS,
  '15m': 15 * ONE_MINUTE_MS,
  '1h': 60 * ONE_MINUTE_MS,
  '4h': 4 * 60 * ONE_MINUTE_MS,
};
const MAX_INTERVAL_MS = CME_INTERVALS['4h'];

/** 回填参数 */
export interface CmeBackfillOptions {
  days: number;          // 首次（或 force）拉取的天数
  force: boolean;        // 忽略已有数据，按 days 整段重拉
  max_cost: number;      // 单品种费用上限（美元）
}

/** 回填结果 */
export interface CmeBackfillResult {
  symbol: string;
  start: number;
  end: number;
  cost: number;
  bars_1m: number;
  written: Record<string, number>;
  contracts: string[];
}

/**
 * 把 1m 聚合成指定周期（输入须按时间升序）
 * 合约取桶内最后一根 1m 的合约
 */
export function aggregate_1m(
  symbol: string,
  bars: DatabentoBar[],
  interval: string,
  contract_names: Map<number, string>,
): CmeKlineRow[] {
  const interval_ms = CME_INTERVALS[interval];
  const result: CmeKlineRow[] = [];
  let current: CmeKlineRow | null = null;
  for (const b of bars) {
    const start = Math.floor(b.open_time / interval_ms) * interval_ms;
    const contract = contract_names.get(b.instrument_id) ?? String(b.instrument_id);
    if (!current || current.open_time !== start) {
      current = {
        symbol,
        interval,
        open_time: start,
        close_time: start + interval_ms - 1,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        contract,
      };
      result.push(current);
    } else {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += b.volume;
      current.contract = contract;
    }
  }
  return result;
}

export class CmeKlineService {
  private readonly repository = new CmeKlineRepository();

  /** 初始化表结构 */
  async init(): Promise<void> {
    await this.repository.init_tables();
  }

  /**
   * 回填一个品种
   * @param symbol 品种根代码，如 ES / GC
   */
  async backfill(symbol: string, options: CmeBackfillOptions): Promise<CmeBackfillResult> {
    const root = symbol.toUpperCase();
    const code = continuous_symbol(root);
    const end = Math.floor(await get_available_end('ohlcv-1m') / ONE_MINUTE_MS) * ONE_MINUTE_MS;

    const latest = options.force ? null : await this.repository.get_latest_open_time(root, '5m');
    const from = latest ?? end - options.days * ONE_DAY_MS;
    const start = Math.floor(from / MAX_INTERVAL_MS) * MAX_INTERVAL_MS;

    const result: CmeBackfillResult = { symbol: root, start, end, cost: 0, bars_1m: 0, written: {}, contracts: [] };
    if (start >= end) return result;

    result.cost = await estimate_cost([code], 'ohlcv-1m', start, end);
    logger.info(`[CmeKline] ${root} ${this.fmt(start)} ~ ${this.fmt(end)} 预估费用 $${result.cost.toFixed(4)}`);
    if (result.cost > options.max_cost) {
      throw new Error(`${root} 预估费用 $${result.cost.toFixed(2)} 超过上限 $${options.max_cost}，已中止（可用 --max-cost 调整）`);
    }

    const bars: DatabentoBar[] = [];
    for (let t = start; t < end; t += FETCH_CHUNK_MS) {
      const chunk_end = Math.min(t + FETCH_CHUNK_MS, end);
      const chunk = await fetch_ohlcv_1m(code, t, chunk_end);
      bars.push(...chunk);
      logger.info(`[CmeKline] ${root} ${this.fmt(t)} ~ ${this.fmt(chunk_end)} 拉到 ${chunk.length} 根 1m`);
    }
    result.bars_1m = bars.length;
    if (bars.length === 0) return result;

    const ids = [...new Set(bars.map(b => b.instrument_id))];
    const names = await resolve_contract_names(code, start, end);
    result.contracts = ids.map(id => names.get(id) ?? String(id));

    for (const interval of Object.keys(CME_INTERVALS)) {
      const rows = aggregate_1m(root, bars, interval, names);
      await this.repository.upsert_klines(rows);
      result.written[interval] = rows.length;
    }
    return result;
  }

  /** 各品种各周期数据概况 */
  async get_summary() {
    return this.repository.get_summary();
  }

  /** UTC 时间 YYYY-MM-DD HH:mm */
  private fmt(ts: number): string {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}
