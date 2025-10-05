import { Router, Request, Response } from 'express';
import { MultiSymbolManager } from '@/core/data/multi_symbol_manager';
import { SubscriptionPool } from '@/core/data/subscription_pool';
import { logger } from '@/utils/logger';

export class WebSocketRoutes {
  private router: Router;
  private multi_symbol_manager: MultiSymbolManager;
  private subscription_pool: SubscriptionPool;

  constructor() {
    this.router = Router();
    this.multi_symbol_manager = MultiSymbolManager.getInstance();
    this.subscription_pool = SubscriptionPool.getInstance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 获取WebSocket连接状态
    this.router.get('/status', this.get_websocket_status.bind(this));

    // 获取订阅的数据流列表
    this.router.get('/streams', this.get_subscribed_streams.bind(this));

    // 获取详细的订阅信息
    this.router.get('/subscriptions', this.get_subscription_details.bind(this));

    // 重新连接WebSocket
    this.router.post('/reconnect', this.reconnect_websocket.bind(this));
  }

  /**
   * 获取WebSocket连接状态
   */
  private async get_websocket_status(req: Request, res: Response): Promise<void> {
    try {
      const status = this.subscription_pool.get_connection_status();

      res.json({
        success: true,
        data: {
          connected: status.connected,
          reconnect_attempts: status.attempts,
          total_streams: status.streams,
          timestamp: Date.now()
        }
      });

    } catch (error) {
      logger.error('Failed to get WebSocket status', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取订阅的数据流列表
   */
  private async get_subscribed_streams(req: Request, res: Response): Promise<void> {
    try {
      const streams = this.subscription_pool.get_subscribed_streams();

      // 按类型分组
      const grouped_streams = this.group_streams_by_type(streams);

      res.json({
        success: true,
        data: {
          total_count: streams.length,
          streams: streams,
          grouped: grouped_streams,
          timestamp: Date.now()
        }
      });

    } catch (error) {
      logger.error('Failed to get subscribed streams', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取详细的订阅信息
   */
  private async get_subscription_details(req: Request, res: Response): Promise<void> {
    try {
      const connection_status = this.subscription_pool.get_connection_status();
      const streams = this.subscription_pool.get_subscribed_streams();
      const grouped_streams = this.group_streams_by_type(streams);

      // 统计各种类型的数量
      const stats = {
        total_streams: streams.length,
        kline_streams: grouped_streams.kline?.length || 0,
        ticker_streams: grouped_streams.ticker?.length || 0,
        depth_streams: grouped_streams.depth?.length || 0,
        trade_streams: grouped_streams.trade?.length || 0
      };

      res.json({
        success: true,
        data: {
          connection: {
            connected: connection_status.connected,
            reconnect_attempts: connection_status.attempts
          },
          statistics: stats,
          streams_by_type: grouped_streams,
          timestamp: Date.now()
        }
      });

    } catch (error) {
      logger.error('Failed to get subscription details', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 重新连接WebSocket
   */
  private async reconnect_websocket(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Manual WebSocket reconnection requested');

      // 断开当前连接
      await this.subscription_pool.disconnect();

      // 等待一秒后重新连接
      setTimeout(async () => {
        try {
          await this.subscription_pool.connect();
          logger.info('Manual WebSocket reconnection completed');
        } catch (error) {
          logger.error('Failed to reconnect WebSocket', error);
        }
      }, 1000);

      res.json({
        success: true,
        message: 'WebSocket reconnection initiated',
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to initiate WebSocket reconnection', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 按类型分组数据流
   */
  private group_streams_by_type(streams: string[]): Record<string, string[]> {
    const grouped: Record<string, string[]> = {
      kline: [],
      ticker: [],
      depth: [],
      trade: [],
      other: []
    };

    for (const stream of streams) {
      if (stream.includes('kline')) {
        grouped.kline.push(stream);
      } else if (stream.includes('ticker')) {
        grouped.ticker.push(stream);
      } else if (stream.includes('depth')) {
        grouped.depth.push(stream);
      } else if (stream.includes('trade')) {
        grouped.trade.push(stream);
      } else {
        grouped.other.push(stream);
      }
    }

    return grouped;
  }

  get_router(): Router {
    return this.router;
  }
}