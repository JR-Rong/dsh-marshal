# 验收记录 · v0.3.0（账号 ticket 群聊）

记录时间：2026-11-18 07:20
环境：macOS（Apple Silicon）、Node v22.20.0、JDK 21.0.13（Temurin）、Android SDK platform 36、Xcode 27.2
定位：手机端 **node 形态**——自绘界面、出站直连 Hub、不承载 hub、不监听端口。

---

## 一、本版改了什么

| 改动 | 落点 |
|---|---|
| 账号 ticket 登录 | 电脑端 npm run ticket → 本机 DSH 用当前账号向 Hub 换一次性 ticket → 二维码/深链 |
| 手机换 cookie | CapacitorHttp 原生栈 POST /marshal/login（带精确 Origin）→ 取 Set-Cookie + CSRF |
| 群聊列表/房间 | 账号 cookie 请求 /marshal/api/discussions；房间成员、消息、状态、保留时间 |
| 群聊发言/停止 | action=send（recipient=moderator）/ action=stop，带 x-marshal-csrf |
| 新建群聊 | 选 2–4 个模型 → action=preview 显示共享范围/最大调用数 → action=create |
| 安全 | 深链 ticket 在应用锁未解除时只暂存，不能绕过锁；登录后清除原生 cookie jar，避免重复 Cookie 被 Hub 判 null |
| 版本 | 0.3.0 / Android versionCode 3 / iOS 3 |

原生侧（Capacitor 插件、壳工程）本版**未改**；CapacitorHttp / CapacitorCookies 是 Capacitor 核心插件，已编进旧壳。

---

## 二、结论速览

| 项 | 结果 | 证据 |
|---|---|---|
| 类型检查 | 通过 | npx tsc --noEmit 无输出 |
| 单元测试 | **49/49** | npm test（新增 account 解析/预览/深链 9 项） |
| Web 构建 | 通过 | npx vite build |
| UI 冒烟 | 通过，14 图 | node scripts/ui-smoke.mjs，无页面报错 |
| 真 Hub 客户端联调 | PASS | npm run live:check |
| 账号 ticket 全链路 | PASS | 本机换票 200 → Hub 登录 200 → discussions 200（10 房间） |
| 真 Hub 群聊界面 | PASS | 2 设备、43 会话、10 群聊房间；只读打开 |
| 群聊写路径/CSRF | PASS（负向） | 已关闭房间 send → 409 expired；缺 CSRF → 403 |
| 群聊 preview | PASS（不创建） | 200，digest 64、members 2、maxCalls 9 |
| Android APK | BUILD SUCCESSFUL | 4.0 MB，versionName 0.3.0 |
| iOS 模拟器包 | 已重组 | 6.7 MB，0.3.0；核心 HTTP/Cookie 插件在 Capacitor.framework |
| 服务端代码 | 无 | grep -rn "createServer\|listen(" src/ 为空 |

---

## 三、账号 ticket 全链路实测

### 1. 电脑端换票

```
POST http://127.0.0.1:64766/marshal/account/login
x-marshal-account: 1
→ 200 { ok:true, ticket:<43 位>, expiresAt:<60s> }
```

### 2. 手机换 cookie（同一链路用 Node 复现）

```
POST https://hub/marshal/login
Origin: https://hub
{ "ticket": "<一次性 ticket>" }
→ 200 { ok:true, csrf, expiresAt, cookieCount:2 }
GET /marshal/api/discussions  (Cookie)
→ 200 rooms=10 catalog=21
GET /marshal/api/session      (Cookie)
→ 200 operatorId + csrf
```

### 3. 写路径与 CSRF（不触发模型）

```
POST /marshal/api/discussions {action:'send', roomId:<closed>, …} + CSRF
→ 409 { code: 'expired' }
POST /marshal/api/discussions {action:'send', …} 无 CSRF
→ 403 forbidden
POST /marshal/api/discussions {action:'preview', …} + CSRF
→ 200 digest=64 members=2 maxCalls=9 mode=discussion
```

说明：只在已关闭/已清除房间上做写路径负向验证，**没有在真 Hub 创建新群或发送真实群消息**，避免触发模型调用与费用；创建/发送的界面链路由 14 张 UI 冒烟图覆盖。

---

## 四、真 Hub 客户端/界面联调

```
devices ok: 2 rjr-mac-local | account-****
sessions ok: rjr-mac-local 323 running 1
sessions ok: account-**** 9 running 0
controls ok: 100 models; current deepseek-account/deepseek-flash / -
history ok: 16 items
upload ok: 25 bytes; complete true
discussions (token): unauthorized（账号模式，符合预期）
```

界面（npm run live:ui，只读）：

```
account session: ok
devices: M5 | Company
sessions rendered: 43
session stats: 输入 357.9k / 输出 100.3k / 缓存读 29.2M
api POST /marshal/api/command 200
api GET  /marshal/api/discussions 200
group rooms: 10 群聊内容已清除 | 群聊内容已清除 | 群聊内容已清除
group room: 群聊内容已清除 messages: 0
LIVE UI PASS（pageErrors: []）
```

> 旧房间均已被 Hub 的隐私策略清除（正文为空、只读），故真 Hub 只能验到列表/房间/成员；有正文的发送与新建由 mock UI 冒烟覆盖。

---

## 五、UI 冒烟（14 图）

390×844@3x，无头 Chrome，页面报错 []：

| 图 | 内容 |
|---|---|
| 01 | 配置页 |
| 02 | 设备列表 |
| 03 | 会话列表 |
| 04 | 会话详情（审批 + 忽略 + 历史 + 流式） |
| 05a | 附件已上传 |
| 05 | 发送消息（模型/思考/附件） |
| 06 | 控制项（模型目录/统计/能力） |
| 07 | 设置（含群聊账号卡） |
| 08 | 应用锁 |
| 09 | 群聊未登录提示 |
| 10 | 群聊列表（ticket 会话） |
| 11 | 群聊房间（成员/消息/发送） |
| 12 | 新建群聊：预览共享范围/最大调用数 |
| 13 | 新建群聊：创建完成 |

docs/screenshots/smoke-report.json 记录 screens: 14。

---

## 六、双端产物

### Android

```
BUILD SUCCESSFUL
artifacts/dsh-marshal-mobile-0.3.0-debug.apk   4.0 MB
sha256 037a00e06e45be06a252434cbf7209186d7d08e839577caa1429e0ebbc523aaa
package com.rongjunrui.marshal.mobile
versionCode 3  versionName 0.3.0
minSdk 24  targetSdk 36
```

### iOS

```
artifacts/dsh-marshal-mobile-0.3.0-ios-simulator.zip   2.0 MB（解压 6.7 MB）
sha256 e9ce10063308f2feca308bc0dc674b2339fc542cad590bb7c312c422d1024354
CFBundleIdentifier      com.rongjunrui.marshal.mobile
CFBundleShortVersionString 0.3.0
CFBundleVersion 3
Capacitor.framework 内含 CAPHttpPlugin / CAPCookiesPlugin（群聊所需）
public/assets 已换成本版构建
```

**iOS 全量重编译仍被沙箱阻断**（SwiftPM 缓存），本版原生代码未改，采用「已编译壳 + 新 Web 资源 + 版本号」重组；普通终端执行 bash scripts/build-ios.sh 可全量重编。模拟器启动仍受 CoreSimulator 1051.55.0 版本限制。

---

## 七、安全与边界

1. **ticket 60 秒、一次性**：二维码/深链/剪贴板都会短暂暴露 ticket；用完即弃，不写入仓库。
2. **应用锁优先级**：锁屏时收到 ticket 只暂存，解锁后才登录，深链不能绕过应用锁。
3. **Cookie 只存安全存储**：登录后清除原生 cookie jar，后续显式带 Cookie 头，避免 URLSession 自动 cookie 与手写头重复（Hub 对重复 cookie 判 null）。
4. **群聊正文受 Hub 隐私策略**：旧房间可能已清除；正文是否可见由节点 allowContent 决定。
5. **未在真机安装**：本机无 AVD、无 adb 设备；iOS 模拟器运行时版本不匹配。
6. **无群聊 SSE**：4 秒轮询；房间进行中时自动刷新。
7. **新建群聊只做讨论模式**：未做 work 模式/工作目录/成员画像/预设；主持人固定为第一项。

---

## 八、复现

```bash
cd dsh-marshal-mobile
npm install
npm test
npx tsc --noEmit
node scripts/ui-smoke.mjs
npm run ticket -- --hub https://hub.example.com
MARSHAL_LIVE_HUB=https://hub.example.com MARSHAL_LIVE_TOKEN=<token> npm run live:check
MARSHAL_LIVE_HUB=https://hub.example.com MARSHAL_LIVE_TOKEN=<token> npm run live:ui
bash scripts/build-android.sh
bash scripts/build-ios.sh   # 需普通终端（SwiftPM 缓存）
```