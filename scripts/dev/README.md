# dev/ — 开发期一次性脚本

这里存放**调试、分析、验证类的一次性脚本**，不参与线上运行。
线上/例行脚本保留在上层 `scripts/` 根目录（pm2 进程、npm scripts、数据回填）。

## 目录划分

| 目录 | 用途 | 典型文件 |
|---|---|---|
| `analysis/` | 数据分析、信号质量统计、导出 | `analyze_trend_signal_quality.ts`、`analyze_1h_lv1_profit.ts`、`export_*.ts` |
| `debug/` | 问题排查、临时调试、数据检查 | `debug_*.ts`、`diagnose_*.ts`、`check_*.ts`、`tmp_*.ts` |
| `backtest/` | 历史回测试验与参数对比 | `backtest_*.ts`、`compare_*.js` |
| `verify/` | 功能验证与专项测试 | `test_*.ts`、`verify_*.js` |
| `maintenance/` | 一次性数据迁移与清理 | `migrate_*.ts`、`clear_*.ts`、`truncate_*.ts` |

## 运行方式

脚本位于二级目录，相对导入为 `../../../src/...`：

```bash
npx ts-node -r tsconfig-paths/register scripts/dev/analysis/analyze_trend_signal_quality.ts
```

> 多数脚本需要连服务器 MySQL（读 `.env`），本机无法访问币安 API，
> 涉及行情拉取的脚本请在服务器上执行。

## 约定

- 新增一次性脚本请放入对应子目录，不要放在 `scripts/` 根目录
- 根目录只保留：pm2 托管入口、npm scripts 引用、例行数据回填
