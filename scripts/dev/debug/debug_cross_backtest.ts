/**
 * 调试CROSSUSDT回测 - 找出为什么没有交易
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { BacktestEngine } from '../../../src/trading/backtest_engine';
import { BacktestConfig, StrategyType } from '../../../src/types/trading_types';
import { ConfigManager } from '../../../src/core/config/config_manager';
import { OIRepository } from '../../../src/database/oi_repository';
import { SignalGenerator } from '../../../src/trading/signal_generator';
import { StrategyEngine } from '../../../src/trading/strategy_engine';
import { RiskManager } from '../../../src/trading/risk_manager';

async function debug_cross() {
  console.log('🔍 调试CROSSUSDT回测流程...\n');

  try {
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    const oi_repo = new OIRepository();
    const signal_generator = new SignalGenerator();
    const strategy_engine = new StrategyEngine();

    // 获取11月26日的CROSSUSDT异动
    const start_date = new Date('2025-11-26T00:00:00Z');
    const end_date = new Date('2025-11-26T23:59:59Z');

    console.log('1️⃣ 加载CROSSUSDT异动数据...');
    const anomalies = await oi_repo.get_anomaly_records({
      start_time: start_date,
      end_time: end_date,
      symbol: 'CROSSUSDT',
      order: 'ASC'
    });

    console.log(`   找到 ${anomalies.length} 条异动记录\n`);

    // 过滤条件：只看有完整价格极值字段的
    const filtered = anomalies.filter(a =>
      a.daily_price_low !== null &&
      a.daily_price_high !== null &&
      a.price_from_low_pct !== null &&
      a.price_from_high_pct !== null
    );

    console.log(`   过滤后（有价格极值）: ${filtered.length} 条\n`);

    if (filtered.length === 0) {
      console.log('❌ 所有异动都被过滤掉了（缺少价格极值字段）！');
      process.exit(0);
    }

    // 创建风险管理器
    const risk_config = {
      max_position_size_percent: 5,
      max_total_positions: 10,
      max_positions_per_symbol: 1,
      default_stop_loss_percent: 100,
      default_take_profit_percent: 8,
      use_trailing_stop: true,
      trailing_stop_callback_rate: 30,
      daily_loss_limit_percent: 100,
      consecutive_loss_limit: 999,
      pause_after_loss_limit: false,
      max_leverage: 1,
      leverage_by_signal_strength: { weak: 1, medium: 1, strong: 1 }
    };

    const risk_manager = new RiskManager(risk_config);

    console.log('2️⃣ 逐个处理异动...\n');
    console.log('═'.repeat(120));

    const open_positions: any[] = [];
    const closed_positions: any[] = [];
    let balance = 1000;

    for (let i = 0; i < Math.min(filtered.length, 10); i++) {
      const anomaly = filtered[i];
      const time = new Date(anomaly.anomaly_time).toISOString().substring(11, 19);

      console.log(`\n异动 #${i + 1}: ${time}`);
      console.log(`  OI变化: ${parseFloat(anomaly.percent_change.toString()).toFixed(2)}%`);
      console.log(`  价格变化: ${anomaly.price_change_percent ? parseFloat(anomaly.price_change_percent.toString()).toFixed(2) : 'N/A'}%`);

      // 步骤1: 生成信号
      console.log(`\n  步骤1: 生成信号...`);
      const signal = signal_generator.generate_signal(anomaly);

      if (!signal) {
        console.log(`  ❌ 信号生成失败 (generate_signal返回null)`);
        continue;
      }

      console.log(`  ✅ 信号生成成功: 评分=${signal.score.toFixed(2)}, 方向=${signal.direction}`);

      // 步骤2: 策略评估
      console.log(`\n  步骤2: 策略评估...`);
      const strategy_config = {
        strategy_type: StrategyType.BREAKOUT,
        enabled: true,
        min_signal_score: 7,
        min_confidence: 0.5,
        min_oi_change_percent: 3,
        require_price_oi_alignment: true,
        price_oi_divergence_threshold: 5,
        use_sentiment_filter: false,
        min_trader_ratio: 0.8,
        max_funding_rate: 0.01,
        min_funding_rate: -0.01
      };

      strategy_engine.update_config(strategy_config);
      const strategy_result = strategy_engine.evaluate_signal(signal);

      if (!strategy_result.passed) {
        console.log(`  ❌ 策略评估失败: ${strategy_result.reason}`);
        continue;
      }

      console.log(`  ✅ 策略评估通过`);

      // 步骤3: 风险检查
      console.log(`\n  步骤3: 风险检查...`);
      console.log(`     当前未平仓: ${open_positions.length} 个`);
      console.log(`     已平仓: ${closed_positions.length} 个`);

      const risk_check = risk_manager.can_open_position(
        signal,
        [...open_positions, ...closed_positions],
        balance,
        anomaly.anomaly_time
      );

      if (!risk_check.allowed) {
        console.log(`  ❌ 风险检查失败: ${risk_check.reason}`);
        continue;
      }

      console.log(`  ✅ 风险检查通过: 仓位大小=$${risk_check.position_size?.toFixed(2)}, 杠杆=${risk_check.leverage}x`);

      // 步骤4: 防重复检查
      console.log(`\n  步骤4: 防重复检查（10秒窗口）...`);
      const recent_time_window = 10 * 1000;
      const has_recent_position = [...open_positions, ...closed_positions].some(pos => {
        if (pos.symbol !== signal.symbol) return false;
        const time_diff = Math.abs(anomaly.anomaly_time.getTime() - pos.opened_at.getTime());
        return time_diff < recent_time_window;
      });

      if (has_recent_position) {
        console.log(`  ❌ 防重复检查失败: 10秒内已有${signal.symbol}的仓位`);
        continue;
      }

      console.log(`  ✅ 防重复检查通过`);

      // 模拟开仓
      console.log(`\n  ✅✅ 所有检查通过！模拟开仓...`);
      const position = {
        symbol: signal.symbol,
        opened_at: anomaly.anomaly_time,
        entry_price: signal.entry_price || 0
      };

      open_positions.push(position);
      console.log(`  📈 开仓成功！当前未平仓: ${open_positions.length} 个`);
    }

    console.log('\n═'.repeat(120));
    console.log(`\n📊 总结:`);
    console.log(`  处理的异动: ${Math.min(filtered.length, 10)} 个`);
    console.log(`  成功开仓: ${open_positions.length} 个`);
    console.log(`  CROSSUSDT仓位: ${open_positions.filter(p => p.symbol === 'CROSSUSDT').length} 个`);

    if (open_positions.length === 0) {
      console.log(`\n⚠️  没有任何仓位被开启！请检查上面的日志找出被拒绝的原因。`);
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ 调试失败:', error);
    if (error instanceof Error) {
      console.error('错误详情:', error.message);
      console.error('堆栈:', error.stack);
    }
    process.exit(1);
  }
}

debug_cross();
