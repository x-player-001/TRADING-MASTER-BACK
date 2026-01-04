/**
 * Telegram 消息推送服务
 *
 * 功能:
 * 1. 封装 Telegram Bot API，支持发送文本、Markdown、HTML 消息
 * 2. 支持消息队列，避免触发 Telegram 频率限制
 * 3. 支持多种消息类型：普通消息、报警消息、交易信号等
 * 4. 支持重试机制和错误处理
 *
 * 使用方法:
 * ```typescript
 * const telegram = TelegramService.getInstance();
 * await telegram.send_text('Hello World');
 * await telegram.send_alert({ symbol: 'BTCUSDT', message: '放量上涨' });
 * ```
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '@/utils/logger';

/**
 * 消息类型
 */
export type MessageParseMode = 'Markdown' | 'MarkdownV2' | 'HTML' | undefined;

/**
 * 消息优先级
 */
export enum MessagePriority {
  LOW = 0,      // 低优先级（信息类）
  NORMAL = 1,   // 普通优先级
  HIGH = 2,     // 高优先级（报警类）
  URGENT = 3    // 紧急（交易信号）
}

/**
 * 报警消息结构
 */
export interface AlertMessage {
  symbol: string;
  message: string;
  price?: number;
  change_pct?: number;
  volume_ratio?: number;
  direction?: 'UP' | 'DOWN';
  is_important?: boolean;
  extra_info?: string;
}

/**
 * 交易信号消息结构
 */
export interface TradeSignalMessage {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number;
  stop_loss?: number;
  take_profit?: number;
  signal_score?: number;
  reason?: string;
}

/**
 * 队列消息结构
 */
interface QueuedMessage {
  text: string;
  parse_mode?: MessageParseMode;
  priority: MessagePriority;
  timestamp: number;
  retries: number;
}

/**
 * Telegram 服务配置
 */
interface TelegramConfig {
  bot_token: string;
  chat_id: string;
  enabled: boolean;
  rate_limit_ms: number;        // 消息间隔（毫秒）
  max_retries: number;          // 最大重试次数
  retry_delay_ms: number;       // 重试延迟（毫秒）
  queue_max_size: number;       // 队列最大长度
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Partial<TelegramConfig> = {
  enabled: false,
  rate_limit_ms: 100,           // 100ms 间隔，避免触发频率限制
  max_retries: 3,
  retry_delay_ms: 1000,
  queue_max_size: 100
};

export class TelegramService {
  private static instance: TelegramService;
  private config: TelegramConfig;
  private client: AxiosInstance;
  private message_queue: QueuedMessage[] = [];
  private is_processing = false;
  private last_send_time = 0;

  private constructor() {
    // 从环境变量读取配置
    this.config = {
      bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
      chat_id: process.env.TELEGRAM_CHAT_ID || '',
      enabled: process.env.TELEGRAM_ENABLED === 'true',
      rate_limit_ms: parseInt(process.env.TELEGRAM_RATE_LIMIT_MS || '') || DEFAULT_CONFIG.rate_limit_ms!,
      max_retries: parseInt(process.env.TELEGRAM_MAX_RETRIES || '') || DEFAULT_CONFIG.max_retries!,
      retry_delay_ms: parseInt(process.env.TELEGRAM_RETRY_DELAY_MS || '') || DEFAULT_CONFIG.retry_delay_ms!,
      queue_max_size: parseInt(process.env.TELEGRAM_QUEUE_MAX_SIZE || '') || DEFAULT_CONFIG.queue_max_size!
    };

    // 创建 axios 实例
    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${this.config.bot_token}`,
      timeout: 10000
    });

    // 验证配置
    if (this.config.enabled && (!this.config.bot_token || !this.config.chat_id)) {
      logger.warn('[Telegram] Enabled but missing BOT_TOKEN or CHAT_ID, disabling...');
      this.config.enabled = false;
    }

    if (this.config.enabled) {
      logger.info('[Telegram] Service initialized and enabled');
    } else {
      logger.debug('[Telegram] Service initialized but disabled');
    }
  }

  /**
   * 获取单例实例
   */
  static getInstance(): TelegramService {
    if (!TelegramService.instance) {
      TelegramService.instance = new TelegramService();
    }
    return TelegramService.instance;
  }

  /**
   * 检查服务是否启用
   */
  is_enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 动态启用/禁用服务
   */
  set_enabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(`[Telegram] Service ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 发送纯文本消息
   */
  async send_text(text: string, priority: MessagePriority = MessagePriority.NORMAL): Promise<boolean> {
    return this.queue_message(text, undefined, priority);
  }

  /**
   * 发送 Markdown 格式消息
   */
  async send_markdown(text: string, priority: MessagePriority = MessagePriority.NORMAL): Promise<boolean> {
    return this.queue_message(text, 'Markdown', priority);
  }

  /**
   * 发送 HTML 格式消息
   */
  async send_html(text: string, priority: MessagePriority = MessagePriority.NORMAL): Promise<boolean> {
    return this.queue_message(text, 'HTML', priority);
  }

  /**
   * 发送报警消息（格式化）
   */
  async send_alert(alert: AlertMessage, priority: MessagePriority = MessagePriority.HIGH): Promise<boolean> {
    const direction_emoji = alert.direction === 'UP' ? '🟢' : '🔴';
    const important_tag = alert.is_important ? '⭐ ' : '';
    const direction_text = alert.direction === 'UP' ? '上涨' : '下跌';

    let text = `${important_tag}🔔 *${alert.symbol}* ${direction_text} ${direction_emoji}\n`;
    text += `📝 ${alert.message}\n`;

    if (alert.price !== undefined) {
      text += `💰 价格: \`${alert.price.toFixed(4)}\`\n`;
    }

    if (alert.change_pct !== undefined) {
      const change_str = alert.change_pct >= 0 ? `+${alert.change_pct.toFixed(2)}%` : `${alert.change_pct.toFixed(2)}%`;
      text += `📈 涨跌: \`${change_str}\`\n`;
    }

    if (alert.volume_ratio !== undefined) {
      text += `📊 放量: \`${alert.volume_ratio.toFixed(1)}x\`\n`;
    }

    if (alert.extra_info) {
      text += `ℹ️ ${alert.extra_info}\n`;
    }

    text += `⏰ ${this.get_beijing_time()}`;

    return this.queue_message(text, 'Markdown', priority);
  }

  /**
   * 发送交易信号消息
   */
  async send_trade_signal(signal: TradeSignalMessage, priority: MessagePriority = MessagePriority.URGENT): Promise<boolean> {
    const direction_emoji = signal.direction === 'LONG' ? '🟢 做多' : '🔴 做空';

    let text = `🚀 *交易信号*\n\n`;
    text += `📌 *${signal.symbol}* ${direction_emoji}\n`;
    text += `💰 入场价: \`${signal.entry_price.toFixed(4)}\`\n`;

    if (signal.stop_loss !== undefined) {
      text += `🛑 止损价: \`${signal.stop_loss.toFixed(4)}\`\n`;
    }

    if (signal.take_profit !== undefined) {
      text += `🎯 止盈价: \`${signal.take_profit.toFixed(4)}\`\n`;
    }

    if (signal.signal_score !== undefined) {
      text += `📊 信号评分: \`${signal.signal_score.toFixed(2)}\`\n`;
    }

    if (signal.reason) {
      text += `📝 原因: ${signal.reason}\n`;
    }

    text += `\n⏰ ${this.get_beijing_time()}`;

    return this.queue_message(text, 'Markdown', priority);
  }

  /**
   * 发送系统通知
   */
  async send_system_notification(title: string, message: string, is_error: boolean = false): Promise<boolean> {
    const emoji = is_error ? '❌' : 'ℹ️';
    const text = `${emoji} *${title}*\n\n${message}\n\n⏰ ${this.get_beijing_time()}`;
    const priority = is_error ? MessagePriority.HIGH : MessagePriority.LOW;
    return this.queue_message(text, 'Markdown', priority);
  }

  /**
   * 将消息加入队列
   */
  private async queue_message(text: string, parse_mode?: MessageParseMode, priority: MessagePriority = MessagePriority.NORMAL): Promise<boolean> {
    if (!this.config.enabled) {
      logger.debug('[Telegram] Service disabled, message not sent');
      return false;
    }

    // 检查队列大小
    if (this.message_queue.length >= this.config.queue_max_size) {
      // 移除最旧的低优先级消息
      const low_priority_index = this.message_queue.findIndex(m => m.priority <= MessagePriority.LOW);
      if (low_priority_index !== -1) {
        this.message_queue.splice(low_priority_index, 1);
      } else {
        logger.warn('[Telegram] Queue full, dropping oldest message');
        this.message_queue.shift();
      }
    }

    // 添加到队列
    this.message_queue.push({
      text,
      parse_mode,
      priority,
      timestamp: Date.now(),
      retries: 0
    });

    // 按优先级排序（高优先级在前）
    this.message_queue.sort((a, b) => b.priority - a.priority);

    // 开始处理队列
    this.process_queue();

    return true;
  }

  /**
   * 处理消息队列
   */
  private async process_queue(): Promise<void> {
    if (this.is_processing || this.message_queue.length === 0) {
      return;
    }

    this.is_processing = true;

    while (this.message_queue.length > 0) {
      const message = this.message_queue[0];

      // 检查频率限制
      const time_since_last = Date.now() - this.last_send_time;
      if (time_since_last < this.config.rate_limit_ms) {
        await this.sleep(this.config.rate_limit_ms - time_since_last);
      }

      // 发送消息
      const success = await this.send_message_internal(message.text, message.parse_mode);

      if (success) {
        this.message_queue.shift();
        this.last_send_time = Date.now();
      } else {
        message.retries++;
        if (message.retries >= this.config.max_retries) {
          logger.error(`[Telegram] Message failed after ${this.config.max_retries} retries, dropping`);
          this.message_queue.shift();
        } else {
          // 重试延迟
          await this.sleep(this.config.retry_delay_ms);
        }
      }
    }

    this.is_processing = false;
  }

  /**
   * 实际发送消息到 Telegram API
   */
  private async send_message_internal(text: string, parse_mode?: MessageParseMode): Promise<boolean> {
    try {
      const response = await this.client.post('/sendMessage', {
        chat_id: this.config.chat_id,
        text,
        parse_mode,
        disable_web_page_preview: true
      });

      if (response.data?.ok) {
        logger.debug('[Telegram] Message sent successfully');
        return true;
      } else {
        logger.warn('[Telegram] API returned error:', response.data);
        return false;
      }
    } catch (error: any) {
      if (error.response?.status === 429) {
        // 触发频率限制，获取等待时间
        const retry_after = error.response.data?.parameters?.retry_after || 30;
        logger.warn(`[Telegram] Rate limited, waiting ${retry_after}s`);
        await this.sleep(retry_after * 1000);
        return false;
      }

      logger.error('[Telegram] Failed to send message:', error.message);
      return false;
    }
  }

  /**
   * 获取北京时间字符串
   */
  private get_beijing_time(): string {
    const now = new Date();
    const beijing_hours = (now.getUTCHours() + 8) % 24;
    const minutes = now.getUTCMinutes().toString().padStart(2, '0');
    const seconds = now.getUTCSeconds().toString().padStart(2, '0');
    return `${beijing_hours.toString().padStart(2, '0')}:${minutes}:${seconds}`;
  }

  /**
   * 休眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取队列状态
   */
  get_queue_status(): { queue_size: number; is_processing: boolean; enabled: boolean } {
    return {
      queue_size: this.message_queue.length,
      is_processing: this.is_processing,
      enabled: this.config.enabled
    };
  }

  /**
   * 测试连接
   */
  async test_connection(): Promise<{ success: boolean; message: string }> {
    if (!this.config.bot_token || !this.config.chat_id) {
      return { success: false, message: 'Missing BOT_TOKEN or CHAT_ID' };
    }

    try {
      // 获取 bot 信息验证 token
      const bot_response = await this.client.get('/getMe');
      if (!bot_response.data?.ok) {
        return { success: false, message: 'Invalid BOT_TOKEN' };
      }

      const bot_name = bot_response.data.result?.username || 'Unknown';

      // 发送测试消息
      const test_result = await this.send_message_internal(
        `✅ *连接测试成功*\n\nBot: @${bot_name}\n⏰ ${this.get_beijing_time()}`,
        'Markdown'
      );

      if (test_result) {
        return { success: true, message: `Connected to @${bot_name}` };
      } else {
        return { success: false, message: 'Failed to send test message' };
      }
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }
}

// 导出便捷函数
export const telegram = TelegramService.getInstance();
