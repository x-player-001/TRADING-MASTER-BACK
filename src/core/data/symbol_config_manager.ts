import { RedisClientType } from 'redis';
import { DatabaseConfig } from '@/core/config/database';
import { SymbolConfigRepository } from '@/database';
import { SymbolConfig } from '@/types/common';
import { logger } from '@/utils/logger';

export class SymbolConfigManager {
  private static instance: SymbolConfigManager;
  private redis: RedisClientType | null = null;
  private symbol_repository: SymbolConfigRepository;
  private readonly CACHE_KEY = 'config:symbols:active';
  private readonly CACHE_TTL = 3600; // 1小时

  private constructor() {
    this.symbol_repository = new SymbolConfigRepository();
  }

  /**
   * 获取币种配置管理器单例实例
   */
  static getInstance(): SymbolConfigManager {
    if (!SymbolConfigManager.instance) {
      SymbolConfigManager.instance = new SymbolConfigManager();
    }
    return SymbolConfigManager.instance;
  }

  /**
   * 初始化币种配置管理器，建立数据库连接、创建表结构并初始化默认币种
   */
  async initialize(): Promise<void> {
    try {
      this.redis = await DatabaseConfig.get_redis_client();
      await this.symbol_repository.create_table();
      await this.init_default_symbols();

      logger.info('SymbolConfigManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize SymbolConfigManager', error);
      throw error;
    }
  }


  /**
   * 初始化默认30个预设币种配置
   */
  private async init_default_symbols(): Promise<void> {
    const default_symbols: Omit<SymbolConfig, 'id' | 'created_at' | 'updated_at'>[] = [
      // 主流币
      { symbol: 'BTCUSDT', display_name: 'Bitcoin/USDT', base_asset: 'BTC', quote_asset: 'USDT', enabled: true, priority: 1, category: 'major', exchange: 'binance', min_price: 0.01, min_qty: 0.00001 },
      { symbol: 'ETHUSDT', display_name: 'Ethereum/USDT', base_asset: 'ETH', quote_asset: 'USDT', enabled: true, priority: 2, category: 'major', exchange: 'binance', min_price: 0.01, min_qty: 0.0001 },
      // { symbol: 'BNBUSDT', display_name: 'BNB/USDT', base_asset: 'BNB', quote_asset: 'USDT', enabled: true, priority: 3, category: 'major', exchange: 'binance', min_price: 0.01, min_qty: 0.001 },
      // { symbol: 'ADAUSDT', display_name: 'Cardano/USDT', base_asset: 'ADA', quote_asset: 'USDT', enabled: true, priority: 4, category: 'major', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'SOLUSDT', display_name: 'Solana/USDT', base_asset: 'SOL', quote_asset: 'USDT', enabled: true, priority: 5, category: 'major', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'XRPUSDT', display_name: 'XRP/USDT', base_asset: 'XRP', quote_asset: 'USDT', enabled: true, priority: 6, category: 'major', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'DOTUSDT', display_name: 'Polkadot/USDT', base_asset: 'DOT', quote_asset: 'USDT', enabled: true, priority: 7, category: 'major', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'AVAXUSDT', display_name: 'Avalanche/USDT', base_asset: 'AVAX', quote_asset: 'USDT', enabled: true, priority: 8, category: 'major', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'LINKUSDT', display_name: 'Chainlink/USDT', base_asset: 'LINK', quote_asset: 'USDT', enabled: true, priority: 9, category: 'major', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'MATICUSDT', display_name: 'Polygon/USDT', base_asset: 'MATIC', quote_asset: 'USDT', enabled: true, priority: 10, category: 'major', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },

      // // 山寨币
      // { symbol: 'LTCUSDT', display_name: 'Litecoin/USDT', base_asset: 'LTC', quote_asset: 'USDT', enabled: true, priority: 11, category: 'alt', exchange: 'binance', min_price: 0.01, min_qty: 0.001 },
      // { symbol: 'BCHUSDT', display_name: 'Bitcoin Cash/USDT', base_asset: 'BCH', quote_asset: 'USDT', enabled: true, priority: 12, category: 'alt', exchange: 'binance', min_price: 0.01, min_qty: 0.001 },
      // { symbol: 'ALGOUSDT', display_name: 'Algorand/USDT', base_asset: 'ALGO', quote_asset: 'USDT', enabled: true, priority: 13, category: 'alt', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'VETUSDT', display_name: 'VeChain/USDT', base_asset: 'VET', quote_asset: 'USDT', enabled: true, priority: 14, category: 'alt', exchange: 'binance', min_price: 0.00001, min_qty: 1 },
      // { symbol: 'XLMUSDT', display_name: 'Stellar/USDT', base_asset: 'XLM', quote_asset: 'USDT', enabled: true, priority: 15, category: 'alt', exchange: 'binance', min_price: 0.00001, min_qty: 1 },
      // { symbol: 'TRXUSDT', display_name: 'TRON/USDT', base_asset: 'TRX', quote_asset: 'USDT', enabled: true, priority: 16, category: 'alt', exchange: 'binance', min_price: 0.00001, min_qty: 1 },
      // { symbol: 'EOSUSDT', display_name: 'EOS/USDT', base_asset: 'EOS', quote_asset: 'USDT', enabled: true, priority: 17, category: 'alt', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'NEOUSDT', display_name: 'NEO/USDT', base_asset: 'NEO', quote_asset: 'USDT', enabled: true, priority: 18, category: 'alt', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'ATOMUSDT', display_name: 'Cosmos/USDT', base_asset: 'ATOM', quote_asset: 'USDT', enabled: true, priority: 19, category: 'alt', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'FTMUSDT', display_name: 'Fantom/USDT', base_asset: 'FTM', quote_asset: 'USDT', enabled: true, priority: 20, category: 'alt', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },

      // // 稳定币相关
      // { symbol: 'USDCUSDT', display_name: 'USDC/USDT', base_asset: 'USDC', quote_asset: 'USDT', enabled: false, priority: 91, category: 'stable', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'BUSDUSDT', display_name: 'BUSD/USDT', base_asset: 'BUSD', quote_asset: 'USDT', enabled: false, priority: 92, category: 'stable', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'DAIUSDT', display_name: 'DAI/USDT', base_asset: 'DAI', quote_asset: 'USDT', enabled: false, priority: 93, category: 'stable', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },

      // // 更多山寨币
      // { symbol: 'ICPUSDT', display_name: 'Internet Computer/USDT', base_asset: 'ICP', quote_asset: 'USDT', enabled: true, priority: 21, category: 'alt', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'FILUSDT', display_name: 'Filecoin/USDT', base_asset: 'FIL', quote_asset: 'USDT', enabled: true, priority: 22, category: 'alt', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'SANDUSDT', display_name: 'The Sandbox/USDT', base_asset: 'SAND', quote_asset: 'USDT', enabled: true, priority: 23, category: 'alt', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'MANAUSDT', display_name: 'Decentraland/USDT', base_asset: 'MANA', quote_asset: 'USDT', enabled: true, priority: 24, category: 'alt', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 },
      // { symbol: 'AXSUSDT', display_name: 'Axie Infinity/USDT', base_asset: 'AXS', quote_asset: 'USDT', enabled: true, priority: 25, category: 'alt', exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
      // { symbol: 'CHZUSDT', display_name: 'Chiliz/USDT', base_asset: 'CHZ', quote_asset: 'USDT', enabled: true, priority: 26, category: 'alt', exchange: 'binance', min_price: 0.00001, min_qty: 1 },
      // { symbol: 'ENJUSDT', display_name: 'Enjin Coin/USDT', base_asset: 'ENJ', quote_asset: 'USDT', enabled: true, priority: 27, category: 'alt', exchange: 'binance', min_price: 0.0001, min_qty: 0.1 }
    ];

    // 检查是否已经初始化过
    const count = await this.symbol_repository.count();

    if (count === 0) {
      await this.symbol_repository.batch_insert(default_symbols);
      logger.info(`Initialized ${default_symbols.length} default symbols`);
    } else {
      logger.info(`Found ${count} existing symbols in database`);
    }
  }

  /**
   * 获取所有币种配置，优先从缓存获取
   */
  async get_all_symbols(): Promise<SymbolConfig[]> {
    try {
      // 先尝试从缓存获取
      const cached = await this.redis!.get(this.CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }

      // 从数据库获取
      const symbols = await this.symbol_repository.find_all();

      // 更新缓存
      await this.redis!.setEx(this.CACHE_KEY, this.CACHE_TTL, JSON.stringify(symbols));

      return symbols;
    } catch (error) {
      logger.error('Failed to get all symbols', error);
      throw error;
    }
  }

  /**
   * 获取所有已启用的币种配置
   */
  async get_enabled_symbols(): Promise<SymbolConfig[]> {
    try {
      return await this.symbol_repository.find_enabled();
    } catch (error) {
      logger.error('Failed to get enabled symbols', error);
      throw error;
    }
  }

  /**
   * 根据币种符号获取单个币种配置
   * @param symbol - 交易对符号 (如: BTCUSDT)
   */
  async get_symbol_by_name(symbol: string): Promise<SymbolConfig | null> {
    try {
      return await this.symbol_repository.find_by_symbol(symbol);
    } catch (error) {
      logger.error(`Failed to get symbol ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 添加新的币种配置
   * @param symbol_data - 币种配置数据
   * @returns 新增记录的ID
   */
  async add_symbol(symbol_data: Omit<SymbolConfig, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    try {
      const insert_id = await this.symbol_repository.insert(symbol_data);

      // 清除缓存
      await this.redis!.del(this.CACHE_KEY);

      logger.info(`Added symbol ${symbol_data.symbol} with ID ${insert_id}`);
      return insert_id;
    } catch (error) {
      logger.error(`Failed to add symbol ${symbol_data.symbol}`, error);
      throw error;
    }
  }

  /**
   * 更新币种配置
   * @param symbol - 交易对符号
   * @param updates - 要更新的字段
   * @returns 是否更新成功
   */
  async update_symbol(symbol: string, updates: Partial<SymbolConfig>): Promise<boolean> {
    try {
      const success = await this.symbol_repository.update(symbol, updates);

      if (success) {
        // 清除缓存
        await this.redis!.del(this.CACHE_KEY);
        logger.info(`Updated symbol ${symbol}`);
      }

      return success;
    } catch (error) {
      logger.error(`Failed to update symbol ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 删除币种配置
   * @param symbol - 交易对符号
   * @returns 是否删除成功
   */
  async delete_symbol(symbol: string): Promise<boolean> {
    try {
      const success = await this.symbol_repository.delete(symbol);

      if (success) {
        // 清除缓存
        await this.redis!.del(this.CACHE_KEY);
        logger.info(`Deleted symbol ${symbol}`);
      }

      return success;
    } catch (error) {
      logger.error(`Failed to delete symbol ${symbol}`, error);
      throw error;
    }
  }

  /**
   * 切换币种启用状态
   * @param symbol - 交易对符号
   * @param enabled - 是否启用
   * @returns 是否更新成功
   */
  async toggle_symbol_status(symbol: string, enabled: boolean): Promise<boolean> {
    return await this.symbol_repository.toggle_enabled(symbol, enabled);
  }

  /**
   * 按分类获取币种配置
   * @param category - 币种分类 (major/alt/stable)
   */
  async get_symbols_by_category(category: 'major' | 'alt' | 'stable'): Promise<SymbolConfig[]> {
    try {
      return await this.symbol_repository.find_by_category(category);
    } catch (error) {
      logger.error(`Failed to get symbols by category ${category}`, error);
      throw error;
    }
  }
}