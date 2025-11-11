#!/bin/bash
# ===========================================
# 项目安全清理脚本
# 用途: 切换为Public仓库前的敏感信息清理
# ===========================================

set -e  # 遇到错误立即退出

echo "=========================================="
echo "🔒 开始项目安全清理..."
echo "=========================================="
echo ""

# 1. 更新 .gitignore
echo "📝 [1/5] 更新 .gitignore..."
if ! grep -q ".claude/settings.local.json" .gitignore; then
    echo "" >> .gitignore
    echo "# Claude AI本地配置" >> .gitignore
    echo ".claude/settings.local.json" >> .gitignore
    echo "  ✅ 已添加 .claude/settings.local.json"
else
    echo "  ℹ️  .gitignore 已包含 Claude 配置"
fi

if ! grep -q "/secrets/" .gitignore; then
    echo "" >> .gitignore
    echo "# 敏感数据目录" >> .gitignore
    echo "/secrets/" >> .gitignore
    echo "/data/backups/" >> .gitignore
    echo "  ✅ 已添加敏感数据目录"
fi
echo ""

# 2. 移除已追踪的敏感文件
echo "🗑️  [2/5] 检查并移除敏感文件追踪..."
if git ls-files --error-unmatch .claude/settings.local.json 2>/dev/null; then
    git rm --cached .claude/settings.local.json
    echo "  ✅ 已移除 settings.local.json 追踪"
else
    echo "  ℹ️  settings.local.json 未被追踪"
fi
echo ""

# 3. 验证 .env 状态
echo "🔍 [3/5] 验证 .env 状态..."
if git ls-files --error-unmatch .env 2>/dev/null; then
    echo "  ⚠️  警告: .env 文件在Git追踪中，正在移除..."
    git rm --cached .env
    echo "  ✅ 已移除 .env 追踪"
else
    echo "  ✅ .env 文件未被追踪（安全）"
fi
echo ""

# 4. 检查Git历史
echo "📜 [4/5] 检查Git历史中的敏感信息..."
if git log --all --full-history --oneline -- .env 2>/dev/null | head -1 | grep -q "."; then
    echo "  ⚠️  警告: .env 在历史记录中存在！"
    echo "  需要使用 git filter-branch 或 BFG Repo-Cleaner 清理"
    echo "  参考: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository"
else
    echo "  ✅ Git历史中无 .env 记录（安全）"
fi
echo ""

# 5. 检查是否有未提交的更改
echo "📊 [5/5] 检查Git状态..."
if [[ -n $(git status -s) ]]; then
    echo "  ℹ️  检测到以下未提交的更改:"
    git status -s
    echo ""
    echo "  建议执行:"
    echo "  git add .gitignore"
    echo "  git commit -m 'chore: 更新.gitignore以提升安全性'"
else
    echo "  ✅ 工作区干净"
fi
echo ""

# 6. 最终检查清单
echo "=========================================="
echo "✅ 安全清理完成！"
echo "=========================================="
echo ""
echo "📋 切换为Public前的最终检查清单："
echo ""
echo "  必须完成:"
echo "  [ ] 1. 确认 .env 中的API密钥不是生产环境密钥"
echo "  [ ] 2. 检查 .env.test 文件内容"
echo "  [ ] 3. 如果 .gitignore 有更新，提交更改"
echo ""
echo "  建议完成:"
echo "  [ ] 4. 在 README.md 中添加安全配置说明"
echo "  [ ] 5. 创建 .env.production.example 文件"
echo ""
echo "🎯 准备就绪后，在GitHub仓库设置中切换为Public"
echo ""
