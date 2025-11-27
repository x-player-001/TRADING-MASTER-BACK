import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import pLimit, { Limit } from 'p-limit';
import * as crypto from 'crypto';
import {
  BinanceOpenInterestResponse,
  BinanceExchangeInfoResponse,
  BinanceExchangeInfoSymbol,
  BinancePremiumIndexResponse,
  ContractSymbolConfig,
  OIPollingResult,
  BinanceTopLongShortPositionRatioResponse,
  BinanceTopLongShortAccountRatioResponse,
  BinanceGlobalLongShortAccountRatioResponse,
  BinanceTakerBuySellVolumeResponse
} from '../types/oi_types';

/**
 * 币安期货API客户端
 */
export class BinanceFuturesAPI {
  private readonly base_url = 'https://fapi.binance.com';
  private readonly api_client: AxiosInstance;
  private readonly rate_limiter: Limit;
  private readonly max_concurrent: number;
  private readonly api_key: string;
  private readonly api_secret: string;

  constructor(max_concurrent_requests: number = 50, api_key?: string, api_secret?: string) {
    this.max_concurrent = max_concurrent_requests;
    this.rate_limiter = pLimit(max_concurrent_requests);
    this.api_key = api_key || process.env.BINANCE_API_KEY || '';
    this.api_secret = api_secret || process.env.BINANCE_API_SECRET || '';

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

      const usdt_symbols = filtered_symbols.map(symbol => {
        // 从filters中提取MIN_NOTIONAL和LOT_SIZE
        const min_notional_filter = symbol.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        const lot_size_filter = symbol.filters.find(f => f.filterType === 'LOT_SIZE');

        return {
          symbol: symbol.symbol,
          base_asset: symbol.baseAsset,
          quote_asset: symbol.quoteAsset,
          contract_type: 'PERPETUAL' as const,
          status: 'TRADING' as const,
          enabled: true,
          priority: this.calculate_symbol_priority(symbol),

          // 精度信息
          price_precision: symbol.pricePrecision,
          quantity_precision: symbol.quantityPrecision,
          base_asset_precision: symbol.baseAssetPrecision,
          quote_precision: symbol.quotePrecision,

          // 交易规则
          min_notional: min_notional_filter ? parseFloat(min_notional_filter.notional) : undefined,
          step_size: lot_size_filter ? parseFloat(lot_size_filter.stepSize) : undefined
        };
      });

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
      let last_used_weight: string | undefined;

      // 使用rate_limiter限制并发请求
      const tasks = symbols.map(symbol =>
        this.rate_limiter(async () => {
          try {
            const response = await this.api_client.get<BinanceOpenInterestResponse>('/fapi/v1/openInterest', {
              params: { symbol }
            });

            // 获取响应头中的权重信息
            last_used_weight = response.headers?.['x-mbx-used-weight-1m'];

            return {
              symbol: response.data.symbol,
              open_interest: parseFloat(response.data.openInterest),
              timestamp_ms: response.data.time || Date.now()
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

      console.log(`[BinanceAPI] Batch OI - 请求 ${symbols.length} 个币种, 成功 ${valid_results.length} 个, 耗时 ${duration}ms`);
      console.log(`[BinanceAPI] API权重使用: ${last_used_weight || 'N/A'}/2400 (1分钟)`);

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
   * 批量获取所有币种的标记价格和资金费率
   * 权重: 10 (不带symbol参数，返回所有币种)
   */
  async get_all_premium_index(): Promise<BinancePremiumIndexResponse[]> {
    try {
      const response = await this.api_client.get<BinancePremiumIndexResponse[]>('/fapi/v1/premiumIndex');

      // 打印响应头中的权重信息
      const usedWeight = response.headers['x-mbx-used-weight-1m'];
      const orderCount = response.headers['x-mbx-order-count-1m'];

      console.log(`[BinanceAPI] Premium Index - 返回 ${response.data.length} 个交易对`);
      console.log(`[BinanceAPI] API权重使用: ${usedWeight || 'N/A'}/2400 (1分钟), 订单数: ${orderCount || 'N/A'}`);

      return response.data;
    } catch (error: any) {
      console.error('[BinanceAPI] Failed to get premium index:', error.message);
      throw new Error(`Failed to fetch premium index: ${error.message}`);
    }
  }

  /**
   * 获取单个币种的标记价格和资金费率
   * 权重: 1 (带symbol参数)
   */
  async get_premium_index(symbol: string): Promise<BinancePremiumIndexResponse> {
    try {
      const response = await this.api_client.get<BinancePremiumIndexResponse>('/fapi/v1/premiumIndex', {
        params: { symbol }
      });
      return response.data;
    } catch (error: any) {
      console.error(`[BinanceAPI] Failed to get premium index for ${symbol}:`, error.message);
      throw new Error(`Failed to fetch premium index for ${symbol}: ${error.message}`);
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

  // ==================== 市场情绪API ====================

  /**
   * 获取大户持仓量多空比
   * 权重: 1
   * @param symbol 交易对符号
   * @param period 时间周期 "5m","15m","30m","1h","2h","4h","6h","12h","1d"
   * @param limit 返回数量，默认30，最大500
   */
  async get_top_long_short_position_ratio(
    symbol: string,
    period: string = '5m',
    limit: number = 1
  ): Promise<BinanceTopLongShortPositionRatioResponse[]> {
    try {
      const response = await this.api_client.get<BinanceTopLongShortPositionRatioResponse[]>(
        '/futures/data/topLongShortPositionRatio',
        {
          params: { symbol, period, limit }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error(`[BinanceAPI] Failed to get top long/short position ratio for ${symbol}:`, error.message);
      throw new Error(`Failed to fetch top long/short position ratio: ${error.message}`);
    }
  }

  /**
   * 获取大户账户数多空比
   * 权重: 1
   * @param symbol 交易对符号
   * @param period 时间周期 "5m","15m","30m","1h","2h","4h","6h","12h","1d"
   * @param limit 返回数量，默认30，最大500
   */
  async get_top_long_short_account_ratio(
    symbol: string,
    period: string = '5m',
    limit: number = 1
  ): Promise<BinanceTopLongShortAccountRatioResponse[]> {
    try {
      const response = await this.api_client.get<BinanceTopLongShortAccountRatioResponse[]>(
        '/futures/data/topLongShortAccountRatio',
        {
          params: { symbol, period, limit }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error(`[BinanceAPI] Failed to get top account ratio for ${symbol}:`, error.message);
      throw new Error(`Failed to fetch top account ratio: ${error.message}`);
    }
  }

  /**
   * 获取全市场多空人数比
   * 权重: 1
   * @param symbol 交易对符号
   * @param period 时间周期 "5m","15m","30m","1h","2h","4h","6h","12h","1d"
   * @param limit 返回数量，默认30，最大500
   */
  async get_global_long_short_account_ratio(
    symbol: string,
    period: string = '5m',
    limit: number = 1
  ): Promise<BinanceGlobalLongShortAccountRatioResponse[]> {
    try {
      const response = await this.api_client.get<BinanceGlobalLongShortAccountRatioResponse[]>(
        '/futures/data/globalLongShortAccountRatio',
        {
          params: { symbol, period, limit }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error(`[BinanceAPI] Failed to get global account ratio for ${symbol}:`, error.message);
      throw new Error(`Failed to fetch global account ratio: ${error.message}`);
    }
  }

  /**
   * 获取合约主动买卖量
   * 权重: 1
   * @param symbol 交易对符号
   * @param period 时间周期 "5m","15m","30m","1h","2h","4h","6h","12h","1d"
   * @param limit 返回数量，默认30，最大500
   */
  async get_taker_buy_sell_volume(
    symbol: string,
    period: string = '5m',
    limit: number = 1
  ): Promise<BinanceTakerBuySellVolumeResponse[]> {
    try {
      const response = await this.api_client.get<BinanceTakerBuySellVolumeResponse[]>(
        '/futures/data/takerlongshortRatio',
        {
          params: { symbol, period, limit }
        }
      );
      return response.data;
    } catch (error: any) {
      console.error(`[BinanceAPI] Failed to get taker buy/sell volume for ${symbol}:`, error.message);
      throw new Error(`Failed to fetch taker buy/sell volume: ${error.message}`);
    }
  }

}