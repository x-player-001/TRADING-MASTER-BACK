/**
 * OI功能集成测试
 * 手动运行测试脚本
 */

import dotenv from 'dotenv';
import { OIDataManager } from '../core/data/oi_data_manager';
import { BinanceFuturesAPI } from '../api/binance_futures_api';

// 加载环境变量
dotenv.config();

class OIIntegrationTest {
  private oi_data_manager: OIDataManager;
  private binance_api: BinanceFuturesAPI;

  constructor() {
    this.oi_data_manager = new OIDataManager();
    this.binance_api = new BinanceFuturesAPI();
  }

  async run_tests(): Promise<void> {
    console.log('🧪 Starting OI Integration Tests...\n');

    try {
      // 测试1: 数据库连接
      await this.test_database_connection();

      // 测试2: 币安API连接
      await this.test_binance_api_connection();

      // 测试3: 获取合约列表
      await this.test_get_contracts();

      // 测试4: 获取OI数据
      await this.test_get_oi_data();

      // 测试5: 初始化OI管理器
      await this.test_oi_manager_initialization();

      console.log('\n✅ All tests passed! OI功能集成成功');

    } catch (error) {
      console.error('\n❌ Test failed:', error);
      process.exit(1);
    }
  }

  private async test_database_connection(): Promise<void> {
    console.log('📊 Testing database connection...');

    try {
      await this.oi_data_manager.initialize();
      console.log('✅ Database connection successful');
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  private async test_binance_api_connection(): Promise<void> {
    console.log('🌐 Testing Binance API connection...');

    try {
      const is_connected = await this.binance_api.ping();
      if (!is_connected) {
        throw new Error('Binance API ping failed');
      }
      console.log('✅ Binance API connection successful');
    } catch (error) {
      console.error('❌ Binance API connection failed:', error);
      throw error;
    }
  }

  private async test_get_contracts(): Promise<void> {
    console.log('📋 Testing contract list retrieval...');

    try {
      const contracts = await this.binance_api.get_usdt_perpetual_symbols();
      console.log(`✅ Retrieved ${contracts.length} USDT perpetual contracts`);

      if (contracts.length > 0) {
        console.log(`   Sample contracts: ${contracts.slice(0, 5).map(c => c.symbol).join(', ')}`);
      }
    } catch (error) {
      console.error('❌ Failed to get contract list:', error);
      throw error;
    }
  }

  private async test_get_oi_data(): Promise<void> {
    console.log('📈 Testing OI data retrieval...');

    try {
      // 测试获取单个币种的OI数据
      const test_symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
      const oi_data = await this.binance_api.get_batch_open_interest(test_symbols);

      console.log(`✅ Retrieved OI data for ${oi_data.length}/${test_symbols.length} symbols`);

      for (const data of oi_data.slice(0, 3)) {
        console.log(`   ${data.symbol}: ${data.open_interest.toLocaleString()} OI`);
      }
    } catch (error) {
      console.error('❌ Failed to get OI data:', error);
      throw error;
    }
  }

  private async test_oi_manager_initialization(): Promise<void> {
    console.log('⚙️  Testing OI manager initialization...');

    try {
      // 获取健康状态
      const health_status = await this.oi_data_manager.get_health_status();

      console.log('✅ OI Manager health check:');
      console.log(`   Initialized: ${health_status.is_initialized}`);
      console.log(`   Database: ${health_status.database_healthy ? '✅' : '❌'}`);
      console.log(`   API: ${health_status.api_healthy ? '✅' : '❌'}`);

      // 测试手动刷新币种
      console.log('🔄 Testing symbol refresh...');
      await this.oi_data_manager.refresh_symbols();
      console.log('✅ Symbol refresh completed');

      // 获取启用的币种
      const enabled_symbols = await this.oi_data_manager.get_enabled_symbols();
      console.log(`✅ Found ${enabled_symbols.length} enabled symbols`);

    } catch (error) {
      console.error('❌ OI manager initialization failed:', error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.oi_data_manager.destroy();
      console.log('🧹 Cleanup completed');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }
}

// 运行测试
const test = new OIIntegrationTest();

// 优雅退出处理
const cleanup_and_exit = async (signal: string) => {
  console.log(`\n📴 Received ${signal}, cleaning up...`);
  await test.cleanup();
  process.exit(0);
};

process.on('SIGTERM', () => cleanup_and_exit('SIGTERM'));
process.on('SIGINT', () => cleanup_and_exit('SIGINT'));

// 运行测试
test.run_tests()
  .then(() => test.cleanup())
  .catch(async (error) => {
    console.error('Test execution failed:', error);
    await test.cleanup();
    process.exit(1);
  });