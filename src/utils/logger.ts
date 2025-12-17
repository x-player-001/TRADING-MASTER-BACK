export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

// ANSI颜色代码
const Colors = {
  Reset: '\x1b[0m',
  Bright: '\x1b[1m',
  Dim: '\x1b[2m',

  // 前景色
  Red: '\x1b[31m',
  Green: '\x1b[32m',
  Yellow: '\x1b[33m',
  Blue: '\x1b[34m',
  Magenta: '\x1b[35m',
  Cyan: '\x1b[36m',
  White: '\x1b[37m',
  Gray: '\x1b[90m',

  // 背景色
  BgRed: '\x1b[41m',
  BgGreen: '\x1b[42m',
  BgYellow: '\x1b[43m',
  BgBlue: '\x1b[44m',
  BgMagenta: '\x1b[45m',
  BgCyan: '\x1b[46m'
} as const;

export class Logger {
  private static instance: Logger;
  private log_level: LogLevel = LogLevel.INFO;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  set_log_level(level: LogLevel): void {
    this.log_level = level;
  }

  /**
   * 获取 UTC+8 (北京/香港时间) 格式的时间字符串
   */
  private get_utc8_time(): string {
    const now = new Date();
    // UTC+8 偏移量（毫秒）
    const utc8_offset = 8 * 60 * 60 * 1000;
    const utc8_time = new Date(now.getTime() + utc8_offset);
    // 格式: YYYY-MM-DD HH:mm:ss
    return utc8_time.toISOString().replace('T', ' ').substring(0, 19);
  }

  debug(message: string, data?: any): void {
    if (this.log_level <= LogLevel.DEBUG) {
      console.log(`${Colors.Gray}[DEBUG] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, data || '');
    }
  }

  info(message: string, data?: any): void {
    if (this.log_level <= LogLevel.INFO) {
      console.log(`${Colors.Cyan}[INFO] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, data || '');
    }
  }

  warn(message: string, data?: any): void {
    if (this.log_level <= LogLevel.WARN) {
      console.warn(`${Colors.Yellow}[WARN] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, data || '');
    }
  }

  error(message: string, error?: Error | any): void {
    if (this.log_level <= LogLevel.ERROR) {
      console.error(`${Colors.Red}[ERROR] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, error || '');
    }
  }

  // 专门的API日志方法 - 使用蓝色
  api(message: string, data?: any): void {
    if (this.log_level <= LogLevel.DEBUG) {
      console.log(`${Colors.Blue}[API] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, data || '');
    }
  }

  // OI轮询日志 - 使用绿色
  oi(message: string, data?: any): void {
    if (this.log_level <= LogLevel.INFO) {
      console.log(`${Colors.Green}[OI] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, data || '');
    }
  }

  // 缓存日志 - 使用紫色
  cache(message: string, data?: any): void {
    if (this.log_level <= LogLevel.DEBUG) {
      console.log(`${Colors.Magenta}[CACHE] ${this.get_utc8_time()} - ${message}${Colors.Reset}`, data || '');
    }
  }
}

export const logger = Logger.getInstance();