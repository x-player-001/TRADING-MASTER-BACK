/**
 * 测试OI快照查询
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { OIRepository } from '../src/database/oi_repository';
import { ConfigManager } from '../src/core/config/config_manager';

async function test_query_snapshots() {
  console.log('=== 测试OI快照查询 ===\n');

  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();
  console.log('✅ 配置管理器初始化完成\n');

  const oi_repo = new OIRepository();

  // 测试几个日期
  const test_cases = [
    { symbol: 'BTCUSDT', date: '2025-11-12' },
    { symbol: 'BTCUSDT', date: '2025-11-13' },
    { symbol: 'BTCUSDT', date: '2025-11-14' },
    { symbol: 'NXPCUSDT', date: '2025-11-12' },
  ];

  for (const test of test_cases) {
    console.log(`\n查询 ${test.symbol} 在 ${test.date} 的快照数据...`);
    try {
      const snapshots = await oi_repo.get_symbol_oi_curve(test.symbol, test.date);
      console.log(`  ✅ 查询成功，共 ${snapshots.length} 条数据`);

      if (snapshots.length > 0) {
        const prices = snapshots
          .map((s: any) => s.mark_price)
          .filter((p: any) => p !== undefined && p !== null && p > 0);

        console.log(`  - 有效价格数量: ${prices.length}`);
        if (prices.length > 0) {
          const min = Math.min(...prices.map((p: any) => typeof p === 'string' ? parseFloat(p) : p));
          const max = Math.max(...prices.map((p: any) => typeof p === 'string' ? parseFloat(p) : p));
          console.log(`  - 价格范围: $${min.toFixed(2)} - $${max.toFixed(2)}`);
        }
      }
    } catch (error: any) {
      console.log(`  ❌ 查询失败:`, error.message);
    }
  }

  process.exit(0);
}

test_query_snapshots();
