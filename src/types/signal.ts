/**
 * 信号类型定义
 */
export enum SignalType {
  BUY = 'BUY',
  SELL = 'SELL',
  NEUTRAL = 'NEUTRAL'
}

export enum SignalStrength {
  WEAK = 'weak',       // 0-40
  MEDIUM = 'medium',   // 41-70
  STRONG = 'strong'    // 71-100
}

/**
 * 交易信号
 */
export interface TradingSignal {
  id?: number;
  symbol: string;
  interval: string;
  signal_type: SignalType;
  strength: number;           // 0-100
  price: number;              // 触发价格
  indicators: SignalIndicators;
  description: string;
  timestamp: number;
  created_at?: Date;
}

/**
 * 信号触发指标
 */
export interface SignalIndicators {
  ma_cross?: {
    type: 'golden' | 'death';  // 金叉/死叉
    fast_ma: number;
    slow_ma: number;
  };
  rsi?: {
    value: number;
    status: 'oversold' | 'overbought' | 'neutral';  // 超卖/超买/中性
  };
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
    cross?: 'bullish' | 'bearish';  // 多头交叉/空头交叉
  };
  pattern?: string;  // K线形态: hammer/engulfing/doji等
}

/**
 * 技术指标数据
 */
export interface TechnicalIndicators {
  symbol: string;
  interval: string;
  timestamp: number;
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma60?: number;
  rsi14?: number;
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
  };
  bollinger?: {
    upper: number;
    middle: number;
    lower: number;
  };
}

/**
 * 形态识别结果
 */
export interface PatternDetection {
  id?: number;
  symbol: string;
  interval: string;
  pattern_type: string;
  confidence: number;     // 0-1
  description: string;
  detected_at: number;
  created_at?: Date;
}

/**
 * 支撑阻力位
 */
export interface SupportResistance {
  type: 'support' | 'resistance';
  price: number;
  strength: number;    // 0-1
  touch_count: number; // 触碰次数
}
