# Decision Log · Marshal Mobile Node

## v0.1 — 2026-11-20（初稿待签收）
- **背景**：奉皇上旨意开发 Marshal 移动端 Node 应用（iOS + Android），要求以 node 形态运行、扫码连接目标设备并访问该设备及其关联 Hub、精致 Apple 风格、直接使用仓库现有图标（`plugin-build/icon.svg`）、双端真机测试。
- **调研结论**：
  1. 当前 `main` 分支尚未包含 `mobile/` 目录；远端 `origin/feat/mobile-one-code` 虽有早期 Capacitor 8 客户端，但其 UI 为暗灰极客风（非 Apple 风格）、图标为手绘「调」字（非仓库 `icon.svg`），且 Android 强依赖 JDK 21 + SDK 36。
  2. 本机环境为 Zulu JDK 17.0.19 + Android SDK 35 + Xcode 27.2（Swift 6.4.2），连接华为真机 `ALT-AL10`（Android 12，已装旧版 `com.rongjunrui.marshal.mobile` v0.7.5）与 `siyao的iPhone`（iPhone 14 Pro Max，iOS 27.2，当前 `developerMode: disabled`）。
  3. 线上 Hub（`https://123.57.223.115`）已开放 `/marshal/api/pairing`、`/marshal/api/pairing/redeem`、`/marshal/api/devices`、`/marshal/api/sessions`、`/marshal/api/discussions`、`/marshal/api/cross-groups/state` 等接口。
- **拟定方案**：起草 `design/frontend-guidelines.md` v0.1，待皇上确认视觉方向、技术底座/包名策略及 iOS 真机开发者模式与签名安排后立即推进原型、冻结与双端真机开发验收。

## v0.7.6 — 2026-11-20（Apple HIG 视觉与 Android 真机验收落地）
- **落地内容**：按 Apple HIG 双层材质、语义 Token、浅/深色跟随系统与仓库 `plugin-build/icon.svg` 同源图标完成 `mobile` v0.7.6 改造；63/63 单测与 TypeScript 检查通过，Android 华为真机（ALT-AL10）安装与明暗色实测通过，详见 `mobile/docs/ACCEPTANCE-v11-apple.md`。

## v0.8.0 — 2026-11-21（PR7 全功能移动端 UI/UE 交互原型定稿）
- **定稿产物**：`design/mobile-pr7-prototype.html`（可点击高保真 iOS 视觉 + 交互线框图双模原型）与 `design/mobile-pr7-ui-ue-spec.md`。
- **核心架构演进**：
  1. **黄金四栏信息架构**：升级为 `工单` · `会话`（统一收口单聊、Agent 群聊、工单群）· `智能体`（原编排更名，合入成员预设与长期记忆星系）· `节点`。
  2. **工单详情与工单群解耦**：点开工单卡片弹出结构化「工单详情」直接确认批准/重试/驳回（携带 `baseRevision`），并可一键进出绑定的「工单群」查看各 Agent 协作讨论。
  3. **现代移动端会话体验**：对齐手机端 Claude / ChatGPT / Gemini 范式——顶部上滑自动分页加载更早历史（取消读取历史按钮）、全宽无边框 AI 排版与可折叠思考链、去对勾悬浮胶囊输入舱（思考强度抽屉仅保留垂直单列列表），新建会话支持按「运行主机 → 该机可用智能体 → 工作目录」精准发起。
  4. **桌面同源实时 3D 记忆星系与四大主题系列**：移植 `plugin-build/client/index.js` 三维力导向 `MemoryGalaxy` Canvas 实时渲染与触控点选交互；在保持 Apple 双层材质前提下扩展支持「纯粹白、曜石黑、DeepSeek 蓝、Codex 紫」四大主题色系列。

## vNext Desktop UI/UE v4 — 2026-11-21（桌面端 Marshal × DSH 官方 Seam 融合交互原型定稿）
- **定稿产物**：`design/marshal-vnext-prototype.html`（v4 可交互桌面端原型，含浅/深色主题与架构复用透视层）与 `design/marshal-vnext-ui-ue-spec.md`。
- **核心决策**：
  1. **原生融合与单一入口**：左侧边栏完整保留 DSH 官方原生项目（`自动化任务 / 插件 / 新建会话 / 工作区 / 设置`），仅保留 **1 个「调度官」插件入口**（3D 记忆星系收归调度官内部，全屏极缓漂移 `0.00028 rad/frame` + 悬停刹停）；置顶首个 Marshal 创建的智能体为「主 Agent」，在工作区上方提供 `工单群 / 群聊 / 智能体` 快捷直达分组（方案 A）。
  2. **官方右侧栏按需动态标签页**：右侧栏默认严格沿用官方 `dsh-client-ui-sidebar-right`（`文件 / 终端 / 浏览器` + `+` 引导页）；工单群点 **`DAG 编排`** 新增可关闭的竖直 DAG 标签页（点任意节点查看思考、工具与 Diff），单聊点 **`任务清单`** 新增可关闭的任务清单标签页（置顶 **`自由闲聊（不绑定任务）`** 选项）。
  3. **输入框原生归位与三层快选自动关闭**：单聊与群聊的模型及思考强度均放回官方风格输入框底部；工单群/群聊采用 `Agent → 模型 → 思考强度` 三层联动列表，点击思考强度后立即生效并自动关闭弹层。
  4. **单聊 ↔ 工单群指导闭环与实时通话接口预留**：单聊关联工单的任务支持一键「汇总并同步指导至工单群」，确认后以结构化指导卡片写入工单群并刷新右侧竖直 DAG 节点；预留 `VoiceCallProvider` 实时通话接口（Grok Bot 独立语音小会话 + 挂断纪要卡片范式），区分官方 SenseVoice 整段口述转写能力。
