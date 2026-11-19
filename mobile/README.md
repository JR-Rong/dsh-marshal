# 调度官手机端 · dsh-marshal-mobile

手机端**直连** dsh-marshal Hub：界面由 App 自己绘制，不再加载网页控制台。看设备、挑会话、读历史、收实时事件、发消息、答审批、看控制项，全部在原生界面里完成。

- 应用身份：`com.rongjunrui.marshal.mobile`
- 技术栈：Capacitor 8（原生壳）+ TypeScript/Vite（自绘界面）+ 本地插件 `plugins/marshal-stream`（原生 SSE）
- 两端同码：Android 与 iOS 共用 `src/`，各自只承载壳工程

---

## 一、硬约束：只能当客户端

| 约束 | 落地方式 |
|---|---|
| 不承载 Hub | 无任何 HTTP/WS 服务端代码，不监听端口 |
| 不承载 node | 不含 node 角色装配与设备令牌握手 |
| 直连而非嵌入 | 不再内嵌 Hub 网页；所有请求走 `/marshal/api/*`，事件流走原生插件 |
| 不绕过鉴权 | 统一用 `x-marshal-token`；Hub 拒绝就如实报错 |

对照：`grep -rn "createServer\|listen(" src/` 为空即无服务端代码。

---

## 二、结构

```
┌──────────────────── 手机 App ────────────────────┐
│ Capacitor 原生壳                                  │
│  · Keychain / EncryptedSharedPreferences 安全存储 │
│  · 状态栏 / 启动图 / 网络监听 / 返回键 / 深链      │
│                                                   │
│ 自绘界面（src/）                                  │
│  · 配置向导、设备列表、会话列表、会话详情          │
│  · 实时消息流、审批卡、控制项、历史分页            │
│  · 应用锁（6 位 PIN，PBKDF2-SHA256）              │
│                                                   │
│ 传输层                                            │
│  · HTTP：CapacitorHttp（原生栈，无跨域限制）       │
│  · SSE：本地插件 marshal-stream                   │
│    iOS URLSession / Android HttpURLConnection     │
└───────────────────────┬───────────────────────────┘
                        │ HTTPS + x-marshal-token
                        ▼
             dsh-marshal Hub（不改一行）
```

**为什么需要原生 SSE 插件**：WebView 里的事件源受同源策略限制，Hub 又未开 CORS；
插件按 SSE 规范在原生侧读流再回传 JS，App 仍是纯客户端，不开端口。

---

## 三、功能清单

| 功能 | 状态 | 说明 |
|---|---|---|
| 配置与连接测试 | 可用 | Hub 地址规范化、令牌校验、实测 `/marshal/api/devices` |
| 设备列表 | 可用 | 在线/离线、agent 标签、点击进会话 |
| 会话列表 | 可用 | 按 agent 分组、运行状态、时间 |
| 会话详情 | 可用 | 历史分页 + 实时事件（`message.delta` / `turn.*` / `tool.*`） |
| 发消息 | 可用 | `op=prompt`，带幂等键 |
| 审批与提问 | 可用 | `input.requested` 卡片；审批只呈现安全的「这一次」选项 |
| 中断 | 可用 | 需能力文档含 `interrupt` 且带 `runtimeEpoch` |
| 控制项 | 只读呈现 | Hub 当前把模型/思考强度标为 `v0-field-only`，App 如实显示不造假开关 |
| 群聊 | 受阻（本 Hub） | 群聊接口不接受令牌；本 Hub 又是账号登录模式，登录用令牌返回 400 |
| 应用锁 | 可用 | 6 位 PIN，启动/切回解锁 |

> 群聊已按接口写好接入位；Hub 若开放令牌登录（`accountLogin: false`）即可用同一套代码打开。

---

## 四、开发与构建

### 环境

- Node.js ≥ 22、npm
- Android：JDK 21+、Android SDK（platform 36）
- iOS：Xcode 16+，先同意许可 `sudo xcodebuild -license accept`

### 命令

```bash
npm install
npm run dev            # 浏览器预览（接口需 mock）
npm test               # 31 项单元测试
npm run typecheck
npm run build

bash scripts/build-android.sh   # 出调试 APK
bash scripts/build-ios.sh       # 出模拟器 .app
bash scripts/verify.sh          # 类型 + 单测 + 构建 + 双端同步 + UI 冒烟
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`、`ios/build/Build/Products/Debug-iphonesimulator/App.app`

> iOS 构建会把 SwiftPM 缓存写到 `~/Library/Caches/org.swift.swiftpm`；在被沙箱限制的环境里需在普通终端执行，或对该目录放行。

---

## 五、首次使用

1. 填 Hub 地址与 `dashboardToken`（≥16 位），点「保存并进入」。
2. 首页列出在线设备 → 点设备 → 选会话。
3. 会话页：上方是审批/提问卡，中间是历史与实时消息，底部是输入框。
4. 「控制」查看能力与可调项；运行态可「中断」。

---

## 六、安全

- 令牌只存安全存储；界面与日志不打印明文。
- 公网 Hub 强制 https；跨域请求走原生栈，不降低 TLS 校验。
- 审批卡过滤「总是/记住/会话内」类选项，只允许「这一次」的决定。
- 应用锁 PBKDF2-SHA256 21 万次迭代，常数时间比对。

---

## 七、已知限制

1. **群聊在本 Hub 不可用**：`/marshal/api/discussions` 要求 cookie 会话，而本 Hub 的登录是账号 ticket 模式，令牌登录返回 400。
2. **控制项只读**：Hub 侧把 tunables 标为不可编辑。
3. **模拟器跑不起**：本机 CoreSimulator 1051.55.0 低于 Xcode 27.2 要求，只能编译不能启动。
4. **未在真机安装验证**：本机无 AVD、无 adb 设备。
5. **无推送**：Hub 无 push 通道。

---

## 八、目录结构

```
dsh-marshal-mobile/
├─ src/
│  ├─ main.ts            启动
│  ├─ app.ts             视图与状态机（设备/会话/聊天/控制/群聊/设置/锁）
│  └─ lib/
│     ├─ marshal.ts      Hub 接口客户端 + 纯解析函数
│     ├─ sse.ts          SSE 传输（原生插件 / EventSource 兜底）
│     ├─ config.ts       配置与地址规范化
│     ├─ storage.ts      安全存储
│     ├─ lock.ts         应用锁
│     └─ native.ts       状态栏/网络/返回键/深链
├─ plugins/marshal-stream/   本地 Capacitor 插件（iOS + Android 原生 SSE）
├─ android/ · ios/           Capacitor 壳工程
├─ scripts/ · tests/ · docs/
└─ artifacts/                本地构建产物（不入库）
```
