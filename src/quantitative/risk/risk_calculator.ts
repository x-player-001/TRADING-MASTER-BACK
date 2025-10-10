import { RiskConfig, RiskCheckResult, RiskExposure, SymbolExposure } from '../types/risk_types';
import { Position } from '../types/trading_types';
import { Trade } from '../types/trading_types';
import { RiskRepository } from '@/database/quantitative/risk_repository';
import { PositionRepository } from '@/database/quantitative/position_repository';
import { TradeRepository } from '@/database/quantitative/trade_repository';
import { logger } from '@/utils/logger';

/**
 * 风险计算器
 * 负责风险检查和风险敞口计算
 */
export class RiskCalculator {
  private risk_repository: RiskRepository;
  private position_repository: PositionRepository;
  private trade_repository: TradeRepository;

  constructor() {
    this.risk_repository = new RiskRepository();
    this.position_repository = new PositionRepository();
    this.trade_repository = new TradeRepository();
  }

  /**
   * 检查是否可以开仓（完整风控检查）
   */
  async check_can_open_position(
    strategy_id: number,
    symbol: string,
    position_value: number,
    total_capital: number
  ): Promise<RiskCheckResult> {
    try {
      // 获取风控配置
      const risk_config = await this.risk_repository.find_by_strategy(strategy_id);

      if (!risk_config) {
        return {
          passed: false,
          reason: 'Risk config not found for strategy'
        };
      }

      // 1. 检查黑名单
      if (risk_config.blacklist_symbols.includes(symbol)) {
        return {
          passed: false,
          reason: `Symbol ${symbol} is blacklisted`,
          is_blacklisted: true
        };
      }

      // 2. 检查最大持仓数量
      const open_positions = await this.position_repository.find_open_positions(strategy_id);
      const current_positions = open_positions.length;

      if (current_positions >= risk_config.max_positions) {
        return {
          passed: false,
          reason: 'Maximum number of positions reached',
          current_positions,
          max_positions: risk_config.max_positions
        };
      }

      // 3. 检查单仓最大占比
      const position_percent = (position_value / total_capital) * 100;
      const max_position_size = risk_config.max_position_size_percent;

      if (position_percent > max_position_size) {
        return {
          passed: false,
          reason: 'Position size exceeds maximum allowed',
          position_size: position_percent,
          max_position_size
        };
      }

      // 4. 检查总风险敞口
      const total_risk = await this.calculate_total_risk(strategy_id, total_capital);
      const new_total_risk = total_risk + position_percent;

      if (new_total_risk > risk_config.max_total_risk_percent) {
        return {
          passed: false,
          reason: 'Total risk exposure exceeds maximum allowed',
          total_risk: new_total_risk,
          max_total_risk: risk_config.max_total_risk_percent
        };
      }

      // 5. 检查当日亏损
      const daily_loss = await this.calculate_daily_loss(strategy_id, total_capital);

      if (daily_loss < -risk_config.max_daily_loss_percent) {
        return {
          passed: false,
          reason: 'Daily loss limit reached',
          daily_loss,
          max_daily_loss: risk_config.max_daily_loss_percent
        };
      }

      // 所有检查通过
      return {
        passed: true,
        current_positions,
        max_positions: risk_config.max_positions,
        position_size: position_percent,
        max_position_size,
        total_risk: new_total_risk,
        max_total_risk: risk_config.max_total_risk_percent,
        daily_loss,
        max_daily_loss: risk_config.max_daily_loss_percent
      };
    } catch (error) {
      logger.error('[RiskCalculator] Error checking position risk', error);
      return {
        passed: false,
        reason: `Risk check error: ${error instanceof Error ? error.message : 'Unknown'}`
      };
    }
  }

  /**
   * 计算总风险敞口
   */
  private async calculate_total_risk(strategy_id: number, total_capital: number): Promise<number> {
    const open_positions = await this.position_repository.find_open_positions(strategy_id);

    let total_position_value = 0;

    for (const position of open_positions) {
      const position_value = position.entry_price * position.quantity;
      total_position_value += position_value;
    }

    return (total_position_value / total_capital) * 100;
  }

  /**
   * 计算当日亏损百分比
   */
  private async calculate_daily_loss(strategy_id: number, total_capital: number): Promise<number> {
    const today_start = new Date();
    today_start.setHours(0, 0, 0, 0);

    const today_trades = await this.trade_repository.find_by_strategy(strategy_id, 1000);

    // 筛选今天的交易
    const today_trades_filtered = today_trades.filter(trade => {
      const trade_date = new Date(trade.exit_time);
      return trade_date >= today_start;
    });

    // 计算今日盈亏
    const daily_pnl = today_trades_filtered.reduce((sum, trade) => sum + trade.pnl, 0);

    return (daily_pnl / total_capital) * 100;
  }

  /**
   * 获取风险敞口详情
   */
  async get_risk_exposure(strategy_id: number, total_capital: number): Promise<RiskExposure> {
    try {
      const open_positions = await this.position_repository.find_open_positions(strategy_id);

      let total_position_value = 0;
      let total_risk_amount = 0;
      let total_unrealized_pnl = 0;

      // 按币种分组
      const symbol_map = new Map<string, {
        count: number;
        value: number;
        risk: number;
        pnl: number;
      }>();

      for (const position of open_positions) {
        const position_value = position.entry_price * position.quantity;
        const risk_amount = position.stop_loss
          ? Math.abs(position.entry_price - position.stop_loss) * position.quantity
          : position_value * 0.02; // 默认2%风险

        total_position_value += position_value;
        total_risk_amount += risk_amount;
        total_unrealized_pnl += position.unrealized_pnl || 0;

        if (!symbol_map.has(position.symbol)) {
          symbol_map.set(position.symbol, { count: 0, value: 0, risk: 0, pnl: 0 });
        }

        const symbol_data = symbol_map.get(position.symbol)!;
        symbol_data.count += 1;
        symbol_data.value += position_value;
        symbol_data.risk += risk_amount;
        symbol_data.pnl += position.unrealized_pnl || 0;
      }

      // 转换为数组
      const positions_by_symbol: SymbolExposure[] = [];
      for (const [symbol, data] of symbol_map.entries()) {
        positions_by_symbol.push({
          symbol,
          position_count: data.count,
          total_value: data.value,
          risk_amount: data.risk,
          unrealized_pnl: data.pnl
        });
      }

      // 计算当日盈亏
      const daily_pnl_percent = await this.calculate_daily_loss(strategy_id, total_capital);

      const available_capital = total_capital - total_position_value;
      const risk_percent = (total_position_value / total_capital) * 100;

      return {
        strategy_id,
        total_positions: open_positions.length,
        total_position_value,
        total_risk_amount,
        risk_percent,
        available_capital,
        daily_pnl: (daily_pnl_percent * total_capital) / 100,
        daily_loss_percent: daily_pnl_percent,
        positions_by_symbol
      };
    } catch (error) {
      logger.error('[RiskCalculator] Error calculating risk exposure', error);
      throw error;
    }
  }

  /**
   * 验证风控配置合理性
   */
  static validate_risk_config(config: Partial<RiskConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.max_positions !== undefined && config.max_positions < 1) {
      errors.push('max_positions must be at least 1');
    }

    if (config.max_position_size_percent !== undefined) {
      if (config.max_position_size_percent <= 0 || config.max_position_size_percent > 100) {
        errors.push('max_position_size_percent must be between 0 and 100');
      }
    }

    if (config.max_total_risk_percent !== undefined) {
      if (config.max_total_risk_percent <= 0 || config.max_total_risk_percent > 100) {
        errors.push('max_total_risk_percent must be between 0 and 100');
      }
    }

    if (config.stop_loss_percent !== undefined) {
      if (config.stop_loss_percent <= 0 || config.stop_loss_percent > 50) {
        errors.push('stop_loss_percent must be between 0 and 50');
      }
    }

    if (config.take_profit_percent !== undefined) {
      if (config.take_profit_percent <= 0 || config.take_profit_percent > 100) {
        errors.push('take_profit_percent must be between 0 and 100');
      }
    }

    if (config.max_daily_loss_percent !== undefined) {
      if (config.max_daily_loss_percent <= 0 || config.max_daily_loss_percent > 50) {
        errors.push('max_daily_loss_percent must be between 0 and 50');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
