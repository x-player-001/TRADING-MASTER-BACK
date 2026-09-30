/**
 * CME 期货合约规格（K线回放用）
 *
 * 回放引擎按「数量 × 价格」记账，期货的「1 手」= multiplier 个单位：
 *   qty = 手数 × multiplier，盈亏 = 价差 × qty 即为美元盈亏。
 * 手续费按名义价值比例近似（真实为每手固定费用，约 $2~3/边）。
 */

/** 合约规格 */
export interface CmeContractSpec {
  symbol: string;              // 品种根代码（cme_klines.symbol）
  name: string;
  exchange: string;
  multiplier: number;          // 合约乘数：每点价值（美元）
  tick_size: number;           // 最小变动价位
  default_fee_rate: number;    // 回放默认手续费率（taker/maker 相同）
  default_leverage: number;    // 回放默认杠杆（约等于 1 / 保证金比例）
  default_balance: number;     // 回放默认初始资金（1 手名义价值数十万美元，1 万不够开仓）
}

export const CME_CONTRACTS: Record<string, CmeContractSpec> = {
  ES: {
    symbol: 'ES',
    name: 'E-mini 标普500',
    exchange: 'CME',
    multiplier: 50,
    tick_size: 0.25,
    default_fee_rate: 0.00001,
    default_leverage: 20,
    default_balance: 100000,
  },
  GC: {
    symbol: 'GC',
    name: 'COMEX 黄金',
    exchange: 'COMEX',
    multiplier: 100,
    tick_size: 0.1,
    default_fee_rate: 0.00001,
    default_leverage: 20,
    default_balance: 100000,
  },
};

/** 是否为 CME 期货品种 */
export function is_cme_symbol(symbol: string): boolean {
  return Object.prototype.hasOwnProperty.call(CME_CONTRACTS, symbol.toUpperCase());
}
