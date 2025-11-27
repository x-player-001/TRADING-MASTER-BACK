# 评分系统优化 V2

## 修改时间
2025-11-26 23:03

## 备份文件
`src/trading/signal_generator.ts.backup_20251126_230304`

## 修改原因

通过实际信号案例分析发现原评分系统存在以下问题：

### 实际案例
```
DODOX:  OI+3.08%, Price+7.88%, 大户持仓1.25, 大户账户3.58 → 原评分6.1, 实际涨幅很好
TANSSI: OI+3.83%, Price+1.65%, 大户持仓1.58, 大户账户3.22 → 原评分6.8, 实际涨幅很好
OM:     OI+3.15%, Price+1.71%, 大户持仓1.23, 大户账户1.98, 资金费率-0.0326% → 原评分5.5, 实际涨幅很好
```

### 核心问题
1. **OI评分区间错误**：3-5%的OI变化才是真正的早期启动，但只给2分
2. **价格评分过于保守**：没有区分"强突破"和"追高"
3. **大户账户多空比完全未使用**：这是反映大户共识度的超级指标
4. **资金费率未实现**：固定返回1分，没有利用负费率信号

---

## 优化方案

### 1. OI评分优化（0-3分）

#### 修改前
```typescript
if (abs_change >= 5 && abs_change <= 10) {
  score = 3;      // 最佳：早期启动阶段
} else if (abs_change >= 3 && abs_change < 5) {
  score = 2;      // 一般：刚开始异动
}
```

#### 修改后
```typescript
if (abs_change >= 3 && abs_change <= 5) {
  score = 3;      // 最佳：早期启动阶段 ✨
} else if (abs_change > 5 && abs_change <= 10) {
  score = 2.5;    // 良好：中期加速阶段
}
```

**改进点**：
- 3-5%的OI变化提升到最高分（早期启动最佳入场点）
- 5-10%降为次优（已进入加速期）

---

### 2. 价格评分优化（0-2分）

#### 修改前
```typescript
if (abs_price_change > 6 && abs_price_change <= 10) {
  score = 0.8;    // 警惕：可能偏高
}
```

#### 修改后
```typescript
if (abs_price_change > 6 && abs_price_change <= 10) {
  // 关键判断：结合OI变化
  if (is_oi_early_stage) {  // OI在3-5%
    score = 2;    // OI早期+价格大涨 = 强突破确认 ✨
  } else {
    score = 1.2;  // OI已加速+价格大涨 = 可能追高
  }
}
```

**改进点**：
- 不再简单认为6-10%的价格变化是"追高"
- **智能判断**：如果OI刚启动(3-5%)，价格大涨(6-10%)是强突破确认
- 只有OI已加速时，价格大涨才认为是追高

---

### 3. 增加大户账户多空比（情绪评分新增指标）

#### 新增代码
```typescript
// 3. 大户账户数多空比（超级指标 - 反映大户共识度）✨
if (anomaly.top_account_long_short_ratio) {
  const ratio = parseFloat(anomaly.top_account_long_short_ratio.toString());
  indicators_count++;

  if (is_long_signal) {
    if (ratio > 3.0) {
      score += 2.0;   // 超强：绝大多数大户做多
    } else if (ratio > 2.0) {
      score += 1.5;   // 强：大户高度一致做多
    } else if (ratio > 1.5) {
      score += 1.0;   // 中等：大户偏多
    } else {
      score += 0.3;   // 弱：大户分歧大
    }
  }
  // 做空信号类似逻辑...
}
```

**改进点**：
- 情绪评分从3个指标增加到4个
- 大户账户多空比权重最高（给2.0分）
- 反映大户群体的一致性，比单纯持仓量更准确

---

### 4. 实现资金费率评分（0-2分）

#### 修改前
```typescript
private calculate_funding_rate_score(anomaly: OIAnomalyRecord): number {
  return 1;  // 固定返回中性分
}
```

#### 修改后
```typescript
private calculate_funding_rate_score(anomaly: OIAnomalyRecord): number {
  const funding_rate = parseFloat(anomaly.funding_rate_after.toString());

  if (is_long_signal) {
    // 做多信号：负费率是超级信号
    if (funding_rate < -0.01) {
      score = 2;      // 超强：深度负费率
    } else if (funding_rate < 0) {
      score = 1.7;    // 强：轻微负费率
    }
    // ...
  }
}
```

**改进点**：
- 利用 `funding_rate_after` 字段
- **负费率是做多超级信号**：做空的人补贴做多的人
- **正费率是做空超级信号**：做多的人补贴做空的人

---

## 预期效果

### 案例信号重新评分预估

#### DODOX
- **原评分**：6.1
- **优化后预估**：
  - OI评分：2→3 (+1)
  - 价格评分：0.8→2 (+1.2) ← OI早期+价格7.88%=强突破
  - 情绪评分：2.5→3 (+0.5) ← 新增大户账户3.58
  - 资金费率：不变
- **新评分预估**：8.8+ ✨

#### TANSSI
- **原评分**：6.8
- **优化后预估**：
  - OI评分：2→3 (+1)
  - 价格评分：1→2 (+1)
  - 情绪评分：2.8→3 (+0.2) ← 新增大户账户3.22
  - 资金费率：不变
- **新评分预估**：9.0+ ✨

#### OM
- **原评分**：5.5
- **优化后预估**：
  - OI评分：2→3 (+1)
  - 价格评分：1→2 (+1)
  - 情绪评分：1.5→2.3 (+0.8) ← 新增大户账户1.98
  - **资金费率：1→2 (+1)** ← 负费率-0.0326%
- **新评分预估**：8.3+ ✨

---

## 评分系统新框架

### 总分构成（0-10分）
```
总分 = OI评分(0-3) + 价格评分(0-2) + 情绪评分(0-3) + 资金费率(0-2)
```

### 信号强度分类
- **≥7分**: STRONG（强信号）
- **5-7分**: MEDIUM（中等信号）
- **<5分**: WEAK（弱信号）

### 核心改进
1. ✅ **早期启动识别**：3-5% OI变化给最高分
2. ✅ **智能突破判断**：结合OI判断价格涨幅是强突破还是追高
3. ✅ **大户共识度**：新增大户账户多空比，反映群体一致性
4. ✅ **资金费率信号**：利用负/正费率增强信号质量

---

## 回滚方法

如需回滚到原评分逻辑：

```bash
cp src/trading/signal_generator.ts.backup_20251126_230304 src/trading/signal_generator.ts
```

---

## 下一步测试

1. 运行评分分布分析，查看新评分的分布情况
2. 执行7天回测，对比新旧评分系统的表现
3. 验证3个实际案例的新评分是否符合预期

---

## 技术细节

### 修改的函数
1. `calculate_oi_score()` - OI评分逻辑
2. `calculate_price_score()` - 价格评分逻辑
3. `calculate_sentiment_score()` - 情绪评分（新增第4个指标）
4. `calculate_funding_rate_score()` - 资金费率评分（从固定1分改为动态评分）

### 新增依赖字段
- `top_account_long_short_ratio` - 大户账户数多空比
- `funding_rate_after` - 异动后的资金费率

### 兼容性
- 所有字段都做了存在性检查
- 如果字段不存在，降级为默认分数
- 向后兼容，不会因缺少字段而报错
