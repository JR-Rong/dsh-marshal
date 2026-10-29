# dsh-marshal（调度官）设计文档

日期：2026-10-29
状态：待评审
形态：DeepSeek Harness 插件（一个 npm 包 `dsh-marshal`，两种角色）

## 1. 问题

工作分散在多台机器（Windows / macOS / Linux），每台跑不同的 agent（Codex、Claude Code、Hermes、OpenClaw、Qoder、DSH），任务状态无法汇总：不知道哪台机器上还有什么在跑、卡在哪一步、是不是正等人回答。

需要的不是"把 agent 统一到一个平台"，而是**一个能看见并接管所有机器上所有 agent 会话的控制面**。

## 2. 目标

三个验收场景：

1. 在机器 A 的浏览器里列出所有机器上所有 agent 的会话，带状态（运行中 / 等回答 / 空闲 / 错误）、标题、最后活动时间。
2. 在机器 A 上选中机器 B 的一个 Codex 会话，看到它**正在想什么、正在调哪个工具**（流式），并直接发送下一条提示词继续。
3. 机器 B 的 agent 弹出选择框或审批框时，机器 A 上能看到同一个框并作答；多个远端同时看到时先到者胜出，无人应答则在超时后交回 B 本地。

## 2.1 与现有方案的区别

DSH 生态里已经有一批远程访问实现，但都停留在"连上**自己那台**电脑的单个 DSH"：

| 项目 | 做了什么 | 与 marshal 的差别 |
|---|---|---|
| DSH Mobile Remote | Web UI 加 Remote Access 段，六位码/二维码配对，手机打开电脑的页面 | 单机、单 DSH |
| harness-remote | 第三方移动客户端，LAN/cpolar 扫码，流式聊天 + approval banner | 单机、单 DSH |
| DSHBox / sorsama/deepseek-harness-mobile | 在 Android 上本地跑 DSH | 与本插件不冲突，可视为一个 node |
| dashi-taskboard | 协作式任务板，靠用户手动贴状态 | 被动观察 + 双向控制，不依赖自觉 |

marshal 的位置是**多机器、多 agent、双向**：不仅看，还能接管；不仅管 DSH，还管 Codex / Claude / Qoder 等；连"人等 agent"这一环（选择框、审批）也跨机打通。这些项目的配对码、移动端聊天 UI、通知推送都值得后续复用，但没必要因此自研 App。

## 3. 非目标

- 不做会话迁移：不搬历史文件，续跑始终发生在会话原本所在的机器上。
- 不做 agent 之间的自动委派。
- 不做云端会话存储：权威副本永远在源机器磁盘上。
- 不做手机原生 App：v0 只保证面板在桌面浏览器可用；手机浏览器能打开同一地址，单列适配与 PWA manifest 留 v1，不自研 App。社区已有一批实现（见 §2.1），长期优先复用而不是重造。
- 不统一各 agent 的模型/厂商。

## 4. 关键约束

| 约束 | 来源 | 设计后果 |
|---|---|---|
| 公司电脑不能开入站端口，但能 SSH/HTTPS 出站 | 用户明确要求 | 所有跨机链路必须是源端主动外连；不做 P2P |
| 公司机器的会话内容不应默认外传 | 用户此前选择"只上报元数据" | 隐私降级为**按设备可配的两档**，默认元数据 |
| 不写死任何内网地址或模型端点 | 用户明确要求 | 无默认 hub 地址、无默认 LLM 端点；标题生成只用本地规则；全部端点/端口/适配器路径见 §5.1，缺必填项启动即失败 |
| 每台机器装同一个 DSH 插件 | 用户明确要求 | 单包双角色，配置选择 `hub` / `node` |

## 5. 架构

一个包 `dsh-marshal`，通过 `dsh plugin add` 安装到每台机器的 DSH 中，`cordis.patch.yml` 的 `config.role` 选择角色。

```
        ┌──────── 公司笔记本 (role: node) ────────┐
        │ dsh web + dsh-marshal(node)               │
        │  adapters: codex / claude / qoder       │
        └───────────────┬─────────────────────────┘
                        │ WSS 主动外连（仅出站）
                        ▼
   ┌──────────── 中心 Linux 服务器 (role: hub) ────────────┐
   │ dsh web + dsh-marshal(hub)                              │
   │  · 设备注册表 / 会话索引 / 实时流扇出                  │
   │  · GET /marshal 页面（浏览器打开即调度端）               │
   │  · 本地 adapters（中心机自己也是被管节点）             │
   └───────────────▲───────────────────────────────────────┘
                   │ WSS 主动外连
        ┌──────────┴─────────┐   ┌────────────────────┐
        │ Mac (node)         │   │ Windows (node)     │
        └────────────────────┘   └────────────────────┘
```

- **node**：常驻端。本地运行 `dsh web --host 127.0.0.1 --no-open`，插件在其中运行适配器、维持到 hub 的长连接、执行 hub 下发的指令。**自己不监听任何外部端口。**
- **hub**：终止 node 连接，维护设备/会话索引，向浏览器扇出实时流，并托管 `/marshal` 页面。同时以 node 的方式管好自己机器上的 agent。

所有跨机指令路径为 `浏览器 → hub → 目标 node`。多一跳，换取零入站端口。

图中 node 侧的 codex/claude/qoder 适配器是目标形态；**v0 只实现 dsh 适配器**（见 §15）。

包内只有 host 侧代码：面板是 `ctx.webServer` 上的一个自包含路由，不构建客户端 bundle，因此不依赖前端插槽机制，也不受 SPA 版本影响。

### 5.1 配置

所有端点必须显式配置，没有内置默认值；缺必填项时启动失败并打印缺的是哪一项。

```yaml
- name: dsh-marshal
  config:
    role: hub | node                 # 必填
    # node 侧
    hubUrl: wss://your-hub/marshal/uplink   # 必填，无默认
    token: ${MARSHAL_TOKEN}          # 必填，由 hub CLI 签发
    deviceName: laptop-b             # 缺省取 hostname
    privacy: metadata | content      # 缺省 metadata
    questionRelay: off | remote      # 缺省 off；remote 时插件认领提问并转发
    answerTimeoutMs: 300000          # 远端无人回答则交回本地 UI
    approvalRelay: off | remote      # 缺省 off（v3）
    ringBufferMinutes: 15            # v1 起生效（v0 只解析不缓存）
    redaction:                       # 离开源机器前执行
      - 'sk-[A-Za-z0-9]{16,}'
      - '/home/[^/]+'
    adapters:
      codex:    { enabled: true,  sessionRoot: ~/.codex }
      claude:   { enabled: true,  sessionRoot: ~/.claude }
      qoder:    { enabled: false, cdpPort: 9222 }
      hermes:   { enabled: false, sessionRoot: ~/.hermes }
      openclaw: { enabled: false, sessionRoot: ~/.openclaw }
    # hub 侧
    dashboardToken: ${MARSHAL_DASHBOARD_TOKEN}  # 必填，浏览器访问 /marshal 用
    devicesFile: ~/.dsh-marshal/devices.json
```

hub 不单独监听：`listen` 已删除，hub 复用 DSH 自己的 `ctx.webServer`（同一端口、同一 TLS 配置、同一反代），页面在 `/marshal`，上行在 `/marshal/uplink`。监听地址与证书由 DSH 的 `webServer` 配置决定。

除 `role`、`hubUrl`、`token`、`dashboardToken` 外，其余配置都可以经 DSH 的 `settings` 命名空间热改，改完立即生效并广播 `capability.changed`（v1 起）；v0 只读启动时配置。

### 5.2 各形态能做什么

| 形态 | 能当 node | 能当 hub | 看板 |
|---|---|---|---|
| `dsh web` | 是 | 是 | 浏览器打开 hub 地址 |
| `dsh` 桌面版（Electron） | 是（node 不需要 HTTP 服务，只做出站连接） | 否（桌面壳用 `file://` 加载页面、经 IPC 桥接 API，不提供 HTTP 路由） | 在系统浏览器打开 hub 地址；后续可加一个窗口入口 |
| 手机浏览器 | — | — | 直接打开 hub 地址，页面按移动视口适配并提供 PWA manifest |

结论：**node 到处都能装，hub 需要 web 形态**。中心机本来就是 Linux 常驻，`dsh web` 正合适。

### 5.3 一次跨机指令的完整路径

用户在 A 上打开 `https://hub/marshal`，选中 B 上的 Codex 会话 S1，点发送：

1. 浏览器 `POST /marshal/api/command`，body 是 `{ op: 'prompt', target: { device: 'B', agent: 'codex', sessionId: 'S1' }, ... }`。A 的浏览器只认识 hub 一个地址，不知道 B 在哪。
2. hub 查内存里的设备表，找到 B **已在**的那条长连接（B 开机时就主动连上来的 WSS），往这条连接写一帧。
3. B 的插件收到，校验 `device` 等于自己、`sessionId` 在自己的清单里，然后在**本机**执行 `codex resume S1` 并发送提示词。
4. Codex 的流式输出在 B 本地被归一化成 `MarshalEvent`，沿同一条 WSS 反向回传 hub。
5. hub 扇出给所有订阅者，A 的页面上出现思考块和工具卡片。

所谓"多一跳"，指 A→hub、hub→B 两段网络，而直连只要 A→B 一段：代价是几十毫秒延迟和 hub 的带宽。

换来的是三件事：B 完全不需要监听端口（公司电脑的根本约束）；"谁能访问谁"退化成"谁能不能连上 hub"这一个问题；权限和审计只需要在 hub 一处做，不用 N×N 点对点配置。

另外两个副作用要知道。**hub 是唯一知道全貌的地方**，所以看板必须在它上面，否则每个客户端都要自己连所有机器。**hub 挂了跨机就没法用**，但每台机器本地的 DSH 完全不受影响——这是刻意保留的：插件不是单点，只有"跨机"这一层是。

## 6. 复用的 DSH 接缝

不自造会话模型，DSH 已有的接缝直接用：

| 接缝 | 用途 | 文档 |
|---|---|---|
| `ctx.sessionController`（`session` 命名空间） | 会话列表/搜索/创建/提示词/取消/队列/历史/实时跟随，共 27 个 Remote 方法 | `packages/api/session-controller` |
| `ctx.on('user-questions/request')` 瀑布 + `ctx.userQuestions.answer` | 阻断式提问：瀑布里认领即独占（v0 用这条）；`answer` 只能结算已 `continued` 的提问（v1 补偿） | `packages/interaction/user-questions`、`packages/sdk/server/src/user-questions.ts` |
| `ctx.userApproval`（`approval/request` waterfall） | 工具执行的一次性许可；无应答者时按拒绝关闭 | `packages/interaction/user-approval` |
| `ctx.commands`（`list` / `execute`） | 斜杠命令，覆盖 `/plan` 等模式切换与技能调用 | `packages/interaction/commands` |
| `permissionPresets.catalog()` | 权限档位目录（切换写 `settings` 命名空间） | `packages/interaction/permission-presets` |
| `goals` 命名空间 | get / edit / pause / resume / complete / clear / create | `packages/goal/goal` |
| `session.selectModel` + `session.modelCatalog` | 模型与思考强度（同一方法，`ModelSelection.reasoningEffort`） | `packages/api/session-controller/src/types.ts:88` |
| `skills/list` | 当前会话可见的技能目录（只读） | `packages/api/session-controller/src/skill-catalog.ts` |
| `pluginInventory.list` / `pluginManager.setPluginEnabled` | 插件清单（只读）与宿主级热插拔 | `packages/host/plugin-inventory`、`packages/boot/plugin-manager` |
| `ctx.webServer` | 插件注册具名路由，托管 `/marshal` 页面与 API | `packages/host/webserver` |

**DSH 会话的"看思考、看工具、接着说话"不需要新机制**——它在 DSH 内部天然成立，我们只做跨机搬运。

## 7. 线协议

### 7.1 事件信封

```ts
type MarshalEvent = {
  v: 1
  device: string            // 稳定设备 id
  agent: 'dsh' | 'codex' | 'claude' | 'hermes' | 'openclaw' | 'qoder'
  sessionId: string
  seq: number               // 每会话单调递增，断线可续
  ts: string
  kind:
    | 'session.updated' | 'session.removed'
    | 'turn.started' | 'turn.completed'
    | 'reasoning.delta'
    | 'message.delta' | 'message.completed'
    | 'tool.started' | 'tool.output' | 'tool.completed'
    | 'input.requested' | 'input.resolved'
    | 'capability.changed'
    | 'error'
  payload: unknown          // 按 kind 收窄
}
```

### 7.2 指令

指令一律带幂等键与 30 秒 TTL；**hub 重启后绝不重放**。

```ts
type Target = { device: string; agent: AgentKind; sessionId: string }
type TunableId = Tunable['id']

type MarshalCommand =
  | { op: 'prompt';      target: Target; args: { text: string; attachments?: string[] } }
  | { op: 'resume';      target: Target; args: { text?: string } }   // v0 只启动跟随并回执，忽略 text；续跑用 prompt
  | { op: 'create';      target: Target; args: { cwd: string; preset?: string } }
  | { op: 'interrupt';   target: Target }
  | { op: 'answer';      target: Target; args: { requestId: string; answers: Answer[] } }
  | { op: 'cancel';      target: Target; args: { requestId: string } }   // 仅 choice
  | { op: 'configure';   target: Target; args: { field: TunableId; value: unknown } }
// 每条指令另带 { id: string; idempotencyKey: string; deadline: string }
```

### 7.3 能力描述

node 注册时为每个 (agent, session) 声明能力，UI 据此渲染，不展示做不到的按钮。

```ts
type Capability = {
  observe: 'stream' | 'poll' | 'none'
  dispatch: 'resume' | 'prompt' | 'new' | 'none'
  reasoning: boolean
  toolDetail: 'args+output' | 'args' | 'none'
  promptFidelity: 'native' | 'relay' | 'dom' | 'none'   // 对话框保真度
  tunables: Tunable[]
}

type Tunable = {
  id: 'model' | 'reasoning' | 'permission' | 'plan' | 'goal' | 'skill' | 'plugin'
  scope: 'next-turn' | 'next-session' | 'host'
  effect: 'immediate' | 'needs-restart' | 'next-session'
  values?: readonly { id: string; label: string; description?: string }[]
  current?: unknown
  direction?: 'tighten-only'                        // 见 §10
}
```

### 7.4 会话写者

会话状态带 `writer: 'interactive' | 'marshal' | 'idle'`。`interactive` 表示该会话正在交互式进程里运行（用户正坐在那台机器前），此时**只允许观察**：写指令直接返回 `writer-busy`，不排队（排队会造出未验证的隐性延迟，见 ADR-4，留 v1）。DSH 侧对应已有的 `session/writer-held` 错误码。

## 8. 适配器

| agent | 观察来源 | 思考 | 工具细节 | 续跑 | 对话框 | 等级 |
|---|---|---|---|---|---|---|
| DSH | 进程内 session 事件 | 是 | 参数 + 结果 | `session/prompt` | `userQuestions` + `approval/request` | control |
| Codex | `codex app-server` JSON-RPC（或 `exec --json`） | 是 | 参数 + 输出 | `resume <id>` | app-server server→client 请求 | control |
| Claude Code | `claude -p --output-format stream-json` | 是（thinking 块） | 参数 + 结果 | `--resume` | SDK `canUseTool` / `--permission-prompt-tool` | control |
| Hermes | `~/.hermes/sessions/*.json` 轮询 | 有限 | 有限 | CLI resume，否则按文件 fork | 无结构化通道 | dispatch |
| OpenClaw | `~/.openclaw/agents/*/sessions/*.jsonl` tail | 部分 | 有 tool 块 | 同上 | 无 | dispatch |
| Qoder | transcript JSONL tail | 部分 | 有记录 | 无 headless 续跑 | DOM via CDP | observe |

**能力探测**：适配器启动时探测 CLI 版本与会话目录，把真实能力报给 hub。协议不假设任何 agent 支持它没被验证过的能力；Codex 的具体方法名与是否支持自由文本，按安装版本探测后决定，协议层只依赖"结构化请求 + 选项 + 自由文本"这层抽象。

## 9. 人机交互

### 9.1 模型

```ts
type InputRequest = {
  requestId: string
  intent: 'approval' | 'plan-review' | 'choice'
  title: string
  detail?: string                                       // approval 放完整命令、补丁、cwd
  questions: {
    id: string
    prompt: string
    options: { id: string; label: string; description?: string; recommended?: boolean }[]
    multi: boolean
    custom: boolean
  }[]
  expiresAt?: string
  fidelity: Capability['promptFidelity']
}
```

`intent` 分三档是因为安全含义不同：`approval` 是授予权限，`plan-review` 是放行执行，`choice` 只是流程分支。

### 9.2 语义

- **首答胜出**：一个待答请求只有一次结算。多个**远端**可能同时看到卡片，先到 hub 的答案胜出，其余端收到 `input.resolved` 后收拢卡片并显示"已由 机器B 回答"。本地 UI 在认领模式下不参与竞争（见下条）。
- **接手即独占（已按源码修正）**：DSH 的 `ask_user_question` 走 `user-questions/request` **瀑布**，返回答案即认领该请求，本地应答者不再被调用。因此 `questionRelay: 'remote'` 打开时，marshal 的应答者先接住请求并转发到远端；在 `answerTimeoutMs` 内没人回答就 `next()` 交回本地 UI（本地卡片会延迟出现，这是独占语义的代价，必须在 README 写明）。`questionRelay: 'off'`（默认）时插件不挂应答者，本地行为完全不变。
- **DSH 上的两条通道**：
  1. 进行中的提问：`ctx.on('user-questions/request', handler)` 认领，答案回传后由 handler 返回——与 `packages/sdk/server/src/user-questions.ts` 同款写法。
  2. 已超时转为 `continued` 的提问：`ctx.userQuestions.answer(agent, callId, batch)`，`agent` 来自 `context.sessionController` 的 `agents.resolveAgent`（v1 再做，v0 不覆盖）。
  `userApproval` 只有 `approval/request` 瀑布一条路，配置项 `approvalRelay: 'off' | 'remote'`，默认 `off`（v3）。
- **降级**：无结构化通道的 agent 只发"机器 B 的 Codex 在等一个选择"通知 + 截图（Qoder 可经 CDP 截当前窗口），让远端至少知道卡住了。

## 10. 会话控制

七项能力按"改完什么时候生效"分档，UI 按 `scope` / `effect` 渲染：`next-turn` 画下拉框，`needs-restart` 画带警告按钮，`next-session` 画灰字"仅对新建会话生效"。

| 项 | DSH | Codex | Claude | Hermes/OpenClaw | Qoder |
|---|---|---|---|---|---|
| 模型 | 现成 | next-turn | next-turn | 改配置+重启 | 仅 GUI |
| 思考强度 | 现成（同一方法） | next-turn | next-turn | 不确定 | 仅 GUI |
| 权限模式 | 目录可读；会话级切换需补端点 | next-turn | next-turn | 有限 | 仅 GUI |
| 计划模式 | 走 `/plan` 命令 | plan 协作模式 | 无原生 | 无 | DOM |
| 目标模式 | `goals` 命名空间 | 无 | 无 | 无 | 无 |
| skill | 只读目录 + 命令调用 | 无统一概念 | 目录 | tools 列表 | 有 |
| 插件 | 宿主级热插拔 | 无 | MCP | 有 | 市场 |

两条硬规则：

1. **跨机改设置必须落到源机器执行，UI 用回读值渲染。** hub 只转发不缓存；`selectModel` 返回 `selected`、`goals.edit` 返回新视图，一律以回读为准。
2. **权限只允许远程收紧，不允许远程放宽。** 远程把会话从"询问"切到"免审批"等于隔着网络授予 shell。远端只能往更保守方向切；放宽必须在源机器本地操作。`plan-review` 的"同意执行"按 `approval` 级处理，不走 `choice` 的宽松通道。

另：**禁止远程禁用 marshal 插件自身**（会切断链路），在命令白名单里硬拒。

## 11. 隐私

- 每台设备一个 `privacy` 级别：`metadata`（标题/状态/时间/工具名）或 `content`（思考、工具参数、输出）。公司机器默认 `metadata`。
- 打开 `content` 需要两把钥匙：设备本地配置允许 + hub 对该设备打开开关。
- 内容流默认**不在 hub 落盘**：内存环形缓冲（默认 15 分钟）用于补看，权威副本在源机器。
- 脱敏在离开源机器之前执行，规则可配（密钥模式、家目录绝对路径）。
- 标题生成只用本地规则（截取首条用户消息），不调用任何模型，无默认端点。仅 Codex（`state_*.sqlite` 的 `threads.title`）和 DSH 有原生标题。

## 12. 安全

- 设备 token 由 hub CLI 签发，一机一密，可单独吊销；浏览器侧用独立的 `dashboardToken`（`x-marshal-token` 头或 `?token=`），与 device token 互不通用，也不复用 DSH 的 owner cookie。
- node 校验 `deviceId` 必须等于自身、`sessionId` 必须在自身清单内，其余拒绝。
- 明文内网不允许：hub 走 TLS 或置于现有反代之后；局域网自签场景 node 可钉证书指纹。
- 审批中继默认关闭；开启后 UI 必须展示完整命令与工作目录，`always allow` 对远端隐藏，每次远端批准在源机器写审计行（`answeredBy: device + 时间`）。

## 13. 看板

`GET /marshal`，纯 HTML + SSE，不依赖前端构建产物；由 hub 的 `ctx.webServer` 注册路由。

- 左栏：设备 → agent → 会话，状态点、标题、最后活动时间、橙色「等待你」徽标。
- 右栏：时间线（思考块灰底折叠、消息、工具卡片含参数与输出前 N 行）+ 底部固定待答卡片区 + 会话头部控制条（按能力表渲染）。
- 底部输入框：续跑，乐观回显，以源机器回执为准。
- 实时流 `GET /marshal/api/stream`（SSE），设备与会话索引 `GET /marshal/api/devices`、`GET /marshal/api/sessions`，指令 `POST /marshal/api/command`。
- 多端同步收拢，状态点与 DSH 自身一致。
- 移动端（v1）：单列布局（设备/会话折叠成抽屉）、触控目标 ≥ 44px、待答卡片置顶、`manifest.webmanifest` 支持添加到主屏。手机与桌面打开的是同一页，不做两套。v0 的页面只保证桌面浏览器可用。

## 14. 失效语义

| 情况 | 行为 |
|---|---|
| node 断线 | 有界缓冲（丢弃最旧）元数据事件，指数退避重连；内容事件只保留最后 N 条 |
| hub 重启 | 不重放任何指令；会话状态以 node 重新上报为准 |
| 指令超时（30s 未确认） | 返回明确失败，不自动重试 |
| 会话被本地交互占用 | 返回 `writer-busy`，UI 显示"该会话正在本机运行"；排队留 v1（见 ADR-4） |
| 适配器崩溃 | 只影响该 agent，node 整体保持在线，上报 `error` |
| 待答请求无人接手 | 维持原语义（超时放行或持续阻塞），绝不自动答 |

## 15. 分期

| 版本 | 范围 | 规模 |
|---|---|---|
| v0 | hub + 1 台 node，DSH↔DSH 全链路：列表、实时流（思考/工具）、续跑、`input.requested` 双向、`/marshal` 页面、只通知+截图降级。七项设置只做"认出字段 + 拒绝放宽"，不提供可改控件 | 约 2k 行 |
| v1 | Codex、Claude Code 适配器（真流 + 续跑 + 审批 + next-turn 设置）；设置面收窄到五项可改（模型、思考强度、权限、计划模式、目标模式），`skill`/`plugin` 只读；Claude 无目标模式 | +600 行/个 |
| v1.1 | DSH 会话的设置切换与回读（依赖 v0 的接缝 spike 结论） | 约 +300 行 |
| v2 | Hermes、OpenClaw 文件 tail 观察；Qoder 只观察 + DOM 对话框（opt-in） | +300 行/个 |
| v3 | 审批中继正式开放、留存策略、多用户 | — |
| v3+ | 移动端增强：优先复用社区实现的配对码与推送（DSH Mobile Remote、harness-remote），面板稳定后再考虑轻壳 | 不重复造 App |

> v1 只改会话的下一次回合，不改宿主级配置；`skill`/`plugin` 的开关必须在本机做，远端只显示清单与状态。归属与收紧规则见 [v1 设计](2026-10-29-marshal-v1-design.md)、[v1 架构](2026-10-29-marshal-v1-architecture.md) 与 [v1 实施计划](../plans/2026-10-29-marshal-v1.md)。

### v0 验收

1. 两台机器，A 的浏览器列出 B 的 DSH 会话，状态与 B 本机一致。
2. 在 B 上发起一个会调工具的任务，A 的页面实时出现思考与工具卡片，延迟 < 2s。
3. A 发送提示词，B 的会话继续，A 见回执与后续流。
4. B 弹出 `ask_user_question`，A 出现同款卡片；A 回答后 B 的 agent 继续；若 `answerTimeoutMs` 内没人回答，B 本地卡片随后出现并可继续作答。
5. 断网 30s 后恢复，会话状态自动对齐，无重复指令。

v1 验收补两条：从 A 切换 B 上 Codex/Claude 会话的模型与思考强度，回读值与 B 本机 UI 一致；远端放宽权限的请求被拒绝。

## 16. 风险与未决

| 风险 | 影响 | 处置 |
|---|---|---|
| `approval/request` 是 waterfall，应答者顺序依赖 patch 层挂载顺序 | 可能挂不上，远端审批失效 | v0 先做 `userQuestions`（不受影响）；`approval` 若顺序不可靠则退化为"只通知 + 本机回答" |
| Codex app-server 各版本方法名与能力不同 | 适配器歧义 | 启动时探测版本，按能力表降级，不做假设 |
| Qoder DOM 随版本漂移 | 误点风险 | 选择器不匹配即放弃，绝不盲点；降级为通知 + 截图 |
| permission 会话级即时切换无现成 Remote | 需要补端点 | v1 补一个薄端点，复用 `permissionPresets.set`；v0 只承认收紧方向、拒绝放宽 |
| Hermes/OpenClaw 改配置需重启 | 多端体验别扭 | 标注为危险操作，默认仅本地可用 |
| 单写者冲突 | 双写损坏会话 | `writer` 状态 + 返回 `writer-busy`；排队留 v1；DSH 侧复用 `session/writer-held` |

## 17. 已定默认

- v0 不含 `approval` 类请求，只做 `choice` 与 `plan-review`。`approval` 依赖 waterfall 挂载顺序实测，按 §9 排到 v3。
- hub 的内容环形缓冲为 15 分钟（v1 起）；超出即丢，不落盘。v0 不缓存补看。
- 设备默认 `privacy: metadata`；`content` 需两把钥匙。
- 指令 TTL 30 秒，超时即失败，不重试。
