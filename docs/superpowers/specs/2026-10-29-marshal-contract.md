# dsh-marshal 公共契约

日期：2026-10-29
状态：P1 评审修订；规范草案，尚无实现与运行验收
适用：v0、v1；本文是配置、协议、安全及恢复语义的唯一权威定义。

## 1. 文档关系与版本

- [总体设计](2026-10-29-marshal-design.md)定义产品边界；架构文档定义模块责任；计划定义实现顺序。
- [验收矩阵](2026-10-29-marshal-acceptance.md)定义通过条件。修改本文时必须同步关联任务和验收用例。
- 目前没有已发布的 wire 实现，草案采用 `v: 1`、`contractRevision: p1-review-1`。产品版本 v0/v1 与 wire 版本不是同一概念。
- 握手交换 wire 版本、契约修订和功能集合；不兼容修订拒绝建立控制通道，不能仅看到 `v: 1` 就假定兼容。发布后的破坏性变更须升级协议版本。
- 以下出现的模块名、接口和帧均是待实现契约，不表示源文件已经存在。

## 2. 不变量

| ID | 必须始终成立 |
|---|---|
| INV-01 | node 只主动外连；所有跨机内容先经过源端隐私处理 |
| INV-02 | 网络认证身份决定设备身份，帧中的自报身份不能覆盖它 |
| INV-03 | 浏览器收到受理结果不等于 agent 回合完成；超时不等于未执行 |
| INV-04 | 同一有效幂等键最多发起一次 agent 调用；崩溃不明状态不得自动重放 |
| INV-05 | 浏览、历史读取、订阅和重连不取得写权、不启动推理、不恢复外部运行会话 |
| INV-06 | 写权不明则只读；权限和思考强度变更分别校验，未知状态不允许放宽 |
| INV-07 | 中继默认关闭；审批只允许单次授权，不能扩大持续权限或写全局配置 |
| INV-08 | `current` 只来自已验证的 agent 回读，请求值保存在独立 pending 字段 |
| INV-09 | 审批、提问和答案不进入历史缓冲、正文日志或持久化内容存储 |
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
| `dashboardToken` | hub | 必填，与 device token 隔离；不允许 URL 查询参数传递 |
| `devicesFile` | hub | 默认 `~/.dsh-marshal/devices.json`；设备 ID、显示名、token 摘要、撤销状态、内容授权 |
| `privacy` | node | 默认 `metadata`；可选 `content`，还需 hub 对该 deviceId 允许内容 |
| 设备记录 `allowContent` | hub | 默认 false；由部署者在 hub 本地设置 |
| `questionRelay` | node | 默认 `off`；`off / notify / remote` |
| `approvalRelay` | node | 默认 `off`；`off / notify / remote`；v0 DSH 审批不可用 |
| `answerTimeoutMs` | node | 默认 300000；15000–300000 |
| `approvalTimeoutMs` | node | 默认 60000；15000–300000 |
| `agents` | node | 默认 `[dsh]`；v0 只支持 dsh，v1 按能力探测启用 codex/claude |
| `codexExecutable / claudeExecutable` | node | 可选显式路径；缺省按已验证的包入口/PATH 探测，不猜内网地址 |
| `redaction` | node | 默认附加规则为空，但内置敏感模式始终生效；附加规则不能移除内置规则 |
| `ringBufferMinutes` | hub | 默认 15；1–15；v0 不提供内容补看，v1 才生效 |

固定资源预算：出站单帧不超过 1 MiB；单张交互卡不超过 4096 UTF-8 字节；node 离线事件队列最多 1000 条且总计 8 MiB；v1 历史缓冲每会话最多 2000 条/8 MiB、hub 总计 64 MiB。任何一项达到上限都触发淘汰或拒绝；这些是硬限额，不是“目标平均值”。

hub 复用 DSH webServer 的端口与 TLS/反代，不另监听。node 不暴露外部监听端口；DSH 自身需要的回环服务不属于跨机入口。hub 管理本机 agent 必须显式注册一个本地 node 身份，走相同管道；不是 hub 的隐式副作用。

## 4. 身份、握手与连接代次

1. TLS 建连，设备 token 只在 Authorization 头发送；`hello` 不重复携带 token。
2. hub 从 token 摘要取得注册记录，核验 `hello.deviceId`。`hello` 带版本、`nodeEpoch`、适配器探测摘要，不带会话正文。
3. hub 签发随机 `connectionId`，返回有效隐私策略、时钟信息；node 收到握手 ACK 后才进入 syncing，不能在 WebSocket open 时立即冲刷队列。
4. 同一 deviceId 只保留一个当前连接。替换时递增连接代次；旧连接关闭不得 detach 新连接，旧帧不得修改索引或完成新命令。
5. 每帧入口校验认证设备、连接代次、允许方向、schema 和大小。事件中的 deviceId 不符即拒绝并记录分类；不能原样 publish。
6. hub pending 命令绑定 `(commandId, deviceId, connectionId, nodeEpoch)`。ACK 必须来自绑定连接。重连后的结果通过只读状态查询恢复，不接受旧连接 ACK 冒充新确认。
7. token 撤销立即关闭对应连接并禁止新命令；未知/已撤销 token 是终止性鉴权失败，不无限重试。未完成 hello 的连接有握手超时和数量上限。

浏览器通过登录表单 POST token 换取短期 `Secure; HttpOnly; SameSite=Strict` 会话 cookie；初始登录页可公开但不含数据。页面/API/SSE 均校验会话；写请求校验 Origin 和 CSRF token。非浏览器调用可用专用头。token、cookie、命令正文不写日志。owner 的审计身份由 hub 从认证会话赋予，不接受浏览器自报 `answeredBy`。`operatorId` 是该 hub 安装中持久的 owner 身份，跨浏览器登录、hub 重启和 token 轮换保持稳定；临时浏览器会话 ID 只作审计关联，不参与幂等域。

## 5. 公共帧、操作与时间

所有时间字段统一为 UTC Unix 毫秒整数。`nodeEpoch` 是 node 进程启动标识；每个 `(deviceId, agent, sessionId, nodeEpoch)` 的 `seq` 单调递增。适配器子进程另有 `runtimeEpoch`，重启时原写权和交互失效。

| 帧 | 必需信息与用途 |
|---|---|
| `hello / hello.ack` | wire 版本、契约修订、功能集合、认证设备、nodeEpoch、connectionId、隐私策略 |
| `command` | commandId、idempotencyKey、operatorId、target、op、args、issuedAt、deadline、connectionId、nodeEpoch |
| `ack` | commandId、connectionId、nodeEpoch、status、code、受限 result；只表示命令受理/确认状态 |
| `event` | deviceId、agent、sessionId、nodeEpoch、seq、ts、kind、按 kind 验证的 payload |
| `sync.begin / sync.chunk / sync.end` | syncId、完整范围、快照版本、会话游标、分片计数；快照不含正文 |
| `command.status / command.status.result` | 只读查询原幂等键状态；不触发执行、不携带原始正文 |
| `inputs.snapshot / inputs.snapshot.result` | owner 按会话查询当前有效待答卡；node 重新执行隐私与策略校验 |

target 为 `(deviceId, agent, sessionId)`。agent 标识是字符串，但必须在握手支持集合中。未知操作必须拒绝；未知事件可忽略并计数，不能因此绕过身份或大小检查。

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

旧稿 marshal `resume` 操作删除：浏览改为 `observe`，取得控制改为 `acquire`；底层 agent 的 resume API 只允许在取得写权后的适配器内部使用。

命令 TTL 固定 30000 ms，从 hub 接收合法请求开始计时。node 在入队、获得执行互斥后、调用 agent 前检查 deadline；过期命令零调用。握手和心跳重新估算时钟偏差；无法将偏差/不确定度限制在 5000 ms 内则写请求返回 `clock-skew`，并保守使用最早可能过期时间。执行开始前用单调时钟约束本地等待，不能靠调整墙钟延长 TTL。TTL 不是已开始操作的自动取消机制。

## 6. 命令生命周期与幂等（P1-01、P1-02）

浏览器对一次用户意图生成并保存 idempotencyKey；网络超时不能换键自动重试。幂等域为 `(operatorId, target, idempotencyKey)`，规范化 op/args 的摘要用于检出同键不同载荷；传输 commandId、时间和连接代次不参与载荷摘要。

hub 在任何 await/发送之前原子登记 in-flight。同键同载荷共享一个结果，不能再次发送；同键不同载荷返回 `idempotency-conflict`。ACK 路由必须显式分派到 pending 完成逻辑，event 路由不能吞掉 ACK；error/关闭/超时也必须完成等待者。

node 是去重的最终权威。按幂等域原子登记并在调用 agent 前持久化 `admitted`，之后记录 `accepted / confirmed / rejected / outcome-unknown`。日志仅含身份、目标、操作、时间、状态和带本地密钥的载荷摘要，不含提示词、答案、命令或路径。已记录的键至少保留 24 小时；未决记录不可被 LRU 驱逐，容量满则拒绝新写入。终态过保留窗口可删除，因此不承诺无限期 exactly-once。

| 状态 | 对用户的含义 | 重试规则 |
|---|---|---|
| `rejected` | 明确在调用 agent 前拒绝，附原因 | 更正原因后可显式发起新意图 |
| `accepted` | agent 已受理，后续回合完成由事件表示 | 不重发 |
| `confirmed` | 设置等操作已获得实际回读 | 不重发 |
| `pending-confirmation` | 已请求，尚无实际回读 | 只查询或等待 |
| `outcome-unknown` | 可能已执行，连接/进程故障导致结果不明 | 只查询，禁止自动再次执行 |

node 在 `admitted` 与调用 agent 之间、调用与落结果之间崩溃时，重启将未决项标记 outcome-unknown；除非上游支持且已验证同一操作的幂等恢复，否则不得自动调用。不能靠“磁盘记录存在”推断执行成功。原 nodeEpoch 的延迟 command 一律拒绝。

hub 发送后丢 ACK、hub 重启或连接断开，均返回/恢复为 outcome-unknown。只读状态查询可恢复已存状态；查询 unknown 不触发重发。查询结果必须经过同样身份验证和内容清理。HTTP 区分 200（受理/确认）、202（等待确认/结果未知）、409（冲突）、410（过期）、503（离线）；所有响应带机器可读状态。UI 不把 202 当作成功完成。

## 7. 会话所有权与并发（P1-06）

| 状态 | 证据 | 允许 |
|---|---|---|
| `foreign-unknown` | 索引有会话但没有可靠写权证据 | 只读历史；显示写权未确认 |
| `foreign-running` | 可靠观测到外部写者 | 只读；acquire 返回 writer-busy |
| `acquiring` | 显式 acquire 正在验证/取得上游排他能力 | 第二个 acquire/写请求失败，不排队 |
| `ours-idle / ours-running` | 当前 runtimeEpoch 下有效的排他控制证据 | 按操作和回合状态授权 |

未在本进程发现 Query、状态显示 idle、resume 成功、用户口头确认关闭 TUI，都不能单独证明跨进程排他控制。marshal 的 mutex 只能互斥 marshal 自己的请求。

外部历史会话可写必须证明：上游锁/单一宿主路由等机制在执行期间持续排除其他写者，并能发现失效。验证不成立则 acquire 返回 `ownership-unverified`，保留只读。v1 可以交付“外部历史只读 + 有可靠控制边界的自有会话”，不能宣称已接管任意 TUI。显式 fork 使用独立会话和已验证隔离边界；它不是原会话接管成功。

acquire、prompt、configure 和回合状态转换均使用每会话串行状态机；busy 请求立即拒绝，不建立延迟执行队列。进程崩溃、写权丢失、租约过期即撤销控制、清理待答；旧 epoch 的决定不能影响新回合。DSH 原生 writer-held 若通过 spike 验证，可作为其进程内边界；不能外推给 Codex/Claude。

## 8. 审批、提问与策略（P1-03、P1-04）

`approvalRelay` 与 `questionRelay` 分别控制审批和普通问题。plan-review、ExitPlanMode 等允许开始执行的交互按审批处理，不得借 question 通道授权。策略由源端强制执行，UI 隐藏按钮不是授权检查。

| 策略 | 出站行为 | 原生阻塞如何结算 |
|---|---|---|
| `off` | 不发交互正文，不创建远端可答卡；可保留普通会话 waiting 状态 | DSH 不认领、交本地；独占 headless 若无本地通道，立即拒绝审批/返回无答案 |
| `notify` | 只发脱敏的等待类别，不发命令、问题正文或选项，不可远答 | 与 off 相同；不能声称无人存在的本地 UI 会接回 |
| `remote` | 向已认证 owner 发受限卡片，源端等待决定 | 审批超时拒绝；DSH 普通提问超时 next()；Codex/Claude 问题按已验证无答案路径结束 |

所有适配器构造参数必须包含两项策略，禁止适配器自行默认 remote。策略检查覆盖创建卡片、恢复待答卡和接受 decide/answer 三处。运行中本地收紧为 off 时立即作废卡片并按保守方向结算。

只允许原生可用决策与本项目白名单的交集：`accept-once / decline / cancel`。`cancel` 仅由显式点击触发，超时不升级为中止。禁止 `acceptForSession`、always-allow、execpolicy amendment、持久权限更新和权限范围扩大。Claude 允许一次只返回原输入与 allow，不返回 updatedPermissions；Codex 权限扩大请求返回空授权。MCP elicitation v1 仅拒绝/通知，不能隐式接受 URL 或授权范围。

可用决策缺失或无法可靠解释时，不推断允许项，只提供已验证的拒绝路径。原生混合字符串/对象决策先解析再过滤；不能因为有不支持对象就把整个请求挂起。每张卡记录自己的可用集合，node 对伪造的隐藏决定也要拒绝。

marshal 决定 `accept-once` 分别映射为 Codex 的单次 accept 和 Claude 的 allow；`decline` 映射为原生拒绝；`cancel` 映射为经过验证的拒绝并中止。映射表必须由目标版本样本验证，不能直接将 marshal 字符串原样回写原生接口。

统一 `input.requested` 是判别联合：共同字段为 requestId、runtimeEpoch、kind、expiresAt、notifyOnly；`kind=question` 带 questions，`kind=approval` 带 approval。approval 的 action/title/detail/decisions 一律放嵌套对象；没有另一套扁平载荷。`input.resolved` 只有标识、终态、原因和经认证的操作人，无答案和正文。

questions 每项包含 id、prompt、required、multi、custom、secret，以及可选 options（id、label、description）。answers 按 questionId 携带 selectedOptionIds 和可选 text；禁止按可重复的显示 label 识别选项。approval.decisions 每项含 id、label；它们与服务端保存的允许集合一致。notify 使用 session.updated 的受限 waitKind，不注册可答的 input.requested。

requestId 使用随机 UUID，并以 `(deviceId, agent, sessionId, runtimeEpoch, requestId)` 为完整键。只有合法、未过期、属于当前写者且符合策略的决定才参与首答竞争。node 原子完成状态转换；hub 的短期 claim 仅减少重复转发，验证失败不得永久占用决定权。所有端显示源端确认的终态，不能以点击即批准。原生 JSON-RPC 请求 id 与 itemId 分开保存，按请求 id 回写。

问题保留单选、多选、自由文本、secret 标志和稳定选项 id；页面按问题 id 保存答案，重复点击替换而不累计。仅在所有必答题合法后一次提交。无法表达的提问返回 unsupported/无答案，不造假卡片。secret 默认不跨机收集，提示仅说明本机需要处理；headless 没有本地通道时明确“无答案”，不得显示“已在本机回答”。

## 9. 设置与真实回读（P1-07、P1-08）

每项能力包含 editable、reason、scope、effectiveAt、values、current、confirmedAt、revision，以及独立 pending（requestId、requested、requestedAt、status）。current 缺失表示未知，不用请求值填补。

权限与思考强度必须按 field 分支，禁止共用一个 agent 转移表：

- permission 比较完整有效权限，包括批准策略、sandbox 文件/网络范围、额外目录和规则；模型切换和 plan 操作也检查最终权限。只允许已验证的能力子集转移；不可比较则拒绝。Claude mode 名称不构成普遍可靠的线性偏序。
- reasoning 使用针对模型和协议版本验证的明确等级语义；已知 low < medium < high 时，只允许 high→medium/low，禁止 low→high。同值是已确认的 no-op；未知值/目录无语义依据时返回 unsupported，不从目录位置推断强弱。
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

content 必须同时满足源端 privacy=content 与 hub 注册记录 allowContent=true；重连协商前使用 metadata。任一授权收紧，清除离线内容、历史内容和已缓存响应，并通知浏览器清空可见缓存；已经被人看到的内容无法撤回。清理不能删除无内容的 journal 幂等状态，否则会重新允许重复执行。源机器正文依旧是权威副本。

remote 交互是单独的显式内容授权，只发送决定所需字段，卡片最大 4096 UTF-8 字节。截断/脱敏导致无法完整判断动作时，卡片保留身份、到期和原因，但 accept-once 必须不可用；不能截去危险后缀仍允许批准。content 档也遵守卡片限制。

历史 EventBuffer 使用允许缓存的 kind 白名单；input.requested、input.resolved、secret 和答案全部排除。append、read、size 及定时清理都会处理过期项；按接收单调时间计算保留窗，不能被源端 ts 延长。时间/条数/字节任一限制达到即清理最旧项，并报告回放缺口。无新事件时到期内容也不可读取。

待答表只在 node 内存中存活至原始 expiresAt；hub 不把交互正文留在历史或磁盘。刷新/迟到页面通过 inputs.snapshot 取当前有效卡，带版本和游标，再应用订阅流；过期、已解决或旧 runtimeEpoch 卡不返回。离线队列不缓冲交互正文，重连时重新从当前待答表按策略投影。源端不可达时显示“状态未知”，禁用决定；不展示旧卡为可答。

审计仅保存时间、认证操作人、设备、agent、会话、操作、请求标识、决策、状态/错误分类；不得保存提示词、命令、路径、答案、raw SDK 错误。去重日志是执行元数据，不是内容历史。

## 11. 同步、游标与失效恢复（P1-10）

连接状态：offline → dialing → handshaking → syncing → online。syncing 时禁用写请求；所有启动和重连都执行完整同步，不能只在 applyNode() 首次调用 snapshot。

1. node 为已配置 agents 采集完整分页清单、能力、所有权、状态与各会话高水位 seq，发送 sync.begin/chunk/end；快照采集与增量之间有一致性屏障。
2. hub 在暂存区验证全部分片和范围，仅在 sync.end 完整时原子替换该设备范围的索引。缺失会话删除；缺失/崩溃 agent 标记 unavailable，不将旧能力保留为可写。
3. 缺分片/重复冲突/断线时放弃暂存区，保留旧数据并标 stale；不能部分覆盖。完整范围必须枚举空 agent 清单，防止旧会话残留。
4. 对屏障之后的事件按 `(nodeEpoch, seq)` 去重应用；发现缺口、队列淘汰或 epoch 改变时要求重同步，不把不完整流当作已对齐。新 nodeEpoch 不与旧 seq 比大小。
5. hub 重启后清空临时连接/索引；node 重连重新同步，静默空闲会话也必须出现。不重发任何写命令；仅按第 6 节查询未决状态。
6. 源端通过清单事件或有界周期扫描发现新建/删除会话，不依赖用户点击才更新清单。

浏览器 SSE 使用 hub 签发的单调全局游标与 hubEpoch（不是裸时间戳），支持 Last-Event-ID。回放和实时订阅使用同一屏障，不能先读再订阅留下窗口。超出保留窗或 hubEpoch 改变，发送 reset-required，页面重取索引/能力/当前待答；内容历史缺口明确显示，不伪造完整回放。游标推进与重复消除不能重新打开已结算卡。

WebSocket 和 SSE 均有字节背压。慢浏览器超过预算则断开并要求重同步，不能无限 res.write；控制帧与事件队列分离，ACK 不因内容队列淘汰而静默丢失。agent 崩溃只影响该 agent，撤销其写权和 pending，其他 agent 持续可用。

## 12. 证据、能力与错误

所有能力均要求精确版本、真实脱敏协议样本和目标机验证记录；未知方法/字段关闭对应能力，不把 model/list 成功等同全协议支持。没有安装 agent 时标明 unavailable，不制造历史数据。

错误至少区分 auth-failed、device-mismatch、stale-connection、frame-invalid、device-offline、sync-required、session-unknown、writer-busy、ownership-unverified、expired、clock-skew、idempotency-conflict、outcome-unknown、approval-disabled、approval-expired、decision-invalid、widen-rejected、unsupported、readback-timeout、readback-mismatch、agent-crashed。外传 detail 仅含枚举/安全字段；禁止原样错误消息和堆栈。

本契约的关闭标准由 [P1 验收矩阵](2026-10-29-marshal-acceptance.md)管理。文档修订完成不等于任何运行验收通过。
