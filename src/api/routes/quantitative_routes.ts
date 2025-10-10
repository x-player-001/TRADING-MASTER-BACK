import { Router, Request, Response } from 'express';
import { StrategyRepository } from '@/database/quantitative/strategy_repository';
import { BacktestRepository } from '@/database/quantitative/backtest_repository';
import { TradeRepository } from '@/database/quantitative/trade_repository';
import { PositionRepository } from '@/database/quantitative/position_repository';
import { RiskRepository } from '@/database/quantitative/risk_repository';
import { StrategyManager } from '@/quantitative/strategies/strategy_manager';
import { BacktestEngine } from '@/quantitative/backtesting/backtest_engine';
import { BacktestTaskManager } from '@/quantitative/backtesting/backtest_task_manager';
import { RiskCalculator } from '@/quantitative/risk/risk_calculator';
import { PositionStatus } from '@/quantitative/types/trading_types';
import { logger } from '@/utils/logger';

const router = Router();

// 初始化Repository
const strategy_repository = new StrategyRepository();
const backtest_repository = new BacktestRepository();
const trade_repository = new TradeRepository();
const position_repository = new PositionRepository();
const risk_repository = new RiskRepository();

// 初始化服务
const strategy_manager = StrategyManager.get_instance();
const backtest_engine = new BacktestEngine();
const backtest_task_manager = BacktestTaskManager.get_instance();
const risk_calculator = new RiskCalculator();

// ===================================
// 策略管理API (7个)
// ===================================

/**
 * GET /api/quant/strategies
 * 获取所有策略
 */
router.get('/strategies', async (req: Request, res: Response) => {
  try {
    const strategies = await strategy_repository.find_all();

    return res.json({
      success: true,
      data: strategies,
      count: strategies.length
    });
  } catch (error) {
    logger.error('Failed to get strategies', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/strategies/:id
 * 获取策略详情
 */
router.get('/strategies/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const strategy = await strategy_repository.find_by_id(id);

    if (!strategy) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${id}`
      });
    }

    return res.json({
      success: true,
      data: strategy
    });
  } catch (error) {
    logger.error('Failed to get strategy', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/quant/strategies
 * 创建策略
 */
router.post('/strategies', async (req: Request, res: Response) => {
  try {
    const { name, type, description, parameters, mode } = req.body;

    // 参数验证
    if (!name || !type || !parameters) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Missing required fields: name, type, parameters'
      });
    }

    // 检查名称是否已存在
    const existing = await strategy_repository.find_by_name(name);
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: `Strategy name already exists: ${name}`
      });
    }

    // 创建策略
    const strategy_id = await strategy_repository.create({
      name,
      type,
      description,
      parameters,
      mode
    });

    // 创建默认风控配置
    await risk_repository.create({
      strategy_id,
      max_positions: 5,
      max_position_size_percent: 20,
      max_total_risk_percent: 50,
      stop_loss_percent: 2,
      take_profit_percent: 5,
      max_daily_loss_percent: 10,
      blacklist_symbols: []
    });

    return res.json({
      success: true,
      message: 'Strategy created successfully',
      data: {
        id: strategy_id
      }
    });
  } catch (error) {
    logger.error('Failed to create strategy', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PUT /api/quant/strategies/:id
 * 更新策略
 */
router.put('/strategies/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, parameters, enabled, mode } = req.body;

    // 检查策略是否存在
    const strategy = await strategy_repository.find_by_id(id);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${id}`
      });
    }

    // 更新策略
    await strategy_repository.update(id, {
      name,
      description,
      parameters,
      enabled,
      mode
    });

    return res.json({
      success: true,
      message: 'Strategy updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update strategy', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/quant/strategies/:id
 * 删除策略
 */
router.delete('/strategies/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);

    // 检查策略是否存在
    const strategy = await strategy_repository.find_by_id(id);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${id}`
      });
    }

    // 删除策略（级联删除相关数据）
    await strategy_repository.delete(id);

    return res.json({
      success: true,
      message: 'Strategy deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete strategy', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/quant/strategies/:id/toggle
 * 启用/禁用策略
 */
router.post('/strategies/:id/toggle', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Missing or invalid field: enabled'
      });
    }

    // 检查策略是否存在
    const strategy = await strategy_repository.find_by_id(id);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${id}`
      });
    }

    // 切换启用状态
    await strategy_repository.toggle_enabled(id, enabled);

    return res.json({
      success: true,
      message: `Strategy ${enabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    logger.error('Failed to toggle strategy', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/strategies/:id/performance
 * 获取策略性能统计
 */
router.get('/strategies/:id/performance', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);

    // 检查策略是否存在
    const strategy = await strategy_repository.find_by_id(id);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${id}`
      });
    }

    // 获取性能统计
    const performance = await strategy_repository.get_performance(id);

    return res.json({
      success: true,
      data: performance || {
        strategy_id: id,
        total_backtests: 0,
        total_trades: 0,
        win_trades: 0,
        loss_trades: 0,
        win_rate: 0,
        avg_return: 0,
        best_return: 0,
        worst_return: 0,
        avg_sharpe: 0,
        avg_max_drawdown: 0
      }
    });
  } catch (error) {
    logger.error('Failed to get strategy performance', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ===================================
// 回测系统API
// ===================================

/**
 * POST /api/quant/backtest/run
 * 运行回测（异步任务模式）
 */
router.post('/backtest/run', async (req: Request, res: Response) => {
  try {
    const { strategy_id, symbol, interval, start_time, end_time, initial_capital } = req.body;

    // 参数验证
    if (!strategy_id || !symbol || !interval || !start_time || !end_time || !initial_capital) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Missing required fields: strategy_id, symbol, interval, start_time, end_time, initial_capital'
      });
    }

    // 检查策略是否存在
    const strategy_config = await strategy_repository.find_by_id(strategy_id);
    if (!strategy_config) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${strategy_id}`
      });
    }

    // 创建回测任务
    const backtest_request = {
      strategy_id,
      symbol,
      interval,
      start_time,
      end_time,
      initial_capital
    };

    const task_id = await backtest_task_manager.create_task(backtest_request);

    // 异步执行回测（不阻塞响应）
    setImmediate(async () => {
      try {
        const strategy = await strategy_manager.create_strategy_instance(strategy_id);
        await backtest_engine.run_backtest_async(strategy, backtest_request, task_id);
      } catch (error) {
        logger.error('[BacktestAPI] Async backtest execution failed', error);
      }
    });

    // 立即返回任务ID
    return res.json({
      success: true,
      message: 'Backtest task created successfully',
      data: {
        task_id,
        status: 'pending',
        message: 'Use GET /api/quant/backtest/tasks/:task_id to check progress'
      }
    });
  } catch (error) {
    logger.error('Failed to create backtest task', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/backtest/tasks/:task_id
 * 查询回测任务状态和进度
 */
router.get('/backtest/tasks/:task_id', async (req: Request, res: Response) => {
  try {
    const task_id = req.params.task_id;
    const task_response = await backtest_task_manager.get_task_response(task_id);

    if (!task_response) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Backtest task not found: ${task_id}`
      });
    }

    return res.json({
      success: true,
      data: task_response
    });
  } catch (error) {
    logger.error('[BacktestAPI] Failed to get backtest task', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/quant/backtest/tasks/:task_id
 * 取消回测任务
 */
router.delete('/backtest/tasks/:task_id', async (req: Request, res: Response) => {
  try {
    const task_id = req.params.task_id;

    const success = await backtest_task_manager.cancel_task(task_id);

    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Task not found or cannot be cancelled (already completed/failed/cancelled)'
      });
    }

    return res.json({
      success: true,
      message: 'Backtest task cancelled successfully'
    });
  } catch (error) {
    logger.error('Failed to cancel backtest task', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/backtest/tasks
 * 获取最近的回测任务列表
 */
router.get('/backtest/tasks', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const tasks = await backtest_task_manager.get_recent_tasks(limit);

    return res.json({
      success: true,
      data: tasks,
      count: tasks.length
    });
  } catch (error) {
    logger.error('Failed to get backtest tasks', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/backtest/results
 * 获取回测结果列表
 */
router.get('/backtest/results', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const results = await backtest_repository.find_all(limit, offset);

    return res.json({
      success: true,
      data: results,
      count: results.length,
      pagination: {
        limit,
        offset
      }
    });
  } catch (error) {
    logger.error('Failed to get backtest results', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/backtest/results/:id
 * 获取回测详情
 */
router.get('/backtest/results/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const result = await backtest_repository.find_by_id(id);

    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Backtest result not found: ${id}`
      });
    }

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to get backtest result', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/backtest/results/:id/trades
 * 获取回测交易明细
 */
router.get('/backtest/results/:id/trades', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);

    // 检查回测结果是否存在
    const result = await backtest_repository.find_by_id(id);
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Backtest result not found: ${id}`
      });
    }

    // 获取交易明细
    const trades = await trade_repository.find_by_backtest(id);

    return res.json({
      success: true,
      data: trades,
      count: trades.length
    });
  } catch (error) {
    logger.error('Failed to get backtest trades', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/quant/backtest/results/:id
 * 删除回测记录
 */
router.delete('/backtest/results/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);

    // 检查回测结果是否存在
    const result = await backtest_repository.find_by_id(id);
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Backtest result not found: ${id}`
      });
    }

    // 删除回测结果（级联删除交易记录）
    await backtest_repository.delete(id);

    return res.json({
      success: true,
      message: 'Backtest result deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete backtest result', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ===================================
// 交易记录API
// ===================================

/**
 * GET /api/quant/trades
 * 获取交易记录
 */
router.get('/trades', async (req: Request, res: Response) => {
  try {
    const strategy_id = req.query.strategy_id ? parseInt(req.query.strategy_id as string) : undefined;
    const symbol = req.query.symbol as string;
    const limit = parseInt(req.query.limit as string) || 100;

    let trades;
    if (strategy_id) {
      trades = await trade_repository.find_by_strategy(strategy_id, limit);
    } else if (symbol) {
      trades = await trade_repository.find_by_symbol(symbol, limit);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Missing query parameter: strategy_id or symbol'
      });
    }

    return res.json({
      success: true,
      data: trades,
      count: trades.length
    });
  } catch (error) {
    logger.error('Failed to get trades', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/trades/:id
 * 获取交易详情
 */
router.get('/trades/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const trade = await trade_repository.find_by_id(id);

    if (!trade) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Trade not found: ${id}`
      });
    }

    return res.json({
      success: true,
      data: trade
    });
  } catch (error) {
    logger.error('Failed to get trade', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/trades/statistics
 * 获取交易统计
 */
router.get('/trades/statistics', async (req: Request, res: Response) => {
  try {
    const strategy_id = req.query.strategy_id ? parseInt(req.query.strategy_id as string) : undefined;
    const backtest_id = req.query.backtest_id ? parseInt(req.query.backtest_id as string) : undefined;

    const statistics = await trade_repository.get_statistics(strategy_id, backtest_id);

    return res.json({
      success: true,
      data: statistics
    });
  } catch (error) {
    logger.error('Failed to get trade statistics', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ===================================
// 持仓管理API
// ===================================

/**
 * GET /api/quant/positions
 * 获取当前持仓
 */
router.get('/positions', async (req: Request, res: Response) => {
  try {
    const strategy_id = req.query.strategy_id ? parseInt(req.query.strategy_id as string) : undefined;

    const positions = await position_repository.find_open_positions(strategy_id);

    return res.json({
      success: true,
      data: positions,
      count: positions.length
    });
  } catch (error) {
    logger.error('Failed to get positions', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/positions/statistics
 * 获取持仓统计
 */
router.get('/positions/statistics', async (req: Request, res: Response) => {
  try {
    const strategy_id = req.query.strategy_id ? parseInt(req.query.strategy_id as string) : undefined;

    const stats = await position_repository.get_statistics(strategy_id);

    return res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get position statistics', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/positions/strategy/:strategy_id
 * 按策略获取持仓
 */
router.get('/positions/strategy/:strategy_id', async (req: Request, res: Response) => {
  try {
    const strategy_id = parseInt(req.params.strategy_id);
    const status_query = req.query.status as string;
    const status = status_query === 'open' ? PositionStatus.OPEN : status_query === 'closed' ? PositionStatus.CLOSED : undefined;

    const positions = await position_repository.find_by_strategy(strategy_id, status);

    return res.json({
      success: true,
      data: positions,
      count: positions.length
    });
  } catch (error) {
    logger.error('Failed to get positions by strategy', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/positions/:id
 * 获取持仓详情
 */
router.get('/positions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const position = await position_repository.find_by_id(id);

    if (!position) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Position not found: ${id}`
      });
    }

    return res.json({
      success: true,
      data: position
    });
  } catch (error) {
    logger.error('Failed to get position', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ===================================
// 风险管理API
// ===================================

/**
 * GET /api/quant/risk/config/:strategy_id
 * 获取风控配置
 */
router.get('/risk/config/:strategy_id', async (req: Request, res: Response) => {
  try {
    const strategy_id = parseInt(req.params.strategy_id);

    const config = await risk_repository.find_by_strategy(strategy_id);

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Risk config not found for strategy: ${strategy_id}`
      });
    }

    return res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.error('Failed to get risk config', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PUT /api/quant/risk/config/:strategy_id
 * 更新风控配置
 */
router.put('/risk/config/:strategy_id', async (req: Request, res: Response) => {
  try {
    const strategy_id = parseInt(req.params.strategy_id);

    // 检查策略是否存在
    const strategy = await strategy_repository.find_by_id(strategy_id);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Strategy not found: ${strategy_id}`
      });
    }

    // 更新风控配置
    await risk_repository.update(strategy_id, req.body);

    return res.json({
      success: true,
      message: 'Risk config updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update risk config', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/risk/exposure
 * 获取风险敞口
 */
router.get('/risk/exposure', async (req: Request, res: Response) => {
  try {
    const strategy_id = parseInt(req.query.strategy_id as string);
    const total_capital = parseFloat(req.query.total_capital as string);

    if (!strategy_id || !total_capital) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Missing required parameters: strategy_id, total_capital'
      });
    }

    const exposure = await risk_calculator.get_risk_exposure(strategy_id, total_capital);

    return res.json({
      success: true,
      data: exposure
    });
  } catch (error) {
    logger.error('Failed to get risk exposure', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/quant/risk/check/:strategy_id
 * 检查是否满足风控条件
 */
router.get('/risk/check/:strategy_id', async (req: Request, res: Response) => {
  try {
    const strategy_id = parseInt(req.params.strategy_id);
    const symbol = req.query.symbol as string;
    const position_value = parseFloat(req.query.position_value as string);
    const total_capital = parseFloat(req.query.total_capital as string);

    if (!symbol || !position_value || !total_capital) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Missing required parameters: symbol, position_value, total_capital'
      });
    }

    const check_result = await risk_calculator.check_can_open_position(
      strategy_id,
      symbol,
      position_value,
      total_capital
    );

    return res.json({
      success: true,
      data: check_result
    });
  } catch (error) {
    logger.error('Failed to check risk', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
