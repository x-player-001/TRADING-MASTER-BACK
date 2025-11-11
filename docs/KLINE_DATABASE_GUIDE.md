# K线数据库配置与查询指南

> **用途**：为 Analysis Service 提供K线数据库访问的完整文档

---

## 📋 目录

1. [数据库表结构](#数据库表结构)
2. [连接配置](#连接配置)
3. [TypeScript实现](#typescript实现)
4. [查询示例](#查询示例)
5. [性能优化](#性能优化)
6. [注意事项](#注意事项)

---

## 📊 数据库表结构

### **1. 分表设计**

K线数据按周期分表存储，提高查询性能：

| 表名 | 周期 | 说明 |
|------|------|------|
| `kline_1m` | 1分钟 | 短线分析 |
| `kline_5m` | 5分钟 | 日内交易 |
| `kline_15m` | 15分钟 | 缠论分析常用周期 |
| `kline_1h` | 1小时 | 趋势分析 |
| `kline_4h` | 4小时 | 中期趋势 |
| `kline_1d` | 1天 | 长期趋势 |

---

### **2. 表结构（所有周期表结构相同）**

```sql
CREATE TABLE kline_1m (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,

  -- 核心字段
  symbol VARCHAR(20) NOT NULL COMMENT '交易对符号，如 BTCUSDT',
  open_time TIMESTAMP(3) NOT NULL COMMENT 'K线开始时间（毫秒精度）',
  close_time TIMESTAMP(3) NOT NULL COMMENT 'K线结束时间（毫秒精度）',

  -- 价格字段（OHLC）
  open DECIMAL(20,8) NOT NULL COMMENT '开盘价',
  high DECIMAL(20,8) NOT NULL COMMENT '最高价',
  low DECIMAL(20,8) NOT NULL COMMENT '最低价',
  close DECIMAL(20,8) NOT NULL COMMENT '收盘价',

  -- 成交量字段
  volume DECIMAL(30,8) NOT NULL COMMENT '成交量（基础资产）',
  trade_count INT NOT NULL COMMENT '成交笔数',

  -- 元数据
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '数据入库时间',

  -- 索引
  UNIQUE KEY uk_symbol_time (symbol, open_time),
  INDEX idx_symbol_time_desc (symbol, open_time DESC),
  INDEX idx_time_desc (open_time DESC),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### **3. 字段说明**

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `symbol` | VARCHAR(20) | 交易对符号（大写） | `BTCUSDT`, `ETHUSDT` |
| `open_time` | TIMESTAMP(3) | K线开始时间（UTC+8） | `2025-10-10 09:00:00.000` |
| `close_time` | TIMESTAMP(3) | K线结束时间（UTC+8） | `2025-10-10 09:14:59.999` |
| `open` | DECIMAL(20,8) | 开盘价 | `50000.12345678` |
| `high` | DECIMAL(20,8) | 最高价 | `50500.50000000` |
| `low` | DECIMAL(20,8) | 最低价 | `49800.00000000` |
| `close` | DECIMAL(20,8) | 收盘价 | `50200.25000000` |
| `volume` | DECIMAL(30,8) | 成交量（BTC数量） | `125.45678900` |
| `trade_count` | INT | 成交笔数 | `15234` |

---

### **4. 索引说明**

| 索引名 | 字段 | 类型 | 用途 |
|--------|------|------|------|
| `PRIMARY` | `id` | 主键 | 唯一标识 |
| `uk_symbol_time` | `(symbol, open_time)` | 唯一索引 | 防止重复数据 |
| `idx_symbol_time_desc` | `(symbol, open_time DESC)` | 复合索引 | 加速按时间倒序查询 |
| `idx_time_desc` | `(open_time DESC)` | 单字段索引 | 时间范围查询 |
| `idx_symbol` | `(symbol)` | 单字段索引 | 币种查询 |

---

## 🔧 连接配置

### **1. 环境变量配置**

```bash
# .env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=yourpassword
MYSQL_DATABASE=trading_master

# 连接池配置
MYSQL_CONNECTION_LIMIT=10
MYSQL_QUEUE_LIMIT=0
```

---

### **2. 数据库配置接口**

```typescript
// config/database_config.ts
export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  queueLimit: number;
}

export const getDatabaseConfig = (): DatabaseConfig => ({
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'trading_master',
  connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT || '10'),
  queueLimit: parseInt(process.env.MYSQL_QUEUE_LIMIT || '0')
});
```

---

## 💻 TypeScript实现

### **1. 数据类型定义**

```typescript
// types/kline.ts
export interface KlineData {
  symbol: string;          // 交易对符号
  interval: string;        // 周期（1m, 5m, 15m, 1h, 4h, 1d）
  open_time: number;       // 开始时间（毫秒时间戳）
  close_time: number;      // 结束时间（毫秒时间戳）
  open: number;            // 开盘价
  high: number;            // 最高价
  low: number;             // 最低价
  close: number;           // 收盘价
  volume: number;          // 成交量
  trade_count: number;     // 成交笔数
}
```

---

### **2. K线查询类实现**

```typescript
// database/kline_reader.ts
import mysql from 'mysql2/promise';
import { getDatabaseConfig } from '../config/database_config';
import { KlineData } from '../types/kline';

export class KlineReader {
  private pool: mysql.Pool;

  // 周期到表名的映射
  private readonly TABLE_MAP: Record<string, string> = {
    '1m': 'kline_1m',
    '5m': 'kline_5m',
    '15m': 'kline_15m',
    '1h': 'kline_1h',
    '4h': 'kline_4h',
    '1d': 'kline_1d'
  };

  constructor() {
    const config = getDatabaseConfig();

    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit,
      waitForConnections: true,
      queueLimit: config.queueLimit,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });

    console.log('[KlineReader] 数据库连接池已创建');
  }

  /**
   * 获取表名
   */
  private getTableName(interval: string): string {
    const tableName = this.TABLE_MAP[interval];
    if (!tableName) {
      throw new Error(
        `不支持的周期: ${interval}. 支持的周期: ${Object.keys(this.TABLE_MAP).join(', ')}`
      );
    }
    return tableName;
  }

  /**
   * 将数据库记录转换为KlineData
   */
  private convertToKlineData(record: any, interval: string): KlineData {
    return {
      symbol: record.symbol,
      interval: interval,
      open_time: new Date(record.open_time).getTime(),
      close_time: new Date(record.close_time).getTime(),
      open: parseFloat(record.open),
      high: parseFloat(record.high),
      low: parseFloat(record.low),
      close: parseFloat(record.close),
      volume: parseFloat(record.volume),
      trade_count: parseInt(record.trade_count)
    };
  }

  /**
   * 获取最新的N条K线数据（时间正序）
   * @param symbol 币种符号，如 BTCUSDT
   * @param interval 周期，如 15m
   * @param limit 数量，默认500
   * @returns K线数据数组（时间正序）
   */
  async getLatestKlines(
    symbol: string,
    interval: string,
    limit: number = 500
  ): Promise<KlineData[]> {
    const tableName = this.getTableName(interval);

    // 查询最新N条记录（倒序）
    const sql = `
      SELECT
        symbol,
        open_time,
        close_time,
        open,
        high,
        low,
        close,
        volume,
        trade_count
      FROM ${tableName}
      WHERE symbol = ?
      ORDER BY open_time DESC
      LIMIT ?
    `;

    try {
      const [rows] = await this.pool.execute(sql, [symbol.toUpperCase(), limit]);
      const records = rows as any[];

      // 反转为时间正序（旧→新）
      const klines = records
        .reverse()
        .map(record => this.convertToKlineData(record, interval));

      console.log(`[KlineReader] 查询成功: ${symbol} ${interval}, 返回${klines.length}条`);

      return klines;
    } catch (error) {
      console.error('[KlineReader] 查询失败:', error);
      throw error;
    }
  }

  /**
   * 获取指定时间范围的K线数据（时间正序）
   * @param symbol 币种符号
   * @param interval 周期
   * @param startTime 开始时间（毫秒时间戳）
   * @param endTime 结束时间（毫秒时间戳）
   * @returns K线数据数组（时间正序）
   */
  async getKlinesByTimeRange(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number
  ): Promise<KlineData[]> {
    const tableName = this.getTableName(interval);

    const sql = `
      SELECT
        symbol,
        open_time,
        close_time,
        open,
        high,
        low,
        close,
        volume,
        trade_count
      FROM ${tableName}
      WHERE symbol = ?
        AND open_time >= ?
        AND open_time <= ?
      ORDER BY open_time ASC
    `;

    const [rows] = await this.pool.execute(sql, [
      symbol.toUpperCase(),
      new Date(startTime),
      new Date(endTime)
    ]);

    const records = rows as any[];
    return records.map(record => this.convertToKlineData(record, interval));
  }

  /**
   * 获取某个币种的数据统计
   * @param symbol 币种符号
   * @param interval 周期
   * @returns 统计信息
   */
  async getKlineStats(
    symbol: string,
    interval: string
  ): Promise<{
    total: number;
    earliest: Date | null;
    latest: Date | null;
  }> {
    const tableName = this.getTableName(interval);

    const sql = `
      SELECT
        COUNT(*) as total,
        MIN(open_time) as earliest,
        MAX(open_time) as latest
      FROM ${tableName}
      WHERE symbol = ?
    `;

    const [rows] = await this.pool.execute(sql, [symbol.toUpperCase()]);
    const stats = (rows as any[])[0];

    return {
      total: parseInt(stats.total),
      earliest: stats.earliest,
      latest: stats.latest
    };
  }

  /**
   * 测试数据库连接
   */
  async testConnection(): Promise<boolean> {
    try {
      const [rows] = await this.pool.execute('SELECT 1 as test');
      return (rows as any[])[0]?.test === 1;
    } catch (error) {
      console.error('[KlineReader] 连接测试失败:', error);
      return false;
    }
  }

  /**
   * 关闭连接池
   */
  async close(): Promise<void> {
    await this.pool.end();
    console.log('[KlineReader] 数据库连接池已关闭');
  }
}
```

---

## 📝 查询示例

### **1. 基础查询**

```typescript
// 初始化
const reader = new KlineReader();

// 查询最新500条15分钟K线
const klines = await reader.getLatestKlines('BTCUSDT', '15m', 500);

console.log(`查询到 ${klines.length} 条K线`);
console.log('最早时间:', new Date(klines[0].open_time));
console.log('最新时间:', new Date(klines[klines.length - 1].close_time));
```

---

### **2. 时间范围查询**

```typescript
// 查询2025年10月7日到10月9日的K线
const startTime = new Date('2025-10-07T00:00:00+08:00').getTime();
const endTime = new Date('2025-10-09T23:59:59+08:00').getTime();

const klines = await reader.getKlinesByTimeRange(
  'BTCUSDT',
  '15m',
  startTime,
  endTime
);

console.log(`范围内K线数量: ${klines.length}`);
```

---

### **3. 数据统计查询**

```typescript
const stats = await reader.getKlineStats('BTCUSDT', '15m');

console.log('数据统计:');
console.log('  总记录数:', stats.total);
console.log('  最早数据:', stats.earliest);
console.log('  最新数据:', stats.latest);
```

---

### **4. 批量查询多个币种**

```typescript
const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const interval = '1h';

const results = await Promise.all(
  symbols.map(symbol =>
    reader.getLatestKlines(symbol, interval, 100)
  )
);

results.forEach((klines, index) => {
  console.log(`${symbols[index]}: ${klines.length}条K线`);
});
```

---

### **5. 直接SQL查询（高级）**

```typescript
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'yourpassword',
  database: 'trading_master'
});

// 查询最新10条K线
const [rows] = await connection.execute(`
  SELECT * FROM kline_15m
  WHERE symbol = 'BTCUSDT'
  ORDER BY open_time DESC
  LIMIT 10
`);

console.log(rows);
await connection.end();
```

---

## ⚡ 性能优化

### **1. 连接池配置**

```typescript
// 根据并发量调整连接池大小
connectionLimit: 10  // Analysis Service（查询为主）建议10-20
connectionLimit: 20  // Data Service（读写频繁）建议20-50
```

---

### **2. 查询优化建议**

| 优化项 | 说明 | 示例 |
|--------|------|------|
| **使用索引** | WHERE条件包含symbol | `WHERE symbol = 'BTCUSDT'` |
| **限制数量** | 使用LIMIT控制返回量 | `LIMIT 500` |
| **避免SELECT \*** | 只查询需要的字段 | `SELECT open, high, low, close` |
| **批量查询** | 使用IN代替多次查询 | `WHERE symbol IN (...)` |
| **时间范围** | 使用时间索引加速 | `WHERE open_time >= ? AND open_time <= ?` |

---

### **3. 缓存策略**

```typescript
import NodeCache from 'node-cache';

export class CachedKlineReader extends KlineReader {
  private cache: NodeCache;

  constructor() {
    super();
    // 缓存5分钟
    this.cache = new NodeCache({ stdTTL: 300 });
  }

  async getLatestKlines(
    symbol: string,
    interval: string,
    limit: number = 500
  ): Promise<KlineData[]> {
    const cacheKey = `${symbol}:${interval}:${limit}`;

    // 尝试从缓存获取
    const cached = this.cache.get<KlineData[]>(cacheKey);
    if (cached) {
      console.log('[Cache] 命中缓存');
      return cached;
    }

    // 缓存未命中，查询数据库
    const klines = await super.getLatestKlines(symbol, interval, limit);

    // 写入缓存
    this.cache.set(cacheKey, klines);

    return klines;
  }
}
```

---

## ⚠️ 注意事项

### **1. 时间处理**

- ✅ 数据库使用 `TIMESTAMP(3)` 存储（毫秒精度）
- ✅ JavaScript使用 `Date.getTime()` 获取毫秒时间戳
- ⚠️ 数据库时区为 UTC+8（北京时间）

```typescript
// 正确：使用毫秒时间戳
const timestamp = new Date('2025-10-10T09:00:00+08:00').getTime();
// 1728525600000

// 错误：直接传Date对象到SQL
const date = new Date(); // ❌ 可能导致时区问题
```

---

### **2. 数据类型转换**

```typescript
// ⚠️ MySQL返回的DECIMAL类型是字符串
record.open;     // "50000.12345678"

// ✅ 需要转换为数字
parseFloat(record.open);  // 50000.12345678
```

---

### **3. 符号大小写**

```typescript
// ✅ 数据库存储的是大写符号
symbol.toUpperCase();  // BTCUSDT

// ❌ 小写会查询不到数据
'btcusdt'  // 查询结果为空
```

---

### **4. 数据去重**

- 数据库有 `UNIQUE KEY (symbol, open_time)` 约束
- 插入重复数据会报错或被忽略（使用 `INSERT IGNORE`）
- 查询时无需担心重复数据

---

### **5. 连接池管理**

```typescript
// ✅ 应用启动时创建一次
const reader = new KlineReader();

// ✅ 应用关闭时销毁
process.on('SIGINT', async () => {
  await reader.close();
  process.exit(0);
});

// ❌ 不要每次查询都创建新实例
// 每次 new KlineReader() 会创建新连接池，导致连接泄漏
```

---

## 🔍 数据验证

### **检查数据完整性**

```sql
-- 检查某个币种的K线数据
SELECT
  symbol,
  COUNT(*) as total,
  MIN(open_time) as earliest,
  MAX(open_time) as latest,
  MAX(open_time) - MIN(open_time) as time_span
FROM kline_15m
WHERE symbol = 'BTCUSDT'
GROUP BY symbol;
```

---

### **检查数据缺口**

```sql
-- 检查时间序列是否连续
SELECT
  a.open_time as current_time,
  b.open_time as next_time,
  TIMESTAMPDIFF(MINUTE, a.open_time, b.open_time) as gap_minutes
FROM kline_15m a
LEFT JOIN kline_15m b ON b.id = (
  SELECT MIN(id) FROM kline_15m WHERE id > a.id AND symbol = a.symbol
)
WHERE a.symbol = 'BTCUSDT'
  AND TIMESTAMPDIFF(MINUTE, a.open_time, b.open_time) > 15
ORDER BY a.open_time DESC
LIMIT 10;
```

---

## 📦 完整示例项目结构

```
analysis-service/
├── src/
│   ├── config/
│   │   └── database_config.ts      # 数据库配置
│   ├── database/
│   │   └── kline_reader.ts         # K线查询类
│   ├── types/
│   │   └── kline.ts                # 数据类型定义
│   └── index.ts                    # 入口文件
├── .env                            # 环境变量
├── package.json
└── tsconfig.json
```

---

## 📚 相关文档

- [MySQL连接池配置](https://github.com/sidorares/node-mysql2#using-connection-pools)
- [时间戳处理最佳实践](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date)
- [SQL查询优化](https://dev.mysql.com/doc/refman/8.0/en/optimization.html)

---

## 📞 技术支持

如有问题，请参考：
- Data Service 项目：`trading-master-back`
- 数据库迁移脚本：`database/migrations/create_kline_tables.sql`
- K线存储实现：`src/database/kline_multi_table_repository.ts`

---

**最后更新**: 2025-10-10
**维护者**: Trading Master Team
