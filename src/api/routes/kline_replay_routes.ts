/**
 * K线回放 + 模拟交易 API 路由
 *
 * 会话
 *   GET    /api/replay/data-coverage                 5m 数据覆盖区间（选起点用）
 *   POST   /api/replay/sessions                      创建会话
 *   GET    /api/replay/sessions                      会话列表
 *   GET    /api/replay/sessions/:id                  会话快照（账户/持仓/挂单/当前K线）
 *   PATCH  /api/replay/sessions/:id                  修改名称/备注
 *   DELETE /api/replay/sessions/:id                  删除会话（含全部交易记录）
 *   POST   /api/replay/sessions/:id/finish           结束会话（平仓撤单）
 *
 * 回放
 *   GET    /api/replay/sessions/:id/klines           游标视角K线（interval=5m/15m/1h/4h）
 *   POST   /api/replay/sessions/:id/step             推进（下一步 / 快进）
 *
 * 交易
 *   POST   /api/replay/sessions/:id/orders           下单
 *   GET    /api/replay/sessions/:id/orders           委托列表
 *   DELETE /api/replay/sessions/:id/orders/:order_id 撤单
 *   PATCH  /api/replay/sessions/:id/position         改持仓止损/止盈
 *   POST   /api/replay/sessions/:id/position/close   市价平仓
 *   GET    /api/replay/sessions/:id/positions        仓位回合列表
 *   PATCH  /api/replay/sessions/:id/positions/:position_id  复盘标签/笔记
 *   GET    /api/replay/sessions/:id/fills            成交明细
 *
 * 统计
 *   GET    /api/replay/sessions/:id/stats            单会话统计
 *   GET    /api/replay/stats                         跨会话累计统计
 */

import { Router, Request, Response } from 'express';
import { KlineReplayService, ReplayError } from '@/services/kline_replay/kline_replay_service';
import { ReplayOrderStatus, ReplaySessionStatus } from '@/services/kline_replay/replay_types';
import { logger } from '@/utils/logger';

type Handler = (req: Request) => Promise<unknown>;

/** 可选数字 query 参数 */
function query_number(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 路径参数转整数 id */
function param_id(req: Request, name: string): number {
  return Number(req.params[name]);
}

export class KlineReplayRoutes {
  private router: Router;
  private service: KlineReplayService;

  constructor() {
    this.router = Router();
    this.service = KlineReplayService.get_instance();
    this.setup_routes();
  }

  /** 初始化表结构 */
  async init(): Promise<void> {
    await this.service.init();
  }

  /** 进程退出前落库内存中的回放进度 */
  async shutdown(): Promise<void> {
    await this.service.shutdown();
  }

  get_router(): Router {
    return this.router;
  }

  /** 统一包装：成功返回 {success, data}，业务错误按状态码返回 */
  private wrap(handler: Handler) {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        const data = await handler(req);
        res.json({ success: true, data });
      } catch (error: any) {
        if (error instanceof ReplayError) {
          res.status(error.status_code).json({ success: false, error: error.message });
          return;
        }
        logger.error(`[KlineReplay API] ${req.method} ${req.originalUrl} failed:`, error);
        res.status(500).json({ success: false, error: error?.message ?? 'Internal error' });
      }
    };
  }

  private setup_routes(): void {
    const s = this.service;
    const r = this.router;

    r.get('/data-coverage', this.wrap(() => s.get_data_coverage()));

    // ---------- 会话 ----------
    r.post('/sessions', this.wrap(req => s.create_session({
      ...req.body,
      start_time: Number(req.body?.start_time),
    })));

    r.get('/sessions', this.wrap(req => s.list_sessions({
      status: req.query.status as ReplaySessionStatus | undefined,
      symbol: req.query.symbol as string | undefined,
      limit: query_number(req.query.limit),
      offset: query_number(req.query.offset),
    })));

    r.get('/sessions/:id', this.wrap(req => s.get_snapshot(param_id(req, 'id'))));

    r.patch('/sessions/:id', this.wrap(req => s.update_session_meta(param_id(req, 'id'), {
      name: req.body?.name,
      note: req.body?.note,
    })));

    r.delete('/sessions/:id', this.wrap(async req => {
      await s.delete_session(param_id(req, 'id'));
      return { deleted: true };
    }));

    r.post('/sessions/:id/finish', this.wrap(req => s.finish_session(param_id(req, 'id'))));

    // ---------- 回放 ----------
    r.get('/sessions/:id/klines', this.wrap(req => s.get_klines(
      param_id(req, 'id'),
      String(req.query.interval || '5m'),
      query_number(req.query.limit) ?? 300,
    )));

    r.post('/sessions/:id/step', this.wrap(req => s.step(param_id(req, 'id'), {
      bars: query_number(req.body?.bars),
      until_time: query_number(req.body?.until_time),
      stop_on: req.body?.stop_on,
      intervals: Array.isArray(req.body?.intervals) ? req.body.intervals : undefined,
    })));

    // ---------- 交易 ----------
    r.post('/sessions/:id/orders', this.wrap(req => s.place_order(param_id(req, 'id'), req.body ?? {})));

    r.get('/sessions/:id/orders', this.wrap(req => s.list_orders(
      param_id(req, 'id'),
      req.query.status as ReplayOrderStatus | undefined,
    )));

    r.delete('/sessions/:id/orders/:order_id', this.wrap(req => s.cancel_order(
      param_id(req, 'id'),
      param_id(req, 'order_id'),
    )));

    r.patch('/sessions/:id/position', this.wrap(req => s.update_protection(param_id(req, 'id'), {
      stop_loss: req.body?.stop_loss,
      take_profit: req.body?.take_profit,
    })));

    r.post('/sessions/:id/position/close', this.wrap(req => s.close_position(param_id(req, 'id'), req.body?.qty)));

    r.get('/sessions/:id/positions', this.wrap(req => s.list_positions(
      param_id(req, 'id'),
      req.query.status as 'open' | 'closed' | undefined,
    )));

    r.patch('/sessions/:id/positions/:position_id', this.wrap(req => s.update_position_journal(
      param_id(req, 'id'),
      param_id(req, 'position_id'),
      { tags: req.body?.tags, note: req.body?.note },
    )));

    r.get('/sessions/:id/fills', this.wrap(req => s.list_fills(param_id(req, 'id'))));

    // ---------- 统计 ----------
    r.get('/sessions/:id/stats', this.wrap(req => s.get_session_stats(param_id(req, 'id'))));

    r.get('/stats', this.wrap(req => s.get_overall_stats({
      session_ids: typeof req.query.session_ids === 'string'
        ? req.query.session_ids.split(',').map(Number).filter(n => n > 0)
        : undefined,
      symbol: req.query.symbol as string | undefined,
      direction: req.query.direction as string | undefined,
      tag: req.query.tag as string | undefined,
      start_time: query_number(req.query.start_time),
      end_time: query_number(req.query.end_time),
    })));
  }
}
