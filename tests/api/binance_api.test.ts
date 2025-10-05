import { BinanceAPI } from '@/api';

describe('BinanceAPI', () => {
  let binance_api: BinanceAPI;

  beforeEach(() => {
    binance_api = BinanceAPI.getInstance();
  });

  describe('API配置', () => {
    test('应该能够获取单例实例', () => {
      const instance1 = BinanceAPI.getInstance();
      const instance2 = BinanceAPI.getInstance();
      expect(instance1).toBe(instance2);
    });

    test('应该能够获取API配置信息', () => {
      const config = binance_api.get_api_config();
      expect(config).toHaveProperty('has_key');
      expect(config).toHaveProperty('has_secret');
      expect(config).toHaveProperty('base_url');
      expect(typeof config.has_key).toBe('boolean');
      expect(typeof config.has_secret).toBe('boolean');
      expect(typeof config.base_url).toBe('string');
    });
  });

  describe('公开接口测试', () => {
    test('应该能够ping服务器', async () => {
      const result = await binance_api.ping();
      expect(typeof result).toBe('boolean');
    }, 10000);

    test('应该能够获取服务器时间', async () => {
      const server_time = await binance_api.get_server_time();
      expect(typeof server_time).toBe('number');
      expect(server_time).toBeGreaterThan(0);

      // 验证时间戳是否合理（应该接近当前时间）
      const now = Date.now();
      const diff = Math.abs(now - server_time);
      expect(diff).toBeLessThan(60000); // 差距应小于1分钟
    }, 10000);

    test('应该能够获取交易对信息', async () => {
      const exchange_info = await binance_api.get_exchange_info();
      expect(exchange_info).toHaveProperty('symbols');
      expect(Array.isArray(exchange_info.symbols)).toBe(true);
      expect(exchange_info.symbols.length).toBeGreaterThan(0);
    }, 15000);

    test('应该能够获取单个币种的24小时统计', async () => {
      const ticker = await binance_api.get_24hr_ticker('BTCUSDT');
      expect(ticker).toHaveProperty('symbol');
      expect(ticker.symbol).toBe('BTCUSDT');
      expect(ticker).toHaveProperty('priceChange');
      expect(ticker).toHaveProperty('volume');
    }, 10000);

    test('应该能够获取最新价格', async () => {
      const price = await binance_api.get_ticker_price('BTCUSDT');
      expect(price).toHaveProperty('symbol');
      expect(price).toHaveProperty('price');
      expect(price.symbol).toBe('BTCUSDT');
      expect(typeof parseFloat(price.price)).toBe('number');
    }, 10000);
  });

  describe('K线数据测试', () => {
    test('应该能够获取K线数据', async () => {
      const klines = await binance_api.get_klines('BTCUSDT', '1h', undefined, undefined, 10);

      expect(Array.isArray(klines)).toBe(true);
      expect(klines.length).toBeGreaterThan(0);
      expect(klines.length).toBeLessThanOrEqual(10);

      // 验证K线数据结构
      const first_kline = klines[0];
      expect(first_kline).toHaveProperty('symbol');
      expect(first_kline).toHaveProperty('interval');
      expect(first_kline).toHaveProperty('open');
      expect(first_kline).toHaveProperty('high');
      expect(first_kline).toHaveProperty('low');
      expect(first_kline).toHaveProperty('close');
      expect(first_kline).toHaveProperty('volume');
      expect(first_kline).toHaveProperty('open_time');
      expect(first_kline).toHaveProperty('close_time');

      expect(first_kline.symbol).toBe('BTCUSDT');
      expect(first_kline.interval).toBe('1h');
      expect(typeof first_kline.open).toBe('number');
      expect(typeof first_kline.high).toBe('number');
      expect(typeof first_kline.low).toBe('number');
      expect(typeof first_kline.close).toBe('number');
      expect(typeof first_kline.volume).toBe('number');
    }, 15000);

    test('应该能够获取指定时间范围的K线数据', async () => {
      const end_time = Date.now();
      const start_time = end_time - (24 * 60 * 60 * 1000); // 24小时前

      const klines = await binance_api.get_klines('BTCUSDT', '4h', start_time, end_time, 10);

      expect(Array.isArray(klines)).toBe(true);
      expect(klines.length).toBeGreaterThan(0);

      // 验证时间范围
      const first_kline = klines[0];
      expect(first_kline.open_time).toBeGreaterThanOrEqual(start_time);
      expect(first_kline.close_time).toBeLessThanOrEqual(end_time);
    }, 15000);
  });

  describe('错误处理', () => {
    test('应该能够处理无效的交易对', async () => {
      await expect(binance_api.get_ticker_price('INVALIDPAIR')).rejects.toThrow();
    }, 10000);

    test('应该能够处理无效的时间间隔', async () => {
      await expect(binance_api.get_klines('BTCUSDT', 'invalid', undefined, undefined, 10)).rejects.toThrow();
    }, 10000);
  });
});