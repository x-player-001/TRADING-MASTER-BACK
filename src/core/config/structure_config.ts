/**
 * 结构形态检测配置
 */
export interface StructureDetectionConfig {
  // 是否启用结构检测
  enabled: boolean;

  // 检测间隔 (每N根K线检测一次)
  detection_interval: number;

  // 缓存TTL (毫秒)
  cache_ttl: number;

  // 区间检测参数
  range_detection: {
    lookback: number;           // 回溯K线数量
    min_duration: number;       // 最小持续K线数
    max_duration: number;       // 最大持续K线数
    min_touches: number;        // 最小触碰次数
    min_confidence: number;     // 最小置信度 (0-1)
  };

  // 突破确认参数
  breakout_confirmation: {
    price_threshold: number;    // 价格突破阈值 (百分比)
    volume_multiplier: number;  // 成交量倍数
    confirmation_bars: number;  // 确认K线数量
    min_strength: number;       // 最小强度评分 (0-100)
    min_risk_reward: number;    // 最小风险回报比
  };

  // 监控的时间周期
  monitored_intervals: string[];
}

/**
 * 默认配置
 */
export const DEFAULT_STRUCTURE_CONFIG: StructureDetectionConfig = {
  enabled: true,
  detection_interval: 10,
  cache_ttl: 5 * 60 * 1000, // 5分钟

  range_detection: {
    lookback: 500,           // 检测最近500根K线
    min_duration: 15,        // 区间最小持续15根K线
    max_duration: 100,       // 区间最大持续100根K线
    min_touches: 4,          // 最小触碰次数4次
    min_confidence: 0.5      // 最小置信度0.5
  },

  breakout_confirmation: {
    price_threshold: 2.0,      // 2%
    volume_multiplier: 1.3,
    confirmation_bars: 2,
    min_strength: 70,
    min_risk_reward: 1.5
  },

  monitored_intervals: ['5m', '15m', '1h', '4h']
};

/**
 * 结构配置管理器
 */
export class StructureConfigManager {
  private static instance: StructureConfigManager;
  private config: StructureDetectionConfig;

  private constructor() {
    this.config = { ...DEFAULT_STRUCTURE_CONFIG };
    this.load_from_env();
  }

  static getInstance(): StructureConfigManager {
    if (!StructureConfigManager.instance) {
      StructureConfigManager.instance = new StructureConfigManager();
    }
    return StructureConfigManager.instance;
  }

  /**
   * 从环境变量加载配置
   */
  private load_from_env(): void {
    if (process.env.STRUCTURE_DETECTION_ENABLED) {
      this.config.enabled = process.env.STRUCTURE_DETECTION_ENABLED === 'true';
    }

    if (process.env.STRUCTURE_DETECTION_INTERVAL) {
      this.config.detection_interval = parseInt(process.env.STRUCTURE_DETECTION_INTERVAL);
    }

    if (process.env.STRUCTURE_CACHE_TTL) {
      this.config.cache_ttl = parseInt(process.env.STRUCTURE_CACHE_TTL);
    }

    // Range detection
    if (process.env.RANGE_LOOKBACK) {
      this.config.range_detection.lookback = parseInt(process.env.RANGE_LOOKBACK);
    }

    if (process.env.RANGE_MIN_TOUCHES) {
      this.config.range_detection.min_touches = parseInt(process.env.RANGE_MIN_TOUCHES);
    }

    // Breakout confirmation
    if (process.env.BREAKOUT_PRICE_THRESHOLD) {
      this.config.breakout_confirmation.price_threshold = parseFloat(process.env.BREAKOUT_PRICE_THRESHOLD);
    }

    if (process.env.BREAKOUT_MIN_STRENGTH) {
      this.config.breakout_confirmation.min_strength = parseInt(process.env.BREAKOUT_MIN_STRENGTH);
    }

    if (process.env.BREAKOUT_MIN_RISK_REWARD) {
      this.config.breakout_confirmation.min_risk_reward = parseFloat(process.env.BREAKOUT_MIN_RISK_REWARD);
    }
  }

  /**
   * 获取配置
   */
  get_config(): StructureDetectionConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  update_config(partial: Partial<StructureDetectionConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * 重置为默认配置
   */
  reset_to_default(): void {
    this.config = { ...DEFAULT_STRUCTURE_CONFIG };
  }

  // 便捷访问方法
  is_enabled(): boolean {
    return this.config.enabled;
  }

  get_detection_interval(): number {
    return this.config.detection_interval;
  }

  get_cache_ttl(): number {
    return this.config.cache_ttl;
  }

  get_monitored_intervals(): string[] {
    return [...this.config.monitored_intervals];
  }
}
