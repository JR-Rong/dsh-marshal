#!/usr/bin/env bash
# 构建 iOS 模拟器包（无需签名）。
#
# 前置条件（本机目前缺一项，脚本会明确报出来）：
#   1. 同意 Xcode 许可：sudo xcodebuild -license
#   2. 安装命令行工具：xcode-select --install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode 许可未同意，无法编译 iOS。" >&2
  echo "请在终端执行： sudo xcodebuild -license" >&2
  exit 2
fi

echo "==> 构建 Web 资源"
npm run build

echo "==> 同步到 iOS 工程"
npx cap sync ios

echo "==> xcodebuild（模拟器，免签名）"
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO \
  build

echo "==> 产物：ios/build/Build/Products/Debug-iphonesimulator/App.app"
