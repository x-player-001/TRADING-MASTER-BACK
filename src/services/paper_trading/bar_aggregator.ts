/**
 * 5m → 15m 增量聚合（UTC 对齐，与回测一致：open=首根开盘，close=末根收盘，成交额求和）
 */

import { bucket_start } from './paper_engine';
import { TIMEFRAME_MS } from './paper_strategies';
import { PaperBar } from './paper_types';

const M15 = TIMEFRAME_MS['15m'];

export class Bar15mAggregator {
  private cur: PaperBar | null = null;

  /** 喂入一根 5m，返回已完成的 15m（通常 0 或 1 根；上一桶因缺K线不完整时也会补发） */
  push(b: PaperBar): PaperBar[] {
    const out: PaperBar[] = [];
    const bk = bucket_start(b.open_time, M15);
    if (this.cur && this.cur.open_time !== bk) {
      out.push(this.cur);
      this.cur = null;
    }
    if (!this.cur) {
      this.cur = { ...b, open_time: bk, close_time: bk + M15 - 1 };
    } else {
      this.cur.high = Math.max(this.cur.high, b.high);
      this.cur.low = Math.min(this.cur.low, b.low);
      this.cur.close = b.close;
      this.cur.volume += b.volume;
      this.cur.quote_volume += b.quote_volume;
    }
    if (b.close_time + 1 >= bk + M15) {
      out.push(this.cur);
      this.cur = null;
    }
    return out;
  }
}
