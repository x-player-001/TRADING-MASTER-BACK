import { BaseStrategy } from '../base_strategy';
import { EntrySignal, ExitSignal, TradeSide, ExitReason } from '../../types/trading_types';
import { BreakoutStrategyParams } from '../../types/strategy_types';
import { BacktestRangeDetector } from '@/quantitative/analysis/backtest_range_detector';
import { BreakoutAnalyzer } from '@/analysis/breakout_analyzer';
import { RangeBox } from '@/types/structure';

/**
 * 突破策略
 * 基于区间突破进行交易，复用现有的区间检测和突破分析模块
 */
export class BreakoutStrategy extends BaseStrategy {
  private params: BreakoutStrategyParams;
  private max_klines_seen: number = 0; // 记录见过的最大K线数量

  constructor(config: any) {
    super(config);
    this.params = config.parameters as BreakoutStrategyParams;
  }

  /**
   * 分析入场信号
   */
  async analyze_entry(
    symbol: string,
    interval: string,
    klines: any[],
    current_positions: any[]
  ): Promise<EntrySignal | null> {
    try {
      // 检查是否已有持仓
      const existing_position = current_positions.find(
        p => p.symbol === symbol && p.interval === interval
      );

      if (existing_position) {
        return null; // 已有持仓，不再开新仓
      }

      // 检查K线数量是否足够
      if (!this.validate_klines(klines, this.params.lookback_period)) {
        return null;
      }

      // RangeDetector期望降序数组（最新在前），回测引擎传入的是升序数组
      // 需要反转数组
      const reversed_klines = [...klines].reverse();

      // 获取或检测区间
      const ranges = await this.get_ranges(symbol, interval, reversed_klines);

      if (ranges.length === 0) {
        return null;
      }

      // 获取当前K线和最近几根K线（原始升序数组）
      const current_kline = klines[klines.length - 1];
      const recent_klines = klines.slice(-5);

      // 检测突破
      for (const range of ranges) {
        const breakout_direction = BacktestRangeDetector.detect_breakout(
          range,
          current_kline,
          recent_klines
        );

        if (breakout_direction) {
          // 回测模式：直接生成信号，不使用BreakoutAnalyzer的严格检查
          const current_price = parseFloat(current_kline.close as any);
          const side = breakout_direction === 'up' ? TradeSide.LONG : TradeSide.SHORT;

          // 计算指标快照
          const indicators = {
            range: {
              support: range.support,
              resistance: range.resistance,
              confidence: range.confidence,
              strength: range.strength
            },
            breakout: {
              direction: breakout_direction,
              breakout_price: current_price,
              risk_reward_ratio: 2.5  // 回测固定使用2.5(5%止盈/2%止损)
            }
          };

          // 使用服务器本地时区（UTC+8）格式化时间
          const range_start = new Date(range.start_time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
          const range_end = new Date(range.end_time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

          this.log(`Entry signal detected: ${symbol} ${breakout_direction.toUpperCase()} breakout`, {
            price: current_price,
            range: `${range.support.toFixed(2)}-${range.resistance.toFixed(2)}`,
            range_time: `${range_start} → ${range_end}`,
            confidence: (range.confidence * 100).toFixed(1) + '%'
          });

          return {
            symbol,
            interval,
            side,
            price: current_price,
            timestamp: current_kline.close_time,
            indicators,
            confidence: range.confidence
          };
        }
      }

      return null;
    } catch (error) {
      this.log(`Error analyzing entry: ${error instanceof Error ? error.message : 'Unknown'}`, error);
      return null;
    }
  }

  /**
   * 分析出场信号
   */
  async analyze_exit(position: any, current_kline: any): Promise<ExitSignal | null> {
    try {
      // 策略出场逻辑（除了止损止盈，还可以有其他出场条件）

      // 1. 检查是否有反向突破信号
      // 2. 检查是否趋势反转
      // 3. 检查持仓时间是否过长

      // 简化版本：暂时只依赖止损止盈，不额外触发出场
      return null;
    } catch (error) {
      this.log(`Error analyzing exit: ${error instanceof Error ? error.message : 'Unknown'}`, error);
      return null;
    }
  }

  /**
   * 检测区间（回测时不使用缓存，因为每次调用的K线数量都在增加）
   */
  private async get_ranges(symbol: string, interval: string, klines: any[]): Promise<RangeBox[]> {
    // 更新最大K线数量，但不输出调试日志（在回测结束后统一输出）
    if (klines.length > this.max_klines_seen) {
      this.max_klines_seen = klines.length;
    }

    const ranges = BacktestRangeDetector.detect_ranges(klines, this.params.lookback_period, false);

    // 策略参数过滤（可选的额外过滤）
    const filtered_ranges = ranges.filter(range => {
      return (
        range.touch_count >= this.params.min_range_touches &&
        range.confidence >= this.params.min_confidence &&
        range.strength >= (this.params.min_strength || 70)
      );
    });

    return filtered_ranges;
  }
}
