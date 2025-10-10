/**
 * 回测任务管理器
 * 负责任务的创建、存储、查询和状态更新
 */

import { v4 as uuidv4 } from 'uuid';
import { RedisClientType } from 'redis';
import { DatabaseConfig } from '@/core/config/database';
import { logger } from '@/utils/logger';
import {
  BacktestTask,
  BacktestTaskStatus,
  BacktestProgress,
  BacktestTaskResponse
} from '../types/task_types';
import { BacktestRequest } from '../types/backtest_types';

export class BacktestTaskManager {
  private static instance: BacktestTaskManager;
  private redis: RedisClientType | null = null;

  // Redis键前缀
  private readonly TASK_KEY_PREFIX = 'backtest:task:';
  private readonly PROGRESS_KEY_PREFIX = 'backtest:progress:';
  private readonly TASK_LIST_KEY = 'backtest:tasks:list';

  // 任务过期时间
  private readonly TASK_TTL = 24 * 60 * 60; // 24小时
  private readonly PROGRESS_TTL = 60 * 60;  // 1小时（进度数据可以更短）

  private constructor() {
    // Redis连接将在首次使用时初始化
  }

  static get_instance(): BacktestTaskManager {
    if (!BacktestTaskManager.instance) {
      BacktestTaskManager.instance = new BacktestTaskManager();
    }
    return BacktestTaskManager.instance;
  }

  /**
   * 初始化Redis连接
   */
  private async initialize_redis(): Promise<void> {
    if (!this.redis) {
      this.redis = await DatabaseConfig.get_redis_client();
      logger.info('[BacktestTaskManager] Redis connection initialized');
    }
  }

  /**
   * 获取Redis客户端
   */
  private async get_redis(): Promise<RedisClientType> {
    if (!this.redis) {
      await this.initialize_redis();
    }
    return this.redis!;
  }

  /**
   * 创建新的回测任务
   */
  async create_task(request: BacktestRequest): Promise<string> {
    const task_id = uuidv4();
    const task: BacktestTask = {
      task_id,
      status: BacktestTaskStatus.PENDING,
      request,
      created_at: Date.now()
    };

    try {
      const redis = await this.get_redis();

      // 存储任务信息
      await this.save_task(task);

      // 添加到任务列表
      await redis.lPush(this.TASK_LIST_KEY, task_id);

      logger.info(`[BacktestTaskManager] Created task ${task_id}`, {
        symbol: request.symbol,
        interval: request.interval
      });

      return task_id;
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to create task:`, error);
      throw error;
    }
  }

  /**
   * 获取任务信息
   */
  async get_task(task_id: string): Promise<BacktestTask | null> {
    try {
      const redis = await this.get_redis();
      const task_key = this.TASK_KEY_PREFIX + task_id;
      const task_json = await redis.get(task_key);

      if (!task_json) {
        return null;
      }

      return JSON.parse(task_json);
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to get task ${task_id}:`, error);
      return null;
    }
  }

  /**
   * 获取任务响应（包含进度）
   */
  async get_task_response(task_id: string): Promise<BacktestTaskResponse | null> {
    try {
      const task = await this.get_task(task_id);
      if (!task) {
        return null;
      }

      // 如果任务正在运行，获取最新进度
      if (task.status === BacktestTaskStatus.RUNNING) {
        const progress = await this.get_progress(task_id);
        if (progress) {
          task.progress = progress;
        }
      }

      // 构造响应
      const response: BacktestTaskResponse = {
        task_id: task.task_id,
        status: task.status,
        created_at: task.created_at
      };

      if (task.progress) response.progress = task.progress;
      if (task.result) response.result = task.result;
      if (task.error) response.error = task.error;
      if (task.started_at) response.started_at = task.started_at;
      if (task.completed_at) response.completed_at = task.completed_at;

      return response;
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to get task response ${task_id}:`, error);
      return null;
    }
  }

  /**
   * 更新任务状态
   */
  async update_task_status(
    task_id: string,
    status: BacktestTaskStatus,
    extra_data?: { result?: any; error?: string }
  ): Promise<void> {
    try {
      const task = await this.get_task(task_id);
      if (!task) {
        throw new Error(`Task ${task_id} not found`);
      }

      task.status = status;

      if (status === BacktestTaskStatus.RUNNING && !task.started_at) {
        task.started_at = Date.now();
      }

      if (status === BacktestTaskStatus.COMPLETED ||
          status === BacktestTaskStatus.FAILED ||
          status === BacktestTaskStatus.CANCELLED) {
        task.completed_at = Date.now();
      }

      if (extra_data?.result) {
        task.result = extra_data.result;
      }

      if (extra_data?.error) {
        task.error = extra_data.error;
      }

      await this.save_task(task);

      logger.info(`[BacktestTaskManager] Updated task ${task_id} status to ${status}`);
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to update task status:`, error);
      throw error;
    }
  }

  /**
   * 更新任务进度
   */
  async update_progress(task_id: string, progress: BacktestProgress): Promise<void> {
    try {
      const redis = await this.get_redis();
      const progress_key = this.PROGRESS_KEY_PREFIX + task_id;
      await redis.setEx(
        progress_key,
        this.PROGRESS_TTL,
        JSON.stringify(progress)
      );
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to update progress:`, error);
    }
  }

  /**
   * 获取任务进度
   */
  async get_progress(task_id: string): Promise<BacktestProgress | null> {
    try {
      const redis = await this.get_redis();
      const progress_key = this.PROGRESS_KEY_PREFIX + task_id;
      const progress_json = await redis.get(progress_key);

      if (!progress_json) {
        return null;
      }

      return JSON.parse(progress_json);
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to get progress:`, error);
      return null;
    }
  }

  /**
   * 取消任务
   */
  async cancel_task(task_id: string): Promise<boolean> {
    try {
      const task = await this.get_task(task_id);
      if (!task) {
        return false;
      }

      // 只能取消pending或running状态的任务
      if (task.status !== BacktestTaskStatus.PENDING &&
          task.status !== BacktestTaskStatus.RUNNING) {
        return false;
      }

      await this.update_task_status(task_id, BacktestTaskStatus.CANCELLED);

      logger.info(`[BacktestTaskManager] Cancelled task ${task_id}`);
      return true;
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to cancel task:`, error);
      return false;
    }
  }

  /**
   * 检查任务是否被取消
   */
  async is_cancelled(task_id: string): Promise<boolean> {
    const task = await this.get_task(task_id);
    return task?.status === BacktestTaskStatus.CANCELLED;
  }

  /**
   * 保存任务到Redis
   */
  private async save_task(task: BacktestTask): Promise<void> {
    const redis = await this.get_redis();
    const task_key = this.TASK_KEY_PREFIX + task.task_id;
    await redis.setEx(
      task_key,
      this.TASK_TTL,
      JSON.stringify(task)
    );
  }

  /**
   * 获取最近的任务列表
   */
  async get_recent_tasks(limit: number = 10): Promise<BacktestTask[]> {
    try {
      const redis = await this.get_redis();
      const task_ids = await redis.lRange(this.TASK_LIST_KEY, 0, limit - 1);
      const tasks: BacktestTask[] = [];

      for (const task_id of task_ids) {
        const task = await this.get_task(task_id);
        if (task) {
          tasks.push(task);
        }
      }

      return tasks;
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to get recent tasks:`, error);
      return [];
    }
  }

  /**
   * 清理过期任务（可选，定期调用）
   */
  async cleanup_expired_tasks(): Promise<void> {
    try {
      const redis = await this.get_redis();
      const task_ids = await redis.lRange(this.TASK_LIST_KEY, 0, -1);
      const now = Date.now();
      const expired_threshold = now - (this.TASK_TTL * 1000);

      for (const task_id of task_ids) {
        const task = await this.get_task(task_id);
        if (!task || task.created_at < expired_threshold) {
          // 从列表中移除
          await redis.lRem(this.TASK_LIST_KEY, 1, task_id);
        }
      }

      logger.info(`[BacktestTaskManager] Cleaned up expired tasks`);
    } catch (error) {
      logger.error(`[BacktestTaskManager] Failed to cleanup expired tasks:`, error);
    }
  }
}
