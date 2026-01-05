/**
 * 订单簿监控服务
 *
 * 功能:
 * 1. 大单检测 - 20档平均挂单量的N倍触发报警
 * 2. 买卖失衡 - 买盘/卖盘总量比值异常
 * 3. 撤单检测 - 大单突然消失 (诱多/诱空)
 */

import { logger } from '@/utils/logger';
import { OrderBookAlertRepository } from '@/database/orderbook_alert_repository';
import {
  BinanceDepthUpdate,
  OrderBookSnapshot,
  OrderBookLevel,
  OrderBookAlert,
  OrderBookAlertType,
  AlertSeverity,
  OrderBookMonitorConfig,
  DEFAULT_ORDERBOOK_CONFIG,
  OrderBookMonitorStatistics
} from '@/types/orderbook_types';

export class OrderBookMonitorService {
  private repository: OrderBookAlertRepository;

  // 快照缓存: symbol -> OrderBookSnapshot[]
  private snapshot_cache: Map<string, OrderBookSnapshot[]> = new Map();
  private readonly MAX_SNAPSHOT_HISTORY = 5;

  // 冷启动计数: symbol -> count
  private warmup_count: Map<string, number> = new Map();

  // 冷却记录: "symbol_alertType" -> timestamp
  private cooldown_map: Map<string, number> = new Map();

  // 配置
  private config: OrderBookMonitorConfig;

  // 统计
  private stats = {
    total_alerts: 0,
    big_order_alerts: 0,
    imbalance_alerts: 0,
    withdrawal_alerts: 0,
    symbols_warmed_up: 0
  };

  constructor(config?: Partial<OrderBookMonitorConfig>) {
    this.config = { ...DEFAULT_ORDERBOOK_CONFIG, ...config };
    this.repository = new OrderBookAlertRepository();
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    await this.repository.init_tables();
    logger.info('[OrderBookMonitor] Service initialized');
    logger.info(`[OrderBookMonitor] Config: big_order=${this.config.big_order_multiplier}x, imbalance=${this.config.imbalance_ratio_high}/${this.config.imbalance_ratio_low}, cooldown=${this.config.cooldown_ms / 1000}s`);
  }

  /**
   * 处理订单簿深度更新
   */
  async process_depth_update(data: BinanceDepthUpdate): Promise<OrderBookAlert[]> {
    try {
      // 1. 解析订单簿数据
      const snapshot = this.parse_snapshot(data);

      // 2. 更新快照缓存
      this.update_cache(snapshot);

      // 3. 检查冷启动状态
      const warmup_complete = this.check_warmup(snapshot.symbol);

      const alerts: OrderBookAlert[] = [];

      // 策略1: 大单检测 (无需历史数据)
      const big_orders = this.detect_big_orders(snapshot);
      alerts.push(...big_orders);

      // 策略2: 买卖失衡 (无需历史数据)
      const imbalance = this.detect_imbalance(snapshot);
      if (imbalance) {
        alerts.push(imbalance);
      }

      // 策略3: 撤单检测 (需要历史快照)
      if (warmup_complete) {
        const prev = this.get_previous_snapshot(snapshot.symbol);
        if (prev) {
          const withdrawals = this.detect_withdrawal(snapshot, prev);
          alerts.push(...withdrawals);
        }
      }

      // 4. 应用限频，保存到数据库
      const filtered_alerts = await this.filter_and_save(alerts);

      return filtered_alerts;
    } catch (error) {
      logger.error(`[OrderBookMonitor] Error processing depth update for ${data.s}:`, error);
      return [];
    }
  }

  /**
   * 解析币安订单簿数据为快照格式
   */
  private parse_snapshot(data: BinanceDepthUpdate): OrderBookSnapshot {
    const parse_levels = (levels: [string, string][]): OrderBookLevel[] => {
      return levels.map(([price_str, qty_str]) => {
        const price = parseFloat(price_str);
        const qty = parseFloat(qty_str);
        return {
          price,
          qty,
          value: price * qty
        };
      });
    };

    const bids = parse_levels(data.b);
    const asks = parse_levels(data.a);

    const bid_total_qty = bids.reduce((sum, l) => sum + l.qty, 0);
    const ask_total_qty = asks.reduce((sum, l) => sum + l.qty, 0);
    const bid_total_value = bids.reduce((sum, l) => sum + l.value, 0);
    const ask_total_value = asks.reduce((sum, l) => sum + l.value, 0);

    return {
      symbol: data.s,
      timestamp: data.E,
      bids,
      asks,
      bid_total_qty,
      ask_total_qty,
      bid_total_value,
      ask_total_value,
      current_price: bids.length > 0 ? bids[0].price : (asks.length > 0 ? asks[0].price : 0)
    };
  }

  /**
   * 更新快照缓存
   */
  private update_cache(snapshot: OrderBookSnapshot): void {
    const history = this.snapshot_cache.get(snapshot.symbol) || [];
    history.push(snapshot);

    // 保留最近N个快照
    while (history.length > this.MAX_SNAPSHOT_HISTORY) {
      history.shift();
    }

    this.snapshot_cache.set(snapshot.symbol, history);
  }

  /**
   * 检查冷启动状态
   */
  private check_warmup(symbol: string): boolean {
    const count = this.warmup_count.get(symbol) || 0;

    if (count < this.config.warmup_snapshots) {
      this.warmup_count.set(symbol, count + 1);

      if (count + 1 === this.config.warmup_snapshots) {
        this.stats.symbols_warmed_up++;
      }

      return false;
    }

    return true;
  }

  /**
   * 获取上一个快照
   */
  private get_previous_snapshot(symbol: string): OrderBookSnapshot | null {
    const history = this.snapshot_cache.get(symbol);
    if (!history || history.length < 2) {
      return null;
    }
    return history[history.length - 2];
  }

  /**
   * 策略一：大单检测
   */
  private detect_big_orders(snapshot: OrderBookSnapshot): OrderBookAlert[] {
    const alerts: OrderBookAlert[] = [];
    const all_levels = [...snapshot.bids, ...snapshot.asks];

    if (all_levels.length === 0) {
      return alerts;
    }

    // 计算20档的平均挂单量
    const avg_qty = all_levels.reduce((sum, l) => sum + l.qty, 0) / all_levels.length;

    if (avg_qty === 0) {
      return alerts;
    }

    // 检测买盘大单 (买单墙)
    for (const level of snapshot.bids) {
      const ratio = level.qty / avg_qty;

      if (ratio >= this.config.big_order_multiplier &&
          level.value >= this.config.big_order_min_value_usdt) {
        alerts.push({
          symbol: snapshot.symbol,
          alert_time: snapshot.timestamp,
          alert_type: OrderBookAlertType.BIG_ORDER,
          side: 'BID',
          order_price: level.price,
          order_qty: level.qty,
          order_value_usdt: level.value,
          avg_order_qty: avg_qty,
          order_ratio: ratio,
          current_price: snapshot.current_price,
          severity: this.calculate_severity(ratio, 10, 20, 30),
          is_important: ratio >= 20
        });
      }
    }

    // 检测卖盘大单 (卖单墙)
    for (const level of snapshot.asks) {
      const ratio = level.qty / avg_qty;

      if (ratio >= this.config.big_order_multiplier &&
          level.value >= this.config.big_order_min_value_usdt) {
        alerts.push({
          symbol: snapshot.symbol,
          alert_time: snapshot.timestamp,
          alert_type: OrderBookAlertType.BIG_ORDER,
          side: 'ASK',
          order_price: level.price,
          order_qty: level.qty,
          order_value_usdt: level.value,
          avg_order_qty: avg_qty,
          order_ratio: ratio,
          current_price: snapshot.current_price,
          severity: this.calculate_severity(ratio, 10, 20, 30),
          is_important: ratio >= 20
        });
      }
    }

    return alerts;
  }

  /**
   * 策略二：买卖失衡检测
   */
  private detect_imbalance(snapshot: OrderBookSnapshot): OrderBookAlert | null {
    const total_value = snapshot.bid_total_value + snapshot.ask_total_value;

    // 过滤小币种
    if (total_value < this.config.imbalance_min_total_value) {
      return null;
    }

    if (snapshot.ask_total_qty === 0) {
      return null;
    }

    const ratio = snapshot.bid_total_qty / snapshot.ask_total_qty;

    // 买盘远大于卖盘 (看多信号)
    if (ratio >= this.config.imbalance_ratio_high) {
      return {
        symbol: snapshot.symbol,
        alert_time: snapshot.timestamp,
        alert_type: OrderBookAlertType.IMBALANCE,
        bid_total_qty: snapshot.bid_total_qty,
        ask_total_qty: snapshot.ask_total_qty,
        imbalance_ratio: ratio,
        current_price: snapshot.current_price,
        severity: ratio >= 3 ? AlertSeverity.HIGH : AlertSeverity.MEDIUM,
        is_important: ratio >= 3
      };
    }

    // 卖盘远大于买盘 (看空信号)
    if (ratio <= this.config.imbalance_ratio_low) {
      return {
        symbol: snapshot.symbol,
        alert_time: snapshot.timestamp,
        alert_type: OrderBookAlertType.IMBALANCE,
        bid_total_qty: snapshot.bid_total_qty,
        ask_total_qty: snapshot.ask_total_qty,
        imbalance_ratio: ratio,
        current_price: snapshot.current_price,
        severity: ratio <= 0.33 ? AlertSeverity.HIGH : AlertSeverity.MEDIUM,
        is_important: ratio <= 0.33
      };
    }

    return null;
  }

  /**
   * 策略三：撤单检测
   */
  private detect_withdrawal(
    current: OrderBookSnapshot,
    previous: OrderBookSnapshot
  ): OrderBookAlert[] {
    const alerts: OrderBookAlert[] = [];

    // 检测买盘撤单
    for (const prev_level of previous.bids) {
      // 只检测大单
      if (prev_level.value < this.config.withdrawal_min_value_usdt) {
        continue;
      }

      // 查找当前快照中相同价格的档位
      const curr_level = current.bids.find(
        l => Math.abs(l.price - prev_level.price) < prev_level.price * 0.0001
      );

      const curr_qty = curr_level?.qty || 0;
      const withdrawn_qty = prev_level.qty - curr_qty;

      if (prev_level.qty === 0) continue;

      const withdrawal_ratio = withdrawn_qty / prev_level.qty;
      const withdrawn_value = withdrawn_qty * prev_level.price;

      // 大单消失 (撤单超过80%且价值超过阈值)
      if (withdrawal_ratio >= this.config.withdrawal_min_ratio &&
          withdrawn_value >= this.config.withdrawal_min_value_usdt) {
        alerts.push({
          symbol: current.symbol,
          alert_time: current.timestamp,
          alert_type: OrderBookAlertType.WITHDRAWAL,
          side: 'BID',
          order_price: prev_level.price,
          prev_qty: prev_level.qty,
          curr_qty: curr_qty,
          withdrawn_qty: withdrawn_qty,
          withdrawn_value_usdt: withdrawn_value,
          current_price: current.current_price,
          severity: AlertSeverity.HIGH,
          is_important: true
        });
      }
    }

    // 检测卖盘撤单
    for (const prev_level of previous.asks) {
      if (prev_level.value < this.config.withdrawal_min_value_usdt) {
        continue;
      }

      const curr_level = current.asks.find(
        l => Math.abs(l.price - prev_level.price) < prev_level.price * 0.0001
      );

      const curr_qty = curr_level?.qty || 0;
      const withdrawn_qty = prev_level.qty - curr_qty;

      if (prev_level.qty === 0) continue;

      const withdrawal_ratio = withdrawn_qty / prev_level.qty;
      const withdrawn_value = withdrawn_qty * prev_level.price;

      if (withdrawal_ratio >= this.config.withdrawal_min_ratio &&
          withdrawn_value >= this.config.withdrawal_min_value_usdt) {
        alerts.push({
          symbol: current.symbol,
          alert_time: current.timestamp,
          alert_type: OrderBookAlertType.WITHDRAWAL,
          side: 'ASK',
          order_price: prev_level.price,
          prev_qty: prev_level.qty,
          curr_qty: curr_qty,
          withdrawn_qty: withdrawn_qty,
          withdrawn_value_usdt: withdrawn_value,
          current_price: current.current_price,
          severity: AlertSeverity.HIGH,
          is_important: true
        });
      }
    }

    return alerts;
  }

  /**
   * 计算严重程度
   */
  private calculate_severity(value: number, low_threshold: number, medium_threshold: number, high_threshold: number): AlertSeverity {
    if (value >= high_threshold) {
      return AlertSeverity.HIGH;
    } else if (value >= medium_threshold) {
      return AlertSeverity.MEDIUM;
    }
    return AlertSeverity.LOW;
  }

  /**
   * 检查是否在冷却期
   */
  private is_in_cooldown(symbol: string, alert_type: OrderBookAlertType): boolean {
    const key = `${symbol}_${alert_type}`;
    const last_alert = this.cooldown_map.get(key);

    if (!last_alert) {
      return false;
    }

    return Date.now() - last_alert < this.config.cooldown_ms;
  }

  /**
   * 记录报警时间
   */
  private record_alert(symbol: string, alert_type: OrderBookAlertType): void {
    const key = `${symbol}_${alert_type}`;
    this.cooldown_map.set(key, Date.now());
  }

  /**
   * 过滤并保存报警
   */
  private async filter_and_save(alerts: OrderBookAlert[]): Promise<OrderBookAlert[]> {
    const filtered: OrderBookAlert[] = [];

    for (const alert of alerts) {
      // 检查冷却期
      if (this.is_in_cooldown(alert.symbol, alert.alert_type)) {
        continue;
      }

      // 保存到数据库
      try {
        await this.repository.save_alert(alert);

        // 记录冷却时间
        this.record_alert(alert.symbol, alert.alert_type);

        // 更新统计
        this.stats.total_alerts++;
        if (alert.alert_type === OrderBookAlertType.BIG_ORDER) {
          this.stats.big_order_alerts++;
        } else if (alert.alert_type === OrderBookAlertType.IMBALANCE) {
          this.stats.imbalance_alerts++;
        } else if (alert.alert_type === OrderBookAlertType.WITHDRAWAL) {
          this.stats.withdrawal_alerts++;
        }

        filtered.push(alert);
      } catch (error) {
        logger.error(`[OrderBookMonitor] Failed to save alert:`, error);
      }
    }

    return filtered;
  }

  /**
   * 清理过期的冷却记录
   */
  cleanup_cooldown(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, timestamp] of this.cooldown_map) {
      if (now - timestamp > this.config.cooldown_ms * 2) {
        this.cooldown_map.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * 获取服务统计
   */
  get_statistics(): {
    total_alerts: number;
    big_order_alerts: number;
    imbalance_alerts: number;
    withdrawal_alerts: number;
    symbols_cached: number;
    symbols_warmed_up: number;
    cooldown_entries: number;
    config: OrderBookMonitorConfig;
  } {
    return {
      ...this.stats,
      symbols_cached: this.snapshot_cache.size,
      symbols_warmed_up: this.stats.symbols_warmed_up,
      cooldown_entries: this.cooldown_map.size,
      config: this.config
    };
  }

  /**
   * 获取配置
   */
  get_config(): OrderBookMonitorConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  update_config(updates: Partial<OrderBookMonitorConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('[OrderBookMonitor] Config updated:', this.config);
  }

  /**
   * 获取Repository实例
   */
  get_repository(): OrderBookAlertRepository {
    return this.repository;
  }

  /**
   * 停止服务
   */
  stop(): void {
    this.snapshot_cache.clear();
    this.warmup_count.clear();
    this.cooldown_map.clear();
    logger.info('[OrderBookMonitor] Service stopped');
  }
}
