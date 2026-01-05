/**
 * 订单簿监控 API 路由
 *
 * 接口:
 * - GET  /api/orderbook/snapshot/:symbol 获取实时订单簿快照
 * - GET  /api/orderbook/symbols          获取已缓存的币种列表
 * - GET  /api/orderbook/alerts           查询报警记录
 * - GET  /api/orderbook/alerts/recent    查询最近报警
 * - GET  /api/orderbook/statistics       获取统计数据
 * - GET  /api/orderbook/status           获取监控状态
 * - GET  /api/orderbook/config           获取监控配置
 * - PUT  /api/orderbook/config           更新监控配置
 * - DELETE /api/orderbook/alerts/cleanup 清理旧报警记录
 */

import { Router, Request, Response } from 'express';
import { OrderBookAlertRepository } from '@/database/orderbook_alert_repository';
import { OrderBookMonitorService } from '@/services/orderbook_monitor_service';
import { OrderBookAlertType, AlertSeverity } from '@/types/orderbook_types';
import { logger } from '@/utils/logger';

const router = Router();

// 全局实例（由主脚本注入）
let repository: OrderBookAlertRepository | null = null;
let service: OrderBookMonitorService | null = null;

/**
 * 设置Repository实例
 */
export function set_orderbook_repository(repo: OrderBookAlertRepository): void {
  repository = repo;
}

/**
 * 设置Service实例
 */
export function set_orderbook_service(svc: OrderBookMonitorService): void {
  service = svc;
  repository = svc.get_repository();
}

/**
 * 获取Repository实例
 */
function get_repository(): OrderBookAlertRepository {
  if (!repository) {
    repository = new OrderBookAlertRepository();
  }
  return repository;
}

/**
 * GET /api/orderbook/alerts
 * 查询报警记录
 *
 * Query params:
 * - symbol: string (可选)
 * - date: string (YYYY-MM-DD)
 * - alert_type: BIG_ORDER | IMBALANCE | WITHDRAWAL (可选)
 * - side: BID | ASK (可选)
 * - severity: LOW | MEDIUM | HIGH (可选)
 * - is_important: boolean (可选)
 * - limit: number (默认100)
 */
router.get('/alerts', async (req: Request, res: Response) => {
  try {
    const repo = get_repository();

    const alerts = await repo.get_alerts({
      symbol: req.query.symbol as string,
      date: req.query.date as string,
      alert_type: req.query.alert_type as OrderBookAlertType,
      side: req.query.side as 'BID' | 'ASK',
      severity: req.query.severity as AlertSeverity,
      is_important: req.query.is_important === 'true' ? true :
                    req.query.is_important === 'false' ? false : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 100
    });

    // 格式化输出
    const formatted = alerts.map(alert => ({
      ...alert,
      symbol: alert.symbol.replace('USDT', ''),
      order_value_usdt: alert.order_value_usdt ? Math.round(alert.order_value_usdt) : undefined,
      withdrawn_value_usdt: alert.withdrawn_value_usdt ? Math.round(alert.withdrawn_value_usdt) : undefined,
      order_ratio: alert.order_ratio ? parseFloat(alert.order_ratio.toFixed(1)) : undefined,
      imbalance_ratio: alert.imbalance_ratio ? parseFloat(alert.imbalance_ratio.toFixed(2)) : undefined
    }));

    res.json({
      success: true,
      data: formatted,
      count: formatted.length
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/orderbook/alerts/recent
 * 查询最近N分钟的报警
 *
 * Query params:
 * - minutes: number (默认30)
 * - symbol: string (可选)
 */
router.get('/alerts/recent', async (req: Request, res: Response) => {
  try {
    const repo = get_repository();
    const minutes = req.query.minutes ? parseInt(req.query.minutes as string) : 30;
    const symbol = req.query.symbol as string;

    const alerts = await repo.get_recent_alerts(minutes, symbol);

    // 格式化输出
    const formatted = alerts.map(alert => ({
      ...alert,
      symbol: alert.symbol.replace('USDT', ''),
      order_value_usdt: alert.order_value_usdt ? Math.round(alert.order_value_usdt) : undefined,
      withdrawn_value_usdt: alert.withdrawn_value_usdt ? Math.round(alert.withdrawn_value_usdt) : undefined,
      order_ratio: alert.order_ratio ? parseFloat(alert.order_ratio.toFixed(1)) : undefined,
      imbalance_ratio: alert.imbalance_ratio ? parseFloat(alert.imbalance_ratio.toFixed(2)) : undefined
    }));

    res.json({
      success: true,
      data: formatted,
      count: formatted.length,
      minutes
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get recent alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/orderbook/statistics
 * 获取统计数据
 *
 * Query params:
 * - date: string (YYYY-MM-DD, 可选，默认今天)
 */
router.get('/statistics', async (req: Request, res: Response) => {
  try {
    const repo = get_repository();

    // 默认今天（北京时间）
    let date = req.query.date as string;
    if (!date) {
      const now = new Date();
      const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      date = beijing.toISOString().split('T')[0];
    }

    const statistics = await repo.get_statistics(date);

    res.json({
      success: true,
      data: statistics,
      date
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get statistics failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/orderbook/snapshot/:symbol
 * 获取指定币种的实时订单簿快照
 */
router.get('/snapshot/:symbol', async (req: Request, res: Response) => {
  try {
    if (!service) {
      res.status(400).json({
        success: false,
        error: 'OrderBook monitor service not initialized'
      });
      return;
    }

    const symbol = req.params.symbol.toUpperCase();
    const snapshot = service.get_snapshot(symbol);

    if (!snapshot) {
      res.status(404).json({
        success: false,
        error: `No snapshot found for ${symbol}`,
        available_symbols: service.get_cached_symbols().slice(0, 20)
      });
      return;
    }

    // 格式化输出
    res.json({
      success: true,
      data: {
        symbol: snapshot.symbol,
        timestamp: snapshot.timestamp,
        current_price: snapshot.current_price,
        bids: snapshot.bids.map(l => ({
          price: l.price,
          qty: parseFloat(l.qty.toFixed(4)),
          value_usdt: Math.round(l.value)
        })),
        asks: snapshot.asks.map(l => ({
          price: l.price,
          qty: parseFloat(l.qty.toFixed(4)),
          value_usdt: Math.round(l.value)
        })),
        summary: {
          bid_total_qty: parseFloat(snapshot.bid_total_qty.toFixed(4)),
          ask_total_qty: parseFloat(snapshot.ask_total_qty.toFixed(4)),
          bid_total_value: Math.round(snapshot.bid_total_value),
          ask_total_value: Math.round(snapshot.ask_total_value),
          imbalance_ratio: parseFloat((snapshot.bid_total_qty / snapshot.ask_total_qty).toFixed(4))
        }
      }
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get snapshot failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/orderbook/symbols
 * 获取所有已缓存的币种列表
 */
router.get('/symbols', async (req: Request, res: Response) => {
  try {
    if (!service) {
      res.status(400).json({
        success: false,
        error: 'OrderBook monitor service not initialized'
      });
      return;
    }

    const symbols = service.get_cached_symbols();

    res.json({
      success: true,
      data: symbols,
      count: symbols.length
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get symbols failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/orderbook/status
 * 获取监控状态
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    if (!service) {
      res.json({
        success: true,
        data: {
          is_running: false,
          message: 'OrderBook monitor service not initialized'
        }
      });
      return;
    }

    const stats = service.get_statistics();

    res.json({
      success: true,
      data: {
        is_running: true,
        total_alerts: stats.total_alerts,
        big_order_alerts: stats.big_order_alerts,
        imbalance_alerts: stats.imbalance_alerts,
        withdrawal_alerts: stats.withdrawal_alerts,
        symbols_cached: stats.symbols_cached,
        symbols_warmed_up: stats.symbols_warmed_up,
        cooldown_entries: stats.cooldown_entries
      }
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get status failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/orderbook/config
 * 获取监控配置
 */
router.get('/config', async (req: Request, res: Response) => {
  try {
    if (!service) {
      res.status(400).json({
        success: false,
        error: 'OrderBook monitor service not initialized'
      });
      return;
    }

    const config = service.get_config();

    res.json({
      success: true,
      data: {
        ...config,
        cooldown_minutes: config.cooldown_ms / 60000
      }
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Get config failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/orderbook/config
 * 更新监控配置
 *
 * Body:
 * - big_order_multiplier: number
 * - big_order_min_value_usdt: number
 * - imbalance_ratio_high: number
 * - imbalance_ratio_low: number
 * - withdrawal_min_ratio: number
 * - withdrawal_min_value_usdt: number
 * - cooldown_ms: number
 */
router.put('/config', async (req: Request, res: Response) => {
  try {
    if (!service) {
      res.status(400).json({
        success: false,
        error: 'OrderBook monitor service not initialized'
      });
      return;
    }

    const updates = req.body;

    // 验证参数
    if (updates.big_order_multiplier !== undefined && updates.big_order_multiplier < 1) {
      res.status(400).json({
        success: false,
        error: 'big_order_multiplier must be >= 1'
      });
      return;
    }

    if (updates.imbalance_ratio_high !== undefined && updates.imbalance_ratio_high < 1) {
      res.status(400).json({
        success: false,
        error: 'imbalance_ratio_high must be >= 1'
      });
      return;
    }

    service.update_config(updates);

    res.json({
      success: true,
      message: 'Config updated',
      data: service.get_config()
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Update config failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/orderbook/alerts/cleanup
 * 清理旧报警记录
 *
 * Query params:
 * - days: number (保留天数，默认30)
 */
router.delete('/alerts/cleanup', async (req: Request, res: Response) => {
  try {
    const repo = get_repository();
    const days = req.query.days ? parseInt(req.query.days as string) : 30;

    const deleted = await repo.cleanup_old_alerts(days);

    res.json({
      success: true,
      message: `Cleaned up ${deleted} old alerts`,
      deleted,
      days_kept: days
    });
  } catch (error: any) {
    logger.error('[OrderBook API] Cleanup alerts failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
