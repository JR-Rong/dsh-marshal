#!/usr/bin/env bash
# 构建 iOS 模拟器包（免签名）。
#
# 前置条件：
#   1. 同意 Xcode 许可： sudo xcodebuild -license accept
#   2. 安装命令行工具： xcode-select --install
#
# 注意：SPM 要把包缓存写到 ~/Library/Caches/org.swift.swiftpm。
# 在受限沙箱里构建会报 "You don't have permission to save ... org.swift.swiftpm"，
# 请在普通终端（或具备该目录写权限的环境）里执行本脚本。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode 许可未同意，无法编译 iOS。" >&2
  echo "请在终端执行： sudo xcodebuild -license accept" >&2
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
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO \
  build

APP="$ROOT/ios/build/Build/Products/Debug-iphonesimulator/App.app"
if [[ -d "$APP" ]]; then
  echo "==> 产物：$APP"
  du -sh "$APP"
  echo "  安装到模拟器： xcrun simctl install booted \"$APP\""
fi
