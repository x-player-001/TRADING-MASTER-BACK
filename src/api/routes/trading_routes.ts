/**
 * 交易系统API路由
 */

import { Router, Request, Response } from 'express';
import { OIPollingService } from '../../services/oi_polling_service';
import { TradingMode, StrategyType } from '../../types/trading_types';

export class TradingRoutes {
  public router: Router;
  private oi_polling_service: OIPollingService;

  constructor(oi_polling_service: OIPollingService) {
    this.router = Router();
    this.oi_polling_service = oi_polling_service;
    this.initialize_routes();
  }

  private initialize_routes(): void {
    // 获取交易系统状态
    this.router.get('/status', this.get_status.bind(this));

    // 获取所有持仓
    this.router.get('/positions', this.get_positions.bind(this));

    // 获取开仓持仓
    this.router.get('/positions/open', this.get_open_positions.bind(this));

    // 获取交易统计
    this.router.get('/statistics', this.get_statistics.bind(this));

    // 手动平仓
    this.router.post('/positions/:id/close', this.close_position.bind(this));

    // 启用/禁用交易系统
    this.router.post('/enable', this.enable_trading.bind(this));
    this.router.post('/disable', this.disable_trading.bind(this));

    // 更新配置
    this.router.put('/config', this.update_config.bind(this));

    // 获取配置
    this.router.get('/config', this.get_config.bind(this));

    // 切换交易模式
    this.router.post('/mode', this.set_mode.bind(this));

    // 风险管理
    this.router.get('/risk/status', this.get_risk_status.bind(this));
    this.router.post('/risk/resume', this.resume_trading.bind(this));
  }

  /**
   * 获取交易系统状态
   */
  private async get_status(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.json({
          success: false,
          error: 'Trading system not initialized',
          message: 'Call POST /api/trading/enable to initialize'
        });
        return;
      }

      const status = trading_system.get_status();

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to get status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get trading status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取所有持仓
   */
  private async get_positions(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const positions = trading_system.get_positions();

      res.json({
        success: true,
        data: positions,
        count: positions.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to get positions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get positions',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取开仓持仓
   */
  private async get_open_positions(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const positions = trading_system.get_open_positions();

      res.json({
        success: true,
        data: positions,
        count: positions.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to get open positions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get open positions',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取交易统计
   */
  private async get_statistics(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const statistics = trading_system.get_statistics();

      res.json({
        success: true,
        data: statistics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to get statistics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get statistics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 手动平仓
   */
  private async close_position(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const position_id = parseInt(req.params.id);
      const { current_price } = req.body;

      if (!current_price) {
        res.status(400).json({
          success: false,
          error: 'Missing required parameter: current_price'
        });
        return;
      }

      const success = await trading_system.close_position_manual(position_id, current_price);

      if (success) {
        res.json({
          success: true,
          message: `Position ${position_id} closed successfully`,
          timestamp: new Date().toISOString()
        });
      } else {
        res.status(404).json({
          success: false,
          error: `Position ${position_id} not found or already closed`
        });
      }
    } catch (error) {
      console.error('[TradingRoutes] Failed to close position:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to close position',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 启用交易系统
   */
  private async enable_trading(req: Request, res: Response): Promise<void> {
    try {
      let trading_system = this.oi_polling_service.get_trading_system();

      // 如果交易系统未初始化，先初始化
      if (!trading_system) {
        this.oi_polling_service.initialize_trading_system(true);
        trading_system = this.oi_polling_service.get_trading_system();
      } else {
        trading_system.set_enabled(true);
      }

      res.json({
        success: true,
        message: 'Trading system enabled',
        data: trading_system?.get_status(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to enable trading:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to enable trading',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 禁用交易系统
   */
  private async disable_trading(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      trading_system.set_enabled(false);

      res.json({
        success: true,
        message: 'Trading system disabled',
        data: trading_system.get_status(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to disable trading:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to disable trading',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 更新配置
   */
  private async update_config(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const new_config = req.body;
      trading_system.update_config(new_config);

      res.json({
        success: true,
        message: 'Configuration updated',
        data: trading_system.get_config(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to update config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update configuration',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取配置
   */
  private async get_config(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const config = trading_system.get_config();

      res.json({
        success: true,
        data: config,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to get config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get configuration',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 切换交易模式
   */
  private async set_mode(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const { mode } = req.body;

      if (!mode || !['PAPER', 'TESTNET', 'LIVE'].includes(mode)) {
        res.status(400).json({
          success: false,
          error: 'Invalid mode. Must be one of: PAPER, TESTNET, LIVE'
        });
        return;
      }

      trading_system.update_config({ mode: mode as TradingMode });

      res.json({
        success: true,
        message: `Trading mode set to ${mode}`,
        data: trading_system.get_status(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to set mode:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to set trading mode',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 获取风险状态
   */
  private async get_risk_status(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      const status = trading_system.get_status();

      res.json({
        success: true,
        data: status.risk_status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to get risk status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get risk status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * 恢复交易（解除风险暂停）
   */
  private async resume_trading(req: Request, res: Response): Promise<void> {
    try {
      const trading_system = this.oi_polling_service.get_trading_system();

      if (!trading_system) {
        res.status(404).json({
          success: false,
          error: 'Trading system not initialized'
        });
        return;
      }

      // TODO: 实现 resume_trading 方法
      // trading_system.resume_trading();

      res.json({
        success: true,
        message: 'Trading resumed',
        data: trading_system.get_status(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TradingRoutes] Failed to resume trading:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to resume trading',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
