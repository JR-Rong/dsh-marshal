# 验收记录 · v0.4.0（DSH 工作台 / remote-bridge 甲案第一版）

记录时间：2026-11-18 19:55
运行环境：macOS，DSH 本机 web 端 127.0.0.1:64032，remote-bridge /ios/v1

---

## 一、这一版做了什么

手机端从「只能看 Hub 会话」扩成 **DSH 工作台**：配对 DSH remote-bridge 协议 v1，按智能体看会话、会话内容、任务看板。

| 页 | 数据源 | 状态 |
|---|---|---|
| 智能体 | `squads.state`（10 个小队）+ `presets.list`（5 个预设）+ runs（20 条） | 可用 |
| 会话 | `session.list`（64 条）+ `session.snapshot` | 可用（内容 20 条消息） |
| 任务 | `board.snapshot`（6 个任务） | 只读可用 |
| 群聊 | 远程桥 v1 无群聊消息面 | 给回 Hub 群聊的入口，未内嵌 |
| 记忆 | 远程桥 v1 无 memory 方法 | 如实标注，未画空列表 |

配对：DSH「配对 iPhone」的一次性 token + ES256 挑战，换设备令牌；App 只保存设备令牌。配对后下次打开自动进工作台（有应用锁时先解锁，不绕过锁）。
协议实现：`src/lib/bridge.ts`（纯 TS，Node 可测）；界面：`src/bridge/workbench.ts`。

---

## 二、真桥协议验证

用同一个 `bridge.ts` 跑本机真桥：

```
paired dev_Mw7fSKraxLYk5MEl tokenLen 43
connected caps 25 minor 22
sessions 5
presets 5
squads 10
board tasks 6
snapshot turns 3
```

后续全量拉取（`workbench-live.mjs`）：

```
status 已连接 · 64 会话 · 6 任务
agent cards 10
agent detail 智能体库
session rows 64
messages 20
composer 1
board columns 1 tasks 6
closed 0
errors []
```

---

## 三、配对（安卓）

1. 电脑：DSH →「跨设备」→「配对 iPhone」→ 复制配对链接（30 秒有效）。
2. 手机 USB 连接电脑，电脑执行：
   ```bash
   adb reverse tcp:64032 tcp:64032
   ```
3. 手机装 0.4.0 → 首页/设置「进入 DSH 工作台」→ 粘贴配对链接 → 配对。
4. 过期回 DSH 面板点「重新取码」。

说明：0.4.0 在 Android 开了 `allowMixedContent` 与 `usesCleartextTraffic`，用于本机/局域网 `ws://` 桥；Hub 仍是 https。真机 WebView 的 ws 连接尚未在本机复测（无 adb 设备），首装请按上法联调；若被 WebView 拦，下一步加原生 WebSocket 插件。

---

## 四、测试与构建

| 项 | 结果 |
|---|---|
| 类型检查 | 通过 |
| 单元测试 | 51/51 |
| 构建 | Vite 成功 |
| UI 冒烟 | 15 图，pageErrors [] |
| 工作台真桥 UI | 通过（见上） |
| Android | 0.4.0 / versionCode 6 |
| iOS | 0.4.0 / build 6（模拟器包） |

---

## 五、产物

```
artifacts/dsh-marshal-mobile-0.4.0-debug.apk
sha256 26ec5b7e3821cfcd8d8ee743676976d0033516ee43d05acde4fe04bc600633e7

artifacts/dsh-marshal-mobile-0.4.0-ios-simulator.zip
sha256 8d97e52345eef73c7f48731b26d55ac471ae199693fd8858f0730269a986b1ac
```

截图：`docs/screenshots/workbench-0.4.0.png`

---

## 六、下一阶段（按甲案）

1. **记忆**：给 remote-bridge 加一个 memory 扩展面（类似 task-board-remote），手机端再接；不先用假数据。
2. **群聊内嵌**：远程桥无群消息面；保持 Hub 账号 ticket 入口，或评估给桥加群聊扩展。
3. **配对体验**：相机扫码/深链 `marshal://pair`、局域网地址/隧道、去掉 USB 依赖。
4. **写操作**：看板动作 `board.apply`、建会话/小队运行、审批/提问卡片。