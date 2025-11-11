import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import pLimit, { Limit } from 'p-limit';
import {
  BinanceOpenInterestResponse,
  BinanceExchangeInfoResponse,
  BinanceExchangeInfoSymbol,
  ContractSymbolConfig,
  OIPollingResult
} from '../types/oi_types';

/**
 * 币安期货API客户端
 */
export class BinanceFuturesAPI {
  private readonly base_url = 'https://fapi.binance.com';
  private readonly api_client: AxiosInstance;
  private readonly rate_limiter: Limit;
  private readonly max_concurrent: number;

  constructor(max_concurrent_requests: number = 50) {
    this.max_concurrent = max_concurrent_requests;
    this.rate_limiter = pLimit(max_concurrent_requests);

    // 配置axios实例 - 简化配置，强制禁用代理
    this.api_client = axios.create({
      baseURL: this.base_url,
      timeout: 60000, // 60秒超时
      headers: {
        'User-Agent': 'TradingMaster/1.0'
      },
      proxy: false  // 强制禁用代理
    });

    // 添加请求拦截器用于错误处理
    this.api_client.interceptors.request.use(
      (config) => config,
      (error) => {
        console.error('[BinanceAPI] Request error:', error);
        return Promise.reject(error);
      }
    );

    // 添加响应拦截器用于错误处理
    this.api_client.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('[BinanceAPI] Response error:', {
          url: error.config?.url,
          status: error.response?.status,
          message: error.message,
          data: error.response?.data
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * 获取期货交易信息
   */
  async get_exchange_info(): Promise<BinanceExchangeInfoResponse> {
    try {
      const response = await this.api_client.get<BinanceExchangeInfoResponse>('/fapi/v1/exchangeInfo');
      return response.data;
    } catch (error: any) {
      console.error('[BinanceAPI] Failed to get exchange info:', error.message);
      throw new Error(`Failed to fetch exchange info: ${error.message}`);
    }
  }

  /**
   * 获取USDT永续合约列表
   * @param max_symbols 最大币种数量，'max'表示不限制，返回所有币种
   */
  async get_usdt_perpetual_symbols(max_symbols: number | 'max' = 300): Promise<ContractSymbolConfig[]> {
    try {
      const exchange_info = await this.get_exchange_info();

      let filtered_symbols = exchange_info.symbols
        .filter(symbol =>
          symbol.contractType === 'PERPETUAL' &&
          symbol.quoteAsset === 'USDT' &&
          symbol.status === 'TRADING'
        )
        .sort((a, b) => this.calculate_symbol_priority(b) - this.calculate_symbol_priority(a));

      // 如果不是 'max'，则限制数量
      if (max_symbols !== 'max') {
        filtered_symbols = filtered_symbols.slice(0, max_symbols);
      }

      const usdt_symbols = filtered_symbols.map(symbol => ({
        symbol: symbol.symbol,
        base_asset: symbol.baseAsset,
        quote_asset: symbol.quoteAsset,
        contract_type: 'PERPETUAL' as const,
        status: 'TRADING' as const,
        enabled: true,
        priority: this.calculate_symbol_priority(symbol)
      }));

      console.log(`[BinanceAPI] Fetched ${usdt_symbols.length} USDT perpetual symbols (limit: ${max_symbols})`);
      return usdt_symbols;

    } catch (error: any) {
      console.error('[BinanceAPI] Failed to get USDT perpetual symbols:', error.message);
      throw new Error(`Failed to fetch USDT perpetual symbols: ${error.message}`);
    }
  }

  /**
   * 获取单个币种的开放利息
   */
  async get_open_interest(symbol: string): Promise<BinanceOpenInterestResponse> {
    try {
      const response = await this.api_client.get<BinanceOpenInterestResponse>('/fapi/v1/openInterest', {
        params: { symbol }
      });
      return response.data;
    } catch (error: any) {
      console.error(`[BinanceAPI] Failed to get open interest for ${symbol}:`, error.message);
      throw new Error(`Failed to fetch open interest for ${symbol}: ${error.message}`);
    }
  }

  /**
   * 批量获取多个币种的开放利息
   */
  async get_batch_open_interest(symbols: string[]): Promise<OIPollingResult[]> {
    try {
      const start_time = Date.now();

      // 使用rate_limiter限制并发请求
      const tasks = symbols.map(symbol =>
        this.rate_limiter(async () => {
          try {
            const response = await this.get_open_interest(symbol);
            return {
              symbol: response.symbol,
              open_interest: parseFloat(response.openInterest),
              timestamp_ms: response.time || Date.now()
            };
          } catch (error: any) {
            console.error(`[BinanceAPI] Failed to fetch OI for ${symbol}:`, error.message);
            // 返回null，后续过滤掉
            return null;
          }
        })
      );

      const results = await Promise.all(tasks);

      // 过滤掉失败的请求
      const valid_results = results.filter(result => result !== null) as OIPollingResult[];

      const duration = Date.now() - start_time;

      return valid_results;

    } catch (error: any) {
      console.error('[BinanceAPI] Failed to get batch open interest:', error.message);
      throw new Error(`Failed to fetch batch open interest: ${error.message}`);
    }
  }

  /**
   * 获取24小时价格变动统计
   */
  async get_24hr_ticker(symbol?: string): Promise<any> {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.api_client.get('/fapi/v1/ticker/24hr', { params });
      return response.data;
    } catch (error: any) {
      console.error('[BinanceAPI] Failed to get 24hr ticker:', error.message);
      throw new Error(`Failed to fetch 24hr ticker: ${error.message}`);
    }
  }

  /**
   * 获取服务器时间
   */
  async get_server_time(): Promise<number> {
    try {
      const response = await this.api_client.get('/fapi/v1/time');
      return response.data.serverTime;
    } catch (error: any) {
      console.error('[BinanceAPI] Failed to get server time:', error.message);
      throw new Error(`Failed to fetch server time: ${error.message}`);
    }
  }

  /**
   * 检查API连接状态
   */
  async ping(): Promise<boolean> {
    try {
      await this.api_client.get('/fapi/v1/ping');
      return true;
    } catch (error: any) {
      console.error('[BinanceAPI] Ping failed:', {
        message: error.message,
        code: error.code,
        status: error.response?.status
      });
      return false;
    }
  }

  /**
   * 计算币种优先级
   * 主要币种(BTC, ETH等)优先级更高
   */
  private calculate_symbol_priority(symbol: BinanceExchangeInfoSymbol): number {
    const major_coins = ['BTC', 'ETH', 'BNB', 'ADA', 'DOT', 'SOL', 'MATIC', 'AVAX'];
    const popular_coins = ['DOGE', 'SHIB', 'UNI', 'LINK', 'LTC', 'XRP', 'TRX'];

    if (major_coins.includes(symbol.baseAsset)) {
      return 90;
    } else if (popular_coins.includes(symbol.baseAsset)) {
      return 70;
    } else {
      return 50;
    }
  }

  /**
   * 格式化时间戳为本地时间字符串
   */
  private format_local_time(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
           `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * 获取当前时间信息
   */
  get_current_time_info(): { timestamp_ms: number; time_string: string } {
    const timestamp_ms = Date.now();
    return {
      timestamp_ms,
      time_string: this.format_local_time(timestamp_ms)
    };
  }

  /**
   * 设置新的并发限制
   */
  update_concurrent_limit(new_limit: number): void {
    if (new_limit > 0 && new_limit <= 200) {
      // 注意: p-limit实例一旦创建就不能修改，这里只是记录新值
      // 如果需要真正修改，需要重新创建API实例
    } else {
      console.warn(`[BinanceAPI] Invalid concurrent limit: ${new_limit}, must be between 1-200`);
    }
  }

  /**
   * 获取API使用统计
   */
  get_api_stats(): { max_concurrent: number; base_url: string } {
    return {
      max_concurrent: this.max_concurrent,
      base_url: this.base_url
    };
  }

}