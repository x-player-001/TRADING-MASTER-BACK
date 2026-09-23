#!/bin/bash

# 一键回测脚本
# 使用方法: ./scripts/dev/backtest/quick_backtest.sh

set -e  # 遇到错误立即退出

echo "════════════════════════════════════════════════════════════════"
echo "🚀 一键回测脚本"
echo "════════════════════════════════════════════════════════════════"
echo ""

# 检查是否在项目根目录
if [ ! -f "package.json" ]; then
    echo "❌ 错误: 请在项目根目录运行此脚本"
    echo "   使用方法: ./scripts/dev/backtest/quick_backtest.sh"
    exit 1
fi

# 检查环境变量
if [ ! -f ".env" ]; then
    echo "❌ 错误: 未找到 .env 文件"
    exit 1
fi

echo "✅ 环境检查通过"
echo ""

# 运行回测
echo "⏳ 正在运行回测..."
echo "────────────────────────────────────────────────────────────────"
echo ""

npm run backtest

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✨ 回测完成！"
echo "════════════════════════════════════════════════════════════════"
echo ""

# 显示最新结果文件
LATEST_RESULT=$(ls -t backtest_results/backtest_*.json | head -1)

if [ -n "$LATEST_RESULT" ]; then
    echo "📁 结果文件: $LATEST_RESULT"
    echo ""

    # 显示简要统计
    echo "📊 快速统计:"
    echo "────────────────────────────────────────────────────────────────"
    node -e "
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync('$LATEST_RESULT', 'utf-8'));
        const s = data.summary;

        console.log('  总交易数:', s.total_trades);
        console.log('  胜率:', s.win_rate.toFixed(2) + '%');
        console.log('  总盈亏:', s.total_pnl > 0 ? '+\$' + s.total_pnl.toFixed(2) : '\$' + s.total_pnl.toFixed(2));
        console.log('  ROI:', s.roi_percent > 0 ? '+' + s.roi_percent.toFixed(2) + '%' : s.roi_percent.toFixed(2) + '%');
        console.log('  盈亏比:', s.profit_factor.toFixed(2));
        console.log('  最大回撤:', s.max_drawdown.toFixed(2) + ' (' + s.max_drawdown_percent.toFixed(2) + '%)');
    "
    echo ""
fi

echo "💡 提示:"
echo "  - 查看详细结果: cat $LATEST_RESULT | jq '.summary'"
echo "  - 验证保证金: node scripts/dev/verify/verify_fixed_margin.js"
echo "  - 对比历史: node scripts/dev/backtest/compare_margin_modes.js"
echo ""
