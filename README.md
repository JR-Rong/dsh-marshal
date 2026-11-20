# dsh-marshal

> `rjr/cx/v1-agents` 分支说明：代码已迁移到 wire v2，支持 DSH、Codex 和 Claude 的装配；下文保留的 v0 安装示例不适用于本分支。当前 hub 必填 `publicOrigin`（HTTPS origin），node 必填稳定的 `deviceId` 并使用 `wss://`；账号模式的新设备在插件中选择角色后自动注册；手工运维仍支持 `marshal-device add <deviceId>`。日常在插件内复用 DSH 登录态，不使用 URL token。配置与迁移规则见[公共契约](docs/superpowers/specs/2026-10-29-marshal-contract.md)。
>
> 原生会话：桌面单会话复用 DSH 的聊天视图、输入框和轮次导航；Codex/Claude 保持原始引擎与会话 ID。`/marshal/api/history` 已接通独立只读正文通道，DSH 在宿主提供分页接口时也支持历史；正文须同时通过节点与 Hub 的内容授权。SSE 的有界缓存回放可用，保留时间由 `ringBufferMinutes`（1–15，默认 15）控制。自动化测试使用原生协议替身，不能代替真实 agent 和两机验收。

当前分支的 bundle 默认启用首次设置。安装后打开 DeepSeek Harness 侧边栏“调度官”，选择“边缘主机”或“中心服务器”。已有云端中心时 Mac 选择边缘主机，使用当前 DSH 账号自动加入；不需要复制 token 或手动注册。现有明确角色配置保留原设备身份。调度页面直接显示在插件面板内；侧边栏接口只返回公开地址。内嵌页面采用独立的分区会话 cookie，只允许 `dsh-app://app` 桌面来源嵌入，仍校验 Origin 与 CSRF；独立浏览器入口 `/marshal` 保持禁止嵌入。私有 HTTPS Hub 可在 node 配置绝对路径 `hubCaFile`，为该直连指定 PEM CA 证书；Electron 宿主应使用 CA 签发的站点证书，证书和主机名校验始终启用。

已有会话的接管与继续、控制范围和并发边界见[会话控制说明](docs/session-control.md)。

云端 Hub 可启用 [DSH 账号登录](docs/account-workspaces.md)：同账号的新 Mac 安装并完成角色选择后自动进入同一调度空间；不同账号被拒绝。默认 Hub 地址只是示例 `https://hub.example.com`，首次设置时请改成你自己的 Hub 地址；真实地址、证书和 token 不要提交到仓库。DSH 单会话显示原生轮数、步数、解码速度、token、缓存命中率和上下文占用；不提供的统计不会伪造。群聊可为主持和每位成员分别选择模型支持的思考强度。Agent 工作群的主持分工、双机执行与真实验收记录见[群聊说明](docs/agent-group-chat.md)。

云端可使用独立入口 `marshal-hub` 运行中心服务，无须安装桌面宿主。部署、证书、systemd 与双机迁移步骤见[云端 Hub 文档](docs/cloud-hub.md)。

以下保留的安装和协议说明对应旧 `feat/v0` 实现（评审基线 `702ef24`），不代表当前分支；当前配置与迁移规则以上面的分支说明和[公共契约](docs/superpowers/specs/2026-10-29-marshal-contract.md)为准。

调度官：把 DSH 会话的观察、续跑与提问搬到任意浏览器，node 只做出站连接，不新开任何入站端口。

```
   浏览器（桌面 / 手机）
        │  HTTPS  /marshal?token=<dashboard-token>
        ▼
   hub（DSH web server，role: hub）
        ▲            │
        │ wss 出站   │ command / ack
        │ (无入站口) ▼
   node（role: node，DSH 会话所在机器）
```

- **单包双角色**：同一个 Cordis 插件，`role: hub` 负责扇出与路由，`role: node` 负责观察与执行。
- **零入站端口**：node 只向 hub 发起出站 WebSocket，适合不允许端口外露的机器。
- **默认只发元数据**：`privacy: metadata` 下正文被裁成计数；提问卡片是显式的内容例外。
- **设置只能收紧**：远端不能放宽权限，也不能禁用 marshal 自身。

## 安装当前版本

> **不要从仓库根目录 `dsh plugin add dsh-marshal`。** 根 `package.json` 的 `src/` 是历史核心，不包含智能体/群聊/跨设备代码。
>
> 当前可安装产物：**`plugin-build/dsh-marshal-0.2.0-agent-groups.18.tgz`**。Desktop 从 **Plugins → Add plugin** 选择该 tarball；有 `dsh` 的环境用 `dsh plugin --profile desktop add <abs path>.tgz`。
>
> **必须同时安装** `@linxin666/dsh-agents`（智能体/群聊/跨设备后端）；**建议安装** `@linxin666/dsh-client-ui-task-board`（完整看板）。它们都是 DSH 插件，不是 marshal 的 npm 普通依赖。完整依赖表、命令和排障见 [INSTALL.md](INSTALL.md)。

## Agent 记忆

调度官给每个 Agent 增加 SQLite 长期记忆，并在胶囊里提供“记忆”3D 星系：

- Agent 私有 / 当前工作区共享 / Global 三层；全局写入要机主审批，可见性只有 `all` 和 `no-group`；
- 旧的文件记忆继续挂着，和 SQLite 注入时去重；
- FTS5 + 384 维本地哈希向量，可升级真实 embedding；
- 会话结束自动摘要。配置了 provider/model 且未超过 `dailyTokenCap` 时会调用模型，否则用本地启发式；
- 记忆页可搜索、查看节点详情、手动写入、审批全局记忆、删除、同步；
- 左侧栏增加“工作区 / Agents”切换，工作区会话和 Agent 工作区分开显示；
- Hub 加密同步使用 `DSH_MARSHAL_MEMORY_SYNC_KEY` 共享口令，hub 只保存密文。

详细设计、路径、同步和限制见 [Agent 记忆说明](docs/agent-memory.md)。

## 安装 hub

hub 不自己监听端口，它把 `/marshal` 与 `/marshal/api/*` 挂到 DSH 的 web server 上，因此 hub 机器上必须先有可用的 DSH web。

```bash
dsh plugin add dsh-marshal
```

在 `cordis.patch.yml` 中加入（`dashboardToken` 至少 16 字符，缺失或过短启动即失败）：

```yaml
- insert:
    - id: dsh-marshal
      name: dsh-marshal
      config:
        role: hub
        dashboardToken: <dashboard-token>
        # devicesFile 默认 $HOME/.dsh-marshal/devices.json；字面 ~ 不会被展开，要改就写绝对路径
        # devicesFile: /path/to/.dsh-marshal/devices.json
```

签发一台设备（token 只打印这一次，请立刻交给 node 机器）：

```bash
npx --package dsh-marshal marshal-device laptop-b
# device laptop-b added to <devices-file>
# token (shown once): <device-token>
```

`marshal-device` 由 `dsh-marshal` 包提供：`npx --package dsh-marshal` 只在本地已安装该包时解析到它的 bin；包尚未发布到 npm 时，可在安装目录直接运行 `node lib/src/bin/device.js <device-id>`。不要直接 `npx marshal-device`（那是另一个包名）。

设备表是一个 JSON 文件，CLI 每次写入后都会把权限收紧到 `0600`。CLI 支持 `MARSHAL_DEVICES_FILE` 环境变量覆盖路径，但 **hub 不读这个环境变量**：一旦用了覆盖，必须同时把 hub 配置里的 `devicesFile` 指到同一个绝对路径。设备表只在 hub 启动时读取，签发新设备后要重启 hub；启动时加载不到任何设备会打 `marshal: no devices loaded from …` 警告。文件存在但无法解析时 CLI 直接报错退出，不会当成空表覆盖。

> 目标契约（wire v2）要求 hub 热加载设备表、撤销 5s 内生效、文件损坏时启动失败，并要求 `dashboardToken` 来自随机源；当前实现尚未满足，见 [公共契约](docs/superpowers/specs/2026-10-29-marshal-contract.md#3-配置与默认值)。

hub 启动后日志会打印 `marshal: hub ready at <origin>/marshal`。

当前 v0 一个插件实例只装配一个角色，hub 机器本身不自动出现在设备列表。目标契约要求 hub 管理本机时显式增加一个本地 node 配置（独立 deviceId、相同身份/策略/去重/同步管道），而不是给 hub 开特权捷径；该装配尚未实现。

## 安装 node

```bash
dsh plugin add dsh-marshal
```

```yaml
- insert:
    - id: dsh-marshal
      name: dsh-marshal
      config:
        role: node
        hubUrl: wss://<hub-host>/marshal/uplink
        token: <device-token>
        deviceName: laptop-b   # 必须等于 hub 上签发的设备 id
```

- `hubUrl` **没有默认值**，必填，必须是 `ws://` 或 `wss://` 且带主机名。
- 除 `localhost` 外一律用 `wss://`：代码也接受 `ws://`，但明文连接会把设备 token 暴露在链路上。
- 指令的 `deadline` 是 hub 的绝对时间（默认 30s）：两台机器要保持时钟同步（NTP），偏差过大时指令会被判为过期。
- `token` 至少 16 字符，与 hub 设备表里那台设备的 token 完全一致。
- `deviceName` 可选，默认取宿主环境的 `HOSTNAME`，取不到时是 `unknown`；它必须等于 `marshal-device` 签发的设备 id，否则 hello 阶段的 `device` 对不上，hub 会以 `4401 auth-failed` 关闭连接。它同时是 hello 里的设备 id，也是事件里的 `device` 字段。

node 断线后按指数退避（当前实现上限 30s；目标契约要求封顶 10s 并带 jitter，以满足网络恢复后 30s 内完成同步）重连，断线期间最多缓存 1000 帧、总字节不超过 8 MiB；升级握手返回 `401` 或 hello 阶段收到 `4401` 都视为设备 token 错误，停止重连，改对 token 后再重启。每次连上都会重发会话快照。

## 打开控制台

桌面浏览器与手机浏览器用的是同一个 URL：

```text
https://<hub-host>/marshal?token=<dashboard-token>
```

这是当前 v0 的过渡方式。目标契约改为登录表单换 cookie，页面与 API 不再接受 URL token；hub 需显式配置 `publicOrigin`，登录响应和已登录 session 查询提供 operatorId 与 CSRF token，logout 撤销会话。上述 cookie/CSRF/session/publicOrigin 尚未实现，不能直接加入当前配置。迁移完成前不要把带 token 的 URL 当长期用法。

token 也可以放在 `x-marshal-token` 请求头里（两者同时出现时以查询参数为准）。已落地的 `/marshal` 与 `/marshal/api/devices|sessions|command|stream` 每条路由都要 token，否则 401；其他路径不归本插件处理。

页面做的事：

- 左栏每 5 秒轮询 `/marshal/api/devices`，列出**当前已连接**的设备与 agent。
- 点会话名发 `resume`，node 开始跟随并把事件推回；当前映射忽略原生 snapshot，没有历史读取端点。底部输入框发 `prompt`，底层固定用 DSH `mode: steer`，marshal 尚未实现忙时拒绝；实际运行中输入行为由目标 DSH 决定。
- 事件经 `/marshal/api/stream`（SSE）实时追加。
- hub 每次连上时先清旧索引，再逐条加入 node 快照。当前只读取一次 list({})、无分页遍历与周期发现；turn 事件也不更新索引运行态，因此不能保证完整/持续新鲜的清单或原子恢复。

页面在可用时用 `crypto.randomUUID()` 生成幂等键，不可用时退化成时间戳加随机串，所以普通 http 也能加载。但 token 在 URL 里，**请优先用 HTTPS**：页面响应带 `referrer-policy: no-referrer` 与 `cache-control: no-store`，也不要把带 token 的 URL 粘到第三方页面或聊天工具里。

## 反向代理要求

`/marshal` 与 `/marshal/uplink` 必须同源：页面用相对路径调用 `/marshal/api/*`，node 也向同一主机的 `/marshal/uplink` 拨号。

- 转发 `Upgrade` 与 `Connection: upgrade`，保持请求完整，不要自己终结 WebSocket。
- 不要吃掉 query string（当前 v0 的 `?token=`）；目标版本改为登录 cookie 后不再依赖它。
- node 用 `Authorization: Bearer <device-token>` 握手，不要剥掉这个头；若反代自己也用 `Authorization` 做认证，需要保留原值。
- SSE 与 WebSocket 都是长连接：关掉响应缓冲并放大读超时。

nginx 示例：

```nginx
location /marshal {
    proxy_pass http://127.0.0.1:<dsh-port>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;  # map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    proxy_buffering off;          # SSE
    proxy_read_timeout 3600s;     # 长连接
}
```

## 隐私与提问转发

`privacy` 两档，默认 `metadata`：

| 档位 | reasoning / message | tool.started | tool.output / tool.completed |
|---|---|---|---|
| `metadata`（默认） | 只发字数，`redacted: true` | 工具名 + 参数键名 | 只发字数 |
| `content` | 发正文 | 工具名 + 参数 | 发正文 |

`redaction` 是正则源字符串数组（默认空），当前只对出站 event.payload 中的字符串和键名做替换，命中部分变成 `***`；非法正则启动即失败。

实时思考流需要 `privacy: content`；`metadata` 下页面只显示「（思考 N 字，metadata 档）」「（回复 N 字，metadata 档）」。工具卡片两档都会出现，`metadata` 下只有工具名、参数键名与字数。

提问转发默认关闭，必须显式打开：

```yaml
        questionRelay: remote
        answerTimeoutMs: 300000   # 正整数，默认 300000
```

打开后 node 认领 `user-questions/request`：问题与选项发到 hub。远端作答后请求直接结算，本地不再弹窗；无人作答时本地弹窗在 `answerTimeoutMs` 到期后出现，请求被 abort 时清理远端等待并调用 next()；原生取消后的本地行为尚未实测，不能据此保证弹窗或认定已本地作答。链路断开期间远端无法作答，提问同样要等到超时。只有构造或发送帧本身抛错（例如帧超限）才会当场交回本地。

页面上的提问卡片：

- 只能自由输入、没有带字符串 `label` 的选项的问题无法在页面上作答；只要有一题如此，整张卡片只读，显示「需要本机作答」，等超时回到源机器。
- 多选题必须点「提交」；全是单选时选满即自动提交。
- 本机已经答过的卡片以本机回执为准；远端答完会显示「已由另一处回答」，超时回到本地显示「已交回源机器」。

注意：`metadata` 只裁事件文本，**不裁提问**——问题与选项从 node 发出，会走 `redaction`；答案从浏览器作为指令直接下发，不经过 node 的脱敏管线；三类内容都不会被裁成计数。

目标契约把远端交互当成独立内容授权：除 node 侧 `questionRelay/approvalRelay=remote` 外，还要求 hub 设备记录的 `allowInteractions=true`（默认 false）；单侧授权按 off 处理。当前 v0 尚无这个第二把钥匙。

## 只收紧，不放宽

- 设计上远端只能把权限、思考强度等往紧的方向调；放宽必须回到源机器上做。
- v0 的 `configure` 认得 `model`、`reasoning`、`permission`、`plan`、`goal`、`skill`、`plugin` 这些字段名，但只做识别与拒绝：`tighten-only` 字段传 `"wide"` 返回 `tighten-only`，其余值一律 `unsupported`；v0 不落盘、不回读任何设置。
- 当前 `interrupt` 仅按 sessionId 调用 DSH cancel，尚无 activeTurnId/runtimeEpoch 校验；不能宣称迟到打断不会影响新回合。
- v0 没有审批转发：`approvalRelay` 只被解析、没有接线，因此不存在把 `always allow` 下发到远端的路径。审批面板与设置回读属于 v1。

## 协议速览

WebSocket 上的 JSON 帧统一带 `v: 1`，四种 `type`：

- `hello`：`device`、`token`、`agents`；必须是首帧，hub 校验后回 `ack`（`id: "hello"`）。
- `event`：`device`、`agent`、`sessionId`、`seq`、`ts`、`kind`、`payload`；`kind` 共 14 种，完整列表见 `src/wire/frames.ts` 的 `MARSHAL_KINDS`。
- `command`：`id`、`idempotencyKey`、`deadline`、`op`、`target{device,agent,sessionId}`、可选 `args`；`op` 为 `prompt` / `resume` / `create` / `interrupt` / `answer` / `cancel` / `configure`，v0 实际支持 `prompt` / `resume` / `interrupt` / `answer`，`create` 与 `cancel` 回 `unsupported`，`configure` 只做字段识别与拒绝放宽。`deadline` 已过的指令由 node 直接回 `deadline-expired`，不会执行。
- `ack`：`id`、`ok`；成功时可能带 `result`（hello 的 ack 只有 `ok`），失败带 `code`，`message` 可选。

单帧上限 1 MiB（双向）；指令的结果超过上限时只回固定的小体积 `result-too-large`。hub 对能解析但违反协议的帧用 `4400` 关闭；超过 1 MiB 的入站帧由 `ws` 以 `1009` 关闭；hello 里 token 不匹配用 `4401 auth-failed` 关闭；握手后 10 秒内没收到合法 hello 会被直接断开（客户端看到 `1006`）。升级请求里的设备 token 不对时 hub 回 `401` 并断开。hub 只接受与握手登记一致的 `device`/`agent` 的事件帧，其它按 `4400` 关闭；node 也会拒收目标设备或 agent 不匹配的指令。

`/marshal/api/command` 的状态码：参数错误 `400`、会话不存在 `404`、设备离线或回答已过期 `409`、执行失败 `502`、hub 正在关闭 `503`、超时 `504`。

## 安全说明

- 当前实现要求 `dashboardToken` 与设备 `token` 至少 16 字符；`marshal-device` 生成的是 24 字节随机数的 base64url（32 字符）。目标契约把 `dashboardToken` 也提高到 24 随机字节生成的 32 字符 base64url（≥192 bit 熵），并拒绝明显低熵值。
- token 比较走 SHA-256 摘要 + `timingSafeEqual`，长度差异不落在时序上；401 不回显任何 token 片段。
- 设备表由 CLI 写入后收紧到 `0600`；同一 token 指向两台设备时 hub 拒绝启动；hub 加载时剔除缺 `id`/`name`/`token` 的条目不参与握手。目标契约更进一步：文件存在但无法解析、含重复 ID 或重复 token 摘要时直接启动失败，不静默剔除。
- 控制台的每个已登记路由都要 token；页面响应带 `referrer-policy: no-referrer`、`x-content-type-options: nosniff`、`cache-control: no-store`。
- 单帧上限 1 MiB（双向）：超过上限的入站帧由 `ws` 以 `1009` 关闭；`/marshal/api/command` 的请求体超过 1 MiB 直接 413。
- 非 localhost 一律 `https://` + `wss://`；明文链路会把 token 交出去。

## 排查顺序

1. 先看日志里的 `marshal:` 前缀：`marshal: hub ready at …`、`marshal: link error: …`、`marshal: hub/node config is missing …`、`marshal: follow … dropped event` 分别指向装配、链路、配置与单条事件超限。
2. 打开 `https://<hub-host>/marshal/api/devices?token=<dashboard-token>`：返回里应有该设备。返回 401 是 dashboard token 不对；列表为空说明 node 还没完成握手（这里只列已连接设备，不会列出设备表里的离线项）。
3. 看 node 到 `wss://<hub-host>/marshal/uplink` 的握手：hub 对错误或缺失的设备 token 回 `401`，node 会停止重连；hello 阶段 token 不匹配则收到 `4401 auth-failed`。经反代时 401 可能被替换成 502 或连接重置，同样按设备 token 问题处理。
4. 检查反代有没有吞掉 `Upgrade`/`Connection`：握手挂起、400/426，或 SSE 一直不推数据，通常就是升级头被剥掉或响应被缓冲。

## 状态

- v0 已在分支 `feat/v0` 实现并提交：hub + node，DSH↔DSH 全链路，含双向提问。
- v1（Codex / Claude Code 适配器、设置切换与回读）尚未开始。
- [主持式 agent 群聊](docs/agent-group-chat.md)已实现：在插件内选择 2–4 位 DSH/Codex 成员和主持人，自动分工、回复、汇总，支持最多 3 轮、停止及状态核对。只讨论，不导入工作会话或执行任务；Claude 群聊尚未开放。早期 D1 的完整扩展协议仍是后续设计。
- 两台真机上的联调与验收尚未记录；本文档中的部署步骤按代码实现编写，未附现场验收结果。
- 当前已有 ACK 路由、hub 并发同键合并、node deadline 检查、事件设备/agent 校验及重连快照。ACK 来源绑定、node 持久去重、全通道隐私与原子同步等仍见 P1 增量计划；超时不能据此认定未执行，也不保证重启后不重复执行。

## 文档

| 文档 | 内容 |
|---|---|
| [设计（v0）](docs/superpowers/specs/2026-10-29-marshal-design.md) | DSH 会话的跨机观察、续跑与提问 |
| [架构（v0）](docs/superpowers/specs/2026-10-29-marshal-architecture.md) | 模块、协议与失败路径 |
| [原实施计划（v0）](docs/superpowers/plans/2026-10-29-marshal-v0.md) | 保留初版实现步骤，历史复选框不代表当前状态 |
| [P1 增量计划（v0）](docs/superpowers/plans/2026-10-29-marshal-v0-p1.md) | 在现有实现上补齐缺口与迁移，不重建脚手架 |
| [公共契约](docs/superpowers/specs/2026-10-29-marshal-contract.md) | P1 目标规则、wire v1 → v2 迁移 |
| [复核与验收矩阵](docs/superpowers/specs/2026-10-29-marshal-acceptance.md) | 当前代码证据、剩余 P1、分层验收标准 |
| [DSH 接缝记录](docs/superpowers/spikes/2026-10-29-dsh-seams.md) | 已有源码核对与最小实验，保留证据边界 |
| [设计（v1）](docs/superpowers/specs/2026-10-29-marshal-v1-design.md) | Codex / Claude 的审批、设置与所有权 |
| [架构（v1）](docs/superpowers/specs/2026-10-29-marshal-v1-architecture.md) | 适配器、状态机与兼容策略 |
| [计划（v1）](docs/superpowers/plans/2026-10-29-marshal-v1.md) | v1 实施计划 |
| [讨论组设计（D1）](docs/superpowers/specs/2026-10-30-marshal-discussion.md) | 跨平台讨论边界、调度/授权/恢复及 G01–G17 验收 |
| [讨论组计划（D1）](docs/superpowers/plans/2026-10-30-marshal-discussion.md) | v1 基础完成后的独立实施阶段，全部待执行 |
| [DSH 编排插件参考](docs/superpowers/spikes/2026-10-30-orchestration-references.md) | dsh-agent-teams、官方 Agent Team/workflow 的可复用机制与限制 |

## 开发与验证

```bash
pnpm install
pnpm typecheck
pnpm typecheck:test
pnpm build
pnpm test
```

`pnpm test` 的端到端联调与两机验收在目标机器上执行，不在开发工作站上跑。
