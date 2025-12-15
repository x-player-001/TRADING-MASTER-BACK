/**
 * K线密集区突破监控服务
 *
 * 功能:
 * 1. WebSocket 订阅所有合约的 5m K线
 * 2. 内存缓存每个币种最近 50 根 K线
 * 3. K线完结时检测密集区突破
 * 4. 保存突破信号到数据库
 */

import WebSocket from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import { ConsolidationDetector, KlineData, BreakoutSignal } from '@/analysis/consolidation_detector';
import { KlineBreakoutRepository, KlineBreakoutSignal } from '@/database/kline_breakout_repository';
import { Kline5mRepository, Kline5mData } from '@/database/kline_5m_repository';
import { logger } from '@/utils/logger';

// 服务配置
export interface KlineBreakoutServiceConfig {
  // WebSocket 配置
  ws_base_url: string;
  max_streams_per_connection: number;  // 每个连接最大订阅数
  reconnect_interval_ms: number;
  ping_interval_ms: number;

  // K线缓存配置
  kline_cache_size: number;            // 缓存K线数量，默认50

  // 信号配置
  signal_cooldown_minutes: number;     // 同方向信号冷却时间

  // 只做多还是双向
  allowed_directions: ('UP' | 'DOWN')[];
}

const DEFAULT_CONFIG: KlineBreakoutServiceConfig = {
  ws_base_url: 'wss://fstream.binance.com/stream',
  max_streams_per_connection: 150,
  reconnect_interval_ms: 5000,
  ping_interval_ms: 30000,
  kline_cache_size: 50,
  signal_cooldown_minutes: 30,
  allowed_directions: ['UP', 'DOWN']
};

// WebSocket 连接状态
interface WebSocketConnection {
  ws: WebSocket | null;
  streams: string[];
  is_connected: boolean;
  reconnect_timer: NodeJS.Timeout | null;
  ping_timer: NodeJS.Timeout | null;
}

export class KlineBreakoutService extends EventEmitter {
  private config: KlineBreakoutServiceConfig;
  private connections: WebSocketConnection[] = [];
  private all_symbols: string[] = [];

  // K线缓存: symbol -> KlineData[]
  private kline_cache: Map<string, KlineData[]> = new Map();

  // 组件
  private detector: ConsolidationDetector;
  private repository: KlineBreakoutRepository;
  private kline_repository: Kline5mRepository;

  // 统计
  private stats = {
    total_klines_received: 0,
    total_signals: 0,
    up_signals: 0,
    down_signals: 0,
    start_time: Date.now()
  };

  constructor(config?: Partial<KlineBreakoutServiceConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.detector = new ConsolidationDetector();
    this.repository = new KlineBreakoutRepository();
    this.kline_repository = new Kline5mRepository();
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    logger.info('[KlineBreakout] Starting service...');

    // 1. 获取所有合约交易对
    await this.fetch_all_symbols();
    logger.info(`[KlineBreakout] Found ${this.all_symbols.length} symbols`);

    // 2. 创建 WebSocket 连接
    await this.create_websocket_connections();

    // 3. 启动 REST API 历史数据预热（异步）
    this.preheat_kline_cache();

    logger.info('[KlineBreakout] Service started');
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    logger.info('[KlineBreakout] Stopping service...');

    for (const conn of this.connections) {
      if (conn.ping_timer) clearInterval(conn.ping_timer);
      if (conn.reconnect_timer) clearTimeout(conn.reconnect_timer);
      if (conn.ws) conn.ws.close();
    }

    // 停止 K 线 repository 定时器并刷新缓冲区
    this.kline_repository.stop_flush_timer();
    await this.kline_repository.flush();

    this.connections = [];
    this.kline_cache.clear();

    logger.info('[KlineBreakout] Service stopped');
  }

  /**
   * 获取所有合约交易对
   */
  private async fetch_all_symbols(): Promise<void> {
    try {
      const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
      const symbols = response.data.symbols
        .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL')
        .map((s: any) => s.symbol);

      this.all_symbols = symbols;
    } catch (error) {
      logger.error('[KlineBreakout] Failed to fetch symbols:', error);
      throw error;
    }
  }

  /**
   * 创建 WebSocket 连接（多个连接覆盖所有币种）
   */
  private async create_websocket_connections(): Promise<void> {
    const streams_per_conn = this.config.max_streams_per_connection;
    const total_symbols = this.all_symbols.length;
    const conn_count = Math.ceil(total_symbols / streams_per_conn);

    logger.info(`[KlineBreakout] Creating ${conn_count} WebSocket connections for ${total_symbols} symbols`);

    for (let i = 0; i < conn_count; i++) {
      const start = i * streams_per_conn;
      const end = Math.min(start + streams_per_conn, total_symbols);
      const symbols = this.all_symbols.slice(start, end);

      // 构建 5m K线流名称
      const streams = symbols.map(s => `${s.toLowerCase()}@kline_5m`);

      const connection: WebSocketConnection = {
        ws: null,
        streams,
        is_connected: false,
        reconnect_timer: null,
        ping_timer: null
      };

      this.connections.push(connection);
      await this.connect_websocket(i);
    }
  }

  /**
   * 连接单个 WebSocket
   */
  private async connect_websocket(index: number): Promise<void> {
    const conn = this.connections[index];
    if (!conn) return;

    // 构建 combined stream URL
    const stream_names = conn.streams.join('/');
    const url = `${this.config.ws_base_url}?streams=${stream_names}`;

    return new Promise((resolve, reject) => {
      try {
        conn.ws = new WebSocket(url);

        conn.ws.on('open', () => {
          conn.is_connected = true;
          logger.info(`[KlineBreakout] WebSocket ${index + 1} connected (${conn.streams.length} streams)`);
          this.start_ping(index);
          resolve();
        });

        conn.ws.on('message', (data: WebSocket.Data) => {
          this.handle_message(data.toString());
        });

        conn.ws.on('close', (code: number, reason: string) => {
          conn.is_connected = false;
          this.stop_ping(index);
          logger.warn(`[KlineBreakout] WebSocket ${index + 1} closed: ${code}`);
          this.schedule_reconnect(index);
        });

        conn.ws.on('error', (error: Error) => {
          logger.error(`[KlineBreakout] WebSocket ${index + 1} error:`, error);
          if (!conn.is_connected) {
            reject(error);
          }
        });

        conn.ws.on('pong', () => {
          // 静默接收 pong
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 处理 WebSocket 消息
   */
  private handle_message(raw_data: string): void {
    try {
      const message = JSON.parse(raw_data);

      // Combined stream 格式: { stream: "btcusdt@kline_5m", data: {...} }
      if (message.stream && message.data) {
        const kline_data = message.data;

        // 检查是否是 kline 事件
        if (kline_data.e !== 'kline') return;

        const k = kline_data.k;
        const symbol = k.s;
        const is_final = k.x;

        // 更新缓存（无论是否完结）
        this.update_kline_cache(symbol, k);

        // 只在 K 线完结时检测突破并保存到数据库
        if (is_final) {
          this.stats.total_klines_received++;

          // 保存完结的 K 线到数据库（异步，不阻塞）
          this.save_kline_to_db(symbol, k);

          // 检测突破
          this.check_breakout(symbol);
        }
      }
    } catch (error) {
      // 静默忽略解析错误
    }
  }

  /**
   * 保存 K 线到数据库（异步）
   */
  private save_kline_to_db(symbol: string, k: any): void {
    const kline_data: Kline5mData = {
      symbol,
      open_time: k.t,
      close_time: k.T,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v)
    };

    // 异步添加到写入缓冲区，不阻塞
    this.kline_repository.add_kline(kline_data).catch(err => {
      logger.error(`[KlineBreakout] Failed to save kline for ${symbol}:`, err);
    });
  }

  /**
   * 更新 K 线缓存
   */
  private update_kline_cache(symbol: string, k: any): void {
    const kline: KlineData = {
      open_time: k.t,
      close_time: k.T,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v)
    };

    let cache = this.kline_cache.get(symbol);
    if (!cache) {
      cache = [];
      this.kline_cache.set(symbol, cache);
    }

    // 检查是否是新的 K 线还是更新现有的
    const last_kline = cache[cache.length - 1];
    if (last_kline && last_kline.open_time === kline.open_time) {
      // 更新现有 K 线
      cache[cache.length - 1] = kline;
    } else {
      // 新的 K 线
      cache.push(kline);

      // 保持缓存大小
      while (cache.length > this.config.kline_cache_size + 1) {
        cache.shift();
      }
    }
  }

  /**
   * 检测突破
   */
  private async check_breakout(symbol: string): Promise<void> {
    const cache = this.kline_cache.get(symbol);
    if (!cache || cache.length < 20) {
      return; // 数据不足
    }

    // 历史 K 线（不含最新一根）
    const historical_klines = cache.slice(0, -1);
    // 最新完结的 K 线
    const current_kline = cache[cache.length - 1];

    // 检测突破
    const signal = this.detector.detect_breakout(symbol, historical_klines, current_kline);

    if (signal) {
      // 检查方向是否允许
      if (!this.config.allowed_directions.includes(signal.direction)) {
        return;
      }

      // 检查冷却时间
      const has_recent = await this.repository.has_recent_signal(
        symbol,
        signal.direction,
        this.config.signal_cooldown_minutes
      );

      if (has_recent) {
        return; // 冷却中
      }

      // 保存信号
      await this.save_signal(signal);
    }
  }

  /**
   * 保存突破信号
   */
  private async save_signal(signal: BreakoutSignal): Promise<void> {
    try {
      const db_signal: Omit<KlineBreakoutSignal, 'id' | 'created_at'> = {
        symbol: signal.symbol,
        direction: signal.direction,
        breakout_price: signal.breakout_price,
        upper_bound: signal.zone.upper_bound,
        lower_bound: signal.zone.lower_bound,
        breakout_pct: signal.breakout_pct,
        volume: signal.volume,
        volume_ratio: signal.volume_ratio,
        kline_open: signal.kline.open,
        kline_high: signal.kline.high,
        kline_low: signal.kline.low,
        kline_close: signal.kline.close,
        zone_start_time: new Date(signal.zone.start_time),
        zone_end_time: new Date(signal.zone.end_time),
        zone_kline_count: signal.zone.kline_count,
        center_price: signal.zone.center_price,
        atr: signal.zone.atr,
        signal_time: new Date()
      };

      await this.repository.save_signal(db_signal);

      // 更新统计
      this.stats.total_signals++;
      if (signal.direction === 'UP') {
        this.stats.up_signals++;
      } else {
        this.stats.down_signals++;
      }

      // 发出事件
      this.emit('breakout_signal', signal);

      // 日志输出
      const arrow = signal.direction === 'UP' ? '🚀' : '📉';
      logger.info(`${arrow} [BREAKOUT] ${signal.symbol} ${signal.direction} | Price: ${signal.breakout_price.toFixed(6)} | Breakout: +${signal.breakout_pct.toFixed(2)}% | Volume: ${signal.volume_ratio.toFixed(1)}x`);
      logger.info(`   Zone: ${signal.zone.lower_bound.toFixed(6)} - ${signal.zone.upper_bound.toFixed(6)} | ATR: ${signal.zone.atr.toFixed(6)} | Klines: ${signal.zone.kline_count}`);

    } catch (error) {
      logger.error('[KlineBreakout] Failed to save signal:', error);
    }
  }

  /**
   * 预热 K 线缓存（从 REST API 获取历史数据）
   */
  private async preheat_kline_cache(): Promise<void> {
    logger.info('[KlineBreakout] Preheating kline cache from REST API...');

    const batch_size = 10;
    let preheated = 0;

    for (let i = 0; i < this.all_symbols.length; i += batch_size) {
      const batch = this.all_symbols.slice(i, i + batch_size);
      const promises = batch.map(symbol => this.fetch_historical_klines(symbol));

      try {
        await Promise.all(promises);
        preheated += batch.length;

        if (preheated % 100 === 0) {
          logger.info(`[KlineBreakout] Preheated ${preheated}/${this.all_symbols.length} symbols`);
        }
      } catch (error) {
        // 继续处理其他币种
      }

      // 避免速率限制
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    logger.info(`[KlineBreakout] Cache preheating completed: ${preheated} symbols`);
  }

  /**
   * 获取单个币种的历史 K 线
   */
  private async fetch_historical_klines(symbol: string): Promise<void> {
    try {
      const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: {
          symbol,
          interval: '5m',
          limit: this.config.kline_cache_size
        }
      });

      const klines: KlineData[] = response.data.map((k: any[]) => ({
        open_time: k[0],
        close_time: k[6],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));

      this.kline_cache.set(symbol, klines);
    } catch (error) {
      // 静默失败，后续会通过 WebSocket 补充
    }
  }

  /**
   * 启动心跳
   */
  private start_ping(index: number): void {
    const conn = this.connections[index];
    if (!conn) return;

    conn.ping_timer = setInterval(() => {
      if (conn.ws && conn.is_connected) {
        conn.ws.ping();
      }
    }, this.config.ping_interval_ms);
  }

  /**
   * 停止心跳
   */
  private stop_ping(index: number): void {
    const conn = this.connections[index];
    if (conn && conn.ping_timer) {
      clearInterval(conn.ping_timer);
      conn.ping_timer = null;
    }
  }

  /**
   * 计划重连
   */
  private schedule_reconnect(index: number): void {
    const conn = this.connections[index];
    if (!conn) return;

    if (conn.reconnect_timer) {
      clearTimeout(conn.reconnect_timer);
    }

    conn.reconnect_timer = setTimeout(async () => {
      logger.info(`[KlineBreakout] Reconnecting WebSocket ${index + 1}...`);
      try {
        await this.connect_websocket(index);
      } catch (error) {
        logger.error(`[KlineBreakout] Reconnect ${index + 1} failed:`, error);
        this.schedule_reconnect(index);
      }
    }, this.config.reconnect_interval_ms);
  }

  /**
   * 获取服务状态
   */
  get_status(): {
    running: boolean;
    connections: { index: number; connected: boolean; streams: number }[];
    symbols_count: number;
    cached_symbols: number;
    stats: {
      total_klines_received: number;
      total_signals: number;
      up_signals: number;
      down_signals: number;
      start_time: number;
    };
  } {
    return {
      running: this.connections.some(c => c.is_connected),
      connections: this.connections.map((c, i) => ({
        index: i,
        connected: c.is_connected,
        streams: c.streams.length
      })),
      symbols_count: this.all_symbols.length,
      cached_symbols: this.kline_cache.size,
      stats: { ...this.stats }
    };
  }

  /**
   * 获取统计信息
   */
  async get_statistics(hours: number = 24): Promise<any> {
    return this.repository.get_statistics(hours);
  }

  /**
   * 获取 K 线数据库统计
   */
  async get_kline_db_statistics(): Promise<{
    today_count: number;
    today_symbols: number;
    buffer_size: number;
  }> {
    return this.kline_repository.get_statistics();
  }

  /**
   * 清理旧的 K 线表（保留最近N天）
   */
  async cleanup_old_kline_tables(days_to_keep: number = 7): Promise<number> {
    return this.kline_repository.cleanup_old_tables(days_to_keep);
  }
}
