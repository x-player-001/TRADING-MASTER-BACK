/**
 * 统一错误处理系统
 * 提供分类错误类型和错误处理工具
 */

/**
 * 错误代码枚举
 */
export enum ErrorCode {
  // 系统错误 (1000-1999)
  SYSTEM_ERROR = 1000,
  INITIALIZATION_FAILED = 1001,
  CONFIGURATION_ERROR = 1002,

  // 数据库错误 (2000-2999)
  DATABASE_ERROR = 2000,
  CONNECTION_ERROR = 2001,
  QUERY_ERROR = 2002,
  TRANSACTION_ERROR = 2003,
  POOL_EXHAUSTED = 2004,

  // API错误 (3000-3999)
  API_ERROR = 3000,
  API_RATE_LIMIT = 3001,
  API_UNAUTHORIZED = 3002,
  API_TIMEOUT = 3003,
  API_INVALID_RESPONSE = 3004,

  // 业务错误 (4000-4999)
  BUSINESS_ERROR = 4000,
  VALIDATION_ERROR = 4001,
  RESOURCE_NOT_FOUND = 4002,
  DUPLICATE_RESOURCE = 4003,
  INSUFFICIENT_PERMISSION = 4004,

  // 网络错误 (5000-5999)
  NETWORK_ERROR = 5000,
  WEBSOCKET_ERROR = 5001,
  TIMEOUT_ERROR = 5002,
  CONNECTION_LOST = 5003,
}

/**
 * 错误严重程度
 */
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/**
 * 基础错误类
 */
export class BaseError extends Error {
  public readonly code: ErrorCode;
  public readonly severity: ErrorSeverity;
  public readonly timestamp: Date;
  public readonly context?: any;
  public readonly cause?: Error;
  public readonly isRetryable: boolean;

  constructor(
    message: string,
    code: ErrorCode,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    options?: {
      cause?: Error;
      context?: any;
      isRetryable?: boolean;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.severity = severity;
    this.timestamp = new Date();
    this.cause = options?.cause;
    this.context = options?.context;
    this.isRetryable = options?.isRetryable ?? false;

    // 捕获堆栈跟踪
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * 转换为JSON格式
   */
  toJSON(): any {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context,
      isRetryable: this.isRetryable,
      stack: this.stack,
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack
      } : undefined
    };
  }

  /**
   * 获取详细错误信息
   */
  getDetails(): string {
    const details = [`[${this.code}] ${this.name}: ${this.message}`];

    if (this.context) {
      details.push(`Context: ${JSON.stringify(this.context)}`);
    }

    if (this.cause) {
      details.push(`Caused by: ${this.cause.message}`);
    }

    return details.join('\n');
  }
}

/**
 * 数据库错误
 */
export class DatabaseError extends BaseError {
  constructor(message: string, cause?: any, context?: any) {
    super(message, ErrorCode.DATABASE_ERROR, ErrorSeverity.HIGH, {
      cause,
      context,
      isRetryable: true
    });
  }
}

/**
 * 连接错误
 */
export class ConnectionError extends BaseError {
  constructor(message: string, cause?: any, context?: any) {
    super(message, ErrorCode.CONNECTION_ERROR, ErrorSeverity.HIGH, {
      cause,
      context,
      isRetryable: true
    });
  }
}

/**
 * API错误
 */
export class APIError extends BaseError {
  public readonly statusCode?: number;
  public readonly response?: any;

  constructor(
    message: string,
    statusCode?: number,
    response?: any,
    cause?: any
  ) {
    super(message, ErrorCode.API_ERROR, ErrorSeverity.MEDIUM, {
      cause,
      context: { statusCode, response },
      isRetryable: statusCode ? statusCode >= 500 || statusCode === 429 : false
    });

    this.statusCode = statusCode;
    this.response = response;
  }
}

/**
 * 限流错误
 */
export class RateLimitError extends BaseError {
  public readonly retryAfter?: number;
  public readonly statusCode: number = 429;

  constructor(message: string, retryAfter?: number, context?: any) {
    super(message, ErrorCode.API_RATE_LIMIT, ErrorSeverity.LOW, {
      context: { retryAfter, ...context },
      isRetryable: true
    });
    this.retryAfter = retryAfter;
  }
}

/**
 * 验证错误
 */
export class ValidationError extends BaseError {
  public readonly field?: string;
  public readonly value?: any;

  constructor(message: string, field?: string, value?: any) {
    super(message, ErrorCode.VALIDATION_ERROR, ErrorSeverity.LOW, {
      context: { field, value },
      isRetryable: false
    });

    this.field = field;
    this.value = value;
  }
}

/**
 * 业务逻辑错误
 */
export class BusinessError extends BaseError {
  constructor(message: string, context?: any) {
    super(message, ErrorCode.BUSINESS_ERROR, ErrorSeverity.MEDIUM, {
      context,
      isRetryable: false
    });
  }
}

/**
 * 资源未找到错误
 */
export class NotFoundError extends BaseError {
  public readonly resource?: string;
  public readonly id?: string | number;

  constructor(resource?: string, id?: string | number) {
    const message = resource
      ? `Resource '${resource}' with id '${id}' not found`
      : 'Resource not found';

    super(message, ErrorCode.RESOURCE_NOT_FOUND, ErrorSeverity.LOW, {
      context: { resource, id },
      isRetryable: false
    });

    this.resource = resource;
    this.id = id;
  }
}

/**
 * 超时错误
 */
export class TimeoutError extends BaseError {
  public readonly timeout: number;

  constructor(message: string, timeout: number, context?: any) {
    super(message, ErrorCode.TIMEOUT_ERROR, ErrorSeverity.MEDIUM, {
      context: { ...context, timeout },
      isRetryable: true
    });

    this.timeout = timeout;
  }
}

/**
 * WebSocket错误
 */
export class WebSocketError extends BaseError {
  constructor(message: string, cause?: any, context?: any) {
    super(message, ErrorCode.WEBSOCKET_ERROR, ErrorSeverity.HIGH, {
      cause,
      context,
      isRetryable: true
    });
  }
}

/**
 * 错误处理工具类
 */
export class ErrorHandler {
  /**
   * 判断是否为可重试错误
   */
  static isRetryable(error: any): boolean {
    if (error instanceof BaseError) {
      return error.isRetryable;
    }

    // 网络相关错误通常可重试
    if (error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND') {
      return true;
    }

    return false;
  }

  /**
   * 格式化错误信息
   */
  static format(error: any): string {
    if (error instanceof BaseError) {
      return error.getDetails();
    }

    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    return String(error);
  }

  /**
   * 包装普通错误为BaseError
   */
  static wrap(error: any, defaultCode: ErrorCode = ErrorCode.SYSTEM_ERROR): BaseError {
    if (error instanceof BaseError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;

    return new BaseError(message, defaultCode, ErrorSeverity.MEDIUM, { cause });
  }

  /**
   * 创建HTTP响应错误
   */
  static createHttpError(error: any): {
    status: number;
    body: any;
  } {
    if (error instanceof ValidationError) {
      return {
        status: 400,
        body: {
          success: false,
          error: 'Validation Error',
          message: error.message,
          field: error.field,
          code: error.code
        }
      };
    }

    if (error instanceof NotFoundError) {
      return {
        status: 404,
        body: {
          success: false,
          error: 'Not Found',
          message: error.message,
          code: error.code
        }
      };
    }

    if (error instanceof RateLimitError) {
      return {
        status: 429,
        body: {
          success: false,
          error: 'Rate Limit Exceeded',
          message: error.message,
          retryAfter: error.retryAfter,
          code: error.code
        }
      };
    }

    if (error instanceof APIError) {
      return {
        status: error.statusCode || 500,
        body: {
          success: false,
          error: 'API Error',
          message: error.message,
          code: error.code
        }
      };
    }

    if (error instanceof BaseError) {
      const status = error.severity === ErrorSeverity.CRITICAL ? 500 : 400;
      return {
        status,
        body: {
          success: false,
          error: error.name,
          message: error.message,
          code: error.code
        }
      };
    }

    // 默认错误响应
    return {
      status: 500,
      body: {
        success: false,
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development'
          ? error.message || 'An unexpected error occurred'
          : 'An unexpected error occurred',
        code: ErrorCode.SYSTEM_ERROR
      }
    };
  }

  /**
   * 错误重试策略
   */
  static async retry<T>(
    fn: () => Promise<T>,
    options: {
      maxAttempts?: number;
      delay?: number;
      backoff?: number;
      onRetry?: (error: any, attempt: number) => void;
    } = {}
  ): Promise<T> {
    const {
      maxAttempts = 3,
      delay = 1000,
      backoff = 2,
      onRetry
    } = options;

    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (!ErrorHandler.isRetryable(error) || attempt === maxAttempts) {
          throw error;
        }

        const waitTime = delay * Math.pow(backoff, attempt - 1);

        if (onRetry) {
          onRetry(error, attempt);
        }

        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    throw lastError;
  }
}

/**
 * 异步错误边界装饰器
 */
export function AsyncErrorBoundary(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    try {
      return await originalMethod.apply(this, args);
    } catch (error) {
      const wrappedError = ErrorHandler.wrap(error);

      // 记录错误（这里应该使用logger）
      console.error(`Error in ${target.constructor.name}.${propertyKey}:`, wrappedError.getDetails());

      throw wrappedError;
    }
  };

  return descriptor;
}

// 导出错误类型守卫
export function isBaseError(error: any): error is BaseError {
  return error instanceof BaseError;
}

export function isDatabaseError(error: any): error is DatabaseError {
  return error instanceof DatabaseError;
}

export function isAPIError(error: any): error is APIError {
  return error instanceof APIError;
}

export function isValidationError(error: any): error is ValidationError {
  return error instanceof ValidationError;
}