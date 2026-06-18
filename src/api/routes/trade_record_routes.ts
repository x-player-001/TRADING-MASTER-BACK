/**
 * 交易记录 API 路由（AI 复盘业务，以币安真实成交为主体）
 *
 * POST /api/trade-record/analyze        入场评估（返回 log_id，AI 异步分析）
 * POST /api/trade-record/sync           全局同步：拉真实成交→切回合→落库→复盘
 * GET  /api/trade-record/records         列表（?status=open|closed|analyzing|dismissed）
 * GET  /api/trade-record/stats           盈亏统计（基于真实 realized_pnl）
 * GET  /api/trade-record/calibration     置信度校准
 * POST /api/trade-record/:id/sync        单条同步
 * POST /api/trade-record/:id/dismiss     放弃评估（analyzing → dismissed）
 * POST /api/trade-record/:id/reassess    持仓中再评估
 * GET  /api/trade-record/:id             详情（含评估记录与复盘）
 */

import { Router, Request, Response } from 'express';
import { TradeLogService } from '@/services/trade_log_service';
import { logger } from '@/utils/logger';

export class TradeRecordRoutes {
  private router: Router;
  private service: TradeLogService;

  constructor() {
    this.router = Router();
    this.service = TradeLogService.get_instance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 静态路径必须在动态 :id 之前注册
    this.router.post('/analyze', this.analyze_entry.bind(this));
    this.router.post('/sync', this.sync_all.bind(this));
    this.router.get('/records', this.get_list.bind(this));
    this.router.get('/stats', this.get_stats.bind(this));
    this.router.get('/calibration', this.get_calibration.bind(this));
    this.router.post('/:id/sync', this.sync_one.bind(this));
    this.router.post('/:id/dismiss', this.dismiss.bind(this));
    this.router.post('/:id/reassess', this.reassess.bind(this));
    this.router.get('/:id', this.get_detail.bind(this));
  }

  /** 入场评估 */
  private async analyze_entry(req: Request, res: Response): Promise<void> {
    try {
      const { symbol, direction, entry_reason, planned_entry_price, planned_stop_loss, planned_take_profit, end_time, timeframe } = req.body;
      if (!symbol || !direction || entry_reason === undefined || entry_reason === null) {
        res.status(400).json({ success: false, error: 'Missing required fields: symbol, direction, entry_reason' });
        return;
      }
      if (direction !== 'LONG' && direction !== 'SHORT') {
        res.status(400).json({ success: false, error: 'direction must be LONG or SHORT' });
        return;
      }
      const result = await this.service.analyze_entry({
        symbol: (symbol as string).toUpperCase(),
        direction,
        entry_reason,
        planned_entry_price: planned_entry_price ? Number(planned_entry_price) : undefined,
        planned_stop_loss: planned_stop_loss ? Number(planned_stop_loss) : undefined,
        planned_take_profit: planned_take_profit ? Number(planned_take_profit) : undefined,
        end_time: end_time != null ? Number(end_time) : undefined,
        timeframe: timeframe as string | undefined,
      });
      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] analyze_entry failed:', error);
      res.status(500).json({ success: false, error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 全局同步 */
  private async sync_all(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.service.sync_all();
      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] sync_all failed:', error);
      res.status(500).json({ success: false, error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 单条同步 */
  private async sync_one(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const result = await this.service.sync_one(id);
      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] sync_one failed:', error);
      const is_not_found = error instanceof Error && error.message.includes('not found');
      res.status(is_not_found ? 404 : 500).json({ success: false, error: is_not_found ? 'Not found' : 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 放弃评估 */
  private async dismiss(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      await this.service.dismiss(id);
      res.json({ success: true, message: `Record #${id} dismissed`, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] dismiss failed:', error);
      const is_state_error = error instanceof Error && error.message.includes('not in analyzing');
      res.status(is_state_error ? 400 : 500).json({ success: false, error: is_state_error ? 'Invalid state' : 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 持仓中再评估 */
  private async reassess(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const { current_price, concern } = req.body;
      if (!current_price || !concern) {
        res.status(400).json({ success: false, error: 'Missing required fields: current_price, concern' });
        return;
      }
      const result = await this.service.reassess({ log_id: id, current_price: Number(current_price), concern });
      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] reassess failed:', error);
      const is_state_error = error instanceof Error && error.message.includes('not open');
      res.status(is_state_error ? 400 : 500).json({ success: false, error: is_state_error ? 'Invalid state' : 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 列表 */
  private async get_list(req: Request, res: Response): Promise<void> {
    try {
      const { status, limit = '20', offset = '0' } = req.query;
      const list = await this.service.get_list(
        status as string | undefined,
        Math.min(parseInt(limit as string) || 20, 100),
        parseInt(offset as string) || 0,
      );
      res.json({ success: true, data: { count: list.length, list }, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] get_list failed:', error);
      res.status(500).json({ success: false, error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 盈亏统计 */
  private async get_stats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.service.get_stats();
      res.json({ success: true, data: stats, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] get_stats failed:', error);
      res.status(500).json({ success: false, error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 置信度校准 */
  private async get_calibration(_req: Request, res: Response): Promise<void> {
    try {
      const data = await this.service.get_calibration();
      res.json({ success: true, data, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] get_calibration failed:', error);
      res.status(500).json({ success: false, error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** 详情 */
  private async get_detail(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const detail = await this.service.get_detail(id);
      if (!detail.log) {
        res.status(404).json({ success: false, error: `Record #${id} not found` });
        return;
      }
      res.json({ success: true, data: detail, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeRecordAPI] get_detail failed:', error);
      res.status(500).json({ success: false, error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  get_router(): Router {
    return this.router;
  }
}
