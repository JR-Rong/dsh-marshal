# 验收记录 · v0.2.0（手机端 node 全功能）

记录时间：2026-11-18 06:58
环境：macOS（Apple Silicon）、Node v22.20.0、JDK 21.0.13（Temurin）、Android SDK platform 36 + build-tools、Xcode 27.2
定位：手机端 **node 形态**——自绘界面、出站直连 Hub、不承载 hub、不监听端口。

---

## 一、本版改了什么

| 改动 | 落点 |
|---|---|
| 模型目录与本次发送模型 | `op=controls` 真取模型表；`prompt.options.model` |
| 思考强度 | 按所选模型真实 efforts 列出；`prompt.options.reasoning` |
| 附件上传 | 256 KiB 分片 `op=upload`，≤8 个、每个 ≤10 MB，带 SHA-256 |
| 忽略待答 | `op=cancel`，仅能力文档含 cancel 时出现 |
| 会话统计 | 输入/输出/缓存读/缓存写，未上报时如实显示 |
| 空槽位渲染修复 | `append(null)` 曾显示 "null" 字样，已在 render 过滤 |
| 版本 | 0.2.0 / Android versionCode 2 / iOS 2 |

原生侧（Capacitor 插件、壳工程）本版**未改**；改动集中在 TypeScript 界面与 Hub 客户端。

---

## 二、结论速览

| 项 | 结果 | 证据 |
|---|---|---|
| 类型检查 | 通过 | `npx tsc --noEmit` 无输出 |
| 单元测试 | **39/39** | `npm test`（新增 controls/上传分片/prompt 参数 8 项） |
| Web 构建 | 通过 | `npx vite build` |
| UI 冒烟 | 通过，9 图 | `node scripts/ui-smoke.mjs`，无页面报错 |
| 真 Hub 只读联调 | **PASS** | `npm run live:check`（见 §三） |
| Android APK | BUILD SUCCESSFUL | 4.0 MB，versionName 0.2.0，含新界面 |
| iOS 模拟器包 | 已重组（原生壳复用） | 6.7 MB，bundle id/版本/插件符号正确；**全量重编译被沙箱阻断**（见 §五） |
| 服务端代码 | 无 | `grep -rn "createServer\|listen(" src/` 为空 |
| 端口监听 | 无 | App 只做出站 fetch / 原生 SSE |

---

## 三、真 Hub 联调（2026-11-18）

环境：`MARSHAL_LIVE_HUB=https://hub.example.com`（真实地址脱敏），令牌来自本机 hub.json，不写入仓库。

```
devices ok: 2 rjr-mac-local | account-****
sessions ok: rjr-mac-local 323 running 1
sessions ok: account-**** 9 running 0
controls ok: 100 models; current deepseek-account/deepseek-flash / -
history ok: 16 items; completeness complete
inputs ok: 0 cards
upload ok: 64ece0b1-… 25 bytes; complete true
discussions: unauthorized（本 Hub 账号登录模式，令牌不可用）
LIVE CHECK PASS
```

说明：`controls` 对本地 DSH 设备返回 100 个模型，对账号设备返回 2 个；手机端按会话实际结果渲染，不写死。

### 真 Hub 界面联调（只读）

本地静态服务 + `/marshal/api` 反向代理（代理侧注入令牌），真浏览器跑自绘界面：

```
api GET  /marshal/api/devices  200
api GET  /marshal/api/stream   200
devices: M5 | Company
api GET  /marshal/api/sessions 200
sessions rendered: 43
api POST /marshal/api/command  200
api POST /marshal/api/history  200
api POST /marshal/api/inputs   200
session stats: 输入 357.9k / 输出 100.3k / 缓存读 29.2M
model options: 1（该会话 controls 未返回目录，界面保留「读取模型」重试）
api POST /marshal/api/command  200
controls rows: 22（模型目录列前 12）
LIVE UI PASS（pageErrors: []）
```

截图在 `/tmp/marshal-live-shots/`（含真实设备与会话标题，不提交仓库）。
控制项页对 100 个模型只列前 12 个，其余提示用会话页下拉选择，避免万像素长页。
注：本次界面联调点中的会话 controls 未返回目录（`live:check` 另一会话实测 100 个模型），故截图里保留「读取模型」按钮；不伪造模型表。

---

## 四、壳内 UI 冒烟

390×844@3x，无头 Chrome，9 张截图：

| 图 | 内容 |
|---|---|
| 01 | 配置页 |
| 02 | 设备列表 |
| 03 | 会话列表 |
| 04 | 会话详情（审批卡 + 忽略待答 + 历史 + 流式） |
| 05a | 附件已上传（notes.txt） |
| 05 | 发送消息（模型 DeepSeek-V4-Pro / 思考 高） |
| 06 | 控制项（模型目录 + 会话统计 + 能力） |
| 07 | 设置 |
| 08 | 应用锁 |

报告：`docs/screenshots/smoke-report.json`，`pageErrors: []`。

---

## 五、双端产物

### Android

```
BUILD SUCCESSFUL
artifacts/dsh-marshal-mobile-0.2.0-debug.apk   4.0 MB
sha256 e62dc24bea5f7e6dc3c6b3a6a09074aee2793480b576dfdf611e0610127eccbb
package com.rongjunrui.marshal.mobile
versionCode 2  versionName 0.2.0
minSdk 24  targetSdk 36
permissions INTERNET, ACCESS_NETWORK_STATE
```

构建环境（本机实际使用）：

```bash
export JAVA_HOME=/tmp/jdk21/Contents/Home
export ANDROID_HOME=/tmp/dsh-android-sdk
export ANDROID_USER_HOME=/tmp/dsh-android-user
export GRADLE_USER_HOME=/tmp/dsh-gradle-home
cd android && ./gradlew assembleDebug
```

### iOS

```
artifacts/dsh-marshal-mobile-0.2.0-ios-simulator.zip   2.0 MB（解压 6.7 MB）
sha256 32b10bf271d75bbf83238e12a28ad15babd95c4b1e8592e97dbd220206d88d60
CFBundleIdentifier      com.rongjunrui.marshal.mobile
CFBundleShortVersionString 0.2.0
App.debug.dylib 内 marshalstream 符号 79 处
public/assets 已换成本版构建（含「手机端 node」文案）
```

**未完成全量重编译的原因（如实记录）**：
Xcode 的 SwiftPM 需要写 `~/Library/Caches/org.swift.swiftpm/manifests/ManifestLoading/*.dia`；
当前会话文件沙箱只允许写工作区，`-packageCachePath` / `-clonedSourcePackagesDirPath` / `HOME` / `CFFIXED_USER_HOME` 均未能改掉该路径；
改用 `CFFIXED_USER_HOME` 后 SwiftPM 又调用自身 `sandbox-exec`，被当前沙箱拒绝。
因此本版 iOS 包采用「06:15 已成功编译的原生壳 + 本版 Web 资源 + 版本号」重组；
原生代码本版未改，插件与二进制不受影响。
在普通终端执行 `bash scripts/build-ios.sh` 可做一次全量重编译。

模拟器启动仍受本机 CoreSimulator 版本限制：1051.55.0 < Xcode 27.2 要求的 1174.21.0。
真机安装需在 Xcode 里选 Team 签名。

---

## 六、node 边界与未覆盖

1. **群聊在本 Hub 不可用**：`/marshal/api/discussions` 只认账号 cookie；本 Hub 令牌登录实测 400。代码已按接口留位。
2. **不实现 wire v2 node 执行协议**：手机无 DSH 运行时；纯协议接入只会是「没有会话的空设备」，故按甲案走管理接口直连。
3. **新建会话 / 分支 / 中断未开放**：Hub 能力文档 `create/fork = not-exposed-in-v0`、`interrupt = no-atomic-turn-binding`。
4. **持久可调项只读**：Hub 把 model/reasoning 标为 `v0-field-only`；本版只做「本次发送」参数。
5. **无推送**：Hub 无 push 通道。
6. **真机未装**：本机无 AVD、无 adb 设备；iOS 模拟器运行时版本不匹配。

---

## 七、复现

```bash
cd dsh-marshal-mobile
npm install
npm test
npx tsc --noEmit
npx vite build
node scripts/ui-smoke.mjs
MARSHAL_LIVE_HUB=https://hub.example.com MARSHAL_LIVE_TOKEN=<token> npm run live:check
bash scripts/build-android.sh
bash scripts/build-ios.sh   # 需普通终端（SwiftPM 缓存）
```