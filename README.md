# 智能加密货币交易后端系统

基于Node.js + TypeScript的高性能交易后端系统，专注于实时数据处理、技术分析、交易规则引擎和风险管理。

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18.0.0
- **MySQL** >= 8.0
- **Redis** >= 6.0
- **TypeScript** >= 5.0.0

### 安装步骤

1. **克隆项目**
```bash
git clone <repository-url>
cd trading-master-back
```

2. **安装依赖**
```bash
npm install
```

3. **配置环境变量**
```bash
# 复制环境变量模板
cp .env.example .env

# 编辑配置文件
# 配置币安API密钥、数据库连接等信息
```

4. **设置数据库**
```bash
# 创建MySQL数据库
mysql -u root -p
CREATE DATABASE trading_master;
CREATE DATABASE trading_master_test;
```

5. **启动Redis服务**
```bash
# Windows
redis-server

# Linux/macOS
sudo systemctl start redis
# 或
redis-server /usr/local/etc/redis.conf
```

### 运行项目

#### 开发模式
```bash
npm run dev
```

#### 生产模式
```bash
npm run build
npm start
```

#### 运行测试
```bash
# 运行所有测试
npm test

# 监听模式运行测试
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

#### 代码检查
```bash
# 代码格式检查
npm run lint

# TypeScript类型检查
npm run typecheck
```

## 📋 功能特性

### ✅ 已实现功能

- **🔌 数据处理核心**
  - 币安WebSocket实时数据订阅
  - 30个预设币种多流订阅管理
  - Redis多层缓存优化
  - 历史数据按需获取

- **🗄️ 数据库架构**
  - MySQL关系型数据存储
  - 完整的Repository模式
  - 事务处理和错误恢复

- **🌐 API接口封装**
  - 币安REST API统一封装
  - 自动签名和错误处理
  - 环境变量配置管理

- **🧪 测试框架**
  - Jest单元测试
  - 数据库集成测试
  - API接口测试

### 🚧 开发中功能

- **📊 技术分析引擎** - 技术指标计算
- **⚡ 交易规则引擎** - DSL规则编译器
- **📈 信号处理系统** - 交易信号生成
- **🛡️ 风险控制模块** - 智能风险管理

## 🏗️ 项目结构

```
src/
├── api/                     # API接口封装
│   └── binance_api.ts      # 币安API封装
├── core/                   # 核心业务模块
│   ├── data/               # 数据处理
│   │   ├── symbol_config_manager.ts      # 币种配置管理
│   │   ├── subscription_pool.ts          # WebSocket订阅池
│   │   ├── multi_symbol_manager.ts       # 多币种管理
│   │   ├── stream_dispatcher.ts          # 数据流分发
│   │   └── historical_data_manager.ts    # 历史数据管理
│   └── config/             # 配置管理
├── database/               # 数据库操作层
│   ├── base_repository.ts  # 基础仓库类
│   ├── symbol_config_repository.ts       # 币种配置仓库
│   └── subscription_status_repository.ts # 订阅状态仓库
├── types/                  # 类型定义
├── utils/                  # 工具函数
└── index.ts               # 应用入口

tests/                     # 测试文件
├── api/                   # API测试
├── database/              # 数据库测试
└── setup.ts              # 测试配置
```

## ⚙️ 配置说明

### 环境变量配置

```env
# 币安API配置
BINANCE_API_KEY=your_api_key
BINANCE_API_SECRET=your_api_secret
BINANCE_API_BASE_URL=https://api.binance.com/api/v3
BINANCE_WS_BASE_URL=wss://stream.binance.com:9443/ws

# 数据库配置
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=trading_master

# Redis配置
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# 服务配置
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
CACHE_EXPIRE_HOURS=24
```

## 🔧 开发指南

### 代码规范

- **命名规范**: 采用snake_case命名（文件、变量、函数）
- **类和接口**: 使用PascalCase
- **注释要求**: 每个方法都需要中文注释说明
- **类型安全**: 全面的TypeScript类型定义

### 数据库设计

- **symbol_configs**: 币种配置表
- **subscription_status**: 订阅状态表
- **historical_data_cache**: 历史数据缓存表

### API设计模式

```typescript
// Repository模式
const repository = new SymbolConfigRepository();
const symbols = await repository.find_all();

// 单例模式
const api = BinanceAPI.getInstance();
const klines = await api.get_klines('BTCUSDT', '1h');
```

## 📊 监控和日志

### 系统监控
- WebSocket连接状态监控
- 数据订阅状态追踪
- 缓存命中率统计
- API调用频率监控

### 日志等级
- **DEBUG**: 详细调试信息
- **INFO**: 常规操作信息
- **WARN**: 警告信息
- **ERROR**: 错误信息

## 🤝 贡献指南

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/新功能`)
3. 提交更改 (`git commit -am '添加新功能'`)
4. 推送到分支 (`git push origin feature/新功能`)
5. 创建 Pull Request

## 📄 许可证

MIT License

## 🆘 常见问题

### Q: 如何配置币安API？
A: 在.env文件中设置BINANCE_API_KEY和BINANCE_API_SECRET

### Q: 数据库连接失败怎么办？
A: 检查MySQL服务是否启动，确认.env中的数据库配置正确

### Q: Redis连接错误？
A: 确认Redis服务正在运行，检查端口和密码配置

### Q: 测试无法运行？
A: 确保测试数据库已创建，.env.test配置正确

---

🎯 **目标**: 构建高性能、可扩展的智能交易后端系统，为量化交易提供核心支撑。