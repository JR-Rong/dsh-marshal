# dsh-marshal

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

hub 启动后日志会打印 `marshal: hub ready at <origin>/marshal`。

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

node 断线后按指数退避（上限 30s）重连，断线期间最多缓存 1000 帧、总字节不超过 8 MiB；升级握手返回 `401` 或 hello 阶段收到 `4401` 都视为设备 token 错误，停止重连，改对 token 后再重启。每次连上都会重发会话快照。

## 打开控制台

桌面浏览器与手机浏览器用的是同一个 URL：

```text
https://<hub-host>/marshal?token=<dashboard-token>
```

token 也可以放在 `x-marshal-token` 请求头里（两者同时出现时以查询参数为准）。已落地的 `/marshal` 与 `/marshal/api/devices|sessions|command|stream` 每条路由都要 token，否则 401；其他路径不归本插件处理。

页面做的事：

- 左栏每 5 秒轮询 `/marshal/api/devices`，列出**当前已连接**的设备与 agent。
- 点会话名发 `resume`，node 开始跟随并把事件推回；底部输入框发 `prompt`。
- 事件经 `/marshal/api/stream`（SSE）实时追加。
- hub 在设备每次连上时清空该设备的旧会话索引，再按 node 重发的快照重建，所以删掉的会话不会残留。

页面在可用时用 `crypto.randomUUID()` 生成幂等键，不可用时退化成时间戳加随机串，所以普通 http 也能加载。但 token 在 URL 里，**请优先用 HTTPS**：页面响应带 `referrer-policy: no-referrer` 与 `cache-control: no-store`，也不要把带 token 的 URL 粘到第三方页面或聊天工具里。

## 反向代理要求

`/marshal` 与 `/marshal/uplink` 必须同源：页面用相对路径调用 `/marshal/api/*`，node 也向同一主机的 `/marshal/uplink` 拨号。

- 转发 `Upgrade` 与 `Connection: upgrade`，保持请求完整，不要自己终结 WebSocket。
- 不要吃掉 query string（`?token=`）。
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

`redaction` 是正则源字符串数组（默认空），在离开 node 前对每个字符串和键名做替换，命中部分变成 `***`；非法正则启动即失败。

实时思考流需要 `privacy: content`；`metadata` 下页面只显示「（思考 N 字，metadata 档）」「（回复 N 字，metadata 档）」。工具卡片两档都会出现，`metadata` 下只有工具名、参数键名与字数。

提问转发默认关闭，必须显式打开：

```yaml
        questionRelay: remote
        answerTimeoutMs: 300000   # 正整数，默认 300000
```

打开后 node 认领 `user-questions/request`：问题与选项发到 hub。远端作答后请求直接结算，本地不再弹窗；无人作答时本地弹窗在 `answerTimeoutMs` 到期后出现，请求被 abort 时立即交回本地 UI。链路断开期间远端无法作答，提问同样要等到超时。只有构造或发送帧本身抛错（例如帧超限）才会当场交回本地。

页面上的提问卡片：

- 只能自由输入、没有带字符串 `label` 的选项的问题无法在页面上作答；只要有一题如此，整张卡片只读，显示「需要本机作答」，等超时回到源机器。
- 多选题必须点「提交」；全是单选时选满即自动提交。
- 本机已经答过的卡片以本机回执为准；远端答完会显示「已由另一处回答」，超时回到本地显示「已交回源机器」。

注意：`metadata` 只裁事件文本，**不裁提问**——问题与选项从 node 发出，会走 `redaction`；答案从浏览器作为指令直接下发，不经过 node 的脱敏管线；三类内容都不会被裁成计数。

## 只收紧，不放宽

- 设计上远端只能把权限、思考强度等往紧的方向调；放宽必须回到源机器上做。
- v0 的 `configure` 认得 `model`、`reasoning`、`permission`、`plan`、`goal`、`skill`、`plugin` 这些字段名，但只做识别与拒绝：`tighten-only` 字段传 `"wide"` 返回 `tighten-only`，其余值一律 `unsupported`；v0 不落盘、不回读任何设置。
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

- `dashboardToken` 与设备 `token` 都要求至少 16 字符；`marshal-device` 生成的是 24 字节随机数的 base64url（32 字符）。
- token 比较走 SHA-256 摘要 + `timingSafeEqual`，长度差异不落在时序上；401 不回显任何 token 片段。
- 设备表由 CLI 写入后收紧到 `0600`；同一 token 指向两台设备时 hub 拒绝启动；hub 加载时剔除缺 `id`/`name`/`token` 的条目不参与握手。
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
- 两台真机上的联调与验收尚未记录；本文档中的部署步骤按代码实现编写，未附现场验收结果。

## 文档

| 文档 | 内容 |
|---|---|
| [设计（v0）](docs/superpowers/specs/2026-10-29-marshal-design.md) | DSH 会话的跨机观察、续跑与提问 |
| [架构（v0）](docs/superpowers/specs/2026-10-29-marshal-architecture.md) | 模块、协议与失败路径 |
| [计划（v0）](docs/superpowers/plans/2026-10-29-marshal-v0.md) | 可分步执行的 v0 实施计划 |
| [设计（v1）](docs/superpowers/specs/2026-10-29-marshal-v1-design.md) | Codex / Claude 的审批、设置与所有权 |
| [架构（v1）](docs/superpowers/specs/2026-10-29-marshal-v1-architecture.md) | 适配器、状态机与兼容策略 |
| [计划（v1）](docs/superpowers/plans/2026-10-29-marshal-v1.md) | v1 实施计划 |

## 开发与验证

```bash
pnpm install
pnpm typecheck
pnpm typecheck:test
pnpm build
pnpm test
```

`pnpm test` 的端到端联调与两机验收在目标机器上执行，不在开发工作站上跑。
