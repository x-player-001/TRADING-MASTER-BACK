export interface SymbolConfig {
  id?: number;
  symbol: string;
  display_name: string;
  base_asset: string;
  quote_asset: string;
  enabled: boolean;
  priority: number;
  category: 'major' | 'alt' | 'stable';
  exchange: string;
  min_price: number;
  min_qty: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface SubscriptionStatus {
  id?: number;
  symbol: string;
  stream_type: 'ticker' | 'kline' | 'depth' | 'trade';
  status: 'active' | 'inactive' | 'error';
  last_update?: Date;
  error_count: number;
  error_message?: string;
  reconnect_attempts: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface HistoricalDataCache {
  id?: number;
  symbol: string;
  time_interval: string;
  start_time: Date;
  end_time: Date;
  data_count: number;
  cache_key: string;
  expires_at: Date;
  fetch_duration: number;
  data_source: string;
  created_at?: Date;
}

// TOP币种配置
export interface TopSymbolConfig {
  id?: number;
  symbol: string;
  display_name: string;
  rank_order: number;
  enabled: boolean;
  subscription_intervals: string[];
  created_at?: Date;
  updated_at?: Date;
}

export interface MarketData {
  symbol: string;
  price: number;
  volume: number;
  change_24h: number;
  high_24h: number;
  low_24h: number;
  timestamp: number;
}

export interface KlineData {
  symbol: string;
  interval: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
  is_final: boolean; // 标识K线是否已完成
}

export interface WebSocketConfig {
  base_url: string;
  reconnect_interval: number;
  max_reconnect_attempts: number;
  ping_interval: number;
}

export interface BinanceWebSocketMessage {
  stream: string;
  data: any;
}

export type StreamType = 'ticker' | 'kline' | 'depth' | 'trade';
export type DataEventType = 'market_data' | 'kline_data' | 'error' | 'connected' | 'disconnected';