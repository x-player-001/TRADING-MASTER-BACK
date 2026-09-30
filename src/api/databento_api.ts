/**
 * Databento 历史行情接口（CME 期货K线用）
 *
 * - 数据集 GLBX.MDP3（CME Globex，含 CME / CBOT / NYMEX / COMEX）
 * - 连续合约 `ES.v.0` = 按成交量换月的主力合约（不复权），换月边界在 UTC 零点
 * - K线只提供 1s / 1m / 1h / 1d，5m 等周期需自行由 1m 聚合
 * - 按下载量计费：拉数据前先用 estimate_cost 估价
 *
 * 鉴权：HTTP Basic，用户名为 DATABENTO_API_KEY，密码为空
 */

import axios, { AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const BASE_URL = 'https://hist.databento.com/v0';
export const DATABENTO_DATASET = 'GLBX.MDP3';
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 120_000;

/** Databento 1m K线 */
export interface DatabentoBar {
  open_time: number;          // 毫秒
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  instrument_id: number;      // 当时所用具体合约的 id
}

/** 读取 API key，未配置直接报错 */
function get_api_key(): string {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) throw new Error('未配置 DATABENTO_API_KEY');
  return key;
}

/**
 * 代理设置：axios 自带的环境变量代理对 HTTPS 目标不走 CONNECT 隧道（本机 HTTP 代理下会卡死），
 * 有 HTTPS_PROXY 时改用隧道代理，否则直连
 */
function proxy_config(): AxiosRequestConfig {
  const proxy_url = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy_url) return {};
  return { proxy: false, httpsAgent: new HttpsProxyAgent(proxy_url) };
}

/** POST 表单请求（Databento 历史接口均支持 form 参数） */
async function post_form<T>(path: string, params: Record<string, string>, config: AxiosRequestConfig = {}): Promise<T> {
  const res = await with_retry(() =>
    axios.post(`${BASE_URL}/${path}`, new URLSearchParams(params).toString(), {
      auth: { username: get_api_key(), password: '' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: REQUEST_TIMEOUT_MS,
      ...proxy_config(),
      ...config,
    })
  );
  return res.data as T;
}

/** 连续合约代码：ES → ES.v.0 */
export function continuous_symbol(root: string): string {
  return `${root}.v.0`;
}

/** 数据集某 schema 当前可取数据的截止时间（毫秒；该接口只支持 GET） */
export async function get_available_end(schema: string = 'ohlcv-1m'): Promise<number> {
  const res = await with_retry(() =>
    axios.get(`${BASE_URL}/metadata.get_dataset_range`, {
      params: { dataset: DATABENTO_DATASET },
      auth: { username: get_api_key(), password: '' },
      timeout: REQUEST_TIMEOUT_MS,
      ...proxy_config(),
    })
  );
  const data = res.data;
  const end = data.schema?.[schema]?.end ?? data.end;
  return new Date(end).getTime();
}

/**
 * 估算下载费用（美元，调用本身免费）
 * @param start/end 毫秒时间戳，end 不含
 */
export async function estimate_cost(symbols: string[], schema: string, start: number, end: number): Promise<number> {
  const cost = await post_form<number>('metadata.get_cost', {
    dataset: DATABENTO_DATASET,
    symbols: symbols.join(','),
    stype_in: 'continuous',
    schema,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
  return Number(cost);
}

/**
 * 拉取连续合约 1m K线（只有成交的分钟才有K线）
 * @param symbol 连续合约代码，如 ES.v.0
 * @param start/end 毫秒时间戳，end 不含
 */
export async function fetch_ohlcv_1m(symbol: string, start: number, end: number): Promise<DatabentoBar[]> {
  const text = await post_form<string>('timeseries.get_range', {
    dataset: DATABENTO_DATASET,
    symbols: symbol,
    stype_in: 'continuous',
    schema: 'ohlcv-1m',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    encoding: 'json',
    pretty_px: 'true',
  }, { responseType: 'text', transformResponse: r => r });

  const bars: DatabentoBar[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    bars.push({
      // ts_event 为纳秒字符串，截掉末 6 位即毫秒
      open_time: Number(String(r.hd.ts_event).slice(0, -6)),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      instrument_id: Number(r.hd.instrument_id),
    });
  }
  return bars.sort((a, b) => a.open_time - b.open_time);
}

/** symbology.resolve，返回 { 输入代码: [{ d0, d1, s }] } */
async function resolve_symbols(symbols: string[], stype_in: string, stype_out: string, start_date: string, end: number): Promise<Record<string, Array<{ d0: string; d1: string; s: string }>>> {
  const data = await post_form<any>('symbology.resolve', {
    dataset: DATABENTO_DATASET,
    symbols: symbols.join(','),
    stype_in,
    stype_out,
    start_date,
    // 传完整时间戳：按日期 +1 天会越过免费历史数据的截止时间（最近几小时需实时授权）
    end_date: new Date(end).toISOString(),
  });
  return data.result ?? {};
}

/** 连续合约的一个换月分段 */
export interface ContractSegment {
  start: number;              // 毫秒（UTC 零点，含）
  end: number;                // 毫秒（不含）
  instrument_id: number;
  contract: string;           // 如 ESZ6
}

/**
 * 连续合约在区间内的换月分段
 *
 * 合约 id 会在合约到期后被交易所复用给别的合约（甚至期权），不能拿整段区间一次解析，
 * 否则会取到后来复用者的名字。先取连续合约的换月分段，再逐段只在该段日期内解析。
 * @param symbol  连续合约代码，如 ES.v.0
 * @param start/end 毫秒时间戳
 */
export async function resolve_contract_segments(symbol: string, start: number, end: number): Promise<ContractSegment[]> {
  const raw = (await resolve_symbols([symbol], 'continuous', 'instrument_id',
    new Date(start).toISOString().slice(0, 10), end))[symbol] ?? [];

  const segments: ContractSegment[] = [];
  for (const seg of raw) {
    const seg_start = Date.parse(`${seg.d0}T00:00:00Z`);
    const seg_end = Math.min(Date.parse(`${seg.d1}T00:00:00Z`), end);
    const mappings = (await resolve_symbols([seg.s], 'instrument_id', 'raw_symbol', seg.d0, seg_end))[seg.s] ?? [];
    segments.push({ start: seg_start, end: seg_end, instrument_id: Number(seg.s), contract: mappings[0]?.s ?? seg.s });
  }
  return segments;
}

/** 连续合约在区间内用到的具体合约：合约 id → 合约代码（如 10252 → ESZ6） */
export async function resolve_contract_names(symbol: string, start: number, end: number): Promise<Map<number, string>> {
  const segments = await resolve_contract_segments(symbol, start, end);
  return new Map(segments.map(s => [s.instrument_id, s.contract]));
}

/** 请求重试：429 等 10 秒，5xx/网络错误线性退避，4xx 参数错误直接抛出 */
async function with_retry<T>(request: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await request();
    } catch (error: any) {
      const status = error.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || retry >= MAX_RETRIES - 1) {
        let body = error.response?.data;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch { /* 非 JSON 响应 */ }
        }
        const detail = body?.detail;
        if (detail) {
          const message = typeof detail === 'string' ? detail : detail.message ?? JSON.stringify(detail);
          throw new Error(`Databento ${status}: ${message}`);
        }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, status === 429 ? 10_000 : 2000 * (retry + 1)));
    }
  }
}
