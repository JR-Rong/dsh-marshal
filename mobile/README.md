# 调度官手机端 · dsh-marshal-mobile

把 dsh-marshal（调度官）搬到 Android 与 iOS 上的**客户端**应用：在手机上查看云端 Hub 的设备与会话、进入完整调度台续跑会话、审批提问、参与讨论群聊、调控制项、看历史与上传。

- 应用身份：`com.rongjunrui.marshal.mobile`
- 技术栈：Capacitor 8（原生壳）+ TypeScript/Vite（壳内 UI）
- 两端同源同码：Android 与 iOS 共用 `src/`，只有各自的 `android/`、`ios/` 工程不同

---

## 一、硬约束：只能当客户端

这是本工程的**第一原则**，也是验收项：

| 约束 | 落地方式 |
|---|---|
| 不承载 Hub | 工程里没有任何 HTTP/WS 服务端代码，不监听端口；`android/`、`ios/` 只是 WebView 壳 |
| 不承载 node | 不含 marshal node 角色装配、不含设备令牌握手逻辑 |
| 不伪装成调度中心 | 所有数据都来自用户配置的 Hub；Hub 不可达时如实报错，不做本地冒充 |
| 不绕过鉴权 | 仪表盘用 `x-marshal-token` 直连 Hub 的只读接口；控制台走 Hub 自己的登录与 Cookie |

对照检查：`grep -rn "createServer\|listen(" src/` 应为空；`npx tsc --noEmit` 通过即说明没有引入服务端依赖。

---

## 二、两层结构

```
┌──────────────────────── 手机 App ────────────────────────┐
│ 原生壳（Capacitor）                                        │
│  · 安全存储（iOS Keychain / Android EncryptedSharedPreferences）│
│  · 状态栏 / 启动图 / 网络监听 / 返回键 / 深链               │
│                                                            │
│ 壳内 UI（本仓库 src/）                                     │
│  · 首次配置向导、连接测试                                  │
│  · 原生仪表盘：设备 / 会话 / 运行状态（`/marshal/api/*`）    │
│  · 应用锁（6 位 PIN，PBKDF2-SHA256）                       │
│                                                            │
│ 控制台（进入调度官）                                       │
│  · 在应用内加载 `<hub>/marshal` —— 与浏览器版同一份页面     │
│  · 因此**功能不缺项**：会话续跑、提问审批、讨论群聊、        │
│    控制项（模型/思考强度）、历史分页、上传等全部可用        │
└────────────────────────────────────────────────────────────┘
             │ HTTPS + SSE（同源，Cookie 认证）
             ▼
      dsh-marshal Hub（已有的那台，不改一行代码）
```

**为什么控制台不重写而是加载 Hub 页面**：Hub 的实时流（SSE）、会话能力协商、控制项回读、离线幂等队列都在页面里；重写一遍必然缺项，且 Hub 未开 CORS 时手机直连拿不到流。加载同源页面能让手机端拿到与浏览器**完全一致**的功能面，同时把原生能力（安全存储、锁、通知、深链）补在外壳上。

---

## 三、功能清单

### 壳内原生能力

| 能力 | 说明 |
|---|---|
| 首次配置 | Hub 地址 + 管理令牌，带「先测试连接」（`/marshal/health` + `/marshal/api/devices` 实测） |
| 地址规范化 | 缺协议补 `https://`；粘贴带 `/marshal` 的整条地址自动裁到 origin；公网强制 https |
| 原生仪表盘 | 在线设备、各设备 agent 与会话、运行中数量、上次同步时间、下拉刷新、20s 自动刷新 |
| 应用锁 | 6 位 PIN，PBKDF2-SHA256（21 万次迭代）只存盐与摘要；启动/切回需解锁 |
| 安全存储 | 令牌不落 `localStorage`：原生端走 Keychain / EncryptedSharedPreferences |
| 断网处理 | 网络监听 + 顶部提示；Hub 不可达时给明确失败原因（401/429/超时/不可达） |
| 深链 | `marshal://open?hub=<urlencode>` 直接把 Hub 地址填进配置页 |
| 返回键 | 控制台内 Android 返回键走 WebView 历史回首页；首页返回退出应用 |
| iOS 手势 | `allowsBackForwardNavigationGestures` 打开，边缘侧滑从控制台回首页 |

### 控制台（Hub 页面，功能保真）

| 功能 | 入口 |
|---|---|
| 设备 / 会话索引 | 进入调度官后左侧栏 |
| 会话续跑（prompt） | 会话底部输入框 |
| 实时事件流 | SSE `/marshal/api/stream` |
| 提问与审批回答 | `/marshal/api/inputs` 卡片 |
| 中断 / 取消 | 会话头部操作 |
| 控制项（模型、思考强度等） | 能力面板 `/marshal/api/sessions` → capability |
| 历史分页 | `/marshal/api/history` |
| 讨论群聊 | `/marshal/api/discussions` + `/discussions/stream` |
| 上传 | `/marshal/api/command` op=upload |
| 断线重连与幂等 | 页面内置 intent 队列 |

---

## 四、开发与构建

### 环境

- Node.js ≥ 22、npm
- Android：JDK 17+、Android SDK（platform **36**、build-tools 35+）
- iOS：Xcode 16+，且**必须同意许可**：`sudo xcodebuild -license`

### 常用命令

```bash
npm install
npm run dev              # 浏览器里调壳内 UI（http://127.0.0.1:5178）
npm test                 # Node 单元测试（22 项）
npm run typecheck        # tsc --noEmit
npm run build            # 产出 dist/

npm run cap:sync         # 构建 + 同步到 android/ios
bash scripts/build-android.sh   # 出调试 APK
bash scripts/build-ios.sh       # 出模拟器 .app（需 Xcode 许可）
bash scripts/verify.sh          # 类型 + 单测 + 构建 + 同步 + UI 冒烟
```

### 产物位置

- Android：`android/app/build/outputs/apk/debug/app-debug.apk`
- iOS：`ios/build/Build/Products/Debug-iphonesimulator/App.app`（模拟器，免签名）

### 归档与 PR

本工程已进入 `JR-Rong/dsh-marshal` 仓库的 `mobile/`，分支 `feat/mobile-client`，
PR：<https://github.com/JR-Rong/dsh-marshal/pull/5>。

### 图标与启动图

`scripts/make-assets.py` 用 Pillow 本地绘制，不依赖外部设计稿：

```bash
python3 scripts/make-assets.py
```

会重写 `android/app/src/main/res/mipmap-*`、`drawable*/splash.png` 与 `ios/App/App/Assets.xcassets`。

---

## 五、首次使用

1. 打开 App，填 Hub 地址（形如 `https://hub.example.com`）。
2. 填管理令牌（电脑端 marshal 配置里的 `dashboardToken`，至少 16 位）。
3. 点「先测试连接」，看到「连接成功：N 台设备」。
4. 「保存并进入」→ 首页出现设备与会话。
5. 点「进入调度官」→ 在应用内打开 Hub 控制台；首次需要在控制台里用同一令牌登录一次，之后 Cookie 由 WebView 保持。
6.（可选）设置里开启应用锁；或从电脑发深链 `marshal://open?hub=https%3A%2F%2Fhub.example.com` 预填地址。

---

## 六、安全说明

- 令牌只存本机安全存储；日志、崩溃信息、界面都不打印令牌明文。
- 公网 Hub 强制 https，避免令牌在链路明文暴露。
- 应用锁用 PBKDF2-SHA256 派生，摘要比对采用常数时间比较。
- 控制台沿用 Hub 自己的会话 Cookie 与 CSRF，不另开旁路。
- 「清除本地数据」会同时清掉安全存储与回退的 localStorage。

---

## 七、已知限制

1. **iOS 已能编译，但本机模拟器跑不起来**：`BUILD SUCCEEDED` 已达成；启动模拟器受限于本机 CoreSimulator 版本低于 Xcode 27.2 要求，补齐运行时后即可 `xcrun simctl install booted`。
2. **应用锁是应用级锁定**，不是系统级生物识别（后续可接 Face ID / 指纹插件）。
3. **无推送**：Hub 侧没有 push 通道，审批/提问到达时不会主动弹通知；前台靠刷新与页面内提示。
4. **深链需手动配置**：`marshal://` 只用于预填 Hub 地址，不做控制台深链跳转。
5. **Android 发布包需自签名**：当前只产出 debug APK；release 需要自备 keystore。

---

## 八、目录结构

```
dsh-marshal-mobile/
├─ index.html            壳入口
├─ src/
│  ├─ main.ts            启动
│  ├─ app.ts             页面与状态机（配置/首页/设置/锁）
│  ├─ styles.css         手机优先样式（含安全区）
│  └─ lib/
│     ├─ config.ts       配置模型 + Hub 地址规范化（纯函数）
│     ├─ hub.ts          Hub 只读客户端 + 响应解析（纯函数）
│     ├─ storage.ts      安全存储（Keychain / EncryptedSharedPreferences）
│     ├─ lock.ts         应用锁 PBKDF2
│     ├─ native.ts       状态栏/网络/返回键/深链/退出
│     └─ version.ts      版本与「仅客户端」声明
├─ android/              Capacitor Android 工程（深链、图标、启动图已配置）
├─ ios/                  Capacitor iOS 工程（SPM、深链、侧滑返回已配置）
├─ scripts/              构建、校验、UI 冒烟、图标生成
├─ tests/                Node 单元测试
└─ docs/                 验收记录与截图
```
