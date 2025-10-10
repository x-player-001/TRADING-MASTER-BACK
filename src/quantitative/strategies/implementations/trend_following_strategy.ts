import { BaseStrategy } from '../base_strategy';
import { EntrySignal, ExitSignal, TradeSide, ExitReason } from '../../types/trading_types';
import { TrendFollowingStrategyParams } from '../../types/strategy_types';

/**
 * 趋势跟踪策略
 * 基于移动平均线交叉判断趋势，结合RSI过滤信号
 */
export class TrendFollowingStrategy extends BaseStrategy {
  private params: TrendFollowingStrategyParams;

  constructor(config: any) {
    super(config);
    this.params = config.parameters as TrendFollowingStrategyParams;
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
        return null;
      }

      // 检查K线数量
      const required_length = Math.max(
        this.params.fast_ma_period,
        this.params.slow_ma_period,
        this.params.trend_ma_period,
        this.params.rsi_period
      ) + 10;

      if (!this.validate_klines(klines, required_length)) {
        return null;
      }

      // 提取收盘价
      const closes = klines.map(k => parseFloat(k.close));

      // 计算移动平均线
      const fast_ma_prev = this.calculate_sma(closes.slice(0, -1), this.params.fast_ma_period);
      const fast_ma_curr = this.calculate_sma(closes, this.params.fast_ma_period);

      const slow_ma_prev = this.calculate_sma(closes.slice(0, -1), this.params.slow_ma_period);
      const slow_ma_curr = this.calculate_sma(closes, this.params.slow_ma_period);

      const trend_ma = this.calculate_sma(closes, this.params.trend_ma_period);

      if (!fast_ma_prev || !fast_ma_curr || !slow_ma_prev || !slow_ma_curr || !trend_ma) {
        return null;
      }

      // 计算RSI
      const rsi = this.calculate_rsi(closes, this.params.rsi_period);
      if (!rsi) {
        return null;
      }

      // 当前价格
      const current_price = closes[closes.length - 1];

      // 检查均线交叉
      const ma_cross = this.check_ma_cross(fast_ma_prev, fast_ma_curr, slow_ma_prev, slow_ma_curr);

      // 检查趋势强度
      const trend_diff_percent = Math.abs((current_price - trend_ma) / trend_ma);

      if (trend_diff_percent < this.params.min_trend_strength) {
        return null; // 趋势不够强
      }

      // 做多条件：金叉 + 价格在趋势均线上方 + RSI>50
      if (
        ma_cross === 'golden' &&
        current_price > trend_ma &&
        rsi > 50
      ) {
        const indicators = {
          fast_ma: fast_ma_curr,
          slow_ma: slow_ma_curr,
          trend_ma,
          rsi,
          ma_cross: 'golden',
          trend_strength: trend_diff_percent
        };

        this.log(`Entry signal (LONG): ${symbol}`, {
          price: current_price,
          rsi,
          trend: 'bullish'
        });

        return {
          symbol,
          interval,
          side: TradeSide.LONG,
          price: current_price,
          timestamp: klines[klines.length - 1].close_time,
          indicators,
          confidence: this.calculate_signal_confidence(rsi, trend_diff_percent, 'LONG')
        };
      }

      // 做空条件：死叉 + 价格在趋势均线下方 + RSI<50
      if (
        ma_cross === 'death' &&
        current_price < trend_ma &&
        rsi < 50
      ) {
        const indicators = {
          fast_ma: fast_ma_curr,
          slow_ma: slow_ma_curr,
          trend_ma,
          rsi,
          ma_cross: 'death',
          trend_strength: trend_diff_percent
        };

        this.log(`Entry signal (SHORT): ${symbol}`, {
          price: current_price,
          rsi,
          trend: 'bearish'
        });

        return {
          symbol,
          interval,
          side: TradeSide.SHORT,
          price: current_price,
          timestamp: klines[klines.length - 1].close_time,
          indicators,
          confidence: this.calculate_signal_confidence(rsi, trend_diff_percent, 'SHORT')
        };
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
      // 策略出场条件：
      // 1. 多头持仓：快线下穿慢线（死叉）
      // 2. 空头持仓：快线上穿慢线（金叉）

      // 注意：这需要访问历史K线，这里简化处理
      // 实际应该在回测引擎中传入足够的历史数据

      return null; // 简化版本：只依赖止损止盈
    } catch (error) {
      this.log(`Error analyzing exit: ${error instanceof Error ? error.message : 'Unknown'}`, error);
      return null;
    }
  }

  /**
   * 计算信号置信度
   */
  private calculate_signal_confidence(rsi: number, trend_strength: number, side: 'LONG' | 'SHORT'): number {
    let confidence = 0.5; // 基础置信度

    if (side === 'LONG') {
      // 多头：RSI越低（超卖）置信度越高
      if (rsi < this.params.rsi_oversold) {
        confidence += 0.3;
      } else if (rsi < 50) {
        confidence += 0.1;
      }
    } else {
      // 空头：RSI越高（超买）置信度越高
      if (rsi > this.params.rsi_overbought) {
        confidence += 0.3;
      } else if (rsi > 50) {
        confidence += 0.1;
      }
    }

    // 趋势强度越大，置信度越高
    if (trend_strength > 0.05) {
      confidence += 0.2;
    } else if (trend_strength > 0.02) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }
}
