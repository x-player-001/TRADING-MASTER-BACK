/**
 * 币安 U 本位合约实盘客户端（实盘模块专用，独立于旧交易系统）
 *
 * - 密钥只读 LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET，不回退到其他变量，避免误用旧账户
 * - 条件单走 Algo Service（/fapi/v1/algoOrder，2025-12 起条件单已迁移）
 * - 错误分类：交易所明确返回错误码 → definite（请求未生效）；
 *   超时 / 断网 / 5xx / -1000 -1001 -1006 -1007 → 结果未知，调用方必须查询确认
 * - 本机时间与服务器时间自动校准（每小时），签名带 recvWindow
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import crypto from 'crypto';
import {
  AlgoOrderInfo, AlgoStatus, ExchangeError, ExchangeGateway, LeverageBracket, NewAlgoOrderParams, NewOrderParams,
  OrderInfo, OrderStatus, PositionInfo, SymbolRules, UserTrade,
} from '@/services/live_trading/live_types';
import { parse_symbol_rules } from '@/services/live_trading/exchange_rules';

const BASE_URL = 'https://fapi.binance.com';
const RECV_WINDOW = 5000;
/** 结果未知的错误码（请求可能已被执行） */
const UNKNOWN_CODES = new Set([-1000, -1001, -1006, -1007]);
/** 查询不存在的订单 */
const NOT_FOUND_CODES = new Set([-2013, -2011]);
/** 无需修改（保证金模式已是逐仓等） */
const NO_CHANGE_CODES = new Set([-4046, -4059]);

export class BinanceLiveClient implements ExchangeGateway {
  private readonly http: AxiosInstance;
  private time_offset = 0;
  private last_time_sync = 0;
  private readonly bracket_cache = new Map<string, { at: number; brackets: any[] }>();

  constructor(private readonly api_key: string, private readonly api_secret: string, base_url: string = BASE_URL) {
    if (!api_key || !api_secret) throw new Error('缺少实盘 API 密钥（LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET）');
    this.http = axios.create({ baseURL: base_url, timeout: 10_000, headers: { 'X-MBX-APIKEY': api_key } });
  }

  /** 从环境变量创建 */
  static from_env(): BinanceLiveClient {
    return new BinanceLiveClient(process.env.LIVE_BINANCE_API_KEY || '', process.env.LIVE_BINANCE_API_SECRET || '');
  }

  // ==================== 基础请求 ====================

  /** 校准服务器时间 */
  async sync_time(): Promise<void> {
    const t0 = Date.now();
    const resp = await this.http.get('/fapi/v1/time');
    const t1 = Date.now();
    this.time_offset = Number(resp.data.serverTime) - Math.round((t0 + t1) / 2);
    this.last_time_sync = t1;
  }

  /** 签名请求 */
  private async signed<T = any>(method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, params: Record<string, any> = {}): Promise<T> {
    if (Date.now() - this.last_time_sync > 3600_000) {
      try { await this.sync_time(); } catch { /* 校时失败沿用旧偏移 */ }
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) clean[k] = String(v);
    clean.recvWindow = String(RECV_WINDOW);
    clean.timestamp = String(Date.now() + this.time_offset);
    const query = new URLSearchParams(clean).toString();
    const signature = crypto.createHmac('sha256', this.api_secret).update(query).digest('hex');
    try {
      const resp = await this.http.request({ method, url: `${path}?${query}&signature=${signature}` });
      return resp.data as T;
    } catch (err) {
      throw this.to_error(err, path);
    }
  }

  /** axios 错误 → ExchangeError（区分明确拒绝与结果未知） */
  private to_error(err: unknown, path: string): ExchangeError {
    const e = err as AxiosError<any>;
    const status = e.response?.status ?? null;
    const data = e.response?.data;
    const code = typeof data?.code === 'number' ? data.code : null;
    const msg = `${path}: ${data?.msg ?? e.message}`;
    if (!e.response) return new ExchangeError(msg, null, null, false);          // 超时 / 断网
    if (code !== null && UNKNOWN_CODES.has(code)) return new ExchangeError(msg, code, status, false);
    if (status !== null && status >= 500) return new ExchangeError(msg, code, status, false);
    return new ExchangeError(msg, code, status, true);
  }

  // ==================== 账户配置 ====================

  /** 是否双向持仓模式 */
  async is_hedge_mode(): Promise<boolean> {
    const r = await this.signed('GET', '/fapi/v1/positionSide/dual');
    return r.dualSidePosition === true;
  }

  /** 是否联合保证金模式（该模式不支持逐仓） */
  async is_multi_assets_mode(): Promise<boolean> {
    const r = await this.signed('GET', '/fapi/v1/multiAssetsMargin');
    return r.multiAssetsMargin === true;
  }

  /** USDT 余额（钱包余额 / 可用余额） */
  async get_usdt_balance(): Promise<{ balance: number; available: number }> {
    const rows: any[] = await this.signed('GET', '/fapi/v3/balance');
    const u = rows.find(r => r.asset === 'USDT');
    return { balance: Number(u?.balance ?? 0), available: Number(u?.availableBalance ?? 0) };
  }

  async get_available_balance(): Promise<number> {
    return (await this.get_usdt_balance()).available;
  }

  async set_isolated_margin(symbol: string): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
    } catch (err) {
      if (err instanceof ExchangeError && err.code !== null && NO_CHANGE_CODES.has(err.code)) return;
      throw err;
    }
  }

  async set_leverage(symbol: string, leverage: number): Promise<void> {
    await this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  /** 杠杆分层：取名义价值所在档（缓存 1 小时） */
  async get_leverage_bracket(symbol: string, notional: number): Promise<LeverageBracket> {
    const cached = this.bracket_cache.get(symbol);
    let brackets: any[];
    if (cached && Date.now() - cached.at < 3600_000) {
      brackets = cached.brackets;
    } else {
      const r = await this.signed('GET', '/fapi/v1/leverageBracket', { symbol });
      const row = Array.isArray(r) ? r.find((x: any) => x.symbol === symbol) ?? r[0] : r;
      brackets = (row?.brackets ?? []) as any[];
      if (!brackets.length) throw new ExchangeError(`leverageBracket 无数据 ${symbol}`, null, null, true);
      this.bracket_cache.set(symbol, { at: Date.now(), brackets });
    }
    const b = brackets.find(x => notional <= Number(x.notionalCap)) ?? brackets[brackets.length - 1];
    return { max_leverage: Number(b.initialLeverage), notional_cap: Number(b.notionalCap), maint_margin_ratio: Number(b.maintMarginRatio) };
  }

  // ==================== 行情 / 规则 ====================


  // ==================== 条件单 ====================

  async new_algo_order(p: NewAlgoOrderParams): Promise<AlgoOrderInfo> {
    const r = await this.signed('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      clientAlgoId: p.client_algo_id,
      triggerPrice: p.trigger_price,
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'false',
      quantity: p.close_position ? undefined : p.quantity,
      price: p.price,
      timeInForce: p.time_in_force,
      closePosition: p.close_position ? 'true' : undefined,
      newOrderRespType: 'RESULT',
    });
    return to_algo(r);
  }

  async get_algo_order(client_algo_id: string): Promise<AlgoOrderInfo | null> {
    try {
      const r = await this.signed('GET', '/fapi/v1/algoOrder', { clientAlgoId: client_algo_id });
      if (!r || r.algoId === undefined) return null;
      return to_algo(r);
    } catch (err) {
      if (is_not_found(err)) return null;
      throw err;
    }
  }

  async cancel_algo_order(client_algo_id: string): Promise<void> {
    try {
      await this.signed('DELETE', '/fapi/v1/algoOrder', { clientAlgoId: client_algo_id });
    } catch (err) {
      // 已终态 / 不存在：视为成功，由调用方查询确认最终状态；其他错误（限频、签名等）照常抛出
      if (is_not_found(err)) return;
      throw err;
    }
  }

  async get_open_algo_orders(symbol?: string): Promise<AlgoOrderInfo[]> {
    const r = await this.signed('GET', '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {});
    const rows: any[] = Array.isArray(r) ? r : (r?.orders ?? []);
    return rows.map(to_algo);
  }

  // ==================== 普通单 ====================

  async new_order(p: NewOrderParams): Promise<OrderInfo> {
    const r = await this.signed('POST', '/fapi/v1/order', {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      newClientOrderId: p.client_order_id,
      quantity: p.quantity,
      price: p.price,
      timeInForce: p.time_in_force,
      reduceOnly: p.reduce_only ? 'true' : undefined,
      newOrderRespType: 'RESULT',
    });
    return to_order(r);
  }

  async get_order(symbol: string, ref: { order_id?: number; client_order_id?: string }): Promise<OrderInfo | null> {
    try {
      const r = await this.signed('GET', '/fapi/v1/order', {
        symbol, orderId: ref.order_id, origClientOrderId: ref.order_id === undefined ? ref.client_order_id : undefined,
      });
      return to_order(r);
    } catch (err) {
      if (is_not_found(err)) return null;
      throw err;
    }
  }

  async cancel_order(symbol: string, ref: { order_id?: number; client_order_id?: string }): Promise<void> {
    try {
      await this.signed('DELETE', '/fapi/v1/order', {
        symbol, orderId: ref.order_id, origClientOrderId: ref.order_id === undefined ? ref.client_order_id : undefined,
      });
    } catch (err) {
      if (is_not_found(err)) return;
      throw err;
    }
  }

  async get_open_orders(symbol?: string): Promise<OrderInfo[]> {
    const rows: any[] = await this.signed('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {});
    return rows.map(to_order);
  }

  // ==================== 持仓 / 成交 ====================

  async get_position(symbol: string): Promise<PositionInfo> {
    const rows: any[] = await this.signed('GET', '/fapi/v2/positionRisk', { symbol });
    const r = rows.find(x => x.symbol === symbol && (x.positionSide ?? 'BOTH') === 'BOTH');
    if (!r) return { symbol, amount: 0, entry_price: 0, liquidation_price: 0, margin_type: '', leverage: 0 };
    return to_position(r);
  }

  async get_open_positions(): Promise<PositionInfo[]> {
    const rows: any[] = await this.signed('GET', '/fapi/v2/positionRisk');
    return rows.map(to_position).filter(p => p.amount !== 0);
  }

  async get_user_trades(symbol: string, start_time: number): Promise<UserTrade[]> {
    const rows: any[] = await this.signed('GET', '/fapi/v1/userTrades', { symbol, startTime: start_time, limit: 1000 });
    return rows.map(r => ({
      id: Number(r.id), order_id: Number(r.orderId), symbol: r.symbol, side: r.side,
      price: Number(r.price), qty: Number(r.qty), realized_pnl: Number(r.realizedPnl),
      commission: Number(r.commission), commission_asset: r.commissionAsset, time: Number(r.time),
    }));
  }

  async get_funding_fee(symbol: string, start_time: number, end_time: number): Promise<number> {
    const rows: any[] = await this.signed('GET', '/fapi/v1/income', {
      symbol, incomeType: 'FUNDING_FEE', startTime: start_time, endTime: end_time, limit: 1000,
    });
    return rows.reduce((s, r) => s + Number(r.income), 0);
  }

  // ==================== 用户数据流 ====================

  async create_listen_key(): Promise<string> {
    try {
      const r = await this.http.post('/fapi/v1/listenKey');
      return r.data.listenKey;
    } catch (err) {
      throw this.to_error(err, '/fapi/v1/listenKey');
    }
  }

  async keepalive_listen_key(): Promise<void> {
    try {
      await this.http.put('/fapi/v1/listenKey');
    } catch (err) {
      throw this.to_error(err, '/fapi/v1/listenKey');
    }
  }
}

/** 全部 U 本位 USDT 永续的交易规则（公共接口，无需密钥） */
export async function fetch_exchange_rules(base_url: string = BASE_URL): Promise<Map<string, SymbolRules>> {
  const resp = await axios.get(`${base_url}/fapi/v1/exchangeInfo`, { timeout: 15_000 });
  const m = new Map<string, SymbolRules>();
  for (const s of resp.data.symbols as any[]) {
    if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue;
    m.set(s.symbol, parse_symbol_rules(s));
  }
  return m;
}

/** 订单不存在 / 已结束（撤单、查询时视为正常结果） */
function is_not_found(err: unknown): boolean {
  if (!(err instanceof ExchangeError) || !err.definite) return false;
  if (err.code !== null && NOT_FOUND_CODES.has(err.code)) return true;
  return /not exist|unknown order|not found/i.test(err.message);
}

/** 条件单响应 → AlgoOrderInfo */
function to_algo(r: any): AlgoOrderInfo {
  const actual = r.actualOrderId !== undefined && r.actualOrderId !== null && r.actualOrderId !== '' ? Number(r.actualOrderId) : null;
  return {
    algo_id: Number(r.algoId),
    client_algo_id: r.clientAlgoId,
    symbol: r.symbol,
    side: r.side,
    order_type: r.orderType ?? r.type,
    status: r.algoStatus as AlgoStatus,
    trigger_price: Number(r.triggerPrice ?? 0),
    price: Number(r.price ?? 0),
    quantity: Number(r.quantity ?? 0),
    close_position: r.closePosition === true || r.closePosition === 'true',
    actual_order_id: actual && actual > 0 ? actual : null,
    update_time: Number(r.updateTime ?? 0),
  };
}

/** 订单响应 → OrderInfo */
function to_order(r: any): OrderInfo {
  return {
    order_id: Number(r.orderId),
    client_order_id: r.clientOrderId,
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    status: r.status as OrderStatus,
    orig_qty: Number(r.origQty),
    executed_qty: Number(r.executedQty),
    avg_price: Number(r.avgPrice),
    update_time: Number(r.updateTime ?? r.time ?? Date.now()),
  };
}

/** 持仓响应 → PositionInfo */
function to_position(r: any): PositionInfo {
  return {
    symbol: r.symbol,
    amount: Number(r.positionAmt),
    entry_price: Number(r.entryPrice),
    liquidation_price: Number(r.liquidationPrice),
    margin_type: r.marginType ?? '',
    leverage: Number(r.leverage ?? 0),
  };
}
