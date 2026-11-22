# v11 · Apple 风格与真机验收

日期：2026-11-20
基线：PR7 `rjr/cx/pr6-routing-memory-fixes`（`bfdafce`，`0.2.0-agent-groups.23`）
分支：`feat/mobile-pr7-apple`（手机端 `0.7.6`，Android `versionCode=25`）

## A. 设计与资源

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| A1 | 双层材质：仅 Tab 栏 / 输入区 / Toast 使用 `backdrop-filter`，内容卡片为实底 | PASS | `src/styles.css` 中 `backdrop-filter` 仅出现在 `.tabbar`、`.composer-wrap`、`.toast` |
| A2 | 浅色 / 深色随系统切换，颜色全部走语义 Token | PASS | `:root` + `@media (prefers-color-scheme: dark)`；`apple-light.png` / `apple-dark.png` |
| A3 | 品牌强调色取自仓库图标（`#1F6FEB` / 深色 `#409CFF`） | PASS | Token `--accent`；应用内 logo `logoMark()` 与 `plugin-build/icon.svg` 同源 |
| A4 | 应用图标直接使用仓库 `plugin-build/icon.svg` | PASS | `scripts/make-assets.py` 解析该 SVG 的 path/circle；iOS AppIcon 1024（无 alpha）、Android 自适应/传统/圆形图标 |
| A5 | 启动图统一品牌蓝底 + 白色标记 | PASS | `Splash.imageset`、`drawable*/splash.png` 全套重生成 |
| A6 | 排版：系统字体栈、正文 17px、最小 11px（Tab 标签）/12px（辅助文案）、数字等宽 | PASS | `styles.css` 字号阶梯；`font-variant-numeric: tabular-nums` |
| A7 | 触控热区 ≥44pt；Tab 栏 4 项（设备/会话/看板/设置） | PASS | `.tab-item` 48pt；`.session/.device-head` ≥58pt；`home-*.png` / `sessions-*.png` |
| A8 | iOS 导航栏返回为左侧 chevron，标题超长省略；列表分隔线无圆角弯曲 | PASS | `topbar(..., back)` + `.back-button`；`.card-tap { border-radius: 0 }`；花名册升级为分组行 |
| A9 | 无应用内换肤；`window.alert/confirm/prompt` 为 0 | PASS | 删除 `lib/theme.ts` 与主题选择器；全局搜索无原生弹窗 |
| A10 | 内容层无 Emoji 充当功能图标；Android 浅/深色状态栏图标对比度正常 | PASS | 相机占位改为仓库 logo；`values/styles.xml` + `values-night/styles.xml` + `MainActivity.applySystemBars()` |

截图证据（`mobile/docs/screenshots/`）：
- 首屏（浅/深）：`apple-light.png`、`apple-dark.png`
- 首页（浅/深）：`home-light.png`、`home-dark.png`
- 会话页（浅/深）：`sessions-light.png`、`sessions-dark.png`
- Android 真机（浅/深）：`android-light.png`（顶部状态栏深色图标 `min lum=45.0` / 3,471 像素）、`android-dark.png`（顶部状态栏浅色图标 `max lum=255.0` / 3,783 像素）

## B. 构建与自动化测试

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B1 | TypeScript 类型检查 | PASS | `cd mobile && npx tsc --noEmit` |
| B2 | 移动端单元测试 | PASS | `cd mobile && npm test`（63/63 PASS，0 fail） |
| B3 | Web 生产构建与 Capacitor 双端同步 | PASS | `npm run build && npx cap sync`（Android / iOS 各 9 个插件） |
| B4 | Android debug APK 编译 | PASS | `mobile/android/app/build/outputs/apk/debug/app-debug.apk`（10 MB，`versionCode=25`，`versionName=0.7.6`） |
| B5 | iOS 编译 | 沙箱阻塞 | `xcodebuild -sdk iphoneos` 已成功拉取 `capacitor-swift-pm@8.6.2` 与 `keychain-swift@21.0.0`，但 SwiftPM 写 `~/Library/Caches/org.swift.swiftpm/manifests/ManifestLoading/capapp-spm.dia` 被 `workspace-write` 沙箱拒绝；需宿主终端/授权后构建 |

## C. 真机验证

| # | 设备 | 结果 | 证据 |
|---|---|---|---|
| C1 | Android HUAWEI ALT-AL10（Android 12 / SDK 31，USB `22N0223B28011287`） | PASS | `adb install -r` 成功（`0.7.6` / `versionCode=25`）；浅色与深色模式启动、状态栏明暗图标、图标与排版真机截图实测通过（`android-light.png` / `android-dark.png`） |
| C2 | iPhone 14 Pro Max（iOS 27.2，USB 已配对 `00008120-000929C11110C01E`） | 待皇上解锁前置条件 | `devicectl` 实测：`Developer Mode Status: Disabled`，且本机 `security find-identity` 为 0 个可用签名身份。需在 iPhone 开启「设置 → 隐私与安全性 → 开发者模式」并在 Xcode 登录 Apple ID 选择签名 Team 后 `xcodebuild` 安装 |
| C3 | iOS 模拟器 | 不可用 | 本机未安装匹配的 iOS Simulator Runtime |

## D. 环境自足说明

本机系统仅装有 JDK 17 与 Android platform 35；为不改动系统全局配置，构建工具链隔离于工作区 `.toolchain/`（已加入 `.gitignore`）：

- `.toolchain/jdk`：Temurin JDK 21.0.13.1
- `.toolchain/android-sdk`：Android platform 36 + 软链系统 build-tools/platform-tools/licenses
- `.toolchain/gradle`：Gradle 8.14.3 缓存
- `.toolchain/debug.keystore`：本地调试签名库

Android 一键复现命令：

```bash
ROOT="$PWD"
export JAVA_HOME="$ROOT/.toolchain/jdk/Contents/Home"
export ANDROID_HOME="$ROOT/.toolchain/android-sdk"
export GRADLE_USER_HOME="$ROOT/.toolchain/gradle"
cd "$ROOT/mobile/android" && ./gradlew assembleDebug --no-daemon -x lint \
  -Pandroid.injected.signing.store.file="$ROOT/.toolchain/debug.keystore" \
  -Pandroid.injected.signing.store.password=android \
  -Pandroid.injected.signing.key.alias=androiddebugkey \
  -Pandroid.injected.signing.key.password=android
```

iOS 真机安装命令（在开启开发者模式与 Xcode 签名后于宿主终端执行）：

```bash
cd mobile && npm run cap:sync
open ios/App/App.xcodeproj
# 在 App 与 LiveActivity 两个 Target 选择 Signing Team，目标选 siyao的iPhone 后 Run
```
