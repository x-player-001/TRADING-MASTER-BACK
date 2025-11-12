# OI异动重新检测脚本

## 📋 功能说明

这个脚本用于重新检测指定日期的所有OI（持仓量）异动情况。适用于以下场景：

1. **Bug修复后补检测**：异动检测逻辑修复后，重新检测历史数据
2. **数据迁移后补检测**：从单表迁移到日期分表后，重新分析历史数据
3. **调整检测参数后重新分析**：修改阈值配置后，重新评估异动情况

## 🚀 使用方法

### 基本用法

```bash
# 检测今天的数据（默认）
npm run redetect-oi

# 检测指定日期的数据
npm run redetect-oi 2025-11-12
npm run redetect-oi 2025-11-11
```

### 直接运行

```bash
# 使用 ts-node 直接运行
npx ts-node -r tsconfig-paths/register scripts/redetect_oi_anomalies.ts [日期]

# 示例
npx ts-node -r tsconfig-paths/register scripts/redetect_oi_anomalies.ts 2025-11-12
```

## 📊 输出示例

```
========================================
🔍 开始重新检测 2025-11-12 的OI异动
========================================
📥 尝试从日期表加载: open_interest_snapshots_20251112
✅ 从日期表加载成功: 85234 条记录
📊 加载了 85234 条快照记录
💰 共 126 个币种
  ✓ BTCUSDT: 检测到 12 个异动
  ✓ ETHUSDT: 检测到 8 个异动
  ✓ PTBUSDT: 检测到 15 个异动
  ...

💾 开始保存 156 条异动记录...
✅ 保存完成

✅ 检测完成！共检测到 156 个异动

📊 检测摘要:
  严重级别分布:
    🔴 高 (≥30%):    5 个
    🟡 中 (≥15%):    23 个
    🟢 低 (<15%):    128 个

  周期分布:
    1分钟: 45 个
    2分钟: 38 个
    5分钟: 42 个
    15分钟: 31 个

  TOP 10 变化最大的异动:
    1. PTBUSDT      2m  -45.23% (02:45:17)
    2. XYZUSDT      1m   38.91% (14:23:45)
    3. ABCUSDT      5m  -32.15% (08:12:33)
    ...
========================================
```

## ⚙️ 检测配置

脚本使用与 `oi_polling_service.ts` 一致的检测配置：

```typescript
const DETECTION_CONFIG = {
  // 异动阈值
  thresholds: {
    '60': 3,      // 1分钟: 3%
    '120': 3,     // 2分钟: 3%
    '300': 3,     // 5分钟: 3%
    '900': 10     // 15分钟: 10%
  },

  // 去重阈值
  dedup_threshold: 1,  // 1% - 防止重复报警

  // 严重程度阈值
  severity_thresholds: {
    high: 30,    // ≥30% 为高
    medium: 15   // ≥15% 为中
  }
};
```

## 🔍 数据来源

脚本会按以下优先级加载数据：

1. **日期分表**（优先）：`open_interest_snapshots_YYYYMMDD`
   - 例如：`open_interest_snapshots_20251112`
   - 适用于日期分表迁移后的数据

2. **原始表**（降级）：`open_interest_snapshots`
   - 如果日期表不存在或为空，从原始表查询
   - 适用于迁移前的历史数据

## 📝 注意事项

1. **数据去重**
   - 脚本使用 `INSERT IGNORE` 语句插入，不会重复写入相同的异动记录
   - 安全执行，可多次运行同一日期

2. **时间范围**
   - 只检测指定日期当天的数据（00:00:00 - 23:59:59）
   - 不会影响其他日期的数据

3. **性能考虑**
   - 单日数据量约 80,000-100,000 条快照
   - 检测耗时约 10-30 秒（取决于数据量）
   - 建议在业务低峰期执行

4. **数据库连接**
   - 脚本使用环境变量中的数据库配置
   - 确保 `.env` 文件配置正确
   - 执行完成后会自动关闭数据库连接

## 🛠️ 故障排查

### 问题1: "未找到快照数据"

**原因**: 指定日期没有OI快照数据

**解决方案**:
```bash
# 检查数据库中是否有该日期的数据
mysql -u root -p trading_master -e "
  SELECT COUNT(*) FROM open_interest_snapshots_20251112;
  SELECT COUNT(*) FROM open_interest_snapshots WHERE DATE(snapshot_time) = '2025-11-12';
"
```

### 问题2: "日期格式错误"

**原因**: 日期参数格式不正确

**解决方案**:
```bash
# 正确格式
npm run redetect-oi 2025-11-12

# 错误格式（会报错）
npm run redetect-oi 2025/11/12
npm run redetect-oi 20251112
```

### 问题3: TypeScript 编译错误

**原因**: 缺少依赖或配置问题

**解决方案**:
```bash
# 安装依赖
npm install date-fns

# 确保 tsconfig.json 配置正确
npm run typecheck
```

## 📚 相关文件

- **脚本文件**: `scripts/redetect_oi_anomalies.ts`
- **检测服务**: `src/services/oi_polling_service.ts`
- **数据仓库**: `src/database/oi_repository.ts`
- **日期表管理**: `src/database/daily_table_manager.ts`

## 🔗 相关文档

- [OI异动检测Bug修复说明](../docs/OI_ANOMALY_DETECTION_FIX.md)
- [日期分表迁移文档](../database/migrations/migrate_to_daily_tables.sql)
- [OI曲线API文档](../docs/OI_CURVE_API.md)

---

**更新时间**: 2025-11-12
**版本**: v1.0.0
