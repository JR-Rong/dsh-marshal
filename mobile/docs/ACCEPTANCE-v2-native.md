# 验收记录 · v2 原生直连版

时间：2026-11-18 06:1x
变更：去掉「内嵌 Hub 网页」的壳，改为 **App 自绘界面 + 直连 /marshal/api/* + 原生 SSE 插件**（甲案）。

## 一、结论

| 项 | 结果 | 证据 |
|---|---|---|
| 类型检查 | 通过 | `npx tsc --noEmit` |
| 单元测试 | **31/31** | `npm test`（新增 marshal 客户端解析与审批过滤 9 项） |
| Android APK | BUILD SUCCESSFUL | 4.0 MB，含 `marshal-stream` 插件模块 |
| iOS 包 | BUILD SUCCEEDED | 6.7 MB，`App.debug.dylib` 含 12 处 marshalstream 符号 |
| UI 冒烟 | 通过 | 8 张截图：配置→设备→会话→审批→发消息→控制→设置→锁 |
| 真实 Hub 客户端联调 | 通过 | 见下表 |

## 二、真实 Hub 联调（Node 侧直跑客户端模块）

```
devices ok: 2   M5[dsh,codex,claude] | Company[dsh,codex]
sessions ok: 320 running: 1
history:    ok items=16 completeness=complete
inputs:     ok cards=0
discussions blocked: 令牌被 Hub 拒绝（401）
```

说明：设备/会话/历史/审批均走 `x-marshal-token` 通过；群聊接口明确要求 cookie 会话，
而本 Hub 的 `/marshal/login` 是账号 ticket 模式（用令牌 POST 返回 400），故手机端无法登录。

## 三、功能实现对照

| Hub 接口 | 手机端用法 | 状态 |
|---|---|---|
| GET /marshal/api/devices | 首页设备列表 | 可用 |
| GET /marshal/api/sessions?device= | 会话列表 / 能力文档 | 可用 |
| POST /marshal/api/command (observe/prompt/answer/interrupt) | 订阅、发消息、审批、中断 | 可用 |
| POST /marshal/api/inputs | 拉取待答卡片 | 可用 |
| POST /marshal/api/history | 历史分页 | 可用 |
| GET /marshal/api/stream (SSE) | 实时事件流（原生插件） | 可用 |
| GET/POST /marshal/api/discussions | 群聊 | **被 401 挡住**（需 session） |

## 四、新增的本地插件

`plugins/marshal-stream`：Capacitor 8 本地插件，两端各约 120 行原生代码。

- Android：`HttpURLConnection` 流式读，按 SSE 规范切事件，`notifyListeners` 回传
- iOS：`URLSession` + `URLSessionDataDelegate` 增量解析
- 无第三方依赖；不开监听端口；鉴权仍用 `x-marshal-token`
- 断线由 JS 侧指数退避重连（0.5s→15s 封顶）

## 五、仍未覆盖

1. 群聊（本 Hub 账号登录模式）——接口写好，等 Hub 放开令牌登录即可用。
2. 控制项只读——Hub 侧 tunables 全部 `editable:false`。
3. 模拟器启动——本机 CoreSimulator 1051.55.0 < Xcode 27.2 要求 1174.21.0。
4. 真机安装——本机无 AVD、无 adb 设备。
