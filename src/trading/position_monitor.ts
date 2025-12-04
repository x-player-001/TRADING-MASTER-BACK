/**
 * 仓位监控模块
 *
 * 功能：
 * 1. 监听 UserDataStream 的仓位更新事件
 * 2. 实时处理仓位变化
 * 3. 触发止损单更新
 * 4. 保留兜底轮询机制
 */

import { EventEmitter } from 'events';
import { UserDataStream, PositionUpdate, AccountUpdateEvent, OrderUpdateEvent } from './user_data_stream';
import { BinanceFuturesTradingAPI, PositionInfo } from '../api/binance_futures_trading_api';
import { logger } from '../utils/logger';

/**
 * 本地仓位状态
 */
export interface LocalPositionState {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  unrealizedProfit: number;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  lastUpdateTime: number;
  lastUpdateSource: 'websocket' | 'polling';
}

/**
 * 仓位变化事件
 */
export interface PositionChangeEvent {
  symbol: string;
  previousAmt: number;
  currentAmt: number;
  changeAmt: number;
  changeType: 'open' | 'partial_close' | 'full_close' | 'add';
  source: 'websocket' | 'polling';
  timestamp: number;
}

/**
 * 仓位监控配置
 */
interface PositionMonitorConfig {
  fallback_polling_interval: number;  // 兜底轮询间隔（毫秒）
  enable_websocket: boolean;          // 是否启用WebSocket
  enable_fallback_polling: boolean;   // 是否启用兜底轮询
}

/**
 * 仓位监控器
 */
export class PositionMonitor extends EventEmitter {
  private user_data_stream: UserDataStream;
  private trading_api: BinanceFuturesTradingAPI;
  private config: PositionMonitorConfig;

  // 本地仓位状态缓存
  private positions: Map<string, LocalPositionState> = new Map();

  // 兜底轮询定时器
  private polling_timer: NodeJS.Timeout | null = null;

  // 运行状态
  private is_running: boolean = false;

  constructor(
    api_key: string,
    api_secret: string,
    trading_api: BinanceFuturesTradingAPI,
    config?: Partial<PositionMonitorConfig>
  ) {
    super();

    this.trading_api = trading_api;

    this.config = {
      fallback_polling_interval: 60000,  // 默认60秒兜底轮询
      enable_websocket: true,
      enable_fallback_polling: true,
      ...config
    };

    // 创建用户数据流
    this.user_data_stream = new UserDataStream(api_key, api_secret);

    // 设置事件监听
    this.setup_event_listeners();
  }

  /**
   * 设置事件监听器
   */
  private setup_event_listeners(): void {
    // 监听仓位更新
    this.user_data_stream.on('position_update', (positions: PositionUpdate[]) => {
      this.handle_position_updates(positions, 'websocket');
    });

    // 监听账户更新
    this.user_data_stream.on('account_update', (event: AccountUpdateEvent) => {
      logger.debug(`[PositionMonitor] Account update: reason=${event.updateReason}`);
      this.emit('account_update', event);
    });

    // 监听订单更新
    this.user_data_stream.on('order_update', (event: OrderUpdateEvent) => {
      logger.debug(`[PositionMonitor] Order update: ${event.order.symbol} ${event.order.executionType}`);
      this.emit('order_update', event);
    });

    // 监听连接状态
    this.user_data_stream.on('connected', () => {
      logger.info('[PositionMonitor] WebSocket connected');
      this.emit('stream_connected');
    });

    this.user_data_stream.on('disconnected', (info: { code: number; reason: string }) => {
      logger.warn(`[PositionMonitor] WebSocket disconnected: ${info.code} - ${info.reason}`);
      this.emit('stream_disconnected', info);
    });

    this.user_data_stream.on('error', (error: Error) => {
      logger.error('[PositionMonitor] WebSocket error:', error);
      this.emit('stream_error', error);
    });

    this.user_data_stream.on('max_reconnect_reached', () => {
      logger.error('[PositionMonitor] Max reconnect attempts reached');
      this.emit('stream_failed');
    });
  }

  /**
   * 处理仓位更新
   */
  private handle_position_updates(positions: PositionUpdate[], source: 'websocket' | 'polling'): void {
    const now = Date.now();

    for (const pos of positions) {
      const symbol = pos.symbol;
      const current_amt = pos.positionAmt;
      const previous_state = this.positions.get(symbol);
      const previous_amt = previous_state?.positionAmt || 0;

      // 更新本地状态
      this.positions.set(symbol, {
        symbol,
        positionAmt: current_amt,
        entryPrice: pos.entryPrice,
        unrealizedProfit: pos.unrealizedProfit,
        positionSide: pos.positionSide,
        lastUpdateTime: now,
        lastUpdateSource: source
      });

      // 检测仓位变化
      if (Math.abs(current_amt - previous_amt) > 0.0000001) {
        const change_type = this.determine_change_type(previous_amt, current_amt);

        const change_event: PositionChangeEvent = {
          symbol,
          previousAmt: previous_amt,
          currentAmt: current_amt,
          changeAmt: current_amt - previous_amt,
          changeType: change_type,
          source,
          timestamp: now
        };

        logger.info(`[PositionMonitor] 📊 Position change detected: ${symbol} ${previous_amt} → ${current_amt} (${change_type}) [${source}]`);

        // 发送仓位变化事件
        this.emit('position_change', change_event);

        // 根据变化类型发送特定事件
        if (change_type === 'partial_close') {
          this.emit('partial_close', change_event);
        } else if (change_type === 'full_close') {
          this.emit('full_close', change_event);
        } else if (change_type === 'open') {
          this.emit('position_open', change_event);
        }
      }
    }
  }

  /**
   * 判断仓位变化类型
   */
  private determine_change_type(previous_amt: number, current_amt: number): 'open' | 'partial_close' | 'full_close' | 'add' {
    const prev_abs = Math.abs(previous_amt);
    const curr_abs = Math.abs(current_amt);

    if (prev_abs === 0 && curr_abs > 0) {
      return 'open';
    } else if (prev_abs > 0 && curr_abs === 0) {
      return 'full_close';
    } else if (curr_abs < prev_abs) {
      return 'partial_close';
    } else {
      return 'add';
    }
  }

  /**
   * 执行兜底轮询
   */
  private async do_fallback_polling(): Promise<void> {
    try {
      const positions = await this.trading_api.get_position_info();

      // 过滤有仓位的
      const active_positions = positions.filter((p: PositionInfo) => Math.abs(parseFloat(p.positionAmt)) > 0);

      // 转换格式
      const position_updates: PositionUpdate[] = active_positions.map((p: PositionInfo) => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        unrealizedProfit: parseFloat(p.unRealizedProfit),
        marginType: p.marginType,
        isolatedWallet: parseFloat(p.isolatedWallet || '0'),
        positionSide: p.positionSide as 'BOTH' | 'LONG' | 'SHORT'
      }));

      // 处理更新
      if (position_updates.length > 0) {
        this.handle_position_updates(position_updates, 'polling');
      }

      // 检查是否有本地记录但API返回没有仓位的（可能是全部平仓）
      const active_symbols = new Set(active_positions.map((p: PositionInfo) => p.symbol));
      for (const [symbol, state] of this.positions) {
        if (state.positionAmt !== 0 && !active_symbols.has(symbol)) {
          // 仓位已平，但本地还记录有仓位
          this.handle_position_updates([{
            symbol,
            positionAmt: 0,
            entryPrice: 0,
            unrealizedProfit: 0,
            marginType: 'isolated',
            isolatedWallet: 0,
            positionSide: state.positionSide
          }], 'polling');
        }
      }

    } catch (error) {
      logger.error('[PositionMonitor] Fallback polling failed:', error);
    }
  }

  /**
   * 启动兜底轮询
   */
  private start_fallback_polling(): void {
    if (!this.config.enable_fallback_polling) {
      return;
    }

    if (this.polling_timer) {
      clearInterval(this.polling_timer);
    }

    this.polling_timer = setInterval(async () => {
      await this.do_fallback_polling();
    }, this.config.fallback_polling_interval);

    logger.info(`[PositionMonitor] Fallback polling started (interval: ${this.config.fallback_polling_interval / 1000}s)`);
  }

  /**
   * 停止兜底轮询
   */
  private stop_fallback_polling(): void {
    if (this.polling_timer) {
      clearInterval(this.polling_timer);
      this.polling_timer = null;
    }
  }

  /**
   * 启动仓位监控
   */
  async start(): Promise<void> {
    if (this.is_running) {
      logger.warn('[PositionMonitor] Already running');
      return;
    }

    logger.info('[PositionMonitor] Starting position monitor...');

    try {
      // 1. 先通过API获取当前仓位状态（初始化本地缓存）
      await this.do_fallback_polling();

      // 2. 启动 WebSocket 用户数据流
      if (this.config.enable_websocket) {
        await this.user_data_stream.start();
      }

      // 3. 启动兜底轮询
      this.start_fallback_polling();

      this.is_running = true;
      logger.info('[PositionMonitor] ✅ Position monitor started successfully');
    } catch (error) {
      logger.error('[PositionMonitor] Failed to start:', error);
      throw error;
    }
  }

  /**
   * 停止仓位监控
   */
  async stop(): Promise<void> {
    logger.info('[PositionMonitor] Stopping position monitor...');

    this.is_running = false;

    // 停止兜底轮询
    this.stop_fallback_polling();

    // 停止 WebSocket
    if (this.config.enable_websocket) {
      await this.user_data_stream.stop();
    }

    // 清空缓存
    this.positions.clear();

    logger.info('[PositionMonitor] ✅ Position monitor stopped');
  }

  /**
   * 获取本地缓存的仓位状态
   */
  get_position(symbol: string): LocalPositionState | undefined {
    return this.positions.get(symbol);
  }

  /**
   * 获取所有本地缓存的仓位
   */
  get_all_positions(): LocalPositionState[] {
    return Array.from(this.positions.values()).filter(p => p.positionAmt !== 0);
  }

  /**
   * 强制刷新仓位（手动触发轮询）
   */
  async refresh_positions(): Promise<void> {
    await this.do_fallback_polling();
  }

  /**
   * 获取WebSocket连接状态
   */
  is_websocket_connected(): boolean {
    return this.user_data_stream.is_stream_connected();
  }

  /**
   * 获取运行状态
   */
  is_monitor_running(): boolean {
    return this.is_running;
  }

  /**
   * 更新配置
   */
  update_config(config: Partial<PositionMonitorConfig>): void {
    this.config = { ...this.config, ...config };

    // 如果更新了轮询间隔，重启轮询
    if (config.fallback_polling_interval !== undefined && this.is_running) {
      this.stop_fallback_polling();
      this.start_fallback_polling();
    }

    logger.info('[PositionMonitor] Config updated:', this.config);
  }
}
