/**
 * 追踪止损策略交易脚本
 *
 * 策略说明:
 * - 只做多，不做空
 * - 开仓时设置1%固定止损
 * - 价格上涨1%后：设置成本止损（保本）
 * - 价格上涨2%后：止损上移到2%盈利处 + 启用追踪止盈（回调3%触发）
 *
 * 止损/止盈逻辑:
 * 1. 开仓后立即下止损单: 入场价 * (1 - 1%) = 入场价 * 0.99
 * 2. 价格上涨1%时: 撤销止损单，重新下止损单: 入场价 * (1 + 0.15%) = 成本价（覆盖手续费）
 * 3. 价格上涨2%时: 撤销止损单，下追踪止损单: 激活价=入场价*1.02，回调3%触发平仓
 *
 * 注意:
 * - 单向持仓模式 (positionSide=BOTH)
 * - 使用 Algo Order API (STOP_MARKET / TRAILING_STOP_MARKET)
 * - 防止重复挂单、遗漏撤单
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/run_trailing_stop_strategy.ts
 */

// 加载环境变量
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { TradingMode, StrategyType, StrategyConfig, RiskConfig, PositionSide } from '../src/types/trading_types';
import { OIPollingService } from '../src/services/oi_polling_service';
import { ConfigManager } from '../src/core/config/config_manager';
import { OICacheManager } from '../src/core/cache/oi_cache_manager';
import { BinanceFuturesTradingAPI, OrderSide, PositionSide as BinancePositionSide } from '../src/api/binance_futures_trading_api';
import { OIRepository } from '../src/database/oi_repository';
import { logger } from '../src/utils/logger';

// ==================== 策略配置 ====================
const STRATEGY_CONFIG = {
  // 止损配置
  initial_stop_loss_pct: 1,      // 开仓时止损: -1%
  breakeven_trigger_pct: 1,      // 触发成本止损的盈利阈值: +1%
  trailing_trigger_pct: 2,       // 触发追踪止盈的盈利阈值: +2%
  trailing_callback_pct: 3,      // 追踪止盈回调比例: 3%

  // 资金配置
  initial_balance: 50,           // 初始资金
  position_size_pct: 12,         // 单笔仓位占比: 12%
  max_positions: 5,              // 最大持仓数
  leverage: 6,                   // 杠杆倍数

  // 信号配置
  min_signal_score: 8,           // 最低信号评分
  chase_high_threshold: 7,       // 追高阈值: 7%
  max_holding_minutes: 120,      // 最大持仓时间: 120分钟
};

// ==================== 持仓状态追踪 ====================
interface PositionStopLossState {
  symbol: string;
  entry_price: number;
  quantity: number;
  current_stop_price: number;
  stop_level: 'INITIAL' | 'BREAKEVEN' | 'TRAILING';
  algo_id: number | null;              // 止损单的 algoId
  trailing_algo_id: number | null;     // 追踪止盈单的 algoId（与止损单共存）
  last_update: number;
}

// 全局持仓止损状态 Map
const position_sl_states = new Map<string, PositionStopLossState>();

// ==================== 交易 API 和 Repository ====================
let trading_api: BinanceFuturesTradingAPI | null = null;
let oi_repository: OIRepository | null = null;

// 精度缓存
const precision_cache = new Map<string, { price_precision: number; quantity_precision: number; step_size: number }>();

/**
 * 初始化交易 API
 */
function init_trading_api(): BinanceFuturesTradingAPI {
  const api_key = process.env.BINANCE_TRADE_API_KEY;
  const api_secret = process.env.BINANCE_TRADE_SECRET;

  if (!api_key || !api_secret) {
    throw new Error('BINANCE_TRADE_API_KEY or BINANCE_TRADE_SECRET not set');
  }

  return new BinanceFuturesTradingAPI(api_key, api_secret, false);
}

/**
 * 获取币种精度信息（从数据库，带缓存）
 */
async function get_symbol_precision(symbol: string): Promise<{ price_precision: number; quantity_precision: number; step_size: number } | null> {
  // 检查缓存
  if (precision_cache.has(symbol)) {
    return precision_cache.get(symbol)!;
  }

  try {
    if (!oi_repository) {
      oi_repository = new OIRepository();
    }

    const precision = await oi_repository.get_symbol_precision(symbol);
    if (precision) {
      const result = {
        price_precision: precision.price_precision,
        quantity_precision: precision.quantity_precision,
        step_size: precision.step_size
      };
      precision_cache.set(symbol, result);
      return result;
    }
    return null;
  } catch (error) {
    logger.error(`[Strategy] Failed to get precision for ${symbol}:`, error);
    return null;
  }
}

/**
 * 格式化价格
 */
function format_price(price: number, precision: number): number {
  return parseFloat(price.toFixed(precision));
}

/**
 * 格式化数量
 */
function format_quantity(quantity: number, precision: number, step_size: number): number {
  const step_multiplier = Math.round(quantity / step_size);
  const formatted = step_multiplier * step_size;
  return parseFloat(formatted.toFixed(precision));
}

/**
 * 初始化持仓状态（不下止损单，只记录状态用于后续升级）
 */
function init_position_state(
  symbol: string,
  entry_price: number,
  quantity: number
): void {
  // 只记录状态，不下止损单
  position_sl_states.set(symbol, {
    symbol,
    entry_price,
    quantity,
    current_stop_price: 0,
    stop_level: 'INITIAL',
    algo_id: null,
    trailing_algo_id: null,
    last_update: Date.now()
  });

  logger.info(`[Strategy] Position state initialized: ${symbol} @ ${entry_price}, qty=${quantity}`);
  console.log(`\n📝 持仓状态已记录: ${symbol} @ ${entry_price}（无初始止损，等待盈利后设置成本止损）\n`);
}

/**
 * 设置成本止损（保本）
 * 盈利 >= 1% 时触发，直接下成本止损单（无需撤销，因为初始状态没有止损单）
 */
async function upgrade_to_breakeven_stop(symbol: string): Promise<boolean> {
  if (!trading_api) return false;

  const state = position_sl_states.get(symbol);
  if (!state) {
    logger.warn(`[Strategy] No position state for ${symbol}, cannot set breakeven stop`);
    return false;
  }

  // 如果已经有成本止损单，不需要再下
  if (state.algo_id !== null) {
    logger.debug(`[Strategy] ${symbol} already has breakeven stop (algoId=${state.algo_id}), skipping`);
    return true;
  }

  try {
    // 1. 计算成本止损价: 入场价 * (1 + 0.15%) 覆盖手续费
    const precision = await get_symbol_precision(symbol);
    let breakeven_price = state.entry_price * (1 + 0.0015);
    let formatted_qty = state.quantity;

    if (precision) {
      breakeven_price = format_price(breakeven_price, precision.price_precision);
      formatted_qty = format_quantity(state.quantity, precision.quantity_precision, precision.step_size);
    }

    // 2. 下成本止损单
    const result = await trading_api.place_stop_loss_order(
      symbol,
      OrderSide.SELL,
      formatted_qty,
      breakeven_price,
      BinancePositionSide.BOTH
    );

    // 3. 更新状态
    state.current_stop_price = breakeven_price;
    state.stop_level = 'BREAKEVEN';
    state.algo_id = result.algoId;
    state.last_update = Date.now();

    logger.info(`[Strategy] Breakeven stop placed: ${symbol} @ ${breakeven_price} (entry+0.15%), algoId=${result.algoId}`);
    console.log(`\n🛡️ 成本止损已设置: ${symbol} @ ${breakeven_price} (入场价${state.entry_price}+0.15%手续费)\n`);

    return true;

  } catch (error: any) {
    logger.error(`[Strategy] Failed to place breakeven stop for ${symbol}:`, error.message);
    return false;
  }
}

/**
 * 添加追踪止盈（价格上涨2%后）
 * 保留成本止损单，额外下追踪止盈单，两者共存
 * - 成本止损：保底不亏（触发价 = 入场价 + 0.15%）
 * - 追踪止盈：锁定更多利润（激活后回调3%平仓）
 */
async function upgrade_to_trailing_stop(symbol: string): Promise<boolean> {
  if (!trading_api) return false;

  const state = position_sl_states.get(symbol);
  if (!state) {
    logger.warn(`[Strategy] No position state for ${symbol}, cannot add trailing stop`);
    return false;
  }

  // 如果已经下过追踪止盈单，不需要再下
  if (state.trailing_algo_id !== null) {
    logger.debug(`[Strategy] ${symbol} already has trailing stop, skipping`);
    return true;
  }

  try {
    // 不撤销成本止损单，直接下追踪止盈单

    // 1. 计算追踪止盈的激活价格: 入场价 * (1 + 2%)
    const precision = await get_symbol_precision(symbol);
    let activation_price = state.entry_price * (1 + STRATEGY_CONFIG.trailing_trigger_pct / 100);
    let formatted_qty = state.quantity;

    if (precision) {
      activation_price = format_price(activation_price, precision.price_precision);
      formatted_qty = format_quantity(state.quantity, precision.quantity_precision, precision.step_size);
    }

    // 2. 下追踪止盈单（与成本止损单共存）
    const result = await trading_api.place_trailing_stop_order(
      symbol,
      OrderSide.SELL,  // 多头平仓用 SELL
      formatted_qty,
      STRATEGY_CONFIG.trailing_callback_pct,  // 回调 3%
      BinancePositionSide.BOTH,
      activation_price
    );

    // 3. 更新状态（保留原有 algo_id，新增 trailing_algo_id）
    state.stop_level = 'TRAILING';
    state.trailing_algo_id = result.algoId;
    state.last_update = Date.now();

    logger.info(`[Strategy] Added trailing stop (coexist with breakeven SL): ${symbol} activation=${activation_price} (+${STRATEGY_CONFIG.trailing_trigger_pct}%), callback=${STRATEGY_CONFIG.trailing_callback_pct}%, algoId=${result.algoId}`);
    console.log(`\n📈 追踪止盈已添加: ${symbol} 激活价=${activation_price} (+${STRATEGY_CONFIG.trailing_trigger_pct}%), 回调${STRATEGY_CONFIG.trailing_callback_pct}%止盈`);
    console.log(`   ⚠️ 成本止损仍有效 (algoId=${state.algo_id})，两者共存，先触发者平仓\n`);

    return true;

  } catch (error: any) {
    logger.error(`[Strategy] Failed to add trailing stop for ${symbol}:`, error.message);
    return false;
  }
}

/**
 * 检查并更新止损状态
 * 根据当前价格判断是否需要升级止损级别
 */
async function check_and_update_stop_loss(symbol: string, current_price: number): Promise<void> {
  const state = position_sl_states.get(symbol);
  if (!state) return;

  const entry_price = state.entry_price;
  const pnl_pct = ((current_price - entry_price) / entry_price) * 100;

  // 根据盈利百分比判断是否需要升级止损
  if (pnl_pct >= STRATEGY_CONFIG.trailing_trigger_pct && state.stop_level !== 'TRAILING') {
    // 盈利 >= 2%: 升级到追踪止盈
    logger.info(`[Strategy] ${symbol} reached +${pnl_pct.toFixed(2)}% (>=${STRATEGY_CONFIG.trailing_trigger_pct}%), upgrading to trailing stop`);
    await upgrade_to_trailing_stop(symbol);

  } else if (pnl_pct >= STRATEGY_CONFIG.breakeven_trigger_pct && state.stop_level === 'INITIAL') {
    // 盈利 >= 1%: 升级到成本止损
    logger.info(`[Strategy] ${symbol} reached +${pnl_pct.toFixed(2)}% (>=${STRATEGY_CONFIG.breakeven_trigger_pct}%), upgrading to breakeven stop`);
    await upgrade_to_breakeven_stop(symbol);
  }
}

/**
 * 清理已平仓的持仓状态
 */
function cleanup_closed_positions(open_symbols: Set<string>): void {
  const symbols_to_remove: string[] = [];

  position_sl_states.forEach((state, symbol) => {
    if (!open_symbols.has(symbol)) {
      symbols_to_remove.push(symbol);
    }
  });

  for (const symbol of symbols_to_remove) {
    logger.info(`[Strategy] Position closed, removing stop loss state for ${symbol}`);
    position_sl_states.delete(symbol);
  }
}

// ==================== 主函数 ====================
async function main() {
  console.log('🚀 启动追踪止损策略交易引擎...\n');
  console.log('═'.repeat(80));

  // 策略说明
  console.log('\n📋 追踪止损策略配置:');
  console.log(`   - 初始止损: -${STRATEGY_CONFIG.initial_stop_loss_pct}% (开仓后立即设置)`);
  console.log(`   - 成本止损: 盈利>=${STRATEGY_CONFIG.breakeven_trigger_pct}% 时触发 (保本+0.15%手续费)`);
  console.log(`   - 追踪止盈: 盈利>=${STRATEGY_CONFIG.trailing_trigger_pct}% 时触发 (回调${STRATEGY_CONFIG.trailing_callback_pct}%平仓)`);
  console.log(`   - 只做多，不做空`);
  console.log('\n⚠️  单向持仓模式 (positionSide=BOTH)\n');
  console.log('═'.repeat(80));

  const trading_mode = TradingMode.LIVE;

  console.log('\n🔴 警告: 即将使用真实资金交易!\n');

  try {
    // 初始化配置
    const config_manager = ConfigManager.getInstance();
    config_manager.initialize();

    // 初始化交易 API
    trading_api = init_trading_api();
    console.log('✅ 交易 API 已初始化');

    // 策略配置
    const strategy_config: StrategyConfig = {
      strategy_type: StrategyType.BREAKOUT,
      enabled: true,
      min_signal_score: STRATEGY_CONFIG.min_signal_score,
      min_confidence: 0.5,
      min_oi_change_percent: 3,
      require_price_oi_alignment: true,
      price_oi_divergence_threshold: 5,
      use_sentiment_filter: false,
      min_trader_ratio: 0.8,
      max_funding_rate: 0.01,
      min_funding_rate: -0.01
    };

    const risk_config: RiskConfig = {
      max_position_size_percent: STRATEGY_CONFIG.position_size_pct,
      max_total_positions: STRATEGY_CONFIG.max_positions,
      max_positions_per_symbol: 1,
      default_stop_loss_percent: 100,           // 禁用默认止损（由策略管理）
      default_take_profit_percent: 100,         // 禁用默认止盈（由策略管理）
      use_trailing_stop: false,                 // 禁用默认追踪止盈（由策略管理）
      trailing_stop_callback_rate: 3,
      take_profit_targets: [],                  // 不使用分批止盈
      daily_loss_limit_percent: 80,
      consecutive_loss_limit: 999,
      pause_after_loss_limit: false,
      max_leverage: STRATEGY_CONFIG.leverage,
      leverage_by_signal_strength: {
        weak: STRATEGY_CONFIG.leverage,
        medium: STRATEGY_CONFIG.leverage,
        strong: STRATEGY_CONFIG.leverage
      }
    };

    // 显示配置
    console.log('\n📋 资金配置:');
    console.log(`  初始资金: $${STRATEGY_CONFIG.initial_balance}`);
    console.log(`  单笔保证金: $${STRATEGY_CONFIG.initial_balance * STRATEGY_CONFIG.position_size_pct / 100}`);
    console.log(`  杠杆: ${STRATEGY_CONFIG.leverage}x`);
    console.log(`  最多持仓: ${STRATEGY_CONFIG.max_positions}个`);
    console.log('═'.repeat(80));

    // 创建 OI 监控服务
    const oi_service = new OIPollingService();

    // 初始化缓存管理器
    const cache_manager = new OICacheManager();
    oi_service.set_cache_manager(cache_manager);

    // 初始化情绪管理器
    oi_service.initialize_sentiment_manager(cache_manager);

    // 初始化交易系统
    oi_service.initialize_trading_system(true, {
      mode: trading_mode,
      initial_balance: STRATEGY_CONFIG.initial_balance,
      strategies: [strategy_config],
      active_strategy_type: StrategyType.BREAKOUT,
      risk_config: risk_config,
      allowed_directions: ['LONG'],  // 只做多
      max_holding_time_minutes: STRATEGY_CONFIG.max_holding_minutes,
      enable_notifications: true
    });

    const trading_system = oi_service.get_trading_system();
    if (!trading_system) {
      throw new Error('Failed to initialize trading system');
    }

    // 设置追高阈值
    trading_system.set_chase_high_threshold(STRATEGY_CONFIG.chase_high_threshold);

    console.log('\n✅ 交易引擎已启动');
    console.log(`✅ 追高阈值: ${STRATEGY_CONFIG.chase_high_threshold}%`);

    // 启动 OI 监控
    await oi_service.start();
    console.log('📡 OI 监控已启动');

    // 同步币安持仓
    console.log('🔄 正在同步币安持仓...');
    try {
      const sync_result = await trading_system.sync_positions_from_binance();
      if (sync_result.synced > 0) {
        console.log(`✅ 同步完成: 发现 ${sync_result.synced} 个持仓`);

        // 为已有持仓初始化状态（不下止损单）
        const positions = trading_system.get_open_positions();
        for (const pos of positions) {
          if (pos.side === PositionSide.LONG) {
            // 检查是否已有止损状态
            if (!position_sl_states.has(pos.symbol)) {
              console.log(`🔧 为已有持仓 ${pos.symbol} 初始化状态...`);
              init_position_state(pos.symbol, pos.entry_price, pos.quantity);
            }
          }
        }
      } else {
        console.log('✅ 同步完成: 无持仓');
      }
    } catch (err) {
      console.log('⚠️ 初始同步失败');
    }

    // 启动 markPrice 监控
    console.log('🔗 正在启动 markPrice 实时监控...');
    try {
      await trading_system.start_mark_price_monitor();
      console.log('✅ markPrice 监控已启动');
    } catch (err) {
      console.log('⚠️ markPrice 监控启动失败');
    }

    // ⭐ 监听新开仓事件 - 设置初始止损
    // 通过定时检查新持仓来实现
    let known_positions = new Set<string>();

    // 定时同步并检查止损状态（每10秒）
    setInterval(async () => {
      try {
        await trading_system.sync_positions_from_binance();

        const positions = trading_system.get_open_positions();
        const current_symbols = new Set<string>();

        for (const pos of positions) {
          current_symbols.add(pos.symbol);

          if (pos.side === PositionSide.LONG) {
            // 检查是否是新持仓
            if (!known_positions.has(pos.symbol) && !position_sl_states.has(pos.symbol)) {
              console.log(`\n🆕 检测到新持仓: ${pos.symbol} @ ${pos.entry_price}`);
              init_position_state(pos.symbol, pos.entry_price, pos.quantity);
              known_positions.add(pos.symbol);
            }

            // 检查并更新止损状态
            await check_and_update_stop_loss(pos.symbol, pos.current_price);
          }
        }

        // 清理已平仓的状态
        cleanup_closed_positions(current_symbols);
        known_positions = current_symbols;

      } catch (err) {
        // 静默处理
      }
    }, 10000);  // 每10秒检查一次

    // 状态显示
    const print_status = async () => {
      const oi_status = oi_service.get_status();
      const trade_status = trading_system.get_status();
      const open_positions = trading_system.get_open_positions();

      console.log('\n' + '='.repeat(80));
      console.log(`📊 实时状态 [${new Date().toLocaleString('zh-CN')}]`);
      console.log('='.repeat(80));

      console.log(`OI监控: ${oi_status.is_running ? '✅ 运行中' : '❌ 已停止'} | 监控币种: ${oi_status.active_symbols_count}个`);
      console.log(`交易模式: 💰 实盘 | 系统状态: ${trade_status.enabled ? '✅ 启用' : '❌ 禁用'}`);
      console.log('-'.repeat(80));

      console.log(`当前持仓: ${open_positions.length}/${STRATEGY_CONFIG.max_positions}个`);

      if (open_positions.length > 0) {
        for (const pos of open_positions) {
          const pnl_sign = pos.unrealized_pnl >= 0 ? '+' : '';
          const hold_time = Math.floor((Date.now() - pos.opened_at.getTime()) / 60000);
          const pnl_color = pos.unrealized_pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
          const reset = '\x1b[0m';
          const decimals = pos.entry_price < 0.01 ? 6 : pos.entry_price < 1 ? 5 : 4;

          // 止损状态
          const sl_state = position_sl_states.get(pos.symbol);
          let sl_info = '| 止损: 未设置';
          if (sl_state) {
            const has_sl = sl_state.algo_id !== null;
            const has_trailing = sl_state.trailing_algo_id !== null;
            if (has_sl && has_trailing) {
              sl_info = `| SL: ${sl_state.stop_level} + 追踪`;
            } else if (has_sl) {
              sl_info = `| SL: ${sl_state.stop_level} @ ${sl_state.current_stop_price.toFixed(decimals)}`;
            } else if (has_trailing) {
              sl_info = `| 追踪止盈`;
            }
          }

          console.log(`  └─ \x1b[36m${pos.symbol}\x1b[0m: @ $${pos.entry_price.toFixed(decimals)} → $${pos.current_price.toFixed(decimals)} | PnL: ${pnl_color}${pnl_sign}$${pos.unrealized_pnl.toFixed(2)} (${pnl_sign}${pos.unrealized_pnl_percent.toFixed(2)}%)${reset} | 持仓: ${hold_time}分钟 ${sl_info}`);
        }
      }

      console.log('-'.repeat(80));

      // 今日统计
      try {
        const today_stats = await trading_system.get_today_statistics_from_db();
        const win_rate = today_stats.total_trades > 0
          ? (today_stats.winning_trades / today_stats.total_trades * 100).toFixed(1)
          : '0.0';
        console.log(`📅 今日: ${today_stats.total_trades}笔 | 胜率: ${win_rate}% | 盈亏: ${today_stats.total_pnl >= 0 ? '+' : ''}$${today_stats.total_pnl.toFixed(2)}`);
      } catch (err) {
        // 静默
      }

      console.log('='.repeat(80) + '\n');
    };

    // 立即打印状态
    await print_status();
    console.log('⏳ 等待高质量交易信号...\n');

    // 每2分钟打印状态
    setInterval(print_status, 120000);

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 正在关闭交易引擎...');
      await oi_service.stop();
      console.log('✅ OI监控已停止');
      console.log('\n👋 交易引擎已关闭');
      process.exit(0);
    });

  } catch (error) {
    console.error('\n❌ 启动失败:', error);
    process.exit(1);
  }
}

main();
