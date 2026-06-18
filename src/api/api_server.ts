import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { OIDataManager } from '../core/data/oi_data_manager';
import { logger } from '../utils/logger';
import { ErrorHandler, isBaseError } from '../utils/errors';
import { MonitoringRoutes } from './monitoring_routes';
import { TopSymbolsRoutes } from './routes/top_symbols_routes';
import { HistoricalDataRoutes } from './routes/historical_data_routes';
import { KlinesRoutes } from './routes/klines_routes';
import { WebSocketRoutes } from './routes/websocket_routes';
import { SignalsRoutes } from './routes/signals_routes';
import { StructureRoutes } from './routes/structure_routes';
import { TradingRoutes } from './routes/trading_routes';
import { BacktestRoutes } from './routes/backtest_routes';
import { MonitoringManager } from '@/core/monitoring/monitoring_manager';
import quantitative_routes from './routes/quantitative_routes';
import { BreakoutRoutes } from './routes/breakout_routes';
import { BoundaryAlertRoutes } from './routes/boundary_alert_routes';
import { SRLevelRoutes } from './routes/sr_level_routes';
import volume_monitor_routes, { set_volume_monitor_repository } from './routes/volume_monitor_routes';
import pattern_scan_routes, { set_pattern_scan_service } from './routes/pattern_scan_routes';
import orderbook_monitor_routes, { set_orderbook_service } from './routes/orderbook_monitor_routes';
import trend_follow_routes, { set_trend_follow_repository } from './routes/trend_follow_routes';
import ema20_push_routes, { set_ema20_push_repository } from './routes/ema20_push_routes';
import { TradeRecordRoutes } from './routes/trade_record_routes';
import { TradeLogService } from '@/services/trade_log_service';
import { VolumeMonitorRepository } from '@/database/volume_monitor_repository';
import { TrendFollowRepository } from '@/database/trend_follow_repository';
import { EMA20PushRepository } from '@/database/ema20_push_repository';
import { PatternScanService } from '@/services/pattern_scan_service';
import { OrderBookMonitorService } from '@/services/orderbook_monitor_service';
import { BinanceDepthUpdate } from '@/types/orderbook_types';
import WebSocket from 'ws';
import axios from 'axios';

/**
 * HTTP API服务器
 */
export class APIServer {
  private app: Express;
  private server: any;
  private oi_data_manager: OIDataManager;
  private port: number;
  private monitoring_routes: MonitoringRoutes;
  private top_symbols_routes: TopSymbolsRoutes;
  private historical_data_routes: HistoricalDataRoutes;
  private klines_routes: KlinesRoutes;
  private websocket_routes: WebSocketRoutes;
  private signals_routes: SignalsRoutes;
  private structure_routes: StructureRoutes;
  private trading_routes: TradingRoutes;
  private backtest_routes: BacktestRoutes;
  private breakout_routes: BreakoutRoutes;
  private boundary_alert_routes: BoundaryAlertRoutes;
  private sr_level_routes: SRLevelRoutes;
  private monitoring_manager: MonitoringManager;
  private volume_monitor_repository: VolumeMonitorRepository;
  private pattern_scan_service: PatternScanService;
  private orderbook_monitor_service: OrderBookMonitorService;
  private trend_follow_repository: TrendFollowRepository;
  private ema20_push_repository: EMA20PushRepository;
  private trade_record_routes: TradeRecordRoutes;
  private ws_depth: WebSocket | null = null;

  constructor(oi_data_manager: OIDataManager, port: number = 3000) {
    this.app = express();
    this.oi_data_manager = oi_data_manager;
    this.port = port;
    this.monitoring_routes = new MonitoringRoutes();
    this.top_symbols_routes = new TopSymbolsRoutes();
    this.historical_data_routes = new HistoricalDataRoutes();
    this.klines_routes = new KlinesRoutes();
    this.websocket_routes = new WebSocketRoutes();
    this.signals_routes = new SignalsRoutes();
    this.structure_routes = new StructureRoutes();
    this.trading_routes = new TradingRoutes(this.oi_data_manager.get_oi_polling_service());
    this.backtest_routes = new BacktestRoutes();
    this.breakout_routes = new BreakoutRoutes();
    this.boundary_alert_routes = new BoundaryAlertRoutes();
    this.sr_level_routes = new SRLevelRoutes();
    this.monitoring_manager = MonitoringManager.getInstance();
    this.volume_monitor_repository = new VolumeMonitorRepository();
    this.pattern_scan_service = new PatternScanService();
    this.orderbook_monitor_service = new OrderBookMonitorService();
    this.trend_follow_repository = new TrendFollowRepository();
    this.ema20_push_repository = new EMA20PushRepository();
    this.trade_record_routes = new TradeRecordRoutes();
    this.setup_middleware();
    this.setup_routes();
    this.init_volume_monitor_services();
    this.init_orderbook_monitor_service();
    this.init_trade_record_service();
    this.init_trend_follow_services();
    this.init_ema20_push_services();
  }

  /**
   * 初始化成交量监控相关服务
   */
  private async init_volume_monitor_services(): Promise<void> {
    try {
      await this.volume_monitor_repository.init_tables();
      await this.pattern_scan_service.init();
      set_volume_monitor_repository(this.volume_monitor_repository);
      set_pattern_scan_service(this.pattern_scan_service);
      logger.info('[APIServer] Volume monitor services initialized');
    } catch (error) {
      logger.error('[APIServer] Failed to init volume monitor services:', error);
    }
  }

  /**
   * 初始化订单簿监控服务
   * 暂时禁用订单簿 WebSocket 订阅
   */
  private async init_orderbook_monitor_service(): Promise<void> {
    try {
      await this.orderbook_monitor_service.init();
      set_orderbook_service(this.orderbook_monitor_service);

      // 暂时禁用订单簿 WebSocket 订阅
      // const symbols = await this.get_all_futures_symbols();
      // this.start_depth_websocket(symbols);

      logger.info('[APIServer] OrderBook monitor service initialized (WebSocket disabled)');
    } catch (error) {
      logger.error('[APIServer] Failed to init orderbook monitor service:', error);
    }
  }

  /**
   * 初始化趋势跟随服务
   */
  private async init_trend_follow_services(): Promise<void> {
    try {
      await this.trend_follow_repository.init_tables();
      set_trend_follow_repository(this.trend_follow_repository);
      logger.info('[APIServer] Trend follow services initialized');
    } catch (error) {
      logger.error('[APIServer] Failed to init trend follow services:', error);
    }
  }

  /**
   * 初始化交易日志服务
   */
  private async init_trade_record_service(): Promise<void> {
    try {
      await TradeLogService.get_instance().init();
      logger.info('[APIServer] Trade record service initialized');
    } catch (error) {
      logger.error('[APIServer] Failed to init trade record service:', error);
    }
  }

  private async init_ema20_push_services(): Promise<void> {
    try {
      await this.ema20_push_repository.init_tables();
      set_ema20_push_repository(this.ema20_push_repository);
      logger.info('[APIServer] EMA20 push services initialized');
    } catch (error) {
      logger.error('[APIServer] Failed to init ema20 push services:', error);
    }
  }

  /**
   * 获取所有U本位合约交易对
   */
  private async get_all_futures_symbols(): Promise<string[]> {
    try {
      const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
      const response = await axios.get(url);
      return response.data.symbols
        .filter((s: any) =>
          s.status === 'TRADING' &&
          s.contractType === 'PERPETUAL' &&
          s.symbol.endsWith('USDT')
        )
        .map((s: any) => s.symbol);
    } catch (error) {
      logger.error('[APIServer] Failed to get futures symbols:', error);
      return [];
    }
  }

  /**
   * 启动订单簿 WebSocket 连接
   */
  private start_depth_websocket(symbols: string[]): void {
    if (symbols.length === 0) {
      logger.warn('[APIServer] No symbols to subscribe for orderbook');
      return;
    }

    logger.info(`[APIServer] Subscribing to ${symbols.length} orderbook streams...`);

    // 构建订阅流: symbol@depth20@500ms
    const streams = symbols.map(s => `${s.toLowerCase()}@depth20@500ms`).join('/');
    const ws_url = `wss://fstream.binance.com/stream?streams=${streams}`;

    this.ws_depth = new WebSocket(ws_url);

    this.ws_depth.on('open', () => {
      logger.info('[APIServer] OrderBook WebSocket connected');
    });

    this.ws_depth.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.data && msg.data.e === 'depthUpdate') {
          const depth_data: BinanceDepthUpdate = msg.data;
          await this.orderbook_monitor_service.process_depth_update(depth_data);
        }
      } catch (error) {
        // 静默处理解析错误，避免日志过多
      }
    });

    this.ws_depth.on('error', (error) => {
      logger.error('[APIServer] OrderBook WebSocket error:', error);
    });

    this.ws_depth.on('close', () => {
      logger.warn('[APIServer] OrderBook WebSocket disconnected, reconnecting in 5s...');
      setTimeout(() => this.start_depth_websocket(symbols), 5000);
    });
  }

  /**
   * 设置中间件
   */
  private setup_middleware(): void {
    // CORS支持
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true
    }));

    // JSON解析
    this.app.use(express.json({ limit: '10mb' }));

    // URL编码支持
    this.app.use(express.urlencoded({ extended: true }));

    // 请求日志和性能监控中间件
    this.app.use((req: Request, res: Response, next) => {
      const start_time = Date.now();

      // 跳过频繁的健康检查和前端轮询请求的日志
      const should_log = !req.path.includes('/health') &&
                        !req.path.includes('/recent-alerts') &&
                        !req.path.includes('/favicon.ico') &&
                        !req.path.includes('/sitemap.xml');

      if (should_log) {
        logger.api(`${req.method} ${req.path}`, {
          query: req.query,
          body: req.method !== 'GET' ? req.body : undefined
        });
      }

      // 监听响应完成事件
      res.on('finish', () => {
        const response_time = Date.now() - start_time;
        const is_error = res.statusCode >= 400;

        // 记录API性能指标
        this.monitoring_manager.record_api_request(response_time, is_error);
      });

      next();
    });
  }

  /**
   * 设置路由
   */
  private setup_routes(): void {
    // 健康检查
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'trading-master-backend'
      });
    });

    // API根路径
    this.app.get('/api', (req: Request, res: Response) => {
      res.json({
        message: 'Trading Master Backend API',
        version: '1.0.0',
        endpoints: {
          health: '/health',
          oi: '/api/oi/*',
          monitoring: '/api/monitoring/*',
          'top-symbols': '/api/top-symbols/*',
          historical: '/api/historical/*',
          klines: '/api/klines/*',
          websocket: '/api/websocket/*',
          signals: '/api/signals/*',
          structure: '/api/structure/*',
          quant: '/api/quant/*',
          trading: '/api/trading/*',
          backtest: '/api/backtest/*',
          breakout: '/api/breakout/*',
          'boundary-alerts': '/api/boundary-alerts/*',
          sr: '/api/sr/*',
          'volume-monitor': '/api/volume-monitor/*',
          'pattern-scan': '/api/pattern-scan/*',
          orderbook: '/api/orderbook/*',
          status: '/api/status'
        },
        timestamp: new Date().toISOString()
      });
    });

    // OI相关路由
    this.app.use('/api/oi', this.oi_data_manager.get_api_routes());

    // 监控相关路由
    this.app.use('/api/monitoring', this.monitoring_routes.get_router());

    // TOP币种配置路由
    this.app.use('/api/top-symbols', this.top_symbols_routes.get_router());

    // 历史数据路由
    this.app.use('/api/historical', this.historical_data_routes.get_router());

    // K线数据查询路由
    this.app.use('/api/klines', this.klines_routes.get_router());

    // WebSocket状态查询路由
    this.app.use('/api/websocket', this.websocket_routes.get_router());

    // 交易信号路由
    this.app.use('/api/signals', this.signals_routes.get_router());

    // 结构形态路由
    this.app.use('/api/structure', this.structure_routes.get_router());

    // 量化交易路由
    this.app.use('/api/quant', quantitative_routes);

    // 自动交易路由
    this.app.use('/api/trading', this.trading_routes.router);

    // 回测路由
    this.app.use('/api/backtest', this.backtest_routes.router);

    // K线突破信号路由
    this.app.use('/api/breakout', this.breakout_routes.get_router());

    // 边界报警路由
    this.app.use('/api/boundary-alerts', this.boundary_alert_routes.get_router());

    // 支撑阻力位路由
    this.app.use('/api/sr', this.sr_level_routes.get_router());

    // 成交量监控路由
    this.app.use('/api/volume-monitor', volume_monitor_routes);

    // 形态扫描路由
    this.app.use('/api/pattern-scan', pattern_scan_routes);

    // 订单簿监控路由
    this.app.use('/api/orderbook', orderbook_monitor_routes);

    // 趋势跟随报警路由
    this.app.use('/api/trend-follow', trend_follow_routes);

    // EMA20 均线推动路由
    this.app.use('/api/ema20-push', ema20_push_routes);

    // 交易日志路由
    this.app.use('/api/trade-record', this.trade_record_routes.get_router());

    // 系统状态
    this.app.get('/api/status', async (req: Request, res: Response) => {
      try {
        const health_status = await this.oi_data_manager.get_health_status();
        res.json({
          success: true,
          data: health_status
        });
      } catch (error) {
        logger.error('[API] Failed to get system status:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get system status',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // 404处理
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.originalUrl,
        method: req.method
      });
    });

    // 错误处理中间件
    this.app.use((error: any, req: Request, res: Response, next: NextFunction) => {
      // 记录错误
      if (isBaseError(error)) {
        logger.error('[API] Request error:', error.getDetails());
      } else {
        logger.error('[API] Unhandled error:', error);
      }

      // 生成HTTP错误响应
      const { status, body } = ErrorHandler.createHttpError(error);

      res.status(status).json(body);
    });
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, '0.0.0.0', () => {
          logger.info(`🌐 API Server started on http://0.0.0.0:${this.port}`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          if (error.code === 'EADDRINUSE') {
            logger.error(`❌ Port ${this.port} is already in use`);
            reject(new Error(`Port ${this.port} is already in use`));
          } else {
            logger.error('❌ Server error:', error);
            reject(error);
          }
        });

      } catch (error) {
        logger.error('❌ Failed to start API server:', error);
        reject(error);
      }
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    // 关闭订单簿 WebSocket
    if (this.ws_depth) {
      this.ws_depth.close();
      this.ws_depth = null;
    }

    // 停止订单簿监控服务
    if (this.orderbook_monitor_service) {
      this.orderbook_monitor_service.stop();
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('🛑 API Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * 获取Express应用实例
   */
  get_app(): Express {
    return this.app;
  }

  /**
   * 获取服务器端口
   */
  get_port(): number {
    return this.port;
  }
}