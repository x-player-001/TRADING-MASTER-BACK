/**
 * 测试信号处理记录功能
 */

import dotenv from 'dotenv';
import { signal_processing_repository } from '../../../src/database/signal_processing_repository';
import {
  SignalProcessingResult,
  RejectionCategory,
  SignalDirection
} from '../../../src/types/signal_processing';
import { ConfigManager } from '../../../src/core/config/config_manager';

// 加载环境变量
dotenv.config();

async function test_signal_processing() {
  console.log('🧪 开始测试信号处理记录功能...\n');

  // 初始化配置管理器
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  try {
    // 测试1: 创建一个拒绝记录
    console.log('📝 测试1: 创建拒绝记录（追高拒绝）');
    const rejection_id = await signal_processing_repository.create_record({
      anomaly_id: 12345,
      symbol: 'BTCUSDT',
      signal_direction: SignalDirection.LONG,
      signal_score: 8.5,
      signal_source: 'OI_ANOMALY',
      processing_result: SignalProcessingResult.REJECTED,
      rejection_reason: '追高风险：涨幅9.5%超过阈值8%',
      rejection_category: RejectionCategory.MARKET_CONDITIONS,
      current_open_positions: 2,
      available_balance: 950.50,
      signal_received_at: new Date()
    });
    console.log(`✅ 创建成功，ID: ${rejection_id}\n`);

    // 测试2: 创建一个接受记录
    console.log('📝 测试2: 创建接受记录（成功开仓）');
    const acceptance_id = await signal_processing_repository.create_record({
      anomaly_id: 12346,
      symbol: 'ETHUSDT',
      signal_direction: SignalDirection.LONG,
      signal_score: 9.2,
      signal_source: 'OI_ANOMALY',
      processing_result: SignalProcessingResult.ACCEPTED,
      order_id: '1234567890',
      position_id: 'ETHUSDT_LONG_1733012345678',
      entry_price: 2250.50,
      quantity: 0.044,
      position_value_usd: 99.02,
      current_open_positions: 3,
      available_balance: 851.48,
      signal_received_at: new Date()
    });
    console.log(`✅ 创建成功，ID: ${acceptance_id}\n`);

    // 测试3: 创建一个风控拒绝记录
    console.log('📝 测试3: 创建风控拒绝记录（持仓数量限制）');
    const risk_rejection_id = await signal_processing_repository.create_record({
      anomaly_id: 12347,
      symbol: 'BNBUSDT',
      signal_direction: SignalDirection.LONG,
      signal_score: 8.8,
      signal_source: 'OI_ANOMALY',
      processing_result: SignalProcessingResult.REJECTED,
      rejection_reason: '已达到最大持仓数量限制 (3/3)',
      rejection_category: RejectionCategory.MAX_POSITIONS_LIMIT,
      current_daily_loss: 5.20,
      current_open_positions: 3,
      available_balance: 851.48,
      signal_received_at: new Date()
    });
    console.log(`✅ 创建成功，ID: ${risk_rejection_id}\n`);

    // 测试4: 查询最近记录
    console.log('📊 测试4: 查询最近10条记录');
    const recent = await signal_processing_repository.get_recent_records(10);
    console.log(`✅ 查询到 ${recent.length} 条记录`);
    recent.slice(0, 3).forEach(record => {
      console.log(`   - ${record.symbol} ${record.signal_direction} [${record.processing_result}] ${record.rejection_reason || '成功开仓'}`);
    });
    console.log();

    // 测试5: 统计信号处理结果
    console.log('📈 测试5: 统计今日信号处理结果');
    const today_start = new Date();
    today_start.setHours(0, 0, 0, 0);
    const today_end = new Date();
    today_end.setHours(23, 59, 59, 999);

    const stats = await signal_processing_repository.get_processing_statistics(today_start, today_end);
    console.log(`✅ 统计结果:`);
    console.log(`   总信号数: ${stats.total}`);
    console.log(`   接受: ${stats.accepted} (${stats.total > 0 ? (stats.accepted / stats.total * 100).toFixed(1) : 0}%)`);
    console.log(`   拒绝: ${stats.rejected} (${stats.total > 0 ? (stats.rejected / stats.total * 100).toFixed(1) : 0}%)`);
    console.log(`   拒绝原因分布:`);
    Object.entries(stats.rejection_breakdown).forEach(([category, count]) => {
      console.log(`     - ${category}: ${count}次`);
    });
    console.log();

    // 测试6: 根据anomaly_id查询
    console.log('📝 测试6: 根据anomaly_id查询记录');
    const record = await signal_processing_repository.get_by_anomaly_id(12345);
    if (record) {
      console.log(`✅ 查询成功:`);
      console.log(`   币种: ${record.symbol}`);
      console.log(`   方向: ${record.signal_direction}`);
      console.log(`   评分: ${record.signal_score}`);
      console.log(`   结果: ${record.processing_result}`);
      console.log(`   原因: ${record.rejection_reason}`);
    } else {
      console.log('❌ 未找到记录');
    }
    console.log();

    console.log('✅ 所有测试通过！');

  } catch (error) {
    console.error('❌ 测试失败:', error);
    throw error;
  } finally {
    // 关闭数据库连接
    const { DatabaseConfig } = await import('../../../src/core/config/database');
    await DatabaseConfig.close_connections();
  }
}

// 运行测试
test_signal_processing();
