/**
 * 回测任务类型定义
 */

export enum BacktestTaskStatus {
  PENDING = 'pending',     // 等待执行
  RUNNING = 'running',     // 执行中
  COMPLETED = 'completed', // 完成
  FAILED = 'failed',       // 失败
  CANCELLED = 'cancelled'  // 已取消
}

/**
 * 回测任务进度
 */
export interface BacktestProgress {
  current_kline: number;  // 当前处理到第几根K线
  total_klines: number;   // 总K线数
  trades_count: number;   // 已生成交易数量
  elapsed_seconds: number; // 已耗时(秒)
}

/**
 * 回测任务信息
 */
export interface BacktestTask {
  task_id: string;
  status: BacktestTaskStatus;
  request: any;  // 回测请求参数(BacktestRequest)
  progress?: BacktestProgress;
  result?: any;  // 回测结果(BacktestResult)
  error?: string;  // 错误信息
  created_at: number;  // 创建时间戳
  started_at?: number;  // 开始时间戳
  completed_at?: number;  // 完成时间戳
}

/**
 * 任务查询响应
 */
export interface BacktestTaskResponse {
  task_id: string;
  status: BacktestTaskStatus;
  progress?: BacktestProgress;
  result?: any;
  error?: string;
  created_at: number;
  started_at?: number;
  completed_at?: number;
}
