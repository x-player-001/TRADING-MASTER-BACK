/**
 * 交易规则与精度（纯函数）
 *
 * 价格 / 数量必须对齐 tickSize / stepSize，否则下单被拒（-1111 / -4014）。
 * 步长按字符串处理：先换算成整数个步长再乘回去，并按步长小数位输出字符串，避免浮点尾差。
 */

import { SymbolRules } from './live_types';

/** 步长字符串的小数位数（"0.00100" → 3，"1" → 0） */
export function step_decimals(step: string): number {
  const s = step.includes('e') || step.includes('E') ? Number(step).toFixed(12) : step;
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

/**
 * 按步长取整
 * @param mode floor 向下 / ceil 向上 / round 四舍五入
 */
export function round_to_step(value: number, step: string, mode: 'floor' | 'ceil' | 'round'): number {
  const st = Number(step);
  if (!(st > 0) || !Number.isFinite(value)) return value;
  const units = value / st;
  const EPS = 1e-9;   // 吸收浮点误差：0.3 / 0.1 = 2.9999999999999996 仍视为 3
  const n = mode === 'floor' ? Math.floor(units + EPS) : mode === 'ceil' ? Math.ceil(units - EPS) : Math.round(units);
  return Number((n * st).toFixed(step_decimals(step)));
}

/** 按步长格式化为下单字符串 */
export function format_step(value: number, step: string): string {
  return value.toFixed(step_decimals(step));
}

/** 解析 exchangeInfo 中单个合约的规则 */
export function parse_symbol_rules(s: any): SymbolRules {
  const f = (type: string) => (s.filters as any[]).find(x => x.filterType === type) ?? {};
  const price = f('PRICE_FILTER'), lot = f('LOT_SIZE'), mlot = f('MARKET_LOT_SIZE'), mn = f('MIN_NOTIONAL'), pp = f('PERCENT_PRICE');
  return {
    symbol: s.symbol,
    status: s.status,
    tick_size: String(price.tickSize),
    step_size: String(lot.stepSize),
    min_qty: Number(lot.minQty),
    max_qty: Number(lot.maxQty),
    market_step_size: String(mlot.stepSize ?? lot.stepSize),
    market_max_qty: Number(mlot.maxQty ?? lot.maxQty),
    min_notional: Number(mn.notional ?? 5),
    percent_down: Number(pp.multiplierDown ?? 0),
  };
}

/** 北京时间当日 0 点（毫秒） */
export function beijing_day_start(ts: number): number {
  const BJ = 8 * 3600_000;
  return Math.floor((ts + BJ) / 86_400_000) * 86_400_000 - BJ;
}
