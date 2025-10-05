import { Router, Request, Response } from 'express';
import { TopSymbolsManager } from '@/core/config/top_symbols_manager';
import { TopSymbolConfig } from '@/types/common';

/**
 * TOP币种配置API路由
 */
export class TopSymbolsRoutes {
  private router: Router;
  private top_symbols_manager: TopSymbolsManager;

  constructor() {
    this.router = Router();
    this.top_symbols_manager = TopSymbolsManager.get_instance();
    this.setup_routes();
  }

  /**
   * 设置路由
   */
  private setup_routes(): void {
    // 获取所有TOP币种配置
    this.router.get('/', this.get_all_symbols.bind(this));

    // 获取启用的TOP币种配置
    this.router.get('/enabled', this.get_enabled_symbols.bind(this));

    // 获取单个币种配置
    this.router.get('/:symbol', this.get_symbol.bind(this));

    // 创建币种配置
    this.router.post('/', this.create_symbol.bind(this));

    // 更新币种配置
    this.router.put('/:symbol', this.update_symbol.bind(this));

    // 删除币种配置
    this.router.delete('/:symbol', this.delete_symbol.bind(this));

    // 批量更新排序
    this.router.put('/batch/order', this.update_symbols_order.bind(this));

    // 启用/禁用币种
    this.router.put('/:symbol/toggle', this.toggle_symbol_enabled.bind(this));

    // 获取订阅流配置
    this.router.get('/subscription/streams', this.get_subscription_streams.bind(this));

    // 获取统计信息
    this.router.get('/statistics', this.get_statistics.bind(this));
  }

  /**
   * 获取所有TOP币种配置
   */
  private async get_all_symbols(req: Request, res: Response): Promise<void> {
    try {
      const symbols = await this.top_symbols_manager.get_all_symbols();

      res.json({
        success: true,
        data: symbols,
        count: symbols.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to get all symbols:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get TOP symbols',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 获取启用的TOP币种配置
   */
  private async get_enabled_symbols(req: Request, res: Response): Promise<void> {
    try {
      const symbols = await this.top_symbols_manager.get_enabled_symbols();

      res.json({
        success: true,
        data: symbols,
        count: symbols.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to get enabled symbols:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get enabled TOP symbols',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 获取单个币种配置
   */
  private async get_symbol(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;

      if (!symbol) {
        res.status(400).json({
          success: false,
          error: 'Missing symbol parameter',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const config = await this.top_symbols_manager.get_symbol_by_name(symbol.toUpperCase());

      if (!config) {
        res.status(404).json({
          success: false,
          error: 'Symbol not found',
          timestamp: new Date().toISOString()
        });
        return;
      }

      res.json({
        success: true,
        data: config,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to get symbol:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get symbol',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 创建币种配置
   */
  private async create_symbol(req: Request, res: Response): Promise<void> {
    try {
      const config: Omit<TopSymbolConfig, 'id' | 'created_at' | 'updated_at'> = req.body;

      // 验证必填字段
      if (!config.symbol || !config.display_name || !config.rank_order) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: symbol, display_name, rank_order',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // 设置默认值
      config.symbol = config.symbol.toUpperCase();
      config.enabled = config.enabled !== undefined ? config.enabled : true;
      config.subscription_intervals = config.subscription_intervals || ['15m', '1h'];

      const id = await this.top_symbols_manager.create_symbol(config);

      res.status(201).json({
        success: true,
        message: `Created TOP symbol: ${config.symbol}`,
        data: { id, symbol: config.symbol },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to create symbol:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create symbol',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 更新币种配置
   */
  private async update_symbol(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const updates: Partial<TopSymbolConfig> = req.body;

      if (!symbol) {
        res.status(400).json({
          success: false,
          error: 'Missing symbol parameter',
          timestamp: new Date().toISOString()
        });
        return;
      }

      await this.top_symbols_manager.update_symbol(symbol.toUpperCase(), updates);

      res.json({
        success: true,
        message: `Updated TOP symbol: ${symbol}`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to update symbol:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update symbol',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 删除币种配置
   */
  private async delete_symbol(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;

      if (!symbol) {
        res.status(400).json({
          success: false,
          error: 'Missing symbol parameter',
          timestamp: new Date().toISOString()
        });
        return;
      }

      await this.top_symbols_manager.delete_symbol(symbol.toUpperCase());

      res.json({
        success: true,
        message: `Deleted TOP symbol: ${symbol}`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to delete symbol:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete symbol',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 批量更新排序
   */
  private async update_symbols_order(req: Request, res: Response): Promise<void> {
    try {
      const updates: Array<{ symbol: string; rank_order: number }> = req.body;

      if (!Array.isArray(updates) || updates.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid updates format. Expected array of {symbol, rank_order}',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // 转换为大写
      const formatted_updates = updates.map(u => ({
        symbol: u.symbol.toUpperCase(),
        rank_order: u.rank_order
      }));

      await this.top_symbols_manager.update_symbols_order(formatted_updates);

      res.json({
        success: true,
        message: `Updated ${updates.length} symbols order`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to update symbols order:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update symbols order',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 启用/禁用币种
   */
  private async toggle_symbol_enabled(req: Request, res: Response): Promise<void> {
    try {
      const { symbol } = req.params;
      const { enabled } = req.body;

      if (!symbol) {
        res.status(400).json({
          success: false,
          error: 'Missing symbol parameter',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'Invalid enabled value. Expected boolean',
          timestamp: new Date().toISOString()
        });
        return;
      }

      await this.top_symbols_manager.toggle_symbol_enabled(symbol.toUpperCase(), enabled);

      res.json({
        success: true,
        message: `${enabled ? 'Enabled' : 'Disabled'} TOP symbol: ${symbol}`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to toggle symbol enabled:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to toggle symbol enabled',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 获取订阅流配置
   */
  private async get_subscription_streams(req: Request, res: Response): Promise<void> {
    try {
      const streams = await this.top_symbols_manager.get_subscription_streams();

      res.json({
        success: true,
        data: streams,
        count: streams.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to get subscription streams:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get subscription streams',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 获取统计信息
   */
  private async get_statistics(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.top_symbols_manager.get_statistics();

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TopSymbolsRoutes] Failed to get statistics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 获取路由实例
   */
  get_router(): Router {
    return this.router;
  }
}