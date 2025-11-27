# 🚀 实盘交易使用指南

## 系统已就绪,可以进行实盘交易! ✅

项目已包含完整的实盘交易功能,并且我已经为您创建了使用回测优化参数的启动脚本。

---

## 快速开始

### 1️⃣ 配置API密钥

编辑 `.env` 文件:
```bash
BINANCE_API_KEY=your_api_key_here
BINANCE_API_SECRET=your_secret_key_here
```

### 2️⃣ 启动纸面交易(推荐第一步)

```bash
npx ts-node -r tsconfig-paths/register scripts/run_live_trading_optimized.ts
```

默认是 **PAPER模式**(纸面交易),完全安全,不会下真实订单!

---

## 📊 使用回测优化的最佳配置

✨ **配置亮点**:
- ✅ 只做多 (做空盈利差)
- ✅ 20%@+10%, 20%@+16%, 60%跟踪止盈
- ✅ 无固定止损 (逐仓自动限损)
- ✅ 5倍杠杆,2小时超时
- ✅ 7天回测收益率: **+40.77%**

---

## 🎯 三种交易模式

### 模式1: PAPER (纸面交易) 📝
- **特点**: 不下真实订单,只模拟执行
- **用途**: 测试系统,观察信号
- **风险**: ✅ 零风险
- **建议**: 运行24小时以上

### 模式2: TESTNET (测试网) 🧪  
- **特点**: 使用测试币,真实API环境
- **用途**: 验证订单执行,测试止盈逻辑
- **风险**: ✅ 零风险(测试币)
- **建议**: 完成3笔以上完整交易

### 模式3: LIVE (实盘) 💰
- **特点**: 真实资金交易
- **用途**: 实盘赚钱
- **风险**: ⚠️ 有风险
- **建议**: 从小资金开始($50-$200)

---

## 🔧 切换交易模式

编辑 `scripts/run_live_trading_optimized.ts`:

```typescript
// PAPER模式 (默认,安全)
const trading_mode = TradingMode.PAPER;

// 测试网模式
const trading_mode = TradingMode.TESTNET;

// 实盘模式 (⚠️ 真实资金!)
const trading_mode = TradingMode.LIVE;
```

---

## ⚠️ 重要提示

### 风险警告
1. **回测≠实盘**: 实盘可能有滑点、延迟
2. **市场变化**: 历史表现不代表未来
3. **资金安全**: 
   - 建议初始资金: $50-$200
   - 只用闲钱,随时准备亏损
   - 不要使用借贷资金

### 建议流程
```
PAPER测试(24h+) → TESTNET验证(3笔+) → LIVE小资金试运行
```

---

## 📱 实时监控

系统每30秒显示状态:

```
📊 实时状态
运行状态: ✅ 运行中
模式: 📝 纸面交易
当前持仓: 2个
总交易次数: 15
胜率: 40.0% (6胜/9负)
总盈亏: +$45.32
收益率: 45.32%

📍 当前持仓:
  1. RVVUSDT LONG @ $0.004608
     持仓: 15min | 盈亏: +12.3%
     跟踪止盈: ✅
```

---

## 🛑 停止交易

按 `Ctrl + C` 优雅退出,会显示最终统计。

⚠️ **注意**: 停止后不会自动平仓,需手动处理剩余持仓!

---

## 📁 相关文件

- **启动脚本**: [scripts/run_live_trading_optimized.ts](../scripts/run_live_trading_optimized.ts)
- **交易引擎**: [src/trading/live_trading_engine.ts](../src/trading/live_trading_engine.ts)
- **订单执行**: [src/trading/order_executor.ts](../src/trading/order_executor.ts)

---

## 💡 成功建议

1. **先纸面测试24小时**: 观察信号质量
2. **再测试网验证**: 完成3笔交易
3. **最后小资金实盘**: $50-$200起步
4. **稳定盈利后**: 逐步加大资金

---

**祝交易顺利! 🚀**

*记住: 交易有风险,投资需谨慎!*
