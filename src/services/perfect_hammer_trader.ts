/**
 * 完美倒锤头交易服务
 *
 * 策略参数:
 * - 盈亏比: 1:1.4
 * - 固定风险: 2 USDT/笔
 * - 最大杠杆: 20x
 * - 止损: 信号K线最低价
 *
 * 使用方式:
 * 在 run_volume_monitor.ts 中，信号生成时直接调用 handle_signal()
 */

import { BinanceFuturesTradingAPI, OrderSide, PositionSide } from '@/api/binance_futures_trading_api';
import { OIRepository } from '@/database/oi_repository';
import { Kline5mData } from '@/database/kline_5m_repository';
import { PerfectHammerResult } from '@/services/volume_monitor_service';
import { logger } from '@/utils/logger';

// ==================== 配置 ====================
export interface PerfectHammerTraderConfig {
  // 资金管理
  initial_capital: number;        // 初始本金 (USDT)
  fixed_risk_amount: number;      // 固定每笔风险金额 (USDT)
  reward_ratio: number;           // 盈亏比
  max_leverage: number;           // 最大杠杆倍数

  // 信号过滤
  max_concurrent_signals: number; // 同一批次最多允许的信号数量
  min_stop_pct: number;           // 最小止损距离
  max_stop_pct: number;           // 最大止损距离

  // 持仓限制
  max_positions: number;          // 最大同时持仓数
}

const DEFAULT_CONFIG: PerfectHammerTraderConfig = {
  initial_capital: 20,
  fixed_risk_amount: 2,
  reward_ratio: 1.4,
  max_leverage: 20,
  max_concurrent_signals: 5,
  min_stop_pct: 0.002,    // 0.2%
  max_stop_pct: 0.05,     // 5%
  max_positions: 3,
};

// ==================== 类型定义 ====================
interface ActivePosition {
  symbol: string;
  entry_price: number;
  quantity: number;
  stop_loss: number;           // 初始止损价（信号K线最低价）
  take_profit_target: number;  // 原始止盈目标价（用于判断是否激活跟踪止盈）
  current_stop: number;        // 当前止损价（可能被移动到止盈位）
  stop_order_id: number | null;
  entry_time: number;
  // 跟踪止盈相关
  trailing_active: boolean;    // 是否激活跟踪止盈
  prev_kline_low: number;      // 上一根K线最低价（激活跟踪后使用）
  price_precision: number;     // 价格精度（用于后续格式化）
}

interface SignalWithKline {
  signal: PerfectHammerResult;
  kline: Kline5mData;
}

// ==================== 交易服务类 ====================
export class PerfectHammerTrader {
  private config: PerfectHammerTraderConfig;
  private trading_api: BinanceFuturesTradingAPI | null = null;
  private oi_repository: OIRepository | null = null;
  private enabled: boolean = false;

  // 当前持仓
  private active_positions = new Map<string, ActivePosition>();

  // 精度缓存
  private precision_cache = new Map<string, {
    price_precision: number;
    quantity_precision: number;
    step_size: number;
  }>();

  // 统计
  private stats = {
    signals_received: 0,
    signals_skipped_batch: 0,
    signals_skipped_leverage: 0,
    signals_skipped_stop: 0,
    signals_skipped_position: 0,
    trades_opened: 0,
  };

  constructor(config: Partial<PerfectHammerTraderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化交易服务
   */
  async init(): Promise<boolean> {
    const api_key = process.env.BINANCE_TRADE_API_KEY;
    const api_secret = process.env.BINANCE_TRADE_SECRET;

    if (!api_key || !api_secret) {
      logger.warn('[PerfectHammerTrader] Trading API keys not set, trading disabled');
      this.enabled = false;
      return false;
    }

    try {
      this.trading_api = new BinanceFuturesTradingAPI(api_key, api_secret, false);
      this.oi_repository = new OIRepository();
      this.enabled = true;

      logger.info('[PerfectHammerTrader] Initialized successfully');
      logger.info(`[PerfectHammerTrader] Config: ratio=${this.config.reward_ratio}, risk=${this.config.fixed_risk_amount}U, max_lev=${this.config.max_leverage}x`);

      // 检查并清理现有持仓的挂单（服务重启场景）
      await this.cleanup_existing_positions();

      // 启动持仓同步
      this.start_position_sync();

      return true;
    } catch (error) {
      logger.error('[PerfectHammerTrader] Init failed:', error);
      this.enabled = false;
      return false;
    }
  }

  /**
   * 清理现有持仓的挂单（服务重启场景）
   * 如果发现账户有持仓但本地没有记录，说明是之前的遗留仓位
   * 为安全起见，取消这些币种的所有挂单，让用户手动处理
   */
  private async cleanup_existing_positions(): Promise<void> {
    if (!this.trading_api) return;

    try {
      const positions = await this.trading_api.get_position_info();
      const open_positions = positions.filter(p => parseFloat(String(p.positionAmt)) !== 0);

      if (open_positions.length === 0) {
        logger.info('[PerfectHammerTrader] No existing positions found');
        return;
      }

      console.log(`\n⚠️ [PerfectHammer] 检测到 ${open_positions.length} 个现有持仓（服务重启）`);

      for (const pos of open_positions) {
        const symbol = pos.symbol;
        const amt = parseFloat(String(pos.positionAmt));

        console.log(`   ${symbol}: ${amt > 0 ? '多' : '空'}仓 ${Math.abs(amt)}`);

        // 取消该币种所有挂单，防止遗留挂单
        try {
          await this.trading_api.cancel_all_algo_orders(symbol);
          console.log(`   ✅ 已取消 ${symbol} 所有挂单`);
          logger.info(`[PerfectHammerTrader] ${symbol}: Cancelled existing algo orders on startup`);
        } catch (error: any) {
          console.log(`   ⚠️ ${symbol} 取消挂单失败: ${error.message}`);
        }
      }

      console.log(`\n⚠️ 请手动处理这些遗留持仓，本服务不会自动管理它们\n`);

    } catch (error: any) {
      logger.warn(`[PerfectHammerTrader] Failed to check existing positions: ${error.message}`);
    }
  }

  /**
   * 检查是否启用
   */
  is_enabled(): boolean {
    return this.enabled;
  }

  /**
   * 处理一批信号 (同一根K线完结时产生的所有信号)
   * @param signals 信号和对应K线数据的数组
   */
  async handle_batch_signals(signals: SignalWithKline[]): Promise<void> {
    if (!this.enabled || signals.length === 0) return;

    this.stats.signals_received += signals.length;

    // 检查批量信号数量
    if (signals.length > this.config.max_concurrent_signals) {
      logger.warn(`[PerfectHammerTrader] Batch signal detected: ${signals.length} signals, skipping all`);
      this.stats.signals_skipped_batch += signals.length;
      console.log(`\n⚠️ 批量信号过多 (${signals.length}个)，跳过本批次所有信号\n`);
      return;
    }

    // 逐个处理信号
    for (const { signal, kline } of signals) {
      await this.handle_single_signal(signal, kline);
    }
  }

  /**
   * 处理单个信号
   */
  private async handle_single_signal(signal: PerfectHammerResult, kline: Kline5mData): Promise<boolean> {
    if (!this.trading_api) return false;

    const symbol = signal.symbol;

    // 检查是否已有该币种的持仓
    if (this.active_positions.has(symbol)) {
      logger.debug(`[PerfectHammerTrader] ${symbol}: Already has position, skipping`);
      this.stats.signals_skipped_position++;
      return false;
    }

    // 检查持仓数量限制
    if (this.active_positions.size >= this.config.max_positions) {
      logger.info(`[PerfectHammerTrader] ${symbol}: Max positions reached (${this.active_positions.size}/${this.config.max_positions}), skipping`);
      this.stats.signals_skipped_position++;
      return false;
    }

    // 计算止损价和止损距离
    const entry_price = signal.current_price;
    const stop_loss = kline.low;
    const stop_pct = (entry_price - stop_loss) / entry_price;

    // 检查止损距离
    if (stop_pct < this.config.min_stop_pct) {
      logger.info(`[PerfectHammerTrader] ${symbol}: Stop loss too small (${(stop_pct * 100).toFixed(3)}%), skipping`);
      this.stats.signals_skipped_stop++;
      return false;
    }

    if (stop_pct > this.config.max_stop_pct) {
      logger.info(`[PerfectHammerTrader] ${symbol}: Stop loss too large (${(stop_pct * 100).toFixed(3)}%), skipping`);
      this.stats.signals_skipped_stop++;
      return false;
    }

    // 计算仓位大小
    const risk_amount = this.config.fixed_risk_amount;
    const position_value = risk_amount / stop_pct;

    // 计算杠杆
    const leverage = position_value / this.config.initial_capital;

    if (leverage > this.config.max_leverage) {
      logger.info(`[PerfectHammerTrader] ${symbol}: Required leverage ${leverage.toFixed(1)}x > max ${this.config.max_leverage}x, skipping`);
      this.stats.signals_skipped_leverage++;
      return false;
    }

    // 计算止盈目标价（用于判断是否激活跟踪止盈，不实际下单）
    const take_profit_target = entry_price + (entry_price - stop_loss) * this.config.reward_ratio;

    // 获取精度
    const precision = await this.get_symbol_precision(symbol);
    if (!precision) {
      logger.error(`[PerfectHammerTrader] ${symbol}: Failed to get precision, skipping`);
      return false;
    }

    // 计算数量并格式化
    const raw_quantity = position_value / entry_price;
    const quantity = this.format_quantity(raw_quantity, precision.quantity_precision, precision.step_size);
    const formatted_stop = this.format_price(stop_loss, precision.price_precision);
    const formatted_tp_target = this.format_price(take_profit_target, precision.price_precision);

    // 设置杠杆
    const leverage_to_set = Math.ceil(leverage);
    try {
      await this.trading_api.set_leverage(symbol, leverage_to_set);
    } catch (error: any) {
      logger.warn(`[PerfectHammerTrader] ${symbol}: Failed to set leverage: ${error.message}`);
    }

    // 开仓
    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📈 [PerfectHammer] 开仓: ${symbol} (跟踪止盈策略)`);
      console.log(`   入场: $${entry_price.toFixed(precision.price_precision)}`);
      console.log(`   止损: $${formatted_stop} (-${(stop_pct * 100).toFixed(2)}%)`);
      console.log(`   止盈目标: $${formatted_tp_target} (+${(stop_pct * 100 * this.config.reward_ratio).toFixed(2)}%) [跟踪触发点]`);
      console.log(`   数量: ${quantity}`);
      console.log(`   杠杆: ${leverage_to_set}x`);
      console.log(`   策略: 突破止盈目标后激活跟踪，跌破上一根K线最低价时平仓`);
      console.log(`${'='.repeat(60)}\n`);

      // 市价开仓
      const order_result = await this.trading_api.place_market_order(
        symbol,
        OrderSide.BUY,
        quantity,
        PositionSide.BOTH
      );

      logger.info(`[PerfectHammerTrader] ${symbol}: Market order placed, orderId=${order_result.orderId}`);

      // 下止损单（只下止损，不下止盈）
      let stop_order_id: number | null = null;
      try {
        const sl_result = await this.trading_api.place_stop_loss_order(
          symbol,
          OrderSide.SELL,
          quantity,
          formatted_stop,
          PositionSide.BOTH
        );
        stop_order_id = sl_result.algoId;
        logger.info(`[PerfectHammerTrader] ${symbol}: Stop loss @ ${formatted_stop}, algoId=${stop_order_id}`);
      } catch (error: any) {
        logger.error(`[PerfectHammerTrader] ${symbol}: Failed to place stop loss: ${error.message}`);
      }

      // 注意：不下止盈单！跟踪止盈由 on_kline_update 处理

      // 记录持仓
      this.active_positions.set(symbol, {
        symbol,
        entry_price,
        quantity,
        stop_loss: formatted_stop,
        take_profit_target: formatted_tp_target,
        current_stop: formatted_stop,
        stop_order_id,
        entry_time: Date.now(),
        // 跟踪止盈初始化
        trailing_active: false,
        prev_kline_low: 0,
        price_precision: precision.price_precision,
      });

      this.stats.trades_opened++;
      return true;

    } catch (error: any) {
      logger.error(`[PerfectHammerTrader] ${symbol}: Failed to open position: ${error.message}`);
      console.log(`\n❌ 开仓失败: ${symbol} - ${error.message}\n`);
      return false;
    }
  }

  /**
   * 处理 K 线更新（跟踪止盈核心逻辑）
   * 实时调用（未完结K线也会调用），实现"一旦突破就激活"
   * @param symbol 币种
   * @param kline K 线数据
   * @param is_final 是否为完结K线
   */
  async on_kline_update(symbol: string, kline: Kline5mData, is_final: boolean = true): Promise<void> {
    if (!this.enabled || !this.trading_api) return;

    const position = this.active_positions.get(symbol);
    if (!position) return;

    // 阶段1: 未激活跟踪止盈，检查是否突破止盈目标
    // 使用当前价格（close）实时检查，一旦突破就激活
    if (!position.trailing_active) {
      // 实时检查：当前价格 >= 止盈目标就激活（不用等K线完结）
      if (kline.close >= position.take_profit_target) {
        // 激活跟踪止盈！
        position.trailing_active = true;
        position.prev_kline_low = kline.low;

        const final_str = is_final ? '完结' : '实时';
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 [PerfectHammer] ${symbol} 跟踪止盈已激活! (${final_str})`);
        console.log(`   突破止盈目标: $${position.take_profit_target}`);
        console.log(`   当前价格: $${kline.close.toFixed(position.price_precision)}`);
        console.log(`   止损已移动至: $${position.take_profit_target} (原止盈位)`);
        console.log(`   跟踪基准(当前K线最低): $${kline.low.toFixed(position.price_precision)}`);
        console.log(`${'='.repeat(60)}\n`);

        // 取消旧止损单，下新止损单（在止盈目标位）
        await this.update_stop_loss(position, position.take_profit_target);

        logger.info(`[PerfectHammerTrader] ${symbol}: Trailing activated (${final_str}), stop moved to ${position.take_profit_target}`);
      }
    }
    // 阶段2: 已激活跟踪止盈
    else {
      // 只在K线完结时检查是否跌破上一根K线最低价，并更新跟踪基准
      // 未完结K线不做处理，避免频繁触发
      if (!is_final) {
        return;
      }

      // 检查是否跌破上一根K线最低价
      if (kline.low < position.prev_kline_low) {
        // 触发跟踪止盈！市价平仓
        console.log(`\n${'='.repeat(60)}`);
        console.log(`💰 [PerfectHammer] ${symbol} 跟踪止盈触发!`);
        console.log(`   入场价: $${position.entry_price.toFixed(position.price_precision)}`);
        console.log(`   平仓触发: K线最低 $${kline.low.toFixed(position.price_precision)} < 上一K线最低 $${position.prev_kline_low.toFixed(position.price_precision)}`);
        console.log(`   预计盈利: +${((position.prev_kline_low - position.entry_price) / position.entry_price * 100).toFixed(2)}%`);
        console.log(`${'='.repeat(60)}\n`);

        // 市价平仓
        await this.close_position_market(position);
        return;
      }

      // 更新跟踪基准（上一根K线最低价）
      position.prev_kline_low = kline.low;
      logger.debug(`[PerfectHammerTrader] ${symbol}: Trailing updated, prev_low=${kline.low}`);
    }
  }

  /**
   * 更新止损单
   */
  private async update_stop_loss(position: ActivePosition, new_stop_price: number): Promise<void> {
    if (!this.trading_api) return;

    const formatted_stop = this.format_price(new_stop_price, position.price_precision);

    // 取消旧止损单
    if (position.stop_order_id) {
      try {
        await this.trading_api.cancel_algo_order(position.stop_order_id);
        logger.info(`[PerfectHammerTrader] ${position.symbol}: Old stop order cancelled`);
      } catch (error: any) {
        logger.warn(`[PerfectHammerTrader] ${position.symbol}: Failed to cancel old stop: ${error.message}`);
      }
    }

    // 下新止损单
    try {
      const sl_result = await this.trading_api.place_stop_loss_order(
        position.symbol,
        OrderSide.SELL,
        position.quantity,
        formatted_stop,
        PositionSide.BOTH
      );
      position.stop_order_id = sl_result.algoId;
      position.current_stop = formatted_stop;
      logger.info(`[PerfectHammerTrader] ${position.symbol}: New stop @ ${formatted_stop}, algoId=${sl_result.algoId}`);
    } catch (error: any) {
      logger.error(`[PerfectHammerTrader] ${position.symbol}: Failed to place new stop: ${error.message}`);
    }
  }

  /**
   * 市价平仓
   */
  private async close_position_market(position: ActivePosition): Promise<void> {
    if (!this.trading_api) return;

    // 先取消该币种的所有 algo 订单（更安全，避免遗漏）
    try {
      await this.trading_api.cancel_all_algo_orders(position.symbol);
      logger.info(`[PerfectHammerTrader] ${position.symbol}: All algo orders cancelled before close`);
    } catch (error: any) {
      logger.warn(`[PerfectHammerTrader] ${position.symbol}: Failed to cancel algo orders: ${error.message}`);
    }

    // 市价平仓
    try {
      await this.trading_api.place_market_order(
        position.symbol,
        OrderSide.SELL,
        position.quantity,
        PositionSide.BOTH
      );
      logger.info(`[PerfectHammerTrader] ${position.symbol}: Position closed by trailing stop`);
      console.log(`\n✅ [PerfectHammer] ${position.symbol} 已市价平仓\n`);
    } catch (error: any) {
      logger.error(`[PerfectHammerTrader] ${position.symbol}: Failed to close position: ${error.message}`);
      console.log(`\n❌ [PerfectHammer] ${position.symbol} 平仓失败: ${error.message}\n`);
    }

    // 移除持仓记录
    this.active_positions.delete(position.symbol);
  }

  /**
   * 启动持仓同步 (定期检查持仓是否已平仓)
   * 当检测到仓位消失时，取消该币种所有挂单，防止遗留挂单导致反向开仓
   */
  private start_position_sync(): void {
    setInterval(async () => {
      if (!this.trading_api || this.active_positions.size === 0) return;

      try {
        const positions = await this.trading_api.get_position_info();
        // 过滤有持仓的（positionAmt != 0）
        const open_symbols = new Set(
          positions
            .filter(p => parseFloat(String(p.positionAmt)) !== 0)
            .map(p => p.symbol)
        );

        // 检查是否有持仓被平仓（止损触发或其他原因）
        for (const [symbol, pos] of this.active_positions) {
          if (!open_symbols.has(symbol)) {
            logger.info(`[PerfectHammerTrader] Position closed externally: ${symbol}`);
            console.log(`\n📊 [PerfectHammer] 持仓已平仓: ${symbol}`);
            console.log(`   入场: $${pos.entry_price.toFixed(pos.price_precision)}`);
            console.log(`   止损位: $${pos.current_stop}`);
            console.log(`   跟踪激活: ${pos.trailing_active ? '是' : '否'}`);

            // ⚠️ 关键：取消该币种所有挂单，防止遗留挂单导致反向开仓
            try {
              await this.trading_api.cancel_all_algo_orders(symbol);
              console.log(`   ✅ 已取消 ${symbol} 所有挂单\n`);
              logger.info(`[PerfectHammerTrader] ${symbol}: Cancelled all algo orders after position closed`);
            } catch (error: any) {
              console.log(`   ⚠️ 取消挂单失败: ${error.message}\n`);
              logger.warn(`[PerfectHammerTrader] ${symbol}: Failed to cancel algo orders: ${error.message}`);
            }

            this.active_positions.delete(symbol);
          }
        }
      } catch (error) {
        // 静默处理
      }
    }, 10000);  // 每10秒检查
  }

  /**
   * 获取币种精度信息
   */
  private async get_symbol_precision(symbol: string): Promise<{
    price_precision: number;
    quantity_precision: number;
    step_size: number;
  } | null> {
    if (this.precision_cache.has(symbol)) {
      return this.precision_cache.get(symbol)!;
    }

    try {
      if (!this.oi_repository) {
        this.oi_repository = new OIRepository();
      }

      const precision = await this.oi_repository.get_symbol_precision(symbol);
      if (precision) {
        const result = {
          price_precision: precision.price_precision,
          quantity_precision: precision.quantity_precision,
          step_size: precision.step_size
        };
        this.precision_cache.set(symbol, result);
        return result;
      }
      return null;
    } catch (error) {
      logger.error(`[PerfectHammerTrader] Failed to get precision for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * 格式化价格
   */
  private format_price(price: number, precision: number): number {
    return parseFloat(price.toFixed(precision));
  }

  /**
   * 格式化数量
   */
  private format_quantity(quantity: number, precision: number, step_size: number): number {
    const step_multiplier = Math.round(quantity / step_size);
    const formatted = step_multiplier * step_size;
    return parseFloat(formatted.toFixed(precision));
  }

  /**
   * 获取统计信息
   */
  get_stats(): typeof this.stats & { active_positions: number } {
    return {
      ...this.stats,
      active_positions: this.active_positions.size,
    };
  }

  /**
   * 获取当前持仓
   */
  get_positions(): Map<string, ActivePosition> {
    return this.active_positions;
  }

  /**
   * 获取配置
   */
  get_config(): PerfectHammerTraderConfig {
    return { ...this.config };
  }

  /**
   * 停止服务
   */
  stop(): void {
    this.enabled = false;
    logger.info('[PerfectHammerTrader] Stopped');
  }
}
