# 调度官手机端 node · dsh-marshal-mobile

手机端 **node 形态**：手机自己发起出站连接、自己绘制界面；既能直连 dsh-marshal Hub，也能配对 DSH remote-bridge 进入 agent-first 工作台。不加载 Hub 网页，不内置 hub，不监听任何端口。

- 应用身份：`com.rongjunrui.marshal.mobile`
- 技术栈：Capacitor 8（原生壳）+ TypeScript/Vite（自绘界面）+ 本地插件 `plugins/marshal-stream`（原生 SSE）
- 两端同码：Android 与 iOS 共用 `src/`，各自只承载壳工程
- 版本：0.7.6（Apple 风格界面；一个码：Hub + DSH 工作台一次配好；扫码配对）
- 设计：Apple HIG（iOS 26/27）双层材质 + 分组列表 + 4 栏 Tab；浅色 / 深色跟随系统
- 图标：唯一来源 `../plugin-build/icon.svg`（Marshal 蓝），脚本生成 iOS AppIcon、Android 自适应/传统图标、启动图与通知图标

---

## 一、node 边界（必须先说清）

| 约束 | 落地方式 |
|---|---|
| 不是 hub | 无任何 HTTP/WS 服务端代码，不监听端口，不保存设备表，不扇出命令 |
| 只做出站连接 | HTTP 走 `https`，事件流走原生插件向 Hub 出站读取 |
| 不嵌入 Hub 网页 | 界面全部自绘；不加载 `/marshal` 页面 |
| 不伪装执行端 | 手机没有 DSH/Codex/Claude 运行时，因此不实现 wire v2 的 node 执行协议；按既定甲案以 Hub 管理接口直连，不声称能替电脑执行会话 |

> 一句话：**手机是 node 侧的一台直连设备，不是第二个调度中心。**
> 群聊接口只认 Hub 的账号 cookie 会话。本 App 用**一次性账号 ticket**（由电脑端 DSH 换出）换 cookie：电脑生成二维码/深链 → 手机扫码 → 原生 HTTP 登录 → 群聊可用。全程仍是手机节点出站，不开端口。

---

## 二、结构

```
┌──────────────────── 手机 App（node 侧）────────────────────┐
│ Capacitor 原生壳                                            │
│  · Keychain / EncryptedSharedPreferences 安全存储            │
│  · 状态栏 / 启动图 / 网络监听 / 返回键 / 深链                │
│                                                             │
│ 自绘界面（src/）                                             │
│  · 配置向导、设备列表、会话列表、会话详情                    │
│  · 模型 / 思考强度 / 附件 / 审批 / 忽略待答 / 统计           │
│  · 应用锁（6 位 PIN，PBKDF2-SHA256）                         │
│                                                             │
│ 传输层                                                       │
│  · HTTP：CapacitorHttp（原生栈，无跨域限制）                 │
│  · SSE：本地插件 marshal-stream                              │
│    iOS URLSession / Android HttpURLConnection                │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTPS 出站 + x-marshal-token
                        ▼
             dsh-marshal Hub（不改一行）
```

---

## 三、功能清单

| 功能 | 状态 | 说明 |
|---|---|---|
| 扫码配对 | 可用 | 首次启动/首页点「扫码配对」直接开相机；「手机连接」现在是一个码（Hub+DSH），扫一次全配好 |
| 一键配对 | 可用 | 电脑端 `npm run onboard` 生成含 Hub+令牌(+ticket) 的二维码/深链；也可粘贴 |
| 配置与连接测试 | 可用 | Hub 地址规范化、令牌校验、实测 `/marshal/api/devices` |
| 设备列表 | 可用 | 在线/离线、agent 标签、点击进会话 |
| 会话列表 | 可用 | 按 agent 分组、运行状态、时间 |
| 会话详情 | 可用 | 历史分页 + 实时事件（`message.delta` / `turn.*` / `tool.*`） |
| 发消息 | 可用 | `op=prompt`，幂等键；失败回滚输入与附件 |
| 选模型 | 可用 | `op=controls` 取真实模型目录，`prompt.options.model` 本次生效 |
| 思考强度 | 可用 | 按所选模型真实 efforts 列出，`prompt.options.reasoning` |
| 附件上传 | 可用 | 256 KiB 分片 `op=upload`，最多 8 个、每个 ≤10 MB |
| 审批与提问 | 可用 | `input.requested` 卡片；审批过滤「总是/记住/会话内」，只允许「这一次」 |
| 忽略待答 | 可用 | `op=cancel`（能力文档含 cancel 时） |
| 会话统计 | 可用 | 输入/输出/缓存读/缓存写；Hub 未上报时如实显示「未上报」 |
| 中断 | 按能力 | 仅当能力文档含 `interrupt` 且带 `runtimeEpoch`；本 Hub 标注为未开放 |
| 群聊账号 | 可用 | 电脑端 `npm run ticket` 生成一次性 ticket/二维码；手机扫码换 cookie（8h，30min 空闲过期） |
| 群聊列表/房间 | 可用 | `/marshal/api/discussions` + 账号 cookie；房间成员、消息、状态 |
| 群聊发言/停止 | 可用 | `action=send`（recipient=moderator）/ `action=stop`，带 CSRF；房间空闲且 <3 轮才可发 |
| 新建群聊 | 可用 | 选 2–4 个模型 → 预览共享范围/最大调用数 → 确认创建（会触发模型调用） |
| 新建会话 / 分支 | 未开放 | 本 Hub 能力文档 `unavailable.create/fork = not-exposed-in-v0` |
| 持久可调项 | 只读 | Hub 把 model/reasoning 标为 `editable:false`（v0-field-only） |
| 应用锁 | 可用 | 6 位 PIN，启动/切回解锁 |
| DSH 工作台 | 可用 | 配对 DSH remote-bridge `/ios/v1`：智能体首页、会话内容、任务看板；协议 P-256 配对，设备令牌存本机 |
| 外观 | 跟随系统 | 浅色 / 深色随 iOS、Android 自动切换；强调色固定为仓库图标的 Marshal 蓝，不提供应用内换肤（HIG） |
| 底部 Tab | 可用 | 设备 / 会话 / 看板 / 设置 四栏；群聊与记忆从设备页进入 |
| 群聊（工作台内） | 待接 | 远程桥 v1 没有群聊消息面；工作台「群聊」页给回 Hub 群聊的入口 |
| 记忆（工作台内） | 只读 | 电脑通过 Hub 上报；没有读到时不显示空列表 |
| 推送 | 无 | Hub 无 push 通道 |

---

## 四、开发与构建

### 环境

- Node.js ≥ 22、npm
- Android：JDK 21+、Android SDK（platform 36 + build-tools 36）
- iOS：Xcode 16+（本机 Xcode 27.2）
- 图标生成：`rsvg-convert`（librsvg）+ Python Pillow

> 本机若没有系统级 JDK 21 / platform 36，可把工具链放进工作区（不入库）：
> `.toolchain/jdk`（Temurin 21）与 `.toolchain/android-sdk`（platform 36，其余目录软链到系统 SDK），
> 构建时设置 `JAVA_HOME`、`ANDROID_HOME`、`GRADLE_USER_HOME` 指向工作区即可，无需改动系统。

### 命令

```bash
npm install
npm run dev            # 浏览器预览（接口需 mock）
npm test               # 51 项单元测试
npm run typecheck
npm run build
python3 scripts/make-assets.py  # 从 ../plugin-build/icon.svg 重新生成全部图标/启动图

bash scripts/build-android.sh   # 出调试 APK
bash scripts/build-ios.sh       # 出模拟器 .app
bash scripts/verify.sh          # 类型 + 单测 + 构建 + 双端同步 + UI 冒烟

# 真机（Android，已验证）：adb install -r android/app/build/outputs/apk/debug/app-debug.apk
# 界面截图（浅/深色）：先 npm run preview，再 node scripts/ui-shot.mjs / ui-states.mjs
```

真 Hub 只读联调（不发送 prompt）：

```bash
MARSHAL_LIVE_HUB=https://hub.example.com \
MARSHAL_LIVE_TOKEN=<dashboardToken> \
npm run live:check    # 只读客户端联调
npm run live:ui       # 真 Hub 只读界面联调（含群聊；截图到 /tmp/marshal-live-shots）

# 一键配对：Hub + 管理令牌（默认顺带 60 秒群聊 ticket），生成手机可扫二维码
npm run onboard -- --hub https://hub.example.com
npm run onboard -- --hub https://hub.example.com --no-ticket   # 只配 Hub + 令牌

# 只生成群聊 ticket（已有配置时用）
npm run ticket -- --hub https://hub.example.com
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`、`ios/build/Build/Products/Debug-iphonesimulator/App.app`

---

## 五、首次使用

1. **扫码配对（推荐）**：电脑端调度官 →「跨设备」页，点「📱 手机连接」显示**一个码**（Hub 地址/令牌/群聊 ticket + DSH 工作台配对全部在里面）；手机 App 点「扫码配对」，相机对准即可。App 自动识别：一码同时配 Hub 与 DSH，然后直接进工作台。DSH「配对 iPhone」仍保留，作为只配工作台的后备。
2. 相机不可用/权限被拒时，展开「手动配置（高级）」填 Hub 地址与 `dashboardToken`（≥16 位），或粘贴配对链接。
3. 首页列出在线设备 → 点设备 → 选会话。
4. 会话页：上方审批/提问卡，中间历史与实时消息，底部可选模型、思考强度、附件。
5. 「控制」查看模型目录、统计、能力与未开放项。
6. 群聊 ticket 过期时：电脑端运行 `npm run ticket -- --hub <Hub>`，扫码/粘贴即可重新登录；设置页会显示「群聊账号已登录」。
7. 新建群聊：群聊 → 新建 → 选 2–4 个模型 → 预览共享范围与最大调用数 → 确认（会触发模型调用）。
8. **DSH 工作台（agent-first）**：电脑端「跨设备」→「手机连接」一个码里已含 DSH 配对；也可单独扫「配对 iPhone」。安卓 USB 若 DSH 地址是 `127.0.0.1`，先 `adb reverse tcp:<链接端口> tcp:<链接端口>`（端口以二维码/DSH 面板为准）。配对后按智能体看会话、看板；群聊页回 Hub 群聊，记忆页等远程扩展。

### 工作台配对说明

- **一个码**：桌面「手机连接」只放 Hub 地址和 60 秒配对码。局域网工作台在 Android 上必须用 `wss://`。
- DSH 一次性令牌只有 30 秒；桌面弹窗会在过期前 5 秒自动刷新二维码；扫最新一张。
- **桌面客户端更新后需重启 DSH 一次**，正在跑的旧页面才会加载「一个码」的新弹窗。
- 远程桥地址默认是电脑 `ws://127.0.0.1:<当前 DSH 端口>/ios/v1`；手机用 USB 时先 `adb reverse` 对应端口，或用 DSH 的局域网/隧道地址。端口以二维码/DSH 面板为准，不写死。
- 安卓 WebView 默认禁止混合内容；0.4.0 已开 `allowMixedContent` 与 `usesCleartextTraffic`，仅用于本机/局域网桥；Hub 仍走 https。
- 一次性配对 token 30 秒；过期回 DSH 面板点「重新取码」。App 只保存设备令牌，不保存配对 token。
- 配对后下次打开自动进工作台；设了应用锁时先解锁，不绕过锁。
- 扫码是首选；「手动粘贴」收在配对页的「高级」折叠里，不占主屏。
- 相机权限：安卓已加 `CAMERA` 并用 Capacitor WebView 的权限回调；iOS Info.plist 已加 `NSCameraUsageDescription`。

### 外观与设计（Apple 风格）

- **双层材质**：内容层一律不透明语义色（浅色 `#F2F2F7/#FFFFFF`，深色 `#000/#1C1C1E`）；磨砂半透明只用于底部 Tab 栏与输入区浮层（`backdrop-filter`）。
- **系统外观**：`prefers-color-scheme` 自动浅/深；不提供应用内换肤，避免与系统设置冲突（HIG）。
- **排版**：SF Pro / PingFang SC 系统字体栈；大标题 30pt、正文 17pt、辅助 13pt，最小 12pt；数字等宽。
- **触控**：可点区域 ≥44pt；列表行高 ≥52pt；Tab 栏 4 项、单项 48pt。
- **品牌**：强调色取自仓库图标 `plugin-build/icon.svg` 的 Marshal 蓝（浅色 `#1F6FEB`，深色 `#409CFF`）；应用内 logo 与 App Icon 同源。
- **图标流水线**：`scripts/make-assets.py` 解析 icon.svg 的路径与顶灯，经 `rsvg-convert` 渲染出 1024 AppIcon（无 alpha）、Android 自适应前景/传统图标/圆形图标、启动图与通知小图标；不再自绘「调」字或绿色渐变。
- 浅色 / 深色首屏、首页与会话页截图见 `docs/screenshots/apple-*.png`、`home-*.png`、`sessions-*.png`。

---

## 六、安全

- 令牌只存安全存储；界面与日志不打印明文。
- 配对二维码不含管理令牌。局域网桥在 Android 上必须是 `wss://`，明文 `ws://` 会被系统拒绝。
- 公网 Hub 强制 https；跨域请求走原生栈，不降低 TLS 校验。
- 审批卡过滤「总是/记住/会话内」类选项，只允许「这一次」的决定。
- 附件分片带 SHA-256 校验，由节点复核；手机端不落长期副本。
- 应用锁 PBKDF2-SHA256 21 万次迭代，常数时间比对。

---

## 七、Android 0.3.2 重要修复

0.3.1 在 Android WebView 里把 `Origin: https://localhost` 带给 Hub，Hub 会 **403**；表现为「Hub 拒绝了连接/令牌」后回到设置页。0.3.2 已把全部 `/marshal/api/*` 改为原生 `CapacitorHttp` 并显式发送 Hub 精确 Origin。**Android 请务必使用 0.3.2+**，并每次点「刷新二维码」后 60 秒内扫码。

## 八、已知限制

1. **一键配对二维码含管理令牌**：它是长期凭据，不要截图转发；群聊 ticket 60 秒、只能用一次，过期/已用需重新生成；账号会话 8 小时绝对到期、30 分钟空闲到期。
2. **群聊正文受 Hub 隐私策略**：本 Hub 的旧房间已被清除（标题「群聊内容已清除」、只读）；新建/进行中的房间才可发送。
3. **群聊无 SSE**：手机端对 `/marshal/api/discussions` 每 4 秒轮询；没有用账号 cookie 的 SSE 长连接。
4. **新建群聊首版只做讨论模式**：未做 work 模式/工作目录/成员画像/预设；主持人固定为第一项。
5. **不实现 wire v2 node 执行协议**：手机无 DSH 运行时，纯协议接入只会是「没有会话的空设备」；按甲案走管理接口直连。
6. **新建会话/分支/中断未开放**：Hub 能力文档明确 `not-exposed-in-v0` / `no-atomic-turn-binding`。
7. **模拟器跑不起**：本机 CoreSimulator 1051.55.0 低于 Xcode 27.2 要求，只能编译不能启动。
8. **Android 真机已安装验证**：HUAWEI ALT-AL10（Android 12 / SDK 31）USB 连接，已安装 0.7.6 并启动截图。
9. **iOS 真机需皇上两步授权**：① 在「设置 → 隐私与安全性 → 开发者模式」打开并重启；② 在 Xcode 登录 Apple ID（免费 Personal Team）用于签名。当前本机无签名身份、且真机开发者模式关闭，只能编译不能安装。
10. **iOS 模拟器不可用**：本机 CoreSimulator 运行时列表为空（低于 Xcode 27.2 要求），`simctl` 无可用设备；模拟器安装验收需另装 runtime。

---

## 九、目录结构

```
dsh-marshal-mobile/
├─ src/
│  ├─ main.ts            启动
│  ├─ app.ts             视图与状态机（设备/会话/聊天/控制/群聊/设置/锁）
│  └─ lib/
│     ├─ marshal.ts      Hub 接口客户端 + 纯解析/分片/参数函数
│     ├─ account.ts      账号 ticket 换 cookie + 群聊客户端/解析
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