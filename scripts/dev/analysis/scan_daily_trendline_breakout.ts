/**
 * 日线趋势线 / 盘整上沿突破扫描（研究阶段，独立于趋势跟随）
 *
 * 数据源:
 *   --source 1d   读 kline_1d_agg（服务器先跑 scripts/backfill_kline_1d.ts）【默认】
 *   --source 4h   由 kline_4h_agg 按 UTC 日聚合（本机验证用，历史较短且有空洞）
 *
 * 参数:
 *   --symbols RUNEUSDT,QNTUSDT   指定币种（默认全表）
 *   --max-age 30                 只输出最近 N 天内的突破；--history 输出全部历史
 *   --scale linear|log           连线坐标（默认 linear）
 *   --from KMNOUSDT              从该币种（含）起按字母序续扫
 *   --save                       结果写入 daily_trendline_breakouts（先删该币种窗口内旧事件再写入）
 *
 * 运行:
 *   npx ts-node -r tsconfig-paths/register scripts/dev/analysis/scan_daily_trendline_breakout.ts --source 4h --symbols RUNEUSDT,QNTUSDT,KITEUSDT
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '@/core/config/config_manager';
import { DatabaseConfig } from '@/core/config/database';
import { DailyBreakoutRepository } from '@/database/daily_breakout_repository';
import {
  detect_trendline_breakouts, TrendlineBreakout, TrendlineBreakoutConfig, DEFAULT_TRENDLINE_CONFIG,
} from '@/analysis/trendline_breakout_detector';

const DAY_MS = 86_400_000;

interface ScanArgs {
  source: '1d' | '4h';
  symbols: string[] | null;
  from: string | null;
  save: boolean;
  config: Partial<TrendlineBreakoutConfig>;
}

/** 解析命令行参数 */
function parse_args(): ScanArgs {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const config: Partial<TrendlineBreakoutConfig> = {};
  if (get('--max-age')) config.max_breakout_age_days = Number(get('--max-age'));
  if (argv.includes('--history')) config.max_breakout_age_days = Infinity;
  if (get('--scale') === 'log') config.price_scale = 'log';
  return {
    source: get('--source') === '4h' ? '4h' : '1d',
    symbols: get('--symbols')?.split(',').map(s => s.trim().toUpperCase()) ?? null,
    from: get('--from')?.toUpperCase() ?? null,
    save: argv.includes('--save'),
    config,
  };
}

/** 毫秒时间 → YYYY-MM-DD（UTC，与币安日线对齐） */
function fmt_day(t: number | null): string {
  return t === null ? '-' : new Date(t).toISOString().slice(0, 10);
}

/** 格式化价格：保留 4 位有效数字以上 */
function fmt_price(p: number): string {
  return p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4);
}

/** 打印一条突破事件 */
function print_breakout(symbol: string, b: TrendlineBreakout): void {
  const type = b.line_type === 'descending' ? '下降趋势线' : '盘整上沿';
  const status = { breakout: '已突破', retest: '回踩中', failed: '失败' }[b.status];
  console.log(`\n${symbol}  ${type}  [${status}]  触点 ${b.touch_count}  跨度 ${Math.round(b.span_days)}天  斜率 ${b.slope_pct_per_day.toFixed(3)}%/天`);
  console.log(`  触点: ${b.touches.map(t => `${fmt_day(t.time)}@${fmt_price(t.price)}`).join('  ')}`);
  console.log(`  突破: ${fmt_day(b.breakout_time)} 收 ${fmt_price(b.breakout_close)} / 线 ${fmt_price(b.breakout_line_value)}` +
    ` (+${b.breakout_pct.toFixed(2)}%)  量比 ${b.breakout_volume_ratio.toFixed(2)}  深度 ${b.depth_pct.toFixed(1)}%`);
  if (b.retest_time !== null) {
    console.log(`  回踩: ${fmt_day(b.retest_time)} 起  最低 ${fmt_price(b.retest_low!)}  离线最近 ${b.retest_distance_pct!.toFixed(2)}%`);
  }
  if (b.fail_time !== null) console.log(`  失败: ${fmt_day(b.fail_time)} 收盘跌破线`);
  console.log(`  最新: ${fmt_day(b.last_time)} 收 ${fmt_price(b.last_close)} / 线 ${fmt_price(b.last_line_value)}` +
    ` (${b.last_distance_pct >= 0 ? '+' : ''}${b.last_distance_pct.toFixed(2)}%)  突破后最大涨幅 ${b.max_gain_pct.toFixed(1)}%`);
}

/** 主流程：串行逐币读取 → 检测 → 打印/入库 */
async function main(): Promise<void> {
  const args = parse_args();
  ConfigManager.getInstance().initialize();
  const repo = new DailyBreakoutRepository();
  if (args.save) await repo.init_tables();

  const cfg = { ...DEFAULT_TRENDLINE_CONFIG, ...args.config };
  const all_symbols = args.symbols ?? (args.source === '4h' ? await repo.get_4h_symbols() : await repo.get_daily_symbols());
  const symbols = args.from ? all_symbols.filter(s => s >= args.from!) : all_symbols;
  const since = Date.now() - (cfg.max_lookback_days + 60) * DAY_MS;
  console.log(`数据源 ${args.source}  币种 ${symbols.length}  坐标 ${cfg.price_scale}  突破窗口 ${cfg.max_breakout_age_days} 天`);

  const counts = { symbols_hit: 0, breakout: 0, retest: 0, failed: 0 };
  for (const symbol of symbols) {
    try {
      const bars = args.source === '4h'
        ? await repo.get_daily_klines_from_4h(symbol, since)
        : await repo.get_daily_klines(symbol, since);
      const results = detect_trendline_breakouts(bars, args.config);
      if (args.save && bars.length > 0) {
        const window_start = bars[bars.length - 1].open_time - cfg.max_breakout_age_days * DAY_MS;
        await repo.delete_breakouts_since(symbol, Number.isFinite(window_start) ? window_start : 0);
      }
      if (results.length === 0) continue;

      counts.symbols_hit++;
      for (const b of results) {
        counts[b.status]++;
        print_breakout(symbol, b);
        if (args.save) await repo.upsert_breakout(symbol, b);
      }
    } catch (error: any) {
      console.error(`${symbol} 扫描失败: ${error.message}`);
    }
  }

  console.log(`\n命中币种 ${counts.symbols_hit}  已突破 ${counts.breakout}  回踩中 ${counts.retest}  失败 ${counts.failed}`);
}

main()
  .catch(error => {
    console.error('扫描异常:', error);
    process.exitCode = 1;
  })
  .finally(() => DatabaseConfig.close_connections().then(() => process.exit()));
