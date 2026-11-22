# Marshal Desktop vNext · 全功能 UI/UE 交互设计规范与官方融合定稿说明

## 0. 文档元信息
- **分支 / PR 归属**：`feat/mobile-pr7-apple` → PR #7（`rjr/cx/pr6-routing-memory-fixes`）
- **对应原型文件**：[`design/marshal-vnext-prototype.html`](./marshal-vnext-prototype.html)（v4，单文件自包含可交互原型，支持浅/深色双主题与默认关闭的「架构复用透视」层）
- **基线对齐**：DeepSeek Harness 官方基线 `0.2.2-rc.5`（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`）与 `dsh-marshal` `0.2.0-agent-groups.32`
- **设计原则**：原生融合优先（复用 DSH 官方 `dsh-client-ui-theme` `--dsw-*` 设计系统与官方扩展槽位，绝不强占或重写原生左右侧栏与输入框），保留并放大 Marshal 跨机联邦、多智能体工单编排、1:1 任务指导闭环与三层长期记忆星系等差异化核心价值。

## 1. 三栏信息架构与官方 Seam 融合

### 1.1 左侧边栏（方案 A · 非破坏性扩展）
1. **100% 保留 DSH 原生能力**：完整保留原生顶部品牌栏、`新建会话`、`自动化任务`（`ui-schedule`）、`插件`（`ui-plugin-manager`）、`工作区`（`dsh-workspace`）与底部 `设置`。
2. **主 Agent 快捷入口（受 Grok Bot 启发）**：将用户通过 Marshal 创建的**第一个智能体**置顶为主 Agent 专属入口卡片（带在线状态环与一键发起实时语音通话按钮）。
3. **单一插件入口**：左侧插件面板列表仅保留 **1 个「调度官」入口**（聚合角标显示异常工单 + 待审批全局记忆总数）；`3D 记忆星系` 统一收归「调度官」内部标签页（`工单看板 / 问题监控 / 3D 记忆星系 / 智能体与集群`）。
4. **缩短操作链路**：在 `工作区` 上方按可折叠分组直接展示 **工单群**（带异常状态圆点）、**群聊** 与 **智能体**，点击直达会话，不再需要多层跳转。

### 1.2 右侧边栏（完全沿用官方 `dsh-client-ui-sidebar-right` + 按需动态标签页）
1. **默认纯净原生**：初始仅包含 DSH 官方标签页（`文件` / `终端` / `浏览器` + `+` 新建标签引导页），不强占右侧空间。
2. **按需点击按钮新增可关闭标签页**（底层调用 `ctx.sidebarRight.openTab(...)`）：
   - 在**工单群**顶栏点击 **`DAG 编排`** → 新增可关闭的 `DAG 编排 · #T-xxx ×` 标签页，竖直展开编排 DAG（支持串行、并行分叉与汇合节点，点任意节点弹出详情审阅思考过程 Thinking、工具调用、产出物与代码 Diff，并支持跳转定位左侧消息或从此节点重跑）。
   - 在**智能体单聊**顶栏点击 **`任务清单`** → 新增可关闭的 `任务清单 · <Agent> ×` 标签页，支持在任务间切换与新建任务。

## 2. 关键交互与体验定稿细则

### 2.1 工单群与群聊：显式 `@Agent` 交接 + 输入框三层快选
1. **显式任务交接提示**：群内每轮 Agent 交接渲染醒目的 `@成员` 胶囊与结构化交接横幅（来源 Agent → `@目标 Agent` · 交接阶段 · 产出物引用 · 关联 DAG 节点跳转）。
2. **运行异常监控与原地纠偏**：工单看板与问题监控页整合官方 `dsh-repeat-tool-reminder`、`dsh-tool-call-timeout-policy`、`ctx.approval`、`ctx.userQuestions` 与 `dsh-client-ui-trajectory` 信号，识别工具循环停滞、沙箱权限拦截、审查分歧待拍板，支持原地注入纠偏指令或单次放行。
3. **每 Agent 独立模型与思考强度（三层联动快选）**：收口至输入框底部「`Agent 模型与思考 (N) ▾`」弹层——`第 1 列：Agent 列表 → 第 2 列：模型 → 第 3 列：思考强度`，**点击任意思考强度后立即应用并自动关闭弹层**。

### 2.2 智能体单聊：官方原生输入框 + 自由闲聊/任务切换 + 汇总指导工单闭环
1. **对齐官方对话壳层与输入框**：单聊的模型与思考强度全部归位至官方风格输入框底部（`+ 附件`、`模型 · 思考 ▾` 双列快选且选完自动关闭、官方 SenseVoice 口述转写、空输入框直拨实时通话 / 有字发送），同时保留清晰的消息内容呈现与可折叠思考链。
2. **任务清单内置「自由闲聊」选项**：右侧 `任务清单` 标签页顶部固定提供 **`自由闲聊（不绑定任务）`** 切换卡片，明确区分「随便聊聊」与具体「直接任务（可挂接 1~N 个子会话）」或「关联工单任务」。
3. **1:1 讨论汇总指导工单群闭环**：当单聊切换至**关联工单的任务**（如 `#T-042`）时，顶栏下方呈现同步提示条（任务清单卡片与语音通话纪要卡片亦提供同入口）；点击 **`汇总并同步指导至 #T-xxx`** 可在预览弹窗中编辑提炼后的决策要点与 `@成员` 指令，确认后自动以结构化指导卡片发入对应工单群、解除阻塞/待裁决状态，并同步在右侧竖直 `DAG 编排` 中追加最新执行节点。

### 2.3 实时语音通话与官方语音插件边界
- 经核验，DSH `0.2.2-rc.5` 内置 `dsh-experimental-speech-to-text` / `dsh-experimental-speech-to-text-sensevoice` / `dsh-experimental-client-ui-voice-input` 仅支持「录音结束后整段口述转写（Dictation）」，暂未提供全双工流式实时语音通话或 TTS。
- 因此 Marshal 在单聊预留 `VoiceCallProvider` 抽象接口（兼容 Realtime/Live Voice API 或 SenseVoice + LLM + TTS 级联），交互采用 **Grok Bot 范式**：通话运行于独立短暂语音小会话，挂断后自动向主对话投递包含摘要、行动项与可折叠逐字稿的「实时通话总结纪要」卡片，并支持一键写入任务清单或同步指导关联工单群。

### 2.4 全屏极缓 3D 记忆星系（收归调度官内部）
- 入口位于 `调度官 → 3D 记忆星系`，打开时自动收起右侧边栏以铺满主画布；
- 默认公转角速度降至极缓微漂移（`0.00028 rad/frame`），支持鼠标悬停星体自动刹停、一键暂停/恢复漂移、拖拽 360° 旋转、滚轮缩放、按 `Agent 私有 / 工作区交接 / 全局机主` 过滤、浮动详情卡与全局记忆提案审批弹窗。

## 3. 官方插件复用与去冗余边界（供下阶段重构实施）

| 能力域 | 复用 DSH 官方底座（`0.2.2-rc.5`） | Marshal 保留的差异化能力 | 计划清除的历史冗余 |
|---|---|---|---|
| 工作区与预设 | `dsh-workspace` (`ctx.workspaceRegistry`)、`dsh-agent-preset-registry` | 跨设备 Agent 花名册、主 Agent 置顶、任务清单模型 | 移除 `Agent · ` 伪工作区与 `MutationObserver` DOM Hack |
| 存储与状态同步 | `dsh-storage-domain` + `dsh-storage-sqlite` (`domain/changed`) | 三层长期记忆（含 Mnemon 与 E2EE 墓碑同步） | 移除 2 秒全量轮询 |
| 编排与执行 | `dsh-subagent` / `codex` / `claude-code`、`dsh-experimental-worktree`、`dsh-experimental-forge`、`dsh-schedule`、`dsh-agent-team` | 跨主机群聊/工单群中继、竖直 DAG 视图、1:1 汇总指导工单、长驻远端接管 | 移除内嵌 `dsh-agents/index.js`（3,163 行）与 `task-board/index.js`（10,297 行）重复实现 |
| 前端壳层与配置 | `dsh-client-ui-sidebar-right` (`openTab`)、`dsh-client-ui-conversation`、`dsh-client-ui-deliverables`、`dsh-action-cards`、`plugins.row.config` | 左侧方案 A 快捷组、三层模型/思考快选、全屏 3D 记忆星系、实时语音通话卡片 | 移除独立 `/marshal-superagent` HTML 页、`superagent-hook.js`、iframe 嵌套与自建 Cookie/CSRF 会话层 |
