import { KlineData } from '@/types/common';
import { RangeBox, BreakoutSignal, BreakoutStatus } from '@/types/structure';
import { logger } from '@/utils/logger';

/**
 * 突破分析器
 * 分析区间突破信号的有效性和目标位
 */
export class BreakoutAnalyzer {

  /**
   * 分析区间突破并生成交易信号
   * @param range 交易区间
   * @param klines K线数据 (包含突破K线)
   * @param breakout_direction 突破方向
   * @returns 突破信号 或 null
   */
  static analyze_breakout(
    range: RangeBox,
    klines: KlineData[],
    breakout_direction: 'up' | 'down'
  ): BreakoutSignal | null {
    try {
      const current_kline = klines[klines.length - 1];
      const breakout_price = parseFloat(current_kline.close as any);
      const breakout_volume = parseFloat(current_kline.volume as any);

      // 1. 计算突破强度
      const breakout_strength = this.calculate_breakout_strength(
        range,
        breakout_price,
        breakout_volume,
        breakout_direction
      );

      // 突破强度至少要60分
      if (breakout_strength < 60) {
        logger.debug(`Breakout strength too weak: ${breakout_strength}`);
        return null;
      }

      // 2. 计算成交量比率
      const volume_ratio = breakout_volume / range.avg_volume;

      // 3. 计算目标位和止损
      const { target_price, stop_loss } = this.calculate_target_and_stop(
        range,
        breakout_price,
        breakout_direction
      );

      // 4. 计算风险收益比
      const risk = Math.abs(breakout_price - stop_loss);
      const reward = Math.abs(target_price - breakout_price);
      const risk_reward_ratio = reward / risk;

      // 风险收益比至少1.5:1
      if (risk_reward_ratio < 1.5) {
        logger.debug(`Risk/Reward ratio too low: ${risk_reward_ratio.toFixed(2)}`);
        return null;
      }

      // 5. 构建突破信号
      const signal: BreakoutSignal = {
        symbol: range.symbol,
        interval: range.interval,
        breakout_direction,
        breakout_price,
        previous_range_high: range.resistance,
        previous_range_low: range.support,
        breakout_strength,
        breakout_volume,
        avg_volume: range.avg_volume,
        volume_ratio: Number(volume_ratio.toFixed(2)),
        target_price: Number(target_price.toFixed(2)),
        stop_loss: Number(stop_loss.toFixed(2)),
        risk_reward_ratio: Number(risk_reward_ratio.toFixed(2)),
        result: 'pending',
        breakout_time: current_kline.open_time
      };

      return signal;

    } catch (error) {
      logger.error('Failed to analyze breakout', error);
      return null;
    }
  }

  /**
   * 计算突破强度 (0-100)
   */
  private static calculate_breakout_strength(
    range: RangeBox,
    breakout_price: number,
    breakout_volume: number,
    direction: 'up' | 'down'
  ): number {
    let strength = 0;

    // 1. 区间可靠性得分 (最高30分)
    strength += range.confidence * 30;

    // 2. 突破幅度得分 (最高25分)
    const breakout_level = direction === 'up' ? range.resistance : range.support;
    const breakout_percent = Math.abs((breakout_price - breakout_level) / breakout_level) * 100;
    strength += Math.min(breakout_percent * 5, 25); // 5%突破 = 满分

    // 3. 成交量得分 (最高25分)
    const volume_ratio = breakout_volume / range.avg_volume;
    strength += Math.min((volume_ratio - 1) * 20, 25); // 2倍量 = 满分

    // 4. 区间持续时间得分 (最高10分)
    strength += Math.min(range.duration_bars / 5, 10); // 50根K线 = 满分

    // 5. 区间触碰次数得分 (最高10分)
    strength += Math.min(range.touch_count, 10);

    return Math.round(Math.min(strength, 100));
  }

  /**
   * 计算目标位和止损
   */
  private static calculate_target_and_stop(
    range: RangeBox,
    breakout_price: number,
    direction: 'up' | 'down'
  ): { target_price: number; stop_loss: number } {
    const range_size = range.range_size;

    if (direction === 'up') {
      // 向上突破
      // 目标位: 突破价 + 区间宽度
      const target_price = breakout_price + range_size;

      // 止损: 区间顶部下方 (阻力转支撑)
      const stop_loss = range.resistance * 0.98; // 阻力下方2%

      return { target_price, stop_loss };

    } else {
      // 向下突破
      // 目标位: 突破价 - 区间宽度
      const target_price = breakout_price - range_size;

      // 止损: 区间底部上方 (支撑转阻力)
      const stop_loss = range.support * 1.02; // 支撑上方2%

      return { target_price, stop_loss };
    }
  }

  /**
   * 检查突破后的价格走势，更新信号结果
   * @param signal 突破信号
   * @param current_klines 当前K线数据
   * @returns 更新后的结果状态
   */
  static check_signal_result(
    signal: BreakoutSignal,
    current_klines: KlineData[]
  ): 'pending' | 'hit_target' | 'hit_stop' | 'failed' {
    // 找到突破后的K线
    const breakout_index = current_klines.findIndex(
      k => k.open_time >= signal.breakout_time
    );

    if (breakout_index === -1 || breakout_index === current_klines.length - 1) {
      return 'pending'; // 还没有后续数据
    }

    const after_breakout = current_klines.slice(breakout_index + 1);

    let max_profit = 0;
    let max_loss = 0;

    for (const kline of after_breakout) {
      const high = parseFloat(kline.high as any);
      const low = parseFloat(kline.low as any);

      if (signal.breakout_direction === 'up') {
        // 向上突破: 检查是否触及目标或止损
        if (high >= signal.target_price) {
          return 'hit_target';
        }
        if (low <= signal.stop_loss) {
          return 'hit_stop';
        }

        const profit_percent = ((high - signal.breakout_price) / signal.breakout_price) * 100;
        max_profit = Math.max(max_profit, profit_percent);

      } else {
        // 向下突破
        if (low <= signal.target_price) {
          return 'hit_target';
        }
        if (high >= signal.stop_loss) {
          return 'hit_stop';
        }

        const profit_percent = ((signal.breakout_price - low) / signal.breakout_price) * 100;
        max_profit = Math.max(max_profit, profit_percent);
      }
    }

    // 检查是否假突破 (回到区间内超过3根K线)
    const back_in_range_count = after_breakout.filter(k => {
      const close = parseFloat(k.close as any);
      return close > signal.previous_range_low && close < signal.previous_range_high;
    }).length;

    if (back_in_range_count >= 3) {
      return 'failed'; // 假突破
    }

    return 'pending';
  }

  /**
   * 计算信号的胜率
   * @param signals 历史突破信号列表
   * @returns 胜率统计
   */
  static calculate_win_rate(signals: BreakoutSignal[]): {
    total: number;
    hit_target: number;
    hit_stop: number;
    failed: number;
    pending: number;
    win_rate: number;
    avg_risk_reward: number;
  } {
    const total = signals.length;
    const hit_target = signals.filter(s => s.result === 'hit_target').length;
    const hit_stop = signals.filter(s => s.result === 'hit_stop').length;
    const failed = signals.filter(s => s.result === 'failed').length;
    const pending = signals.filter(s => s.result === 'pending').length;

    const completed = hit_target + hit_stop + failed;
    const win_rate = completed > 0 ? (hit_target / completed) * 100 : 0;

    const avg_risk_reward = signals.length > 0
      ? signals.reduce((sum, s) => sum + s.risk_reward_ratio, 0) / signals.length
      : 0;

    return {
      total,
      hit_target,
      hit_stop,
      failed,
      pending,
      win_rate: Number(win_rate.toFixed(2)),
      avg_risk_reward: Number(avg_risk_reward.toFixed(2))
    };
  }

  /**
   * 判断是否适合交易
   * 综合评估突破信号的质量
   */
  static is_tradeable(signal: BreakoutSignal, range: RangeBox): {
    tradeable: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let tradeable = true;

    // 1. 检查突破强度
    if (signal.breakout_strength < 70) {
      tradeable = false;
      reasons.push(`突破强度偏低(${signal.breakout_strength})`);
    }

    // 2. 检查成交量
    if (signal.volume_ratio < 1.3) {
      tradeable = false;
      reasons.push(`成交量不足(${signal.volume_ratio.toFixed(2)}倍)`);
    }

    // 3. 检查风险收益比
    if (signal.risk_reward_ratio < 2) {
      reasons.push(`风险收益比偏低(${signal.risk_reward_ratio.toFixed(2)})`);
      // 不完全否决，但要警告
    }

    // 4. 检查区间质量
    if (range.confidence < 0.6) {
      tradeable = false;
      reasons.push(`区间可靠性不足(${(range.confidence * 100).toFixed(0)}%)`);
    }

    // 5. 检查区间持续时间
    if (range.duration_bars < 20) {
      reasons.push(`区间持续时间较短(${range.duration_bars}根)`);
    }

    if (tradeable && reasons.length === 0) {
      reasons.push('✅ 突破信号可靠，适合交易');
    }

    return { tradeable, reasons };
  }
}
