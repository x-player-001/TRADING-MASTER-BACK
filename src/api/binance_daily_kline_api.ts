/**
 * 币安 U 本位合约日线接口（日线趋势线突破用）
 *
 * - 交易中的 USDT 永续合约列表
 * - 日线K线（只返回已收盘的），带 429/418 退避重试
 */

import axios from 'axios';
import { DailyKlineRow } from '@/database/daily_breakout_repository';

const BASE_URL = 'https://fapi.binance.com';
const MAX_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 30_000;

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

/** 获取所有交易中的 USDT 永续合约 */
export async function fetch_usdt_perpetual_symbols(): Promise<string[]> {
  const res = await with_retry(() =>
    axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`, { timeout: 30_000, headers: REQUEST_HEADERS })
  );
  return res.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol);
}

/**
 * 拉取日线（只返回已收盘的）
 * 权重：limit < 100 为 1，≤ 500 为 2，≤ 1000 为 5，> 1000 为 10
 */
export async function fetch_daily_klines(symbol: string, limit: number): Promise<DailyKlineRow[]> {
  const res = await with_retry(() =>
    axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: { symbol, interval: '1d', limit },
      headers: REQUEST_HEADERS,
      timeout: 30_000,
    })
  );
  const now = Date.now();
  return res.data
    .filter((k: any[]) => k[6] < now)
    .map((k: any[]) => ({
      symbol,
      open_time: k[0],
      close_time: k[6],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quote_volume: parseFloat(k[7]),
    }));
}

/** 请求重试：429/418 限流等 30 秒，其他错误线性退避 */
async function with_retry<T>(request: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await request();
    } catch (error: any) {
      if (retry >= MAX_RETRIES - 1) throw error;
      const status = error.response?.status;
      const wait = status === 429 || status === 418 ? RATE_LIMIT_WAIT_MS : 1000 * (retry + 1);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
