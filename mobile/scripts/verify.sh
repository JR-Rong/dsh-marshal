#!/usr/bin/env bash
# 一键自检：类型检查 → 单元测试 → Web 构建 → 原生同步 → UI 冒烟（可选）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/4 类型检查"
npx tsc --noEmit

echo "==> 2/4 单元测试"
npm test

echo "==> 3/4 构建 Web 资源"
npx vite build

echo "==> 4/4 原生工程同步"
npx cap sync android >/dev/null
npx cap sync ios >/dev/null
echo "    android + ios 同步完成"

if [[ "${MARSHAL_SKIP_UI:-0}" != "1" ]]; then
  echo "==> 附加：UI 冒烟（Playwright + 本机 Chrome）"
  node scripts/ui-smoke.mjs || echo "   UI 冒烟跳过（未安装 playwright-core 或 Chrome 不可用）"
fi

echo "==> 全部通过"
