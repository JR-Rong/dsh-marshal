# dsh-marshal 公共契约

日期：2026-10-29
状态：基于 `feat/v0@702ef24` 的 P1 目标契约；本次仅修改文档
适用：v0 后续加固及 v1；本文定义目标行为，现有 wire v1 的使用说明见 [README](../../../README.md)。

## 1. 文档关系与版本

- [总体设计](2026-10-29-marshal-design.md)定义产品边界；架构文档定义模块责任；计划定义实现顺序。
- [验收矩阵](2026-10-29-marshal-acceptance.md)定义通过条件。修改本文时必须同步关联任务和验收用例。
- 当前 `feat/v0` 已有 wire `v: 1` 实现。本文引入不兼容的身份、帧和操作语义，目标升级为 `v: 2`、`contractRevision: p1-review-1`；产品 v0/v1 与 wire 版本分开编号。
- 目标握手交换 wire 版本、契约修订和功能集合；不兼容版本拒绝控制连接，不静默降级。不将当前成功握手等同目标契约通过。
- 当前已有模块与待新增模块见架构和增量计划；本文的 journal、原子 sync、cookie 登录等尚未实现。逐项状态见 [基线复核](2026-10-29-marshal-acceptance.md#0-评审基线与已有证据)。

### 1.1 从当前实现迁移

| 方面 | 当前 `feat/v0@702ef24` | 本文目标 |
|---|---|---|
| wire 与时间 | `v:1`，event.ts 为 ISO 字符串，command.deadline 为毫秒 | `v:2`，时间统一毫秒，新增连接/实例代次与 sync/status 帧 |
| 设备身份 | `deviceName` 同时作为设备 ID，target 使用 `device` | `deviceId` 稳定，deviceName 仅显示，target 使用 deviceId |
| 设备凭据 | 文件存 token 原值，握手头及 hello 都携带 token；文件启动加载 | 文件存摘要，token 仅请求头；撤销在 5 秒内生效 |
| 浏览器认证 | URL query 或 `x-marshal-token`，所有现有路由鉴权 | POST 登录换 cookie，写请求增加 Origin/CSRF 检查 |
| 观察 | marshal `resume` 只启动 DSH follow；map 丢弃原生 snapshot，没有历史 API | `observe` 区分原生历史读取与实时订阅；v1 的 `acquire` 独立且显式 |
| DSH 写入 | prompt 固定传原生 `mode: steer`，adapter 仅检查会话存在；cancel 仅带 sessionId | 普通 prompt 忙时拒绝；interrupt 原子绑定回合；未证实能力关闭 |
| 清单与状态 | surface 只调一次 list({})，不遍历分页；turn 事件不更新 hub 会话索引 | 完整分页、持续发现及运行态归并，不能靠浏览器重复读旧索引保证新鲜度 |
| 配置/隐私 | relay 仅 off/remote（默认 off），metadata 裁剪部分事件；redaction 默认为空 | 统一 off/notify/remote；字段白名单、内置脱敏及双重 content 授权 |
| 命令/恢复 | hub 内存去重、node deadline；重连 clearDevice 后重发快照 | node 持久去重、unknown 查询、原子快照与 SSE reset |

迁移纳入 V0-T01/T02/T08/T10：先在隔离的合成设备表与配置副本验证转换，再安排 hub/node 同版本升级。设备 ID 必须沿用原 deviceName 的身份值，显示名变化不能产生新身份；设备表迁移写入新文件且受限权限，不原地破坏旧表。旧 token 可在本地转换为摘要，不能打印、写报告或通过网络重新传输原值。短于 32 字符的 dashboardToken 必须在升级窗口内轮换为随机值。旧二进制可在维护窗口继续接受旧登录；启动目标二进制前完成新凭据配置并验证访问，新版本不为兼容短 token 绕过启动校验。

wire v1/v2 混接必须显式失败，UI 给出协议不匹配；不得用旧节点承载 v2 写请求。v2 节点遇不兼容即停止；旧 v1 节点不认识新 close code 可能持续重拨，升级步骤必须显式停掉旧实例，不能要求未修改旧代码具备新行为。升级前停止接收新写入并排空 pending；无法确定结果的命令记录为 unknown，升级后不自动重放。协调升级完成前保持写入关闭。回滚须先关闭远端写入口，保留新 journal 与未决记录；旧二进制不识别 journal，不能仅保留文件就宣称去重继续生效。旧设备表必须先对账当前撤销/轮换记录，禁止复活已撤销 token；有未决命令或无法保留撤销约束时，只允许隔离的只读诊断，不重开写入。未完成迁移验收前，README 保留当前可执行配置，新增字段不能描述成当前默认值。

## 2. 不变量

| ID | 必须始终成立 |
|---|---|
| INV-01 | node 只主动外连；所有跨机内容先经过源端隐私处理 |
| INV-02 | 网络认证身份决定设备身份，帧中的自报身份不能覆盖它 |
| INV-03 | 浏览器收到受理结果不等于 agent 回合完成；超时不等于未执行 |
| INV-04 | 同一有效幂等键最多发起一次 agent 调用；崩溃不明状态不得自动重放 |
| INV-05 | 浏览、历史读取、订阅和重连不取得写权、不启动推理、不恢复外部运行会话 |
| INV-06 | 写权不明不得发起会话写操作；DSH 已认领普通问题只按 §8 的请求作答权结算；权限和思考强度分别校验 |
| INV-07 | 中继默认关闭；审批只允许单次授权，不能扩大持续权限或写全局配置 |
| INV-08 | `current` 只来自已验证的 agent 回读，请求值保存在独立 pending 字段 |
| INV-09 | 审批、提问和答案不进入 marshal 的历史缓冲、正文日志或持久化内容存储；原生 agent 的记录由其自身管理 |
| INV-10 | 重连靠完整快照和游标恢复；hub 重启不重放命令 |

## 3. 配置与默认值

未知配置键、错误枚举、负数/非有限上限、无效正则均启动失败。配置只能在源机器变更；v0/v1 不开放远端插件配置热改。

| 字段 | 角色 | 默认／约束 |
|---|---|---|
| `role` | 两者 | 必填，`hub` 或 `node` |
| `hubUrl` | node | 必填，`wss://`；生产禁止明文和跳过证书验证 |
| `token` | node | 必填，设备专用；只在 Authorization 头传输 |
| `deviceId` | node | 必填，由 hub 注册时签发；独立于主机名，重启和改名保持不变 |
| `deviceName` | node | 默认 hostname，仅显示用途，不参与鉴权或会话键 |
| `dashboardToken` | hub | 必填，与 device token 隔离；由至少 24 随机字节生成 32 字符 base64url（≥192 bit 熵）。长度/弱口令校验不证明随机性；长度不足 32 字符、单字符重复或命中内置弱口令表时启动失败；不允许 URL 查询参数传递 |
| `publicOrigin` | hub | 必填，浏览器访问的唯一 HTTPS origin（scheme/host/port，无路径、无尾斜杠）；作为 Origin 校验基准，不从请求 Host 或转发头推导。缺失、非 HTTPS 或含路径时启动失败 |
| `devicesFile` | hub | 默认 `$HOME/.dsh-marshal/devices.json`；显式覆盖使用绝对路径，不展开字面 `~`；设备 ID、显示名、token 摘要、撤销状态、内容与交互授权，以及 §5 的授权修订高水位与撤销墓碑。首次初始化时缺失按空表告警；已初始化安装（以 §4 的 operatorId 持久文件存在为准）中缺失、无法解析、含重复 ID/重复 token 摘要或修订不可读时 hub 启动失败，不静默丢弃条目或把修订重置为零 |
| `privacy` | node | 默认 `metadata`；可选 `content`，还需 hub 对该 deviceId 允许内容 |
| 设备记录 `allowContent` | hub | 默认 false；由部署者在 hub 本地设置 |
| 设备记录 `allowInteractions` | hub | 默认 false；远端的提问/审批卡片需同时满足 node 侧 relay=remote 与本项为 true，缺一即按 off 处理 |
| `questionRelay` | node | 默认 `off`；`off / notify / remote` |
| `approvalRelay` | node | 默认 `off`；`off / notify / remote`；v0 DSH 审批不可用 |
| `answerTimeoutMs` | node | 默认 300000；15000–300000；expiresAt 按 §8 的绝对截止时刻公式计算 |
| `approvalTimeoutMs` | node | 默认 60000；15000–300000；expiresAt 按 §8 的绝对截止时刻公式计算 |
| `agents` | node | 默认 `[dsh]`；v0 只支持 dsh，v1 按能力探测启用 codex/claude |
| `codexExecutable / claudeExecutable` | node | 可选显式路径；缺省按已验证的包入口/PATH 探测，不猜内网地址 |
| `redaction` | node | 默认附加规则为空，但内置敏感模式始终生效；附加规则不能移除内置规则 |
| `ringBufferMinutes` | hub | 默认 15；1–15；v0 不提供内容补看，v1 才生效 |

固定资源预算：出站单帧不超过 1 MiB；单张交互卡不超过 4096 UTF-8 字节；node 离线事件队列最多 1000 条且总计 8 MiB；单设备同步暂存不超过 16 MiB、hub 全部暂存不超过 64 MiB；SSE 每客户端待写不超过 4 MiB；journal 必须有显式本地容量上限并在启动时校验，未决项永不驱逐。v1 历史缓冲每会话最多 2000 条/8 MiB、hub 总计 64 MiB。任何一项达到上限都触发淘汰或拒绝；这些是硬限额，不是“目标平均值”。

hub 复用 DSH webServer 的端口与 TLS/反代，不另监听。node 不暴露外部监听端口；DSH 自身需要的回环服务不属于跨机入口。hub 管理本机 agent 必须显式注册一个本地 node 身份，走相同管道；不是 hub 的隐式副作用。

## 4. 身份、握手与连接代次

1. TLS 建连，设备 token 只在 Authorization 头发送；`hello` 不重复携带 token。
2. hub 从 token 摘要取得注册记录，核验 `hello.deviceId`。`hello` 带版本、契约修订、`nodeEpoch`、适配器探测摘要，以及上一次绑定的 `operatorId`/`policyRevision`（实例首次为空），不带会话正文。
3. hub 签发随机 `connectionId`，返回当前 `operatorId`/`policyRevision`、有效隐私策略与时钟信息；node 收到握手 ACK 后才进入 syncing，不能在 WebSocket open 时立即冲刷队列。
4. 同一 deviceId 只保留一个当前连接。替换时递增连接代次；旧连接关闭不得 detach 新连接，旧帧不得修改索引或完成新命令。
5. 每帧入口校验认证设备、连接代次、允许方向、schema 和大小。事件中的 deviceId 不符即拒绝并记录分类；不能原样 publish。
6. hub pending 命令绑定 `(commandId, deviceId, connectionId, nodeEpoch)`。ACK 必须来自绑定连接。重连后的结果通过只读状态查询恢复，不接受旧连接 ACK 冒充新确认。
7. token 撤销生效后立即关闭对应连接并禁止新命令；未知/已撤销 token 是终止性鉴权失败，不无限重试。未完成 hello 的连接有握手超时和数量上限。设备表变更（新增、撤销、内容/交互授权）由 hub 热加载或显式 reload 生效，撤销从有效文件变更到关闭连接的延迟不超过 5 秒；仅启动时读取不满足本节。非法 reload 不部分应用，也不静默继续接受写入：将受影响设备置为授权不可确认、关闭其连接并报告配置错误；无法确定影响范围时关闭全部设备连接，修复后重新鉴权。

浏览器通过 `POST /marshal/login` 校验 dashboardToken 和精确匹配的 Origin 后换取新随机会话；登录不要求预先存在 CSRF token，不能把“登录前无需 CSRF”实现为免验凭据。会话 cookie 使用 `__Host-marshal-session; Secure; HttpOnly; SameSite=Strict; Path=/`，无 Domain；CSRF cookie 使用 `__Host-marshal-csrf`，相同属性但非 HttpOnly。初始登录页可公开且不含数据，其余页面/API/SSE 均鉴权。

登录成功响应返回非秘密的 `operatorId`、会话绑定的 CSRF token 与绝对到期时间；已登录页面重载通过 `GET /marshal/api/session` 取得同样信息，不续期、不创建新会话。登录与 session 响应均为 `Cache-Control: no-store`。写请求（包括 logout）必须校验有效会话、Origin、CSRF header/cookie，并将 CSRF 值与**服务端该会话保存的随机值**比较；仅 header 与 cookie 相等不够。新登录生成新 CSRF，不能绑定稳定 operatorId 代替登录会话。Origin 以配置 publicOrigin 为准，拒绝缺失、null 或不匹配；不信任客户端 Host/X-Forwarded-Host，也不开放跨源凭据 CORS。`POST /marshal/logout` 撤销会话、清除两个 cookie 及关联 SSE。

非浏览器 API 使用独立认证分支：只在未带 marshal 会话 cookie 且 `x-marshal-token` 校验成功时免 cookie/CSRF；混合两种凭据拒绝，无效头不得回退 cookie。有 Origin 的请求仍须匹配 publicOrigin。设备 WSS 的 Authorization 不与 dashboard 头混用。两种分支都受相同大小/限速与授权限制。会话、CSRF、dashboard/device token 及命令正文不写日志或 URL。登录失败按来源和全局两个维度限速（同一来源 15 分钟内最多 5 次失败，之后指数退避；全 hub 失败速率超限时短暂拒绝），延迟不泄露长度或前缀差异。

owner 的审计身份由 hub 从认证会话赋予，不接受浏览器自报 `answeredBy`。`operatorId` 是该 hub 安装中持久的随机 owner 身份，首次启动生成后保存在 hub 本地受限文件中，跨浏览器登录、hub 重启和 token 轮换保持稳定；该文件同时是“安装已初始化”的判定依据：它存在而 §3 的设备状态缺失按 §6 recovery-required，它缺失而设备状态存在时不自动生成新身份。临时浏览器会话 ID 只作审计关联，不参与幂等域。浏览器未决记录按 `(publicOrigin, operatorId)` 隔离；同一 URL 换成另一安装后不得把旧记录当新安装命令重新提交。

认证设计依据：[OWASP 会话绑定 CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[MDN cookie 前缀约束](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。这里使用已有服务端会话状态保存 CSRF，无需再引入另一套无状态签名方案。

浏览器会话使用服务端状态，绝对有效期 8 小时、空闲上限 30 分钟；SSE 心跳不延长空闲期。logout、token 轮换及会话到期后，新 API 请求立即拒绝，已有 SSE 最迟 5 秒内关闭并清除页面敏感视图，不能只在建流时鉴权。operatorId 的持久文件、§5 的授权修订状态与 node journal/HMAC 密钥按 §6 的完整性要求管理。

## 5. 公共帧、操作与时间

所有跨端时间字段统一为 UTC Unix 毫秒整数。`nodeEpoch` 是 marshal node **运行实例**的随机标识；每个 `(deviceId, agent, sessionId, nodeEpoch)` 的 `seq` 单调递增，因此任何去重或比较都必须带上会话键，不能只用 `(nodeEpoch, seq)`。`hubEpoch` 标识 marshal hub 运行实例；SSE 游标只在同一 hubEpoch 内有效。两者在插件重载、角色重建或进程重启导致内存序列/索引重置时都必须更换，不能仅依据 OS 进程是否重启；普通网络重连不更换。旧实例回调/帧不得进入新实例，持久 journal、operatorId 与授权修订不随 epoch 清空。

`runtimeEpoch` 标识适配器实例：子进程类 agent 为进程启动，DSH 为适配器/插件实例；实例重建、宿主重启或子进程退出都使旧 runtimeEpoch 的写权和交互立即失效。公开 seq 是归一化后的投递顺序，不是原生状态的因果版本；迟到事件的处理见 §11。

`policyRevision` 是 hub 侧每设备授权策略（撤销、allowContent、allowInteractions）的持久单调修订号。与 operatorId/deviceId 绑定，在授权生效前与授权变更一次性原子写入 §3 的受限设备状态文件，重启、删除再注册不得复用旧号（删除设备保留撤销墓碑）。写入失败等同非法 reload：不提交新 revision、不发布新授权、受影响设备保持不可确认并关闭连接。状态缺失、损坏、不可读或已检测到旧备份回退按 §6 进入 recovery-required，不从零继续。hello 回带 node 上一次绑定的 operatorId/policyRevision，hello.ack 下发当前值；node 侧该值只是实例内存，重建后为空，空值按首次绑定处理且不能跳过 hub 的当前策略下发。operatorId 不同即不同身份域，不比较修订号，丢弃旧策略状态后重新绑定；同一身份域内 node 回带更高修订而 hub 当前值更低，判定 hub 状态回退并进入 recovery-required，不能下发更低修订。任一值变化都丢弃旧策略的内容/ACK 正文，并按 §8 结算旧待答，不能只删除卡片留下原生阻塞。随后重新协商、完整同步；hubEpoch 变化但持久策略未变不等于撤权。

| 帧 | 方向 | 必需信息与用途 |
|---|---|---|
| `hello / hello.ack` | node→hub / hub→node | wire 版本、契约修订、功能集合、认证设备、nodeEpoch、connectionId、operatorId/policyRevision、隐私与交互策略 |
| `command` | hub→node | commandId、idempotencyKey、operatorId、target、op、args、issuedAt、deadline、connectionId、nodeEpoch |
| `ack` | node→hub | commandId、connectionId、nodeEpoch、status、code、受限 result；只表示命令受理/确认状态 |
| `event` | node→hub | deviceId、agent、sessionId、nodeEpoch、seq、ts、kind、按 kind 验证的 payload |
| `sync.begin / sync.chunk / sync.end` | node→hub | syncId、完整范围、快照版本、会话游标、分片计数；快照不含正文 |
| `sync.ack` | hub→node | 当前 connectionId/nodeEpoch/syncId、accepted/rejected、提交版本或错误；只在原子提交后确认 |
| `command.status / command.status.result` | hub→node / node→hub | 只读查询原幂等键状态；不触发执行、不携带原始正文 |
| `inputs.snapshot / inputs.snapshot.result` | hub→node / node→hub | owner 按会话查询当前有效待答卡；node 重新执行隐私与策略校验 |

方向不符的帧按 `frame-invalid` 拒绝。target 为 `(deviceId, agent, sessionId)`。agent 标识是字符串，但必须在握手支持集合中。未知操作必须拒绝；未知事件可忽略并计数，不能因此绕过身份或大小检查。每个操作的 args 由 `wire/commands` 的判别 schema 定义并在两端验证，未知字段拒绝；`observe` 的 args 区分 `history`（带不透明 cursor 和 limit，单页有界）与 `follow`（订阅/取消订阅），两者都不带写权副作用。

事件 kind 与最小语义统一如下，额外字段必须在版本 schema 和隐私白名单中声明：

| kind | 必要载荷语义 |
|---|---|
| `session.updated / session.removed` | 状态/所有权/更新时间的部分更新或删除；遗漏字段保持旧值，不能把 tokens 更新解释为空闲 |
| `turn.started / turn.completed` | 原生 turnId、runtimeEpoch、明确 running/completed/failed/interrupted 状态 |
| `reasoning.delta / message.delta / message.completed` | itemId、文本增量或最终完成标记；metadata 只给计数，不重复拼接完整消息 |
| `tool.started / tool.output / tool.completed` | callId、工具名、参数/输出或计数、最终状态；不同工具不得共用卡片身份 |
| `input.requested / input.resolved` | 第 8 节嵌套判别载荷，永不进入历史缓冲 |
| `capability.changed` | 当前会话的完整能力快照、revision、回读时间；不是不明确的局部 patch |
| `error` | 受限 code、严重性、关联 ID；无原始异常内容 |

完整 sync 会话行是替换快照；普通 session.updated 是按 schema 合并的局部更新，两者不得混用。Capability 至少包含 observe（stream/poll/history/none）、明确 operations 集合、工具/思考可见级别、ownership、tunables 和逐功能 unavailable reason。dispatch 不再用一个互斥字符串代表多个不同写入能力。

| 操作 | 语义与版本 |
|---|---|
| `observe` | v0/v1：只读历史/订阅，绝不调用 agent resume |
| `acquire` | v1：显式取得控制权；受第 7 节写权门槛约束 |
| `prompt` | v0/v1：已取得有效写权且 idle 才提交；运行中拒绝，不隐式排队 |
| `steer` | v1 可选：仅经过验证的原生能力，必须匹配 activeTurnId；不降级为排队 |
| `interrupt` | 只允许匹配的自有活跃回合，携带 activeTurnId/runtimeEpoch |
| `answer / cancel` | 回答/放弃普通提问；不能作用于审批或 plan-review |
| `decide` | v1：审批单次决定；受第 8 节约束 |
| `configure` | v1：会话设置；受第 9 节约束，DSH 留 v1.1 |
| `create / fork` | v1 可选：显式新建/分叉；能力、cwd 范围和新会话身份均须验证 |

wire v2 将当前 marshal `resume` 重命名为 `observe`；当前 DSH 的 resume 仅建立 follow，并无原生会话接管副作用。v1 新增独立 `acquire`；底层 Codex/Claude 的 resume API 只允许在取得写权后的适配器内部使用。

命令 TTL 固定 30000 ms，从 hub 接收合法请求开始计时。node 在入队、获得执行互斥后、调用 agent 前检查 deadline；过期命令零调用。握手和心跳重新估算时钟偏差；无法将偏差/不确定度限制在 5000 ms 内则写请求返回 `clock-skew`，并保守使用最早可能过期时间。执行开始前用单调时钟约束本地等待，不能靠调整墙钟延长 TTL。TTL 不是已开始操作的自动取消机制。

## 6. 命令生命周期与幂等（P1-01、P1-02）

浏览器对一次用户意图生成并保存 idempotencyKey；网络超时不能换键自动重试。未决或结果未知的键必须在发请求前保存到跨标签页/浏览器重启仍可用的持久存储（如 IndexedDB），以 `(publicOrigin, operatorId)` 隔离；sessionStorage 不能满足关闭标签页后的恢复。仅存 target、op、key、状态、时间等无正文元数据，不存 prompt、答案、token 或响应正文。重开、重新登录后先查状态，不重发命令；人工提交新意图须明确与未知旧意图区分。存储不可用或写入失败时拒绝新的远端写请求；本地记录丢失时提示恢复信息不足，先人工核对，不将再次点击视作可安全重试。幂等域为 `(operatorId, target, idempotencyKey)`，规范化 op/args 的摘要用于检出同键不同载荷；传输 commandId、时间和连接代次不参与载荷摘要。

hub 在任何 await/发送之前原子登记 in-flight。同键同载荷共享一个结果，不能再次发送；同键不同载荷返回 `idempotency-conflict`。ACK 路由必须显式分派到 pending 完成逻辑，event 路由不能吞掉 ACK；error/关闭/超时也必须完成等待者。

node 是去重的最终权威。按幂等域原子登记并在调用 agent 前持久化 `admitted`，之后记录 `accepted / confirmed / rejected / outcome-unknown`。日志仅含身份、目标、操作、时间、状态和带本地密钥的载荷摘要，不含提示词、答案、命令或路径。已记录的键至少保留 24 小时；未决记录不可被 LRU 驱逐，容量满则拒绝新写入。终态过保留窗口可删除，因此不承诺无限期 exactly-once。journal/HMAC 密钥、hub operatorId 及 §5 的授权修订状态必须跨重启稳定，版本迁移保留原域；已初始化安装中发现文件丢失、损坏、回滚到过旧快照或密钥不匹配时禁止新写，返回 recovery-required，不自动新建空表/新身份。首次初始化与恢复有独立标记及人工对账步骤；不能保证检测外部同时抹去全部状态的情况，重建安装须按恢复操作处理。

| 状态 | 对用户的含义 | 重试规则 |
|---|---|---|
| `rejected` | 明确在调用 agent 前拒绝，附原因 | 更正原因后可显式发起新意图 |
| `accepted` | agent 已受理，后续回合完成由事件表示 | 不重发 |
| `confirmed` | 设置等操作已获得实际回读 | 不重发 |
| `pending-confirmation` | 已请求，尚无实际回读 | 只查询或等待 |
| `outcome-unknown` | 可能已执行，连接/进程故障导致结果不明 | 只查询，禁止自动再次执行 |

node 在 `admitted` 与调用 agent 之间、调用与落结果之间崩溃时，重启将未决项标记 outcome-unknown；除非上游支持且已验证同一操作的幂等恢复，否则不得自动调用。不能靠“磁盘记录存在”推断执行成功。原 nodeEpoch 的延迟 command 一律拒绝。

hub 发送后丢 ACK、hub 重启或连接断开，均返回/恢复为 outcome-unknown。只读状态查询可恢复已存状态；查询 unknown 不触发重发。查询结果必须经过同样身份验证和内容清理。HTTP 区分 200（受理/确认）、202（等待确认/结果未知）、400（frame-invalid/version-unsupported）、409（conflict/idempotency-conflict/revision-conflict）、410（过期）、413（size-limit）、503（离线/恢复状态不可信）；所有响应带机器可读 code。UI 不把 202 当作成功完成。

## 7. 会话所有权与并发（P1-06）

| 状态 | 证据 | 允许 |
|---|---|---|
| `foreign-unknown` | 索引有会话但没有可靠写权证据 | 只读历史；DSH 普通问题的已认领请求可按 §8 单独结算，不授予会话写权 |
| `foreign-running` | 可靠观测到外部写者 | 会话写操作拒绝，acquire 返回 writer-busy；DSH 普通问题仅按 §8 已认领请求结算 |
| `acquiring` | 显式 acquire 正在验证/取得上游排他能力 | 第二个 acquire/写请求失败，不排队 |
| `ours-idle / ours-running` | 当前 runtimeEpoch 下有效的排他控制证据 | 按操作和回合状态授权 |

未在本进程发现 Query、状态显示 idle、resume 成功、用户口头确认关闭 TUI，都不能单独证明跨进程排他控制。marshal 的 mutex 只能互斥 marshal 自己的请求。

外部历史会话可写必须证明：上游锁/单一宿主路由等机制在执行期间持续排除其他写者，并能发现失效。验证不成立则 acquire 返回 `ownership-unverified`，保留只读。v1 可以交付“外部历史只读 + 有可靠控制边界的自有会话”，不能宣称已接管任意 TUI。显式 fork 使用独立会话和已验证隔离边界；它不是原会话接管成功。

acquire、prompt、configure 和回合状态转换均使用每会话串行状态机；busy 请求立即拒绝，不建立延迟执行队列。进程崩溃、写权丢失、租约过期即撤销控制、清理待答；旧 epoch 的决定不能影响新回合。DSH 原生 writer-held 若通过 spike 验证，可作为其进程内边界；不能外推给 Codex/Claude。

DSH 没有产品 v0 的 acquire 操作。prompt 必须由原生控制器在同一受理步骤完成“当前 idle + 本次写者取得/互斥”，不能沿用当前固定 mode=steer 或先 list 再 prompt 来证明零忙时注入。若原生接口不提供该保证，则该目标版本 prompt 不开放。interrupt 必须原子比较 activeTurnId/runtimeEpoch 再取消；当前 sessionId-only cancel 不足以排除旧请求打断新回合，无法验证原子能力时关闭 interrupt，不能先读回合再调用无条件 cancel。

## 8. 审批、提问与策略（P1-03、P1-04）

`approvalRelay` 与 `questionRelay` 分别控制审批和普通问题。plan-review、ExitPlanMode 等允许开始执行的交互按审批处理，不得借 question 通道授权。策略由源端强制执行，UI 隐藏按钮不是授权检查。

| 策略 | 出站行为 | 原生阻塞如何结算 |
|---|---|---|
| `off` | 不发交互正文，不创建远端可答卡；可保留普通会话 waiting 状态 | DSH 不认领、交本地；独占 headless 若无本地通道，立即拒绝审批/返回无答案 |
| `notify` | 只发脱敏的等待类别，不发命令、问题正文或选项，不可远答 | 与 off 相同；不能声称无人存在的本地 UI 会接回 |
| `remote` | 向已认证 owner 发受限卡片，源端等待决定；还要求 hub 设备记录的 `allowInteractions=true` | 审批超时拒绝；DSH 普通提问超时 next()；Codex/Claude 问题按已验证无答案路径结束；实际等待不超过原生 expiresAt |

所有适配器构造参数必须包含两项策略，禁止适配器自行默认 remote。策略检查覆盖创建卡片、恢复待答卡和接受 decide/answer 三处。远端卡片是显式内容，必须同时具备源端 `relay=remote` 与 hub `allowInteractions=true`；任一缺失按 off 处理，不发送正文也不注册可答卡。运行中本地收紧为 off 时立即作废卡片并按保守方向结算。只有 node 当前进程能够合法结算的原生请求才可认领。Codex/Claude 受管请求仍要求当前 runtime 写权；仅观察到外部等待状态不能创建可答卡。DSH 的请求作答权来自本插件仍持有的 user-questions/request waterfall 回调及未取消的 request，而非 marshal 发起了该会话：本地 TUI 发起的普通问题可被合法认领，answer/cancel 只结算这一请求，不取得 prompt/interrupt/configure 权限。

在认领时记录 node 的 createdAt（UTC 毫秒）及本地单调截止时刻。先验证原生期限的单位与时钟域，再计算 `expiresAt = min(createdAt + timeoutMs, normalizedNativeExpiresAt)`；无原生期限时第二项为无穷大。与 node 共用系统时钟的 DSH/本机子进程不套用 hub↔node 偏差；原生给相对时长时按该协议已验证的起算点转换，不能从接收时刻重新起算。若原生时钟域不同，必须有独立、有限的不确定度界，转换后取最早可能截止；无法证明时不认领远端请求，立即走已验证的本地/拒绝/无答案路径，不能对两个不可比时刻取 min。对外 expiresAt 使用 node 时钟域；浏览器倒计时仅作展示。

等待同时受认领时固定的单调期限和原生有效性约束，墙钟回拨、重连或刷新均不延长。到期、abort、本地收紧及卸载共用一次终态转换，回答入口也同步检查到期和 signal，不能只等 timer 回调。DSH 超时/cancel 仅在原生请求仍有效时 next() 回本地；abort 表示请求取消，不表示本地已回答或一定弹窗。

仅传输中断时，立即禁止新远端认领/回答/正文发送；已认领且仍有效的原生请求可在 node 内存中等至**原截止时刻**，不因断线自动重建。重新鉴权、同步成功且 operatorId/policyRevision、runtimeEpoch、请求有效性均未变化，才可重投影恢复可答卡。明确撤权、任一策略修订变化、本地 off 或实例卸载则使旧卡 invalidated，并一次性结算仍有效的原生等待（DSH next()；headless 拒绝/无答案）；abort 不重复结算。hub 失联时无法立即获知撤权，只能阻止远端作答并由原期限兜底；重新握手发现变更后立即结算，恢复授权也不复活旧请求。

只允许原生可用决策与本项目白名单的交集：`accept-once / decline / cancel`。`cancel` 仅由显式点击触发，超时不升级为中止。禁止 `acceptForSession`、always-allow、execpolicy amendment、持久权限更新和权限范围扩大。Claude 允许一次只返回原输入与 allow，不返回 updatedPermissions；Codex 权限扩大请求返回空授权。MCP elicitation v1 仅拒绝/通知，不能隐式接受 URL 或授权范围。

可用决策缺失或无法可靠解释时，不推断允许项，只提供已验证的拒绝路径。原生混合字符串/对象决策先解析再过滤；不能因为有不支持对象就把整个请求挂起。每张卡记录自己的可用集合，node 对伪造的隐藏决定也要拒绝。

marshal 决定 `accept-once` 分别映射为 Codex 的单次 accept 和 Claude 的 allow；`decline` 映射为原生拒绝；`cancel` 映射为经过验证的拒绝并中止。映射表必须由目标版本样本验证，不能直接将 marshal 字符串原样回写原生接口。

统一 `input.requested` 是判别联合：共同字段为 requestId、runtimeEpoch、kind、expiresAt；`kind=question` 带 questions，`kind=approval` 带 approval。approval 的 action/title/detail/decisions 一律放嵌套对象；没有另一套扁平载荷。`input.resolved` 只有标识、终态、原因和经认证的操作人，无答案和正文；终态枚举固定为 `answered / declined / expired / cancelled / invalidated / failed`，不得新增未在 schema 中声明的值。

questions 每项包含 id、prompt、required、multi、custom、secret，以及可选 options（id、label、description）。answers 按 questionId 携带 selectedOptionIds 和可选 text；禁止按可重复的显示 label 识别选项。若原生只用 label（当前 DSH 即如此），为本次请求建立稳定 ID→原始选项映射，脱敏仅作用显示文本；回写仍使用原生值。重复原始 label 或语义被脱敏/截断到不可辨别时，整卡不可远答并按已验证路径回本地/无答案，不猜选项或让伪造 ID 进入原生。approval.decisions 每项含 id、label；它们与服务端保存的允许集合一致。notify 使用 session.updated 的受限 waitKind，不注册可答的 input.requested。

requestId 使用随机 UUID，并以 `(deviceId, agent, sessionId, runtimeEpoch, requestId)` 为完整键。只有合法、未过期、持有本节规定的请求作答权且符合策略的决定才参与首答竞争。node 原子完成状态转换；hub 的短期 claim 仅减少重复转发，验证失败不得永久占用决定权。所有端显示源端确认的终态，不能以点击即批准。原生 JSON-RPC 请求 id 与 itemId 分开保存，按请求 id 回写。

问题保留单选、多选、自由文本、secret 标志和稳定选项 id；页面按问题 id 保存答案，重复点击替换而不累计。仅在所有必答题合法后一次提交。无法表达的提问返回 unsupported/无答案，不造假卡片。secret 默认不跨机收集，提示仅说明本机需要处理；headless 没有本地通道时明确“无答案”，不得显示“已在本机回答”。

## 9. 设置与真实回读（P1-07、P1-08）

每项能力包含 editable、reason、scope、effectiveAt、values、current、confirmedAt、revision，以及独立 pending（requestId、requested、requestedAt、status）。current 缺失表示未知，不用请求值填补。

权限与思考强度必须按 field 分支，禁止共用一个 agent 转移表：

- permission 比较完整有效权限，包括批准策略、sandbox 文件/网络范围、额外目录和规则；模型切换和 plan 操作也检查最终权限。只允许已验证的能力子集转移；不可比较则拒绝。Claude mode 名称不构成普遍可靠的线性偏序。
- reasoning 使用针对模型和协议版本验证的明确等级语义；已知 low < medium < high 时，只允许沿该阶梯下调（high→medium/low、medium→low），禁止任何上调（low→medium/high、medium→high）。同值是已确认的 no-op；未知值/目录无语义依据时返回 unsupported，不从目录位置推断强弱。
- plan 是原生设置的视图。Claude plan→default 涉及权限放宽时远端拒绝；不能通过关 plan 绕过 permission 检查。Codex 同样核验组合设置。
- model 可选择已验证目录中的模型；若其默认 effort 或权限会隐式放宽，必须保持已确认限制或拒绝。模型可选不代表费用一定更低。
- goal 仅在完整 set/get/clear 回读及行为已验证时开放；从上游响应或 get 获取实际对象，不能用请求 objective 合成结果。skill/plugin 仅只读目录。

configure 携带 `expectedRevision`；源端先检查版本和写权，再串行化设置操作，且 pending 未解决时拒绝依赖该设置的写请求。v1 只允许 idle 时配置，变化作用于下一回合，禁止为了应用 effort 在活跃回合中关闭 Query。

调用前注册观察者，避免先通知后 RPC 响应导致丢失确认；只有能关联到这次设置/状态版本的回读才确认。10 秒没有可靠回读返回 pending-confirmation / readback-timeout，旧 current 不变，不回滚、不重发；迟到的实际值仍更新能力，但不能覆盖已确认的更高 revision。

回读与请求不一致：先发布真实 current，再返回 readback-mismatch，不能保留旧值或请求值掩盖实际状态。void setter、模型目录、初始缓存都不是实际设置回读。若某版本没有可验证的读取渠道，则该字段 editable=false；不靠等待一个未承诺再次发送的 system/init 来假装确认。下一回合才能验证的字段必须有经过实测的“确认先于执行副作用”屏障；没有该屏障则只读，不能形成“等待下一回合确认但又禁止下一回合”的死锁。

## 10. 隐私、缓冲与待答恢复（P1-09）

出站顺序：按事件类型验证 → 字段白名单投影 → 脱敏 → UTF-8 大小检查 → 编码。适用于事件、ACK/result、错误、同步快照、只读查询和审计，不得只清理 event.payload。未知对象字段默认丢弃；深度超限截除并标记，不原样保留。

metadata 只发会话标识、状态、时间、计数、工具名及经允许的字段名。cwd、prompt preview、原生标题可能含源码/凭据，默认不发；显示标题用设备名/agent/短 ID，源端显式标记为可公开的别名才允许发送。内置敏感模式覆盖已知 token/私钥/连接串，但不声称正则可识别所有秘密；隐私主要由字段白名单保证。

goal.objective、自定义说明等内容型设置同样受保护，不能从 capability/current/pending 绕过 metadata。没有双重 content 授权时，goal 编辑关闭（privacy-readback-unavailable），只显示安全状态/计数；真实完整对象仍可在源端内部参与校验。大文本事件在源端按完整 UTF-8 边界分片，控制帧超限返回分类错误；不能任意截断 JSON 信封或 required 字段后继续执行。

content 必须同时满足源端 privacy=content 与 hub 注册记录 allowContent=true；重连协商前使用 metadata。任一授权收紧，清除离线内容、历史内容和已缓存响应，并通知浏览器清空可见缓存；已经被人看到的内容无法撤回。hub 内容/交互授权收紧时先停止向浏览器转发受影响载荷，再关闭设备连接；node 在连接失效时停用协商授权，禁止正文外发与远端作答。暂时断线期间已认领原生等待按 §8 保留到原期限，与明确 off/撤权的终态结算分开。重连核验持久的 operatorId/policyRevision；已变更策略下的旧内容/卡/ACK 正文不得恢复，未变更且仍有效的待答可重新投影。允许方收紧不能只改 hub 文件而继续沿用 node 缓存的授权。清理不能删除无内容的 journal 幂等状态，否则会重新允许重复执行。源机器正文依旧是权威副本。

remote 交互是单独的显式内容授权，需 node `relay=remote` 与 hub `allowInteractions=true` 同时成立；只发送决定所需字段，卡片最大 4096 UTF-8 字节。截断/脱敏导致无法完整判断动作时，卡片保留身份、到期和原因，但 accept-once 必须不可用；不能截去危险后缀仍允许批准。content 档也遵守卡片限制。所有来自 wire 的文本（消息、思考、工具输出、问题、选项、标题、错误 detail）在浏览器中按纯文本渲染，不得插入 HTML、属性或脚本；页面不得用 `innerHTML` 拼接这些字段。

历史 EventBuffer 使用允许缓存的 kind 白名单；input.requested、input.resolved、secret 和答案全部排除。append、read、size 及定时清理都会处理过期项；按接收单调时间计算保留窗，不能被源端 ts 延长。时间/条数/字节任一限制达到即清理最旧项，并报告回放缺口。无新事件时到期内容也不可读取。

待答表只在 node 内存中存活至 §8 计算的 `expiresAt`；hub 不把交互正文留在历史或磁盘。刷新/迟到页面通过 inputs.snapshot 取当前有效卡，带版本和游标，再应用订阅流；过期、已解决或旧 runtimeEpoch 卡不返回。离线队列不缓冲交互正文，重连时重新从当前待答表按策略投影。源端不可达时显示“状态未知”，禁用决定；不展示旧卡为可答。

审计仅保存时间、认证操作人、设备、agent、会话、操作、请求标识、决策、状态/错误分类；不得保存提示词、命令、路径、答案、raw SDK 错误。去重日志是执行元数据，不是内容历史。

## 11. 同步、游标与失效恢复（P1-10）

连接状态：offline → dialing → handshaking → syncing → online。syncing 时禁用写请求；在当前已有每次重连 snapshot 的基础上，增加完整性屏障与原子提交。当前 onOnline 在 socket open 后触发，帧在 hello ACK 前缓冲，尚不代表原子同步完成。node 拨号退避从 1s 起、封顶 10s，并带 ±20% jitter；鉴权/协议错误停止拨号。该上限用于满足“网络恢复后 30s 内完成同步”，不能沿用 30s 封顶后再叠加同步时间。

1. node 为已配置 agents 采集完整分页清单、能力、所有权、状态与各会话高水位 seq，发送 sync.begin/chunk/end；快照采集与增量之间有一致性屏障。
2. hub 在暂存区验证全部分片和范围，仅在 sync.end 完整时原子替换该设备范围的索引，再回 sync.ack。缺失会话删除；缺失/崩溃 agent 标记 unavailable，不将旧能力保留为可写。
3. 缺分片/重复冲突/断线时放弃暂存区，保留旧数据并标 stale；不能部分覆盖。完整范围必须枚举空 agent 清单，防止旧会话残留。
4. 对屏障之后的事件按 `(deviceId, agent, sessionId, nodeEpoch, seq)` 去重应用；发现缺口、队列淘汰或 epoch 改变时要求重同步，不把不完整流当作已对齐。不同会话的 seq 相互独立，不能只按 `(nodeEpoch, seq)` 去重或排序；新 nodeEpoch 不与旧 seq 比大小。
5. hub 重启后清空临时连接/索引；node 重连重新同步，静默空闲会话也必须出现。不重发任何写命令；仅按第 6 节查询未决状态。
6. 源端通过清单事件或有界周期扫描发现新建/删除会话，不依赖用户点击才更新清单。没有可靠增量时每 10 秒启动一次完整分页扫描且不重叠；单次 10 秒内未完成即标 stale 并拒绝写，不能把第一页或缺失状态当完整数据。在线无重连时，静默新增/删除/运行态变化在 30 秒内可见。省略字段保留旧值；扫描结果不能无条件覆盖扫描期间已更新的状态。

原生状态先在源端按可靠的原生版本/顺序与 `(runtimeEpoch, activeTurnId)` 归并，再投影并分配公开 seq。回合 A 的 completed 晚于 B.started 到达时，即使随后拿到更大的公开 seq，也只能结束 A 的记录，不能把 B 置闲；旧 started 同样不能重新激活结束回合。清单扫描的旧 idle、删除判断及能力结果必须与增量屏障/原生版本对账，不能因扫描最后返回就覆盖新状态。没有原生版本时，需验证控制器的有序流及一致性读取屏障；只有到达顺序或本地自增号不构成证据。无法判定新旧则标 stale/禁写并重新读取权威状态，不猜测 idle；公开 seq 只负责已归一化流的投递去重。

node 发送 sync.end 不等于完成同步；只有收到匹配当前连接/代次/syncId 的成功 sync.ack 后才 online。hub 与 node 双侧在屏障完成前拒绝写入；同步被拒、ACK 丢失/超时不得放开写入，以新 syncId 重新同步且不重放命令。

对公开流完成过滤/投影后才分配 seq；策略过滤掉的事件不占序号，已编号后因队列/背压丢弃才构成缺口。未知 kind 通过身份/schema 校验后可以不渲染，但仍推进接收游标。快照高水位必须使用同一公开序列，避免正常隐私过滤触发无限重同步。

浏览器 SSE 使用 hub 签发的单调全局游标与 hubEpoch（不是裸时间戳），支持 Last-Event-ID。回放和实时订阅使用同一屏障，不能先读再订阅留下窗口。超出保留窗或 hubEpoch 改变，发送 reset-required，页面重取索引/能力/当前待答；内容历史缺口明确显示，不伪造完整回放。游标推进与重复消除不能重新打开已结算卡。

WebSocket 和 SSE 均有字节背压。慢浏览器超过预算则断开并要求重同步，不能无限 res.write；控制帧与事件队列分离，ACK 不因内容队列淘汰而静默丢失。agent 崩溃只影响该 agent，撤销其写权和 pending，其他 agent 持续可用。

## 12. 证据、能力与错误

所有能力均要求精确版本、真实脱敏协议样本和目标机验证记录；未知方法/字段关闭对应能力，不把 model/list 成功等同全协议支持。清单完整性必须有原生证据：分页遍历到终止，或固定版本接口明确保证全量并经超过默认页大小的样本验证，或原生返回权威全量标记/总数且完成对账。返回数组长度不等于权威总数；没有证据时只报告“完整性不可确认”，不把首个结果集当完整清单。没有安装 agent 时标明 unavailable，不制造历史数据。

错误至少区分 auth-failed、device-mismatch、stale-connection、frame-invalid、device-offline、sync-required、session-unknown、writer-busy、ownership-unverified、expired、clock-skew、conflict、idempotency-conflict、revision-conflict、outcome-unknown、approval-disabled、approval-expired、decision-invalid、widen-rejected、unsupported、version-unsupported、size-limit、readback-timeout、readback-mismatch、agent-crashed、recovery-required。外传 detail 仅含枚举/安全字段；禁止原样错误消息和堆栈。

错误通过四个互不混用的通道报告：命令生命周期用 `ack.code`（HTTP 映射见 §6）；异步/会话级故障用 `event.kind=error`；浏览器 API 用 HTTP 状态；连接级致命错误用 WebSocket close code。close code 固定为 4400 frame-invalid、4401 auth-failed、4403 device-mismatch、4406 version-unsupported、4408 handshake-timeout、4409 stale-connection；1009 仅表示帧超限。任何通道都不得用字符串包含关系推断错误类别，也不得省略机器可读 code。

本契约的关闭标准由 [P1 验收矩阵](2026-10-29-marshal-acceptance.md)管理。文档修订完成不等于任何运行验收通过。
