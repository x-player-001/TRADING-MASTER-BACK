import { SymbolConfigRepository } from '@/database';
import { SymbolConfig } from '@/types/common';

describe('SymbolConfigRepository', () => {
  let repository: SymbolConfigRepository;

  beforeEach(() => {
    repository = new SymbolConfigRepository();
  });

  describe('基本CRUD操作', () => {
    const test_symbol: Omit<SymbolConfig, 'id' | 'created_at' | 'updated_at'> = {
      symbol: 'TESTUSDT',
      display_name: 'Test/USDT',
      base_asset: 'TEST',
      quote_asset: 'USDT',
      enabled: true,
      priority: 99,
      category: 'alt',
      exchange: 'binance',
      min_price: 0.01,
      min_qty: 0.001
    };

    test('应该能够创建表', async () => {
      await expect(repository.create_table()).resolves.not.toThrow();
    });

    test('应该能够插入币种配置', async () => {
      const id = await repository.insert(test_symbol);
      expect(id).toBeGreaterThan(0);
    });

    test('应该能够根据符号查找币种', async () => {
      await repository.insert(test_symbol);
      const found = await repository.find_by_symbol('TESTUSDT');
      expect(found).not.toBeNull();
      expect(found?.symbol).toBe('TESTUSDT');
    });

    test('应该能够更新币种配置', async () => {
      await repository.insert(test_symbol);
      const success = await repository.update('TESTUSDT', { enabled: false });
      expect(success).toBe(true);

      const updated = await repository.find_by_symbol('TESTUSDT');
      expect(updated?.enabled).toBe(false);
    });

    test('应该能够删除币种配置', async () => {
      await repository.insert(test_symbol);
      const success = await repository.delete('TESTUSDT');
      expect(success).toBe(true);

      const deleted = await repository.find_by_symbol('TESTUSDT');
      expect(deleted).toBeNull();
    });
  });

  describe('查询操作', () => {
    beforeEach(async () => {
      // 插入测试数据
      const test_symbols = [
        { symbol: 'BTC1USDT', display_name: 'BTC1/USDT', base_asset: 'BTC1', quote_asset: 'USDT', enabled: true, priority: 1, category: 'major' as const, exchange: 'binance', min_price: 0.01, min_qty: 0.001 },
        { symbol: 'ETH1USDT', display_name: 'ETH1/USDT', base_asset: 'ETH1', quote_asset: 'USDT', enabled: false, priority: 2, category: 'major' as const, exchange: 'binance', min_price: 0.01, min_qty: 0.001 },
        { symbol: 'ALT1USDT', display_name: 'ALT1/USDT', base_asset: 'ALT1', quote_asset: 'USDT', enabled: true, priority: 3, category: 'alt' as const, exchange: 'binance', min_price: 0.001, min_qty: 0.01 }
      ];

      for (const symbol of test_symbols) {
        await repository.insert(symbol);
      }
    });

    test('应该能够获取所有币种', async () => {
      const symbols = await repository.find_all();
      expect(symbols.length).toBeGreaterThanOrEqual(3);
    });

    test('应该能够获取已启用的币种', async () => {
      const enabled = await repository.find_enabled();
      expect(enabled.length).toBeGreaterThanOrEqual(2);
      enabled.forEach(symbol => {
        expect(symbol.enabled).toBe(true);
      });
    });

    test('应该能够按分类获取币种', async () => {
      const major_symbols = await repository.find_by_category('major');
      expect(major_symbols.length).toBeGreaterThanOrEqual(2);
      major_symbols.forEach(symbol => {
        expect(symbol.category).toBe('major');
      });
    });

    test('应该能够获取币种总数', async () => {
      const count = await repository.count();
      expect(count).toBeGreaterThanOrEqual(3);
    });

    test('应该能够检查币种是否存在', async () => {
      const exists = await repository.exists('BTC1USDT');
      expect(exists).toBe(true);

      const not_exists = await repository.exists('NONEXISTUSDT');
      expect(not_exists).toBe(false);
    });
  });

  describe('批量操作', () => {
    test('应该能够批量插入币种', async () => {
      const batch_symbols = [
        { symbol: 'BATCH1USDT', display_name: 'Batch1/USDT', base_asset: 'BATCH1', quote_asset: 'USDT', enabled: true, priority: 10, category: 'alt' as const, exchange: 'binance', min_price: 0.001, min_qty: 0.01 },
        { symbol: 'BATCH2USDT', display_name: 'Batch2/USDT', base_asset: 'BATCH2', quote_asset: 'USDT', enabled: true, priority: 11, category: 'alt' as const, exchange: 'binance', min_price: 0.001, min_qty: 0.01 }
      ];

      await expect(repository.batch_insert(batch_symbols)).resolves.not.toThrow();

      const count = await repository.count();
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  afterEach(async () => {
    // 清理测试数据
    try {
      const test_symbols = ['TESTUSDT', 'BTC1USDT', 'ETH1USDT', 'ALT1USDT', 'BATCH1USDT', 'BATCH2USDT'];
      for (const symbol of test_symbols) {
        await repository.delete(symbol);
      }
    } catch (error) {
      // 忽略删除错误
    }
  });
});