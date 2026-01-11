/**
 * 完美倒锤头策略回测脚本
 *
 * 策略规则:
 * 1. 入场: 完美倒锤头信号触发后立即做多
 * 2. 止损: 倒锤头K线最低价
 * 3. 保本止损: 5根K线后，如果价格高于开盘价且低于止盈目标，止损移到开盘价
 * 4. 止盈: 固定金额 (默认70U)
 * 5. 止损金额: 固定金额 (默认50U)
 * 6. 仓位: 根据止损金额和止损距离自动计算
 *
 * 运行命令:
 * npx ts-node -r tsconfig-paths/register scripts/backtest_perfect_hammer.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';

// ==================== 配置 ====================
const CONFIG = {
  // 回测时间范围
  start_date: '2026-01-11',
  end_date: '2026-01-11',

  // ========== 资金管理参数 (固定金额模式) ==========
  initial_capital: 1000,    // 初始本金 (USDT) - 增大用于获取更多样本
  fixed_risk_amount: 2,     // 固定每笔风险金额 (USDT)
  reward_ratio: 1.4,        // 盈亏比 (止盈 = 止损 * 1.4)
  max_leverage: 20,         // 最大杠杆倍数
  min_leverage: 0,          // 最小杠杆倍数 (0=不过滤)
  use_compound: false,      // 是否使用复利模式 (false = 固定金额)

  // 信号过滤
  max_concurrent_signals: 0,  // 同一时间最多允许的信号数量，0=不过滤
  min_stop_pct: 0.005,        // 最小止损距离 0.5%
  max_stop_pct: 0.05,         // 最大止损距离 (5%)，太大跳过
  min_lower_shadow_pct: 85,   // 最小下影线比例 (%) ⭐ 新增

  // 手续费 (Binance U本位合约 Maker 0.02%, Taker 0.05%)
  fee_rate: 0.0005,  // 0.05% taker fee

  // 最大持仓时间 (根K线数，5分钟K线)
  max_hold_bars: 288,  // 24小时 = 288根5分钟K线

  // 滑点
  slippage: 0.0001,  // 0.01%
};

// ==================== 类型定义 ====================
interface PatternSignal {
  id: number;
  symbol: string;
  kline_time: number;
  current_price: number;
  lower_shadow_pct: number;
  upper_shadow_pct: number;
  price_change_pct: number;
  created_at: Date;
}

interface KlineData {
  symbol: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  signal_id: number;
  symbol: string;
  entry_time: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  position_size: number;  // 合约数量
  position_value: number; // 仓位价值 (USDT)

  exit_time?: number;
  exit_price?: number;
  exit_reason?: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIMEOUT' | 'MAX_BARS' | 'BREAKEVEN';
  pnl?: number;           // 盈亏 (USDT)
  pnl_pct?: number;       // 盈亏百分比
  fee?: number;           // 手续费
  net_pnl?: number;       // 净盈亏
  hold_bars?: number;     // 持仓K线数

  // 特征数据 (用于分析)
  lower_shadow_pct?: number;
  upper_shadow_pct?: number;
  stop_pct?: number;
  leverage?: number;
  hour_of_day?: number;
  batch_size?: number;
}

interface BacktestResult {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;

  total_pnl: number;
  total_fee: number;
  net_pnl: number;

  max_win: number;
  max_loss: number;
  avg_win: number;
  avg_loss: number;

  profit_factor: number;
  avg_hold_bars: number;

  trades: Trade[];
}

// ==================== 数据库查询 ====================
async function get_pattern_signals(start_date: string, end_date: string): Promise<PatternSignal[]> {
  const conn = await DatabaseConfig.get_mysql_connection();

  try {
    // 将日期转换为时间戳 (UTC+8 00:00:00)
    const start_ts = new Date(start_date + 'T00:00:00+08:00').getTime();
    const end_ts = new Date(end_date + 'T00:00:00+08:00').getTime() + 24 * 60 * 60 * 1000; // 结束日期+1天

    const sql = `
      SELECT
        id, symbol, kline_time, current_price,
        lower_shadow_pct, upper_shadow_pct, price_change_pct, created_at
      FROM pattern_alerts
      WHERE pattern_type = 'PERFECT_HAMMER'
        AND kline_time >= ?
        AND kline_time < ?
      ORDER BY kline_time ASC
    `;

    const [rows] = await conn.execute(sql, [start_ts, end_ts]);

    return (rows as any[]).map(row => ({
      id: row.id,
      symbol: row.symbol,
      kline_time: Number(row.kline_time),
      current_price: parseFloat(row.current_price),
      lower_shadow_pct: parseFloat(row.lower_shadow_pct),
      upper_shadow_pct: parseFloat(row.upper_shadow_pct),
      price_change_pct: parseFloat(row.price_change_pct),
      created_at: row.created_at
    }));
  } finally {
    conn.release();
  }
}

async function get_signal_kline(symbol: string, kline_time: number, date_str: string): Promise<KlineData | null> {
  const conn = await DatabaseConfig.get_mysql_connection();
  const table_name = `kline_5m_${date_str.replace(/-/g, '')}`;

  try {
    const sql = `
      SELECT symbol, open_time, open, high, low, close, volume
      FROM ${table_name}
      WHERE symbol = ? AND open_time = ?
      LIMIT 1
    `;

    const [rows] = await conn.execute(sql, [symbol, kline_time]);
    const data = rows as any[];

    if (data.length === 0) return null;

    return {
      symbol: data[0].symbol,
      open_time: Number(data[0].open_time),
      open: parseFloat(data[0].open),
      high: parseFloat(data[0].high),
      low: parseFloat(data[0].low),
      close: parseFloat(data[0].close),
      volume: parseFloat(data[0].volume)
    };
  } catch (error) {
    return null;
  } finally {
    conn.release();
  }
}

async function get_following_klines(
  symbol: string,
  start_time: number,
  max_bars: number,
  dates: string[]
): Promise<KlineData[]> {
  const conn = await DatabaseConfig.get_mysql_connection();
  const klines: KlineData[] = [];

  try {
    for (const date of dates) {
      const table_name = `kline_5m_${date.replace(/-/g, '')}`;

      try {
        const sql = `
          SELECT symbol, open_time, open, high, low, close, volume
          FROM ${table_name}
          WHERE symbol = ? AND open_time > ?
          ORDER BY open_time ASC
          LIMIT ?
        `;

        const [rows] = await conn.execute(sql, [symbol, start_time, max_bars - klines.length]);
        const data = rows as any[];

        for (const row of data) {
          klines.push({
            symbol: row.symbol,
            open_time: Number(row.open_time),
            open: parseFloat(row.open),
            high: parseFloat(row.high),
            low: parseFloat(row.low),
            close: parseFloat(row.close),
            volume: parseFloat(row.volume)
          });
        }

        if (klines.length >= max_bars) break;
      } catch (error) {
        // 表不存在，跳过
      }
    }

    return klines;
  } finally {
    conn.release();
  }
}

// ==================== 回测逻辑 ====================

/**
 * 计算当前可用风险金额
 * 固定金额模式: 使用固定风险金额
 * 复利模式: 使用当前资金的固定比例
 */
function calculate_risk_amount(current_capital: number): number {
  if (CONFIG.use_compound) {
    // 复利模式: 10% 当前资金
    return current_capital * 0.10;
  }
  // 固定金额模式
  return CONFIG.fixed_risk_amount;
}

/**
 * 计算仓位大小 (百分比风险模式)
 * @param entry_price 入场价
 * @param stop_loss 止损价
 * @param risk_amount 风险金额 (愿意亏损的金额)
 * @param current_capital 当前资金
 */
function calculate_position_size(
  entry_price: number,
  stop_loss: number,
  risk_amount: number,
  current_capital: number
): { position_size: number; position_value: number; leverage: number; stop_pct: number } | null {
  // 止损距离 (价格差)
  const stop_distance = entry_price - stop_loss;

  // 止损百分比
  const stop_pct = stop_distance / entry_price;

  // 检查止损距离是否在合理范围
  if (stop_pct < CONFIG.min_stop_pct) {
    return null; // 止损太小，杠杆会太高
  }
  if (stop_pct > CONFIG.max_stop_pct) {
    return null; // 止损太大，盈亏比不划算
  }

  // 仓位价值 = 风险金额 / 止损百分比
  // 例如: 风险2U, 止损1% => 仓位价值 = 2 / 0.01 = 200U
  const position_value = risk_amount / stop_pct;

  // 计算杠杆 = 仓位价值 / 资金基准
  // 固定金额模式：用初始资金（仓位大小固定，不受亏损影响）
  // 复利模式：用当前资金
  const leverage_base = CONFIG.use_compound ? current_capital : CONFIG.initial_capital;
  const leverage = position_value / leverage_base;

  // 检查杠杆是否超过限制
  if (leverage > CONFIG.max_leverage) {
    return null; // 杠杆过高，跳过
  }

  // 检查杠杆是否低于最小限制 (影线过长)
  if (leverage < CONFIG.min_leverage) {
    return null; // 杠杆过低，影线过长，跳过
  }

  // 合约数量
  const position_size = position_value / entry_price;

  return { position_size, position_value, leverage, stop_pct };
}

function simulate_trade(
  signal: PatternSignal,
  signal_kline: KlineData,
  following_klines: KlineData[],
  current_capital: number
): Trade | null {
  // 入场价格 = 信号K线收盘价 * (1 + 滑点)
  const entry_price = signal.current_price * (1 + CONFIG.slippage);

  // 止损价格 = 信号K线最低价
  const stop_loss = signal_kline.low;

  // 保本止损价 = 信号K线开盘价
  const breakeven_stop = signal_kline.open;

  // 计算风险金额 (当前资金的固定百分比)
  const risk_amount = calculate_risk_amount(current_capital);

  // 计算仓位
  const position_result = calculate_position_size(
    entry_price,
    stop_loss,
    risk_amount,
    current_capital
  );

  // 如果仓位计算失败 (止损不合理或杠杆过高)，返回null
  if (!position_result) {
    return null;
  }

  const { position_size, position_value, leverage, stop_pct } = position_result;

  // 止盈价格 = 入场价 * (1 + 止损百分比 * 盈亏比)
  // 例如: 止损1%, 盈亏比1.4 => 止盈1.4%
  const take_profit = entry_price * (1 + stop_pct * CONFIG.reward_ratio);

  // 计算北京时间的小时
  const beijing_date = new Date(signal.kline_time + 8 * 60 * 60 * 1000);
  const hour_of_day = beijing_date.getUTCHours();

  const trade: Trade = {
    signal_id: signal.id,
    symbol: signal.symbol,
    entry_time: signal.kline_time + 300000, // 下一根K线开始时入场
    entry_price,
    stop_loss,
    take_profit,
    position_size,
    position_value,
    // 特征数据
    lower_shadow_pct: signal.lower_shadow_pct,
    upper_shadow_pct: signal.upper_shadow_pct,
    stop_pct,
    leverage,
    hour_of_day
  };

  // 跟踪止盈相关
  let current_stop = stop_loss;  // 当前止损价
  let trailing_active = false;   // 是否激活跟踪止盈
  let breakeven_active = false;  // 是否激活保本止损
  let prev_kline_low = 0;        // 上一根K线最低价（用于跟踪止盈判断）

  // 模拟持仓
  for (let i = 0; i < following_klines.length && i < CONFIG.max_hold_bars; i++) {
    const kline = following_klines[i];

    // 阶段0: 检查保本止损条件（5根K线后）- 暂时禁用
    // 条件：持仓>=5根K线、价格高于开盘价、尚未触及止盈目标、未激活跟踪止盈
    // if (!breakeven_active && !trailing_active && i >= 5) {
    //   // 检查当前K线收盘价是否高于开盘价且低于止盈目标
    //   if (kline.close > breakeven_stop && kline.close < take_profit) {
    //     breakeven_active = true;
    //     current_stop = breakeven_stop;  // 止损移动到开盘价（保本）
    //   }
    // }

    // 阶段1: 未激活跟踪止盈，检查是否突破原止盈位
    if (!trailing_active) {
      // 检查止损
      if (kline.low <= current_stop) {
        trade.exit_time = kline.open_time;
        trade.exit_price = current_stop * (1 - CONFIG.slippage);
        trade.exit_reason = breakeven_active ? 'BREAKEVEN' : 'STOP_LOSS';
        trade.hold_bars = i + 1;
        break;
      }

      // 检查是否突破止盈位，激活跟踪止盈
      // 实时激活模式：只检查 high >= 止盈目标（模拟K线内部某一时刻突破）
      // 实盘中 WebSocket 会实时推送价格，一旦当前价格 >= 止盈就激活
      if (kline.high >= take_profit) {
        trailing_active = true;
        current_stop = take_profit;  // 止损移动到原止盈位
        prev_kline_low = kline.low;  // 记录当前K线最低价
        // 不退出，继续跟踪
      }
    }
    // 阶段2: 已激活跟踪止盈，跟踪K线最低价
    else {
      // 检查是否跌破上一根K线最低价
      if (kline.low < prev_kline_low) {
        trade.exit_time = kline.open_time;
        trade.exit_price = prev_kline_low * (1 - CONFIG.slippage);  // 在上一根K线最低价平仓
        trade.exit_reason = 'TAKE_PROFIT';  // 跟踪止盈触发
        trade.hold_bars = i + 1;
        break;
      }

      // 更新跟踪止损（上一根K线最低价）
      prev_kline_low = kline.low;
    }
  }

  // 如果没有触发止损止盈，按最后一根K线收盘价平仓
  if (!trade.exit_time && following_klines.length > 0) {
    const last_kline = following_klines[Math.min(following_klines.length - 1, CONFIG.max_hold_bars - 1)];
    trade.exit_time = last_kline.open_time;
    trade.exit_price = last_kline.close;
    trade.exit_reason = following_klines.length >= CONFIG.max_hold_bars ? 'MAX_BARS' : 'TIMEOUT';
    trade.hold_bars = Math.min(following_klines.length, CONFIG.max_hold_bars);
  }

  // 计算盈亏
  if (trade.exit_price) {
    const price_diff = trade.exit_price - trade.entry_price;
    trade.pnl = price_diff * trade.position_size;
    trade.pnl_pct = (price_diff / trade.entry_price) * 100;

    // 手续费 (开仓 + 平仓)
    trade.fee = trade.position_value * CONFIG.fee_rate * 2;
    trade.net_pnl = trade.pnl - trade.fee;
  }

  return trade;
}

function calculate_results(trades: Trade[]): BacktestResult {
  const completed_trades = trades.filter(t => t.exit_price !== undefined);

  const winning_trades = completed_trades.filter(t => (t.net_pnl || 0) > 0);
  const losing_trades = completed_trades.filter(t => (t.net_pnl || 0) <= 0);

  const total_pnl = completed_trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const total_fee = completed_trades.reduce((sum, t) => sum + (t.fee || 0), 0);
  const net_pnl = completed_trades.reduce((sum, t) => sum + (t.net_pnl || 0), 0);

  const wins = winning_trades.map(t => t.net_pnl || 0);
  const losses = losing_trades.map(t => Math.abs(t.net_pnl || 0));

  const total_wins = wins.reduce((sum, w) => sum + w, 0);
  const total_losses = losses.reduce((sum, l) => sum + l, 0);

  const avg_hold_bars = completed_trades.length > 0
    ? completed_trades.reduce((sum, t) => sum + (t.hold_bars || 0), 0) / completed_trades.length
    : 0;

  return {
    total_trades: completed_trades.length,
    winning_trades: winning_trades.length,
    losing_trades: losing_trades.length,
    win_rate: completed_trades.length > 0 ? winning_trades.length / completed_trades.length * 100 : 0,

    total_pnl,
    total_fee,
    net_pnl,

    max_win: wins.length > 0 ? Math.max(...wins) : 0,
    max_loss: losses.length > 0 ? Math.max(...losses) : 0,
    avg_win: wins.length > 0 ? total_wins / wins.length : 0,
    avg_loss: losses.length > 0 ? total_losses / losses.length : 0,

    profit_factor: total_losses > 0 ? total_wins / total_losses : total_wins > 0 ? Infinity : 0,
    avg_hold_bars,

    trades: completed_trades
  };
}

// ==================== 输出格式化 ====================
function format_time(ts: number): string {
  // 直接加8小时得到北京时间，让 Date 自动处理跨天
  const beijing_date = new Date(ts + 8 * 60 * 60 * 1000);
  const month = (beijing_date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = beijing_date.getUTCDate().toString().padStart(2, '0');
  const hours = beijing_date.getUTCHours().toString().padStart(2, '0');
  const minutes = beijing_date.getUTCMinutes().toString().padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function print_trade(trade: Trade, index: number): void {
  const entry_time = format_time(trade.entry_time);
  const exit_time = trade.exit_time ? format_time(trade.exit_time) : 'N/A';
  const pnl_str = (trade.net_pnl || 0) >= 0
    ? `+${(trade.net_pnl || 0).toFixed(2)}`
    : `${(trade.net_pnl || 0).toFixed(2)}`;
  const result_emoji = (trade.net_pnl || 0) >= 0 ? '✅' : '❌';

  console.log(`${index.toString().padStart(3)}. ${result_emoji} ${trade.symbol.padEnd(12)} | ` +
    `${entry_time} -> ${exit_time} | ` +
    `入场: ${trade.entry_price.toFixed(4)} | ` +
    `出场: ${(trade.exit_price || 0).toFixed(4)} | ` +
    `${trade.exit_reason?.padEnd(10)} | ` +
    `盈亏: ${pnl_str.padStart(8)} U | ` +
    `持仓: ${trade.hold_bars}根`);
}

function print_results(result: BacktestResult): void {
  console.log('\n' + '═'.repeat(100));
  console.log('                              回测结果汇总');
  console.log('═'.repeat(100));

  console.log('\n📊 交易统计:');
  console.log(`   总交易数: ${result.total_trades}`);
  console.log(`   盈利交易: ${result.winning_trades} (${result.win_rate.toFixed(1)}%)`);
  console.log(`   亏损交易: ${result.losing_trades} (${(100 - result.win_rate).toFixed(1)}%)`);

  console.log('\n💰 盈亏统计:');
  console.log(`   总盈亏: ${result.total_pnl >= 0 ? '+' : ''}${result.total_pnl.toFixed(2)} U`);
  console.log(`   总手续费: -${result.total_fee.toFixed(2)} U`);
  console.log(`   净盈亏: ${result.net_pnl >= 0 ? '+' : ''}${result.net_pnl.toFixed(2)} U`);

  console.log('\n📈 盈亏分布:');
  console.log(`   最大单笔盈利: +${result.max_win.toFixed(2)} U`);
  console.log(`   最大单笔亏损: -${result.max_loss.toFixed(2)} U`);
  console.log(`   平均盈利: +${result.avg_win.toFixed(2)} U`);
  console.log(`   平均亏损: -${result.avg_loss.toFixed(2)} U`);

  console.log('\n📉 风险指标:');
  console.log(`   盈亏比: ${result.profit_factor === Infinity ? '∞' : result.profit_factor.toFixed(2)}`);
  console.log(`   平均持仓: ${result.avg_hold_bars.toFixed(1)} 根K线 (${(result.avg_hold_bars * 5 / 60).toFixed(1)} 小时)`);

  // 按出场原因统计
  const by_reason: Record<string, number> = {};
  for (const trade of result.trades) {
    const reason = trade.exit_reason || 'UNKNOWN';
    by_reason[reason] = (by_reason[reason] || 0) + 1;
  }

  console.log('\n🎯 出场原因统计:');
  for (const [reason, count] of Object.entries(by_reason)) {
    const pct = (count / result.total_trades * 100).toFixed(1);
    console.log(`   ${reason}: ${count} (${pct}%)`);
  }

  console.log('\n' + '═'.repeat(100));
}

// ==================== 特征分析 ====================
interface TradeWithFeatures extends Trade {
  lower_shadow_pct?: number;
  upper_shadow_pct?: number;
  stop_pct?: number;
  leverage?: number;
  hour_of_day?: number;
  batch_size?: number;
}

function analyze_features(trades: TradeWithFeatures[]): void {
  const winners = trades.filter(t => (t.net_pnl || 0) > 0);
  const losers = trades.filter(t => (t.net_pnl || 0) <= 0);

  console.log('\n' + '═'.repeat(100));
  console.log('                              特征对比分析');
  console.log('═'.repeat(100));

  // 1. 下影线比例分析
  const win_lower_shadows = winners.filter(t => t.lower_shadow_pct).map(t => t.lower_shadow_pct!);
  const lose_lower_shadows = losers.filter(t => t.lower_shadow_pct).map(t => t.lower_shadow_pct!);

  if (win_lower_shadows.length > 0 && lose_lower_shadows.length > 0) {
    const win_avg_lower = win_lower_shadows.reduce((a, b) => a + b, 0) / win_lower_shadows.length;
    const lose_avg_lower = lose_lower_shadows.reduce((a, b) => a + b, 0) / lose_lower_shadows.length;
    console.log('\n📊 下影线比例:');
    console.log(`   盈利交易平均: ${win_avg_lower.toFixed(1)}%`);
    console.log(`   亏损交易平均: ${lose_avg_lower.toFixed(1)}%`);

    // 分段统计
    const ranges = [[70, 75], [75, 80], [80, 85], [85, 90], [90, 100]];
    console.log('   分段胜率:');
    for (const [min, max] of ranges) {
      const range_wins = winners.filter(t => t.lower_shadow_pct && t.lower_shadow_pct >= min && t.lower_shadow_pct < max).length;
      const range_loses = losers.filter(t => t.lower_shadow_pct && t.lower_shadow_pct >= min && t.lower_shadow_pct < max).length;
      const total = range_wins + range_loses;
      if (total > 0) {
        const win_rate = (range_wins / total * 100).toFixed(1);
        console.log(`     ${min}%-${max}%: ${range_wins}胜/${range_loses}负 (胜率${win_rate}%)`);
      }
    }
  }

  // 2. 上影线比例分析
  const win_upper_shadows = winners.filter(t => t.upper_shadow_pct !== undefined).map(t => t.upper_shadow_pct!);
  const lose_upper_shadows = losers.filter(t => t.upper_shadow_pct !== undefined).map(t => t.upper_shadow_pct!);

  if (win_upper_shadows.length > 0 && lose_upper_shadows.length > 0) {
    const win_avg_upper = win_upper_shadows.reduce((a, b) => a + b, 0) / win_upper_shadows.length;
    const lose_avg_upper = lose_upper_shadows.reduce((a, b) => a + b, 0) / lose_upper_shadows.length;
    console.log('\n📊 上影线比例:');
    console.log(`   盈利交易平均: ${win_avg_upper.toFixed(2)}%`);
    console.log(`   亏损交易平均: ${lose_avg_upper.toFixed(2)}%`);

    // 分段统计: 0%, 0-2%, 2-5%
    const upper_ranges = [[0, 0.01], [0.01, 2], [2, 5]];
    console.log('   分段胜率:');
    for (const [min, max] of upper_ranges) {
      const range_wins = winners.filter(t => t.upper_shadow_pct !== undefined && t.upper_shadow_pct >= min && t.upper_shadow_pct < max).length;
      const range_loses = losers.filter(t => t.upper_shadow_pct !== undefined && t.upper_shadow_pct >= min && t.upper_shadow_pct < max).length;
      const total = range_wins + range_loses;
      if (total > 0) {
        const win_rate = (range_wins / total * 100).toFixed(1);
        const label = min === 0 ? '0%' : `${min}%-${max}%`;
        console.log(`     ${label}: ${range_wins}胜/${range_loses}负 (胜率${win_rate}%)`);
      }
    }
  }

  // 3. 止损距离分析
  const win_stop_pcts = winners.filter(t => t.stop_pct).map(t => t.stop_pct! * 100);
  const lose_stop_pcts = losers.filter(t => t.stop_pct).map(t => t.stop_pct! * 100);

  if (win_stop_pcts.length > 0 && lose_stop_pcts.length > 0) {
    const win_avg_stop = win_stop_pcts.reduce((a, b) => a + b, 0) / win_stop_pcts.length;
    const lose_avg_stop = lose_stop_pcts.reduce((a, b) => a + b, 0) / lose_stop_pcts.length;
    console.log('\n📊 止损距离:');
    console.log(`   盈利交易平均: ${win_avg_stop.toFixed(2)}%`);
    console.log(`   亏损交易平均: ${lose_avg_stop.toFixed(2)}%`);

    // 分段统计
    const stop_ranges = [[0.2, 0.5], [0.5, 1.0], [1.0, 2.0], [2.0, 5.0]];
    console.log('   分段胜率:');
    for (const [min, max] of stop_ranges) {
      const range_wins = winners.filter(t => t.stop_pct && t.stop_pct * 100 >= min && t.stop_pct * 100 < max).length;
      const range_loses = losers.filter(t => t.stop_pct && t.stop_pct * 100 >= min && t.stop_pct * 100 < max).length;
      const total = range_wins + range_loses;
      if (total > 0) {
        const win_rate = (range_wins / total * 100).toFixed(1);
        console.log(`     ${min}%-${max}%: ${range_wins}胜/${range_loses}负 (胜率${win_rate}%)`);
      }
    }
  }

  // 4. 杠杆分析
  const win_leverages = winners.filter(t => t.leverage).map(t => t.leverage!);
  const lose_leverages = losers.filter(t => t.leverage).map(t => t.leverage!);

  if (win_leverages.length > 0 && lose_leverages.length > 0) {
    const win_avg_lev = win_leverages.reduce((a, b) => a + b, 0) / win_leverages.length;
    const lose_avg_lev = lose_leverages.reduce((a, b) => a + b, 0) / lose_leverages.length;
    console.log('\n📊 杠杆倍数:');
    console.log(`   盈利交易平均: ${win_avg_lev.toFixed(1)}x`);
    console.log(`   亏损交易平均: ${lose_avg_lev.toFixed(1)}x`);

    // 分段统计
    const lev_ranges = [[0, 5], [5, 10], [10, 15], [15, 20]];
    console.log('   分段胜率:');
    for (const [min, max] of lev_ranges) {
      const range_wins = winners.filter(t => t.leverage && t.leverage >= min && t.leverage < max).length;
      const range_loses = losers.filter(t => t.leverage && t.leverage >= min && t.leverage < max).length;
      const total = range_wins + range_loses;
      if (total > 0) {
        const win_rate = (range_wins / total * 100).toFixed(1);
        console.log(`     ${min}x-${max}x: ${range_wins}胜/${range_loses}负 (胜率${win_rate}%)`);
      }
    }
  }

  // 5. 时段分析
  const win_hours = winners.filter(t => t.hour_of_day !== undefined).map(t => t.hour_of_day!);
  const lose_hours = losers.filter(t => t.hour_of_day !== undefined).map(t => t.hour_of_day!);

  if (win_hours.length > 0 && lose_hours.length > 0) {
    console.log('\n📊 时段分析 (北京时间):');

    // 按时段分组: 0-4, 4-8, 8-12, 12-16, 16-20, 20-24
    const hour_ranges = [[0, 4], [4, 8], [8, 12], [12, 16], [16, 20], [20, 24]];
    console.log('   分段胜率:');
    for (const [min, max] of hour_ranges) {
      const range_wins = winners.filter(t => t.hour_of_day !== undefined && t.hour_of_day >= min && t.hour_of_day < max).length;
      const range_loses = losers.filter(t => t.hour_of_day !== undefined && t.hour_of_day >= min && t.hour_of_day < max).length;
      const total = range_wins + range_loses;
      if (total > 0) {
        const win_rate = (range_wins / total * 100).toFixed(1);
        console.log(`     ${min.toString().padStart(2, '0')}:00-${max.toString().padStart(2, '0')}:00: ${range_wins}胜/${range_loses}负 (胜率${win_rate}%)`);
      }
    }
  }

  // 6. 持仓时间分析
  const win_hold_bars = winners.filter(t => t.hold_bars).map(t => t.hold_bars!);
  const lose_hold_bars = losers.filter(t => t.hold_bars).map(t => t.hold_bars!);

  if (win_hold_bars.length > 0 && lose_hold_bars.length > 0) {
    const win_avg_hold = win_hold_bars.reduce((a, b) => a + b, 0) / win_hold_bars.length;
    const lose_avg_hold = lose_hold_bars.reduce((a, b) => a + b, 0) / lose_hold_bars.length;
    console.log('\n📊 持仓时间:');
    console.log(`   盈利交易平均: ${win_avg_hold.toFixed(1)}根K线 (${(win_avg_hold * 5 / 60).toFixed(1)}小时)`);
    console.log(`   亏损交易平均: ${lose_avg_hold.toFixed(1)}根K线 (${(lose_avg_hold * 5 / 60).toFixed(1)}小时)`);
  }

  // 7. 批次信号数量分析
  const win_batch = winners.filter(t => t.batch_size).map(t => t.batch_size!);
  const lose_batch = losers.filter(t => t.batch_size).map(t => t.batch_size!);

  if (win_batch.length > 0 && lose_batch.length > 0) {
    const win_avg_batch = win_batch.reduce((a, b) => a + b, 0) / win_batch.length;
    const lose_avg_batch = lose_batch.reduce((a, b) => a + b, 0) / lose_batch.length;
    console.log('\n📊 批次信号数量:');
    console.log(`   盈利交易平均: ${win_avg_batch.toFixed(1)}个信号/批次`);
    console.log(`   亏损交易平均: ${lose_avg_batch.toFixed(1)}个信号/批次`);

    // 分段统计: 1个、2-3个、4-5个、6+个
    const batch_ranges = [[1, 2], [2, 4], [4, 6], [6, 100]];
    console.log('   分段胜率:');
    for (const [min, max] of batch_ranges) {
      const range_wins = winners.filter(t => t.batch_size && t.batch_size >= min && t.batch_size < max).length;
      const range_loses = losers.filter(t => t.batch_size && t.batch_size >= min && t.batch_size < max).length;
      const total = range_wins + range_loses;
      if (total > 0) {
        const win_rate = (range_wins / total * 100).toFixed(1);
        const label = max === 100 ? `${min}+个` : `${min}-${max - 1}个`;
        console.log(`     ${label}: ${range_wins}胜/${range_loses}负 (胜率${win_rate}%)`);
      }
    }
  }

  console.log('\n' + '═'.repeat(100));
}

// ==================== 主函数 ====================
async function main() {
  const mode_str = CONFIG.use_compound ? '复利模式' : '固定金额模式';
  console.log('═'.repeat(100));
  console.log(`                    完美倒锤头策略回测 (${mode_str})`);
  console.log('═'.repeat(100));

  console.log('\n📋 策略参数:');
  console.log(`   回测时间: ${CONFIG.start_date} ~ ${CONFIG.end_date}`);
  console.log(`   初始本金: ${CONFIG.initial_capital} U`);
  console.log(`   单笔风险: ${CONFIG.fixed_risk_amount} U (固定)`);
  console.log(`   盈亏比: 1:${CONFIG.reward_ratio}`);
  console.log(`   杠杆范围: ${CONFIG.min_leverage}x ~ ${CONFIG.max_leverage}x`);
  console.log(`   止损范围: ${CONFIG.min_stop_pct * 100}% ~ ${CONFIG.max_stop_pct * 100}%`);
  console.log(`   手续费率: ${CONFIG.fee_rate * 100}%`);
  console.log(`   最大持仓: ${CONFIG.max_hold_bars} 根K线 (${CONFIG.max_hold_bars * 5 / 60} 小时)`);
  console.log(`   滑点: ${CONFIG.slippage * 100}%`);
  console.log(`   信号过滤: 同时≥${CONFIG.max_concurrent_signals}个信号时跳过`);

  // 初始化
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  // 生成日期列表
  const dates: string[] = [];
  const start = new Date(CONFIG.start_date);
  start.setDate(start.getDate() - 2); // 向前多加2天用于获取历史K线
  const end = new Date(CONFIG.end_date);
  end.setDate(end.getDate() + 2); // 向后多加2天用于获取后续K线

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  // 获取信号
  console.log('\n📡 正在获取信号数据...');
  const signals = await get_pattern_signals(CONFIG.start_date, CONFIG.end_date);
  console.log(`   找到 ${signals.length} 个完美倒锤头信号`);

  if (signals.length === 0) {
    console.log('\n❌ 没有找到信号，退出回测');
    await DatabaseConfig.close_connections();
    return;
  }

  // 统计每个时间点的信号数量，过滤掉密集信号
  const signal_count_by_time: Map<number, number> = new Map();
  for (const signal of signals) {
    const count = signal_count_by_time.get(signal.kline_time) || 0;
    signal_count_by_time.set(signal.kline_time, count + 1);
  }

  // 标记需要跳过的时间点 (max_concurrent_signals=0 表示不过滤)
  const skip_times: Set<number> = new Set();
  let skipped_signals = 0;
  if (CONFIG.max_concurrent_signals > 0) {
    for (const [kline_time, count] of signal_count_by_time.entries()) {
      if (count >= CONFIG.max_concurrent_signals) {
        skip_times.add(kline_time);
        skipped_signals += count;
      }
    }
    if (skip_times.size > 0) {
      console.log(`   ⚠️ 过滤掉 ${skip_times.size} 个时间点的 ${skipped_signals} 个密集信号`);
    }
  } else {
    console.log(`   📢 密集信号过滤已禁用`);
  }

  // 回测每个信号
  console.log('\n🔄 正在回测...\n');
  console.log('─'.repeat(100));

  const trades: Trade[] = [];
  let processed = 0;
  let filtered_count = 0;
  let skip_leverage_count = 0;
  let skip_stop_range_count = 0;
  let skip_lower_shadow_count = 0;
  let skip_no_kline_data = 0;
  let skip_no_following_klines = 0;
  let skip_simulate_failed = 0;

  // 资金跟踪 (复利模式)
  let current_capital = CONFIG.initial_capital;

  for (const signal of signals) {
    processed++;

    // 跳过密集信号时间点
    if (skip_times.has(signal.kline_time)) {
      filtered_count++;
      continue;
    }

    // 获取信号K线 (用于确定止损价)
    // 使用 UTC+8 时间来确定日期，因为K线表是按北京时间分日期的
    const signal_date = new Date(signal.kline_time + 8 * 60 * 60 * 1000).toISOString().split('T')[0];
    const signal_kline = await get_signal_kline(signal.symbol, signal.kline_time, signal_date);

    if (!signal_kline) {
      skip_no_kline_data++;
      continue;
    }

    // 预先检查止损距离是否在合理范围
    const entry_price = signal.current_price * (1 + CONFIG.slippage);
    const stop_loss = signal_kline.low;
    const stop_distance = entry_price - stop_loss;
    const stop_pct = stop_distance / entry_price;

    if (stop_pct < CONFIG.min_stop_pct || stop_pct > CONFIG.max_stop_pct) {
      skip_stop_range_count++;
      continue;
    }

    // 检查下影线比例
    if (CONFIG.min_lower_shadow_pct > 0 && signal.lower_shadow_pct < CONFIG.min_lower_shadow_pct) {
      skip_lower_shadow_count++;
      continue;
    }

    // 预先检查杠杆是否超限
    const risk_amount = calculate_risk_amount(current_capital);
    const estimated_position_value = risk_amount / stop_pct;
    // 固定金额模式使用初始资金计算杠杆，复利模式使用当前资金
    const leverage_base = CONFIG.use_compound ? current_capital : CONFIG.initial_capital;
    const estimated_leverage = estimated_position_value / leverage_base;

    if (estimated_leverage > CONFIG.max_leverage) {
      skip_leverage_count++;
      continue;
    }

    // 检查杠杆是否低于最小限制 (影线过长)
    if (estimated_leverage < CONFIG.min_leverage) {
      skip_leverage_count++;
      continue;
    }

    // 信号K线最低价验证已在信号生成时完成，入库的信号都是合格的，无需再次验证

    // 获取后续K线
    const following_klines = await get_following_klines(
      signal.symbol,
      signal.kline_time,
      CONFIG.max_hold_bars,
      dates
    );

    if (following_klines.length === 0) {
      skip_no_following_klines++;
      continue;
    }

    // 模拟交易 (传入当前资金)
    const trade = simulate_trade(signal, signal_kline, following_klines, current_capital);

    // 如果交易无效 (仓位计算失败)，跳过
    if (!trade) {
      skip_simulate_failed++;
      continue;
    }

    // 添加批次信号数量
    trade.batch_size = signal_count_by_time.get(signal.kline_time) || 1;

    trades.push(trade);

    // 更新资金 (复利模式)
    if (trade.net_pnl !== undefined) {
      current_capital += trade.net_pnl;
    }

    // 打印交易结果 (包含当前资金)
    print_trade(trade, trades.length);
    console.log(`         💰 当前资金: ${current_capital.toFixed(2)} U`);

    // 进度显示
    if (processed % 50 === 0) {
      console.log(`\n   ... 已处理 ${processed}/${signals.length} 个信号 ...\n`);
    }

    // 如果资金归零，停止回测
    if (current_capital <= 0) {
      console.log(`\n   ❌ 资金归零，停止回测`);
      break;
    }
  }

  console.log(`\n   📊 过滤统计: 密集信号=${filtered_count}, 无K线数据=${skip_no_kline_data}, 止损范围外=${skip_stop_range_count}, 下影线不足=${skip_lower_shadow_count}, 杠杆问题=${skip_leverage_count}, 无后续K线=${skip_no_following_klines}, 模拟失败=${skip_simulate_failed}`);

  console.log('─'.repeat(100));

  // 计算并输出结果
  const result = calculate_results(trades);
  print_results(result);

  // 特征对比分析
  analyze_features(trades);

  // 输出资金变化
  console.log('\n💵 资金变化:');
  console.log(`   初始资金: ${CONFIG.initial_capital.toFixed(2)} U`);
  console.log(`   最终资金: ${current_capital.toFixed(2)} U`);
  console.log(`   收益率: ${((current_capital - CONFIG.initial_capital) / CONFIG.initial_capital * 100).toFixed(2)}%`);
  console.log('═'.repeat(100));

  // 关闭数据库连接
  await DatabaseConfig.close_connections();

  console.log('\n✅ 回测完成\n');
}

// 运行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
