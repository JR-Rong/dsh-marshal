#!/usr/bin/env bash
# 构建 Android 调试包。
#
# 依赖：JDK **21+**（Capacitor 8 的 Android 源码按 Java 21 编译）、
#       Android SDK（platform 36、build-tools 35+）、Node 22+。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}java"
MAJOR="$("${JAVA_BIN}" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
if [[ -z "${MAJOR:-}" || "$MAJOR" -lt 21 ]]; then
  echo "需要 JDK 21+（当前：${JAVA_HOME:-系统 java}）。" >&2
  echo "例：export JAVA_HOME=/path/to/jdk-21" >&2
  exit 2
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
# debug keystore 需要可写目录；默认 ~/.android
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$HOME/.android}"
mkdir -p "$ANDROID_USER_HOME"

if [[ ! -d "$ANDROID_HOME/platforms/android-36" ]]; then
  echo "缺少 Android platform 36（${ANDROID_HOME}/platforms/android-36）。" >&2
  echo "安装：sdkmanager 'platforms;android-36'" >&2
  exit 2
fi

echo "==> 构建 Web 资源"
npm run build

echo "==> 同步到 Android 工程"
npx cap sync android

echo "==> Gradle 打包"
cd android
./gradlew assembleDebug --console=plain "${@}"

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ -f "$APK" ]]; then
  echo "==> APK: $APK"
  ls -lh "$APK"
fi
