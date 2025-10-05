import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import crypto from 'crypto-js';
import { KlineData } from '@/types/common';
import { logger } from '@/utils/logger';

export class BinanceAPI {
  private static instance: BinanceAPI;
  private axios_instance: AxiosInstance;
  private api_key: string;
  private api_secret: string;
  private base_url: string;

  private constructor() {
    this.api_key = process.env.BINANCE_API_KEY || '';
    this.api_secret = process.env.BINANCE_API_SECRET || '';
    this.base_url = process.env.BINANCE_API_BASE_URL || 'https://api.binance.com/api/v3';

    // 简化配置，强制禁用代理
    this.axios_instance = axios.create({
      baseURL: this.base_url,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(this.api_key && { 'X-MBX-APIKEY': this.api_key })
      },
      proxy: false  // 强制禁用代理
    });

    this.setup_interceptors();
  }

  /**
   * 获取币安API单例实例
   */
  static getInstance(): BinanceAPI {
    if (!BinanceAPI.instance) {
      BinanceAPI.instance = new BinanceAPI();
    }
    return BinanceAPI.instance;
  }

  /**
   * 设置请求和响应拦截器
   */
  private setup_interceptors(): void {
    // 请求拦截器 - 添加签名
    this.axios_instance.interceptors.request.use(
      (config) => {
        // 如果需要签名且有API密钥
        if (config.params?.signature !== undefined && this.api_secret) {
          const query_string = this.build_query_string(config.params);
          const signature = crypto.HmacSHA256(query_string, this.api_secret).toString();
          config.params.signature = signature;
        }

        // API请求日志已简化
        return config;
      },
      (error) => {
        logger.error('Binance API Request Error', error);
        return Promise.reject(error);
      }
    );

    // 响应拦截器 - 处理错误
    this.axios_instance.interceptors.response.use(
      (response) => {
        return response;
      },
      (error) => {
        if (error.response) {
          logger.error(`Binance API Error: ${error.response.status}`, error.response.data);
        } else {
          logger.error('Binance API Network Error', error.message);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * 构建查询字符串用于签名
   */
  private build_query_string(params: any): string {
    return Object.keys(params)
      .filter(key => key !== 'signature')
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');
  }

  /**
   * 获取服务器时间
   */
  async get_server_time(): Promise<number> {
    try {
      const response = await this.axios_instance.get('/time');
      return response.data.serverTime;
    } catch (error) {
      logger.error('Failed to get server time', error);
      throw error;
    }
  }

  /**
   * 获取交易对信息
   */
  async get_exchange_info(): Promise<any> {
    try {
      const response = await this.axios_instance.get('/exchangeInfo');
      return response.data;
    } catch (error) {
      logger.error('Failed to get exchange info', error);
      throw error;
    }
  }

  /**
   * 获取24小时价格统计
   * @param symbol - 交易对符号 (可选，不传则获取所有)
   */
  async get_24hr_ticker(symbol?: string): Promise<any> {
    try {
      const params: any = {};
      if (symbol) {
        params.symbol = symbol.toUpperCase();
      }

      const response = await this.axios_instance.get('/ticker/24hr', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get 24hr ticker for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 获取最新价格
   * @param symbol - 交易对符号 (可选，不传则获取所有)
   */
  async get_ticker_price(symbol?: string): Promise<any> {
    try {
      const params: any = {};
      if (symbol) {
        params.symbol = symbol.toUpperCase();
      }

      const response = await this.axios_instance.get('/ticker/price', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get ticker price for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 获取订单簿深度
   * @param symbol - 交易对符号
   * @param limit - 深度限制 (默认100)
   */
  async get_depth(symbol: string, limit: number = 100): Promise<any> {
    try {
      const params = {
        symbol: symbol.toUpperCase(),
        limit
      };

      const response = await this.axios_instance.get('/depth', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get depth for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 获取最近成交记录
   * @param symbol - 交易对符号
   * @param limit - 记录数限制 (默认500)
   */
  async get_recent_trades(symbol: string, limit: number = 500): Promise<any> {
    try {
      const params = {
        symbol: symbol.toUpperCase(),
        limit
      };

      const response = await this.axios_instance.get('/trades', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get recent trades for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 获取K线数据
   * @param symbol - 交易对符号
   * @param interval - K线时间间隔
   * @param start_time - 开始时间戳
   * @param end_time - 结束时间戳
   * @param limit - 数据条数限制 (默认500，最大1000)
   */
  async get_klines(
    symbol: string,
    interval: string,
    start_time?: number,
    end_time?: number,
    limit: number = 500
  ): Promise<KlineData[]> {
    try {
      const params: any = {
        symbol: symbol.toUpperCase(),
        interval,
        limit: Math.min(limit, 1000) // Binance最大限制1000
      };

      if (start_time) {
        params.startTime = start_time;
      }

      if (end_time) {
        params.endTime = end_time;
      }

      const response = await this.axios_instance.get('/klines', { params });

      // 转换数据格式
      return response.data.map((kline: any[]) => ({
        symbol,
        interval,
        open_time: kline[0],
        close_time: kline[6],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        trade_count: kline[8],
        is_final: true // 历史数据都是已完成的K线
      }));

    } catch (error) {
      logger.error(`Failed to get klines for ${symbol}:${interval}`, error);
      throw error;
    }
  }

  /**
   * 获取平均价格
   * @param symbol - 交易对符号
   */
  async get_avg_price(symbol: string): Promise<any> {
    try {
      const params = {
        symbol: symbol.toUpperCase()
      };

      const response = await this.axios_instance.get('/avgPrice', { params });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get average price for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 测试连接性
   */
  async ping(): Promise<boolean> {
    try {
      await this.axios_instance.get('/ping');
      return true;
    } catch (error) {
      logger.error('Binance API ping failed', error);
      return false;
    }
  }

  /**
   * 获取账户信息 (需要API密钥和签名)
   */
  async get_account_info(): Promise<any> {
    try {
      if (!this.api_key || !this.api_secret) {
        throw new Error('API key and secret are required for account info');
      }

      const params = {
        timestamp: Date.now()
      };

      const response = await this.axios_instance.get('/account', { params });
      return response.data;
    } catch (error) {
      logger.error('Failed to get account info', error);
      throw error;
    }
  }

  /**
   * 检查API密钥是否配置
   */
  is_api_configured(): boolean {
    return !!(this.api_key && this.api_secret);
  }

  /**
   * 获取API使用统计
   */
  get_api_config(): { has_key: boolean; has_secret: boolean; base_url: string } {
    return {
      has_key: !!this.api_key,
      has_secret: !!this.api_secret,
      base_url: this.base_url
    };
  }
}