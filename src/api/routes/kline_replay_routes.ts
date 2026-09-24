/**
 * K线回放 + 模拟交易 API 路由（撮合在前端，后端只存储）
 *
 *   GET    /api/replay/data-coverage                 5m 数据覆盖区间（选起点用）
 *   POST   /api/replay/sessions                      创建会话
 *   GET    /api/replay/sessions                      会话列表
 *   GET    /api/replay/sessions/:id                  会话完整状态（恢复用：会话 + 游标K线 + 仓位/委托/成交）
 *   PATCH  /api/replay/sessions/:id                  修改名称/备注
 *   DELETE /api/replay/sessions/:id                  删除会话（含全部交易记录）
 *   GET    /api/replay/sessions/:id/bars             游标之后的 5m 批量块（前端逐根揭示）
 *   GET    /api/replay/sessions/:id/klines           截止某时刻的某周期历史K线
 *   POST   /api/replay/sessions/:id/sync             同步进度 + 整份交易记录（支持 sendBeacon）
 *   GET    /api/replay/sessions/:id/orders           委托列表
 *   GET    /api/replay/sessions/:id/stats            单会话统计
 *   GET    /api/replay/stats                         跨会话累计统计
 */

import express, { Router, Request, Response } from 'express';
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

/** 请求体：JSON 或 text/plain（sendBeacon）里的 JSON 字符串 */
function parse_body(req: Request): any {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new ReplayError('请求体不是合法 JSON');
    }
  }
  return req.body ?? {};
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
          res.status(error.status_code).json({ success: false, error: error.message, ...error.extra });
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

    r.get('/sessions/:id', this.wrap(req => s.get_state(param_id(req, 'id'))));

    r.patch('/sessions/:id', this.wrap(req => s.update_session_meta(param_id(req, 'id'), {
      name: req.body?.name,
      note: req.body?.note,
    })));

    r.delete('/sessions/:id', this.wrap(async req => {
      await s.delete_session(param_id(req, 'id'));
      return { deleted: true };
    }));

    // ---------- K线 ----------
    r.get('/sessions/:id/bars', this.wrap(req => s.get_bars(
      param_id(req, 'id'),
      query_number(req.query.after),
      query_number(req.query.limit) ?? 600,
    )));

    r.get('/sessions/:id/klines', this.wrap(req => s.get_klines(
      param_id(req, 'id'),
      String(req.query.interval || '5m'),
      query_number(req.query.end_time),
      query_number(req.query.limit) ?? 300,
    )));

    // ---------- 同步 ----------
    r.post(
      '/sessions/:id/sync',
      express.text({ type: 'text/plain', limit: '10mb' }),
      this.wrap(req => s.sync(param_id(req, 'id'), parse_body(req))),
    );

    r.get('/sessions/:id/orders', this.wrap(req => s.list_orders(
      param_id(req, 'id'),
      req.query.status as ReplayOrderStatus | undefined,
    )));

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
