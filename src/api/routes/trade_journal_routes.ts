/**
 * 交易日志 API 路由
 *
 * POST /api/journal/analyze        入场评估（聚合数据 + Claude 分析，返回 journal_id）
 * POST /api/journal/:id/open       确认开仓（analyzing → open）
 * POST /api/journal/:id/dismiss    放弃开仓（analyzing → dismissed）
 * POST /api/journal/:id/reassess   持仓中再评估（传入当前价和疑虑）
 * POST /api/journal/:id/close      手动平仓 + 生成复盘（open → closed）
 * GET  /api/journal/list           查询列表（支持 ?status=open|closed|analyzing|dismissed）
 * GET  /api/journal/stats          盈亏统计
 * GET  /api/journal/:id            查询单条详情（含所有评估记录和复盘）
 */

import { Router, Request, Response } from 'express';
import { TradeJournalService } from '@/services/trade_journal_service';
import { logger } from '@/utils/logger';

export class TradeJournalRoutes {
  private router: Router;
  private service: TradeJournalService;

  constructor() {
    this.router = Router();
    this.service = TradeJournalService.get_instance();
    this.setup_routes();
  }

  private setup_routes(): void {
    // 注意：静态路径（list/stats）必须在动态路径（:id）之前注册
    this.router.post('/analyze', this.analyze_entry.bind(this));
    this.router.get('/records', this.get_list.bind(this));
    this.router.get('/stats', this.get_stats.bind(this));
    this.router.get('/calibration', this.get_calibration.bind(this));
    this.router.post('/:id/open', this.confirm_open.bind(this));
    this.router.post('/:id/dismiss', this.dismiss.bind(this));
    this.router.post('/:id/reassess', this.reassess.bind(this));
    this.router.post('/:id/close', this.close_trade.bind(this));
    this.router.get('/:id', this.get_detail.bind(this));
  }

  /**
   * 入场评估
   * POST /api/journal/analyze
   * Body: { symbol, direction, entry_reason, planned_entry_price?, planned_stop_loss?, planned_take_profit? }
   */
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

      // 立即返回 journal_id，AI 分析在后台异步执行
      // 前端轮询 GET /api/journal/:id，analyses 有数据则分析完成
      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] analyze_entry failed:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 确认开仓
   * POST /api/journal/:id/open
   */
  private async confirm_open(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      await this.service.confirm_open(id);
      res.json({ success: true, message: `Journal #${id} is now open`, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] confirm_open failed:', error);
      const is_state_error = error instanceof Error && error.message.includes('not in analyzing');
      res.status(is_state_error ? 400 : 500).json({
        success: false,
        error: is_state_error ? 'Invalid state' : 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 放弃开仓
   * POST /api/journal/:id/dismiss
   */
  private async dismiss(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      await this.service.dismiss(id);
      res.json({ success: true, message: `Journal #${id} dismissed`, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] dismiss failed:', error);
      const is_state_error = error instanceof Error && error.message.includes('not in analyzing');
      res.status(is_state_error ? 400 : 500).json({
        success: false,
        error: is_state_error ? 'Invalid state' : 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 持仓中再评估
   * POST /api/journal/:id/reassess
   * Body: { current_price, concern }
   */
  private async reassess(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const { current_price, concern } = req.body;

      if (!current_price || !concern) {
        res.status(400).json({ success: false, error: 'Missing required fields: current_price, concern' });
        return;
      }

      const result = await this.service.reassess({
        journal_id: id,
        current_price: Number(current_price),
        concern,
      });

      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] reassess failed:', error);
      const is_state_error = error instanceof Error && error.message.includes('not open');
      res.status(is_state_error ? 400 : 500).json({
        success: false,
        error: is_state_error ? 'Invalid state' : 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 手动平仓 + 生成复盘
   * POST /api/journal/:id/close
   * Body: { actual_exit_price, exit_reason, planned_entry_price? }
   */
  private async close_trade(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const { actual_exit_price, exit_reason, planned_entry_price } = req.body;

      if (!actual_exit_price || !exit_reason) {
        res.status(400).json({ success: false, error: 'Missing required fields: actual_exit_price, exit_reason' });
        return;
      }

      const result = await this.service.close_and_review({
        journal_id: id,
        actual_exit_price: Number(actual_exit_price),
        exit_reason,
        planned_entry_price: planned_entry_price != null ? Number(planned_entry_price) : undefined,
      });

      res.json({ success: true, data: result, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] close_trade failed:', error);
      const is_state_error = error instanceof Error && error.message.includes('not open');
      res.status(is_state_error ? 400 : 500).json({
        success: false,
        error: is_state_error ? 'Invalid state' : 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 查询列表
   * GET /api/journal/list?status=open&limit=20&offset=0
   */
  private async get_list(req: Request, res: Response): Promise<void> {
    try {
      const { status, limit = '20', offset = '0' } = req.query;
      const list = await this.service.get_journal_list(
        status as string | undefined,
        Math.min(parseInt(limit as string) || 20, 100),
        parseInt(offset as string) || 0,
      );
      res.json({ success: true, data: { count: list.length, list }, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] get_list failed:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 盈亏统计
   * GET /api/journal/stats
   */
  private async get_stats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.service.get_stats();
      res.json({ success: true, data: stats, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] get_stats failed:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 置信度校准统计
   * GET /api/journal/calibration
   */
  private async get_calibration(_req: Request, res: Response): Promise<void> {
    try {
      const data = await this.service.get_calibration();
      res.json({ success: true, data, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] get_calibration failed:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 查询单条详情（含所有评估记录和复盘）
   * GET /api/journal/:id
   */
  private async get_detail(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const detail = await this.service.get_journal_detail(id);

      if (!detail.journal) {
        res.status(404).json({ success: false, error: `Journal #${id} not found` });
        return;
      }

      res.json({ success: true, data: detail, timestamp: Date.now() });
    } catch (error) {
      logger.error('[TradeJournalAPI] get_detail failed:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  get_router(): Router {
    return this.router;
  }
}
