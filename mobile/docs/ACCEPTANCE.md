# 验收记录 · 调度官手机端

记录时间：2026-11-18
环境：macOS（Apple Silicon）、Node v22.20.0、JDK 21.0.13（Temurin）、Android SDK platform 36 + build-tools 36、Xcode 27.2（**许可未同意**）

---

## 一、结论速览

| 项 | 结果 | 证据 |
|---|---|---|
| 类型检查 | 通过 | `npx tsc --noEmit` 无输出 |
| 单元测试 | 通过 22/22 | `npm test` |
| Web 构建 | 通过 | `npx vite build` → `dist/` |
| Android APK | **已产出** | `android/app/build/outputs/apk/debug/app-debug.apk`（4.0 MB） |
| APK 清单 | 正确 | `apkanalyzer manifest print`：包名 `com.rongjunrui.marshal.mobile`、minSdk 24、targetSdk 36、INTERNET + ACCESS_NETWORK_STATE |
| 壳内 UI 冒烟 | 通过（mock） | `docs/screenshots/01~06`，页面无 JS 报错 |
| 壳内 UI 冒烟 | 通过（真实 Hub） | `docs/screenshots/07~08`，实连 `https://hub.example.com`：2 台设备、328 个会话、2 个运行中 |
| iOS 工程 | 结构完整，**编译被 Xcode 许可阻塞** | plist 校验 OK、URL scheme 与侧滑返回已配置、SPM 依赖齐全 |
| 真机/模拟器安装 | **未做** | 本机无 AVD、无 adb 设备；iOS 编译需先同意 Xcode 许可 |
| 交付包 | `artifacts/dsh-marshal-mobile-0.1.0-debug.apk` | 4.0 MB，sha256 `83ca5d59…c25dfc` |

---

## 二、Android 证据

```bash
$ ls -lh android/app/build/outputs/apk/debug/app-debug.apk
-rw-r--r--  1 rongjianrui  staff   4.0M  app-debug.apk

$ apkanalyzer manifest print app-debug.apk | head
package="com.rongjunrui.marshal.mobile"
android:versionCode="1"  android:versionName="1.0"
android:compileSdkVersion="36"
<uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

- 深链：`<data android:scheme="marshal" android:host="open" />` 已并入合并清单
- 壳资源：`assets/public/index.html` 与 `assets/public/assets/*.js` 已打进 APK
- 图标与启动图：`scripts/make-assets.py` 本地生成，`mipmap-*`、`drawable*/splash.png` 全部替换

构建命令（本机实际使用）：

```bash
export JAVA_HOME=/tmp/jdk21/Contents/Home
export ANDROID_HOME=/tmp/dsh-android-sdk          # 本机 SDK 目录不可写，用了副本；常规机器用 ~/Library/Android/sdk
export ANDROID_USER_HOME=/tmp/dsh-android-user     # debug keystore 需可写目录
export GRADLE_USER_HOME=/tmp/dsh-gradle-home
cd android && ./gradlew assembleDebug
```

> 本机踩到的两个环境坑已固化进 `android/gradle.properties`：
> 1. Gradle 直连 `dl.google.com` / `repo.maven.apache.org` TLS 协商失败 → 强制 TLSv1.2 + IPv4；
> 2. 需要 Android platform 36（Capacitor 8 编译目标），本机原只有 35。

---

## 三、功能验收（壳内）

| 场景 | 操作 | 期望 | 实测 |
|---|---|---|---|
| 首次配置 | 输入 Hub + 令牌 → 先测试连接 | 显示「连接成功：N 台设备」 | 通过（真实 Hub 下为 2 台） |
| 地址规范化 | 粘贴 `https://host/marshal?token=x` | 收敛为 origin | 单测覆盖 |
| 公网 http | 输入 `http://hub.example.com` | 拒绝并提示必须 https | 单测覆盖 |
| 首页仪表盘 | 保存后进入 | 在线设备/可见会话/运行中、上次同步 | 通过（真实数据 2 / 328 / 2） |
| 展开设备 | 点设备行 | 列出该设备会话与运行态 | 通过（截图 03/08） |
| 设置页 | 点「设置」 | 改地址/令牌、测试、清数据 | 通过（截图 04） |
| 应用锁 | 开启 → 两次 6 位 PIN | 提示「已开启」，重启需解锁 | 通过（截图 05/06） |
| 错误分支 | 401 / 429 / 超时 / 不可达 | 各自明确文案 | 由 `failureMessage` 覆盖，单测覆盖解析分支 |
| 深链 | `marshal://open?hub=...` | 预填 Hub 地址 | 代码路径已接；真机待验 |

---

## 四、对真实 Hub 的联调

2026-11-18 05:11 以真实令牌连 `https://hub.example.com`：

```json
{ "mode": "live (live 200)", "hub": "https://hub.example.com", "pageErrors": [] }
```

页面实测渲染：

- 设备：`M5`（DSH / Codex / Claude，319 会话，2 运行中）、`Company`（DSH / Codex，9 会话）
- 合计：2 台在线、328 个可见会话、2 个运行中

说明：浏览器预览受 CORS 限制，冒烟脚本用 Node 侧代理转发（`MARSHAL_LIVE_HUB` / `MARSHAL_LIVE_TOKEN`）；真机里壳内请求走 `CapacitorHttp`（原生网络栈），不存在 CORS 问题。

---

## 五、iOS 现状

已完成（静态可查）：

- `ios/App/App/Info.plist`：`plutil -lint` OK；`CFBundleURLSchemes = marshal`
- `ios/App/App/SceneDelegate.swift`：`allowsBackForwardNavigationGestures = true`（边缘侧滑返回）
- `ios/App/CapApp-SPM/Package.swift`：Capacitor 8.6.2 + 7 个插件（secure-storage / app / keyboard / network / preferences / splash-screen / status-bar）
- `Assets.xcassets`：1024 图标 + 2732 启动图已生成

阻塞（本机）：

```
$ xcodebuild -project ios/App/App.xcodeproj -list
You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' ...
```

同意许可后即可执行 `bash scripts/build-ios.sh` 出模拟器包（免签名）。真机安装还需在 Xcode 里选 Team。

---

## 六、未覆盖 / 已知限制

1. **未在真机或模拟器安装 APK**：本机没有 AVD，也没有连接的 Android 设备。安装验证建议：`adb install -r app-debug.apk`。
2. **iOS 未编译**：Xcode 许可未同意（需皇上在终端执行，臣无密码不可代劳）。
3. **无推送**：Hub 无 push 通道，审批/提问不会主动弹通知。
4. **控制台为 Hub 页面**：功能保真以「与浏览器同页」实现，不做重写；因此控制台交互受 Hub 页面自身设计约束。
5. **release 签名未配**：只产出 debug APK。

---

## 七、交付与归档

| 内容 | 位置 |
|---|---|
| 全部源码与双端工程 | 本工作区 `dsh-marshal-mobile/`（约 3 MB，不含 node_modules 与构建产物） |
| 可直接安装的 APK | `artifacts/dsh-marshal-mobile-0.1.0-debug.apk` |
| 验收截图 | `docs/screenshots/01~08` |

建议归档到插件仓库（需一次写权限批准）：

```bash
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .cache \
  --exclude 'android/build' --exclude 'android/app/build' --exclude 'android/.gradle' \
  --exclude 'ios/build' --exclude '*.log' --exclude local.properties \
  "$PWD/dsh-marshal-mobile/" \
  ~/Documents/deepseek-harness/default-workspace/dsh-marshal-clone/mobile/
```

安装到手机：`adb install -r artifacts/dsh-marshal-mobile-0.1.0-debug.apk`，或把 APK 传到手机点开安装（需允许「未知来源」）。

---

## 八、复现命令

```bash
cd dsh-marshal-mobile
npm install
bash scripts/verify.sh                    # 类型 + 单测 + 构建 + 双端同步 + UI 冒烟
bash scripts/build-android.sh             # 出 APK
MARSHAL_LIVE_HUB=https://hub.example.com MARSHAL_LIVE_TOKEN=<token> \
  node scripts/ui-smoke.mjs               # 真实 Hub 截图（07/08）
```
