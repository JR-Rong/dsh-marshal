# dsh-marshal 跨平台讨论组设计（D1）

日期：2026-10-30
状态：后续阶段目标，尚未实现；用户选择首版仅讨论与汇总，后续行动由用户决定
依据：[总体设计](2026-10-29-marshal-design.md) · [公共契约](2026-10-29-marshal-contract.md) · [插件参考调查](../spikes/2026-10-30-orchestration-references.md)
计划：[D1 实施计划](../plans/2026-10-30-marshal-discussion.md)

## 1. 产品边界与进入条件

用户选择来自不同设备/平台的 agent、议题和允许共享的材料，启动有限轮次的讨论，获得带出处的共识、分歧、待确认事项和行动建议。讨论可用于方案比较、设计评审等，不自动落地建议。

D1 在 v1 认证、node journal、真实控制边界、隐私及恢复门槛完成后实施。它不改变 v0/v1 的承诺，也不阻塞现有 P1 加固。至少两个不同原生平台通过验收才宣称“跨平台讨论”；多个 DSH provider/model 只能证明 DSH 内部讨论。

- 首版仅一个 owner；没有多人组织权限、外部群聊连接或对其它人的消息发送。
- 每个成员使用全新、独立的讨论会话；选择已有 agent 身份/平台不等于加入其现有工作会话。首版不 fork、resume 或自动导入工作会话历史。
- agent 只产生文字分析和汇总。讨论中的任务建议不会进入执行队列，不启动代码修改、终端、联网工具、审批或子 agent。
- 用户另行发起执行才进入原有控制流程，重新确定目标、权限与幂等键；讨论消息不构成执行授权，也不携带原生审批卡。

## 2. 用户流程

1. 新建草稿：填写议题，选择 2–4 个成员（设备、原生平台、精确模型/版本、角色），指定一名成员在讨论结束后汇总。
2. 预览：展示会发送给哪些设备及其配置的模型服务、正文片段、轮次、时间/调用上限和原生会话可能保留记录的事实。该确认仅授权这次讨论所需的模型调用与成员间共享。预览结果带版本与摘要；启动请求必须回带同一摘要，成员、材料、provider/model 或 `policyRevision` 任一变化都须重新预览确认，不匹配返回 `revision-conflict`，不能沿用旧确认静默更新共享范围。
3. 开始：使用浏览器按 `(publicOrigin, operatorId)` 持久化的幂等键发起启动，校验每个成员及历史材料来源设备的能力与本地授权，以及每个成员会话的写权门槛（§5），创建专用无工具会话。任一成员创建失败则停止后续创建、立即请求清理本 run 已创建的专用会话，确认清理后转入 `failed`；若创建或清理结果处于 `outcome-unknown`，则转入 `paused`（待人工/状态查询核对）并保留占额，绝不退回 `draft` 复用同一 `runId` 或偷偷换 provider、模型与成员。
4. 第一轮独立给出意见；至少 2 名成员完成有效封存发言才进入下一轮交叉评论，后续轮次只读取上一轮已封存的共同记录。若第一轮有效发言为 0 则直接 `failed`（不调用汇总）；若仅 1 名成员完成有效发言或后续轮次无新有效发言，则不再启动后续交叉轮次。UI 显示发言来源、原生完成证据、未回复或失效成员。
5. 汇总：分别列出共识、分歧、证据与未知项，引用 messageId；未完成者明确缺席，不把沉默当赞成。用户据此决定后续行动。

房间启动后成员、资料和策略冻结。改议题、增删成员或追加材料需要用户创建新的 run，重新展示共享范围与预算；不在后台延长当前运行。

## 3. 架构与复用

```text
用户 → hub RoomCoordinator（成员、轮次、预算、记录与展示）
          │ 复用认证连接、写命令幂等、状态查询及隐私投影
          ├→ node DiscussionSession → DSH 专用会话
          ├→ node DiscussionSession → Codex 专用会话
          └→ node DiscussionSession → Claude 专用会话
```

hub 是唯一调度者，成员不能直接互相发控制命令。每个 node 仍是执行去重、原生隔离和实际状态的权威。不得由 hub 直接调用第三方模型绕过 node 策略。

| 责任 | 复用与增量 |
|---|---|
| RoomCoordinator | 房间/轮次状态机、持久预算预留与封存记录；源消息去重后唯一分配 roomSeq；固定规则调度，不接受模型生成的调度代码 |
| DiscussionSession 适配端口 | 在已有 AgentHost/surface 内实现节点侧专用会话端口（含原生流内部观察以生成 `discussion.output / status`）；维护持久会话用途与 node 本地到期取消；无法保证隔离或源端期限时不开放该平台 |
| 身份、端点与命令 | 浏览器写操作（新建草稿、确认启动 run、暂停/停止）走公共契约 §4/§6 的 cookie+CSRF 及 `(publicOrigin, operatorId)` 持久幂等键；hub→node 扩展 `discussion.create / submit / interrupt / dispose` 四个判别操作（`discussion.create` 沿用 `target.sessionId: null` 并在 node journal 记录新专用 `sessionId`，其余绑定该专用 `sessionId` 与 `runtimeEpoch`；不开放远端 `discussion.observe`），不透传任意原生方法 |
| 内容与页面 | 复用源端白名单、设备策略、纯文本/SSE/背压；讨论正文与原生 PendingInputs、普通会话历史及 v1 `EventBuffer` 隔离，讨论帧不入 `EventBuffer` 或 node 离线事件队列 |
| DSH 原生协作机制 | 参考 Agent Team 的身份/投递与 dsh-agent-teams 的代次/调度；是否调用窄公共接口由 D1-T00 决定，不默认挂载整个 profile |

node→hub 的讨论输出走独立 `discussion.output / discussion.status` 帧，携带 `deviceId/agent/sessionId/runId/memberId/turnId/nodeEpoch/runtimeEpoch/memberSeq`。`memberSeq` 由 node 在 `(deviceId, runId, memberId, nodeEpoch, runtimeEpoch)` 范围内、完成投影后单调分配，覆盖该成员的输出与状态，不占普通会话 `seq`。完整去重键为上述范围加 memberSeq；不同设备/成员的 seq=1 不冲突。hub 先核验认证连接、冻结的成员绑定及原生 turn 身份，再去重归并；同键不同载荷拒绝并暂停对账。node 不得自报 `roomSeq`。

`roomSeq` 仅由 hub 在接纳源消息后按 `(hubEpoch, runId)` 单调分配，供房间快照/浏览器流排序，与成员来源序号分开；普通重连不重置 memberSeq，新 node/runtime 代次使旧 run 的成员失效，不能沿用旧序号继续讨论。预览增量若在传输中丢弃仅标示预览缺口；最终封存输出必须携带完整终态标记与字节校验，终态状态或完整最终输出缺失/不完整使 run 暂停并通过无正文 `command.status`（对 `discussion.*` 额外回带成员原生工作单元 `running / terminated / disposed / unknown` 状态）与 `discussion.dispose` 对账，正文缺口明确标示；不为补齐消息重发 submit，不把到达顺序或较大 roomSeq 当作原生回合完成证据。hubEpoch 变化后浏览器 reset，旧 run 按 §6 恢复。

hub 只把已通过源端白名单与字节校验的完整输出交给 RoomCoordinator；增量只用于展示，不进入封存记录，也不能绕过 `discussion.submit` 的幂等结果。未在握手中协商 `discussion` 能力的 node 不接收房间命令，旧 hub/node 组合显式失败而不是降级解释。

浏览器房间端点（D1 新增）：读取需有效 cookie 会话；写操作还需 cookie+CSRF，以及 `(publicOrigin, operatorId)` 持久幂等键。`GET /marshal/api/discussions` 列出房间及当前占额/未决 run 的无正文元数据摘要（供页面重载或 hub 重启后定位占额项并对账），`POST /marshal/api/discussions` 新建草稿，`POST /marshal/api/discussions/:roomId/runs` 在预览确认后启动，`POST /marshal/api/discussions/:roomId/stop` 停止或暂停，`GET /marshal/api/discussions/:roomId` 读取状态与封存记录分页，`GET /marshal/api/discussions/stream` 提供绑定 `(hubEpoch, runId, roomSeq)` 高水位屏障与 reset 的房间专用 SSE（先订阅有界暂存再取房间快照，且在登出/轮换/会话到期后 ≤5s 内关闭）。端点不提供正文导出、不写文件，也不接受 URL 查询参数中的凭据。

未来路径建议为 `src/hub/discussions/`、`src/agents/discussion.ts` 与现有 wire、runner、privacy、api/page 的最小扩展。以上均未创建；不另建重复的认证、journal 或适配器进程监督器。

## 4. 讨论权限与内容授权

“仅讨论”必须由原生能力和宿主隔离强制执行，不能只靠 system prompt。新会话需要已验证的工具禁用：无文件/终端/网络工具、MCP、技能执行、子 agent、用户自定义启动 hook 或自动恢复工作任务；模型服务的正常推理请求除外。若宿主不能保证这些条件或创建会话就会执行不可隔离的 hook，标 `discussion-unavailable`，不以“工具申请时再拒绝”替代禁用证据。

讨论专用会话必须关闭原生交互：任何原生提问、审批或 plan-review 请求一律按本机无通道处理（拒绝/无答案），把该成员标为失败或缺席；不注册 `input.requested`、不创建远端可答卡，也不因等待而延长 run。若平台无法在不产生可答交互的前提下运行，同样标 `discussion-unavailable`，不能把 §8 的远答通道复用到讨论会话。

本地新增默认关闭的 `allowDiscussion` 授权（node 本地配置与 hub 设备记录均须 true），不由浏览器开启。所有参与讨论的成员设备以及提供历史片段的**材料来源设备**（`sourceDeviceId`）均须同时满足双侧 `allowDiscussion=true` 与现有 `content` 双授权（源端 `privacy=content` 且 hub `allowContent=true`）。hub 的该授权变化加入同一持久 `policyRevision`。每个 run 的 owner 确认绑定参与成员列表、材料来源设备、provider/model、材料摘要和策略修订；普通 `allowContent`/`allowInteractions` 均不自动授权把内容再次发给别的 agent。汇总者与其它成员同等授权。

只共享 owner 预览确认的粘贴文本或显式选择的、经允许的历史片段，以及本 run 的讨论输出。历史选择仍经过公共契约 §10 过滤（含按 request/call/item 剔除 tool/history 中的结构化交互副本）；原生提问、审批、secret 和结构化答案不得作为材料。讨论输入、发言与汇总仅存于 RoomCoordinator 的有界 hub RAM，并通过讨论房间专用快照/流向已认证浏览器展示，**永不进入 v1 `EventBuffer`、普通会话历史或 node 离线事件队列**。首版不抓取附件/URL、不自动读取 cwd/仓库/完整历史。所有成员知道这些内容会交给列明的模型服务；不承诺原生 runtime/provider 无日志或零保留。

跨成员转发必须同时满足发送方（含历史材料来源设备）当前出站授权、所有接收方当前讨论授权和该 run 的共享清单。每条成员输出标为不可信引用数据；其中“忽略规则”“执行命令”“添加成员”等文字不能修改房间配置、预算或工具权限。消息实际作者取认证 device/session 绑定，不能相信正文或帧自报名称。

运行中任一参与成员或材料来源设备的授权、模型配置或 runtime 变化即暂停整个 run，停止新分发，清空本 run 的正文（含派生汇总）并通知所有浏览器清空；源端尽力取消已接纳调用并释放专用会话。新策略经用户重新确认才能使用全新专用会话开始新 run，不复用已收过撤权内容的旧讨论上下文。无法撤回已经送达其它模型/已被人看到的内容，不宣称清缓存等于撤回披露。

### 4.1 专用会话与普通入口隔离

node 按 `(deviceId, agent, nativeSessionId)` 持久识别用途，保存 `purpose=discussion / operatorId / roomId / runId / memberId` 无正文归属记录；operatorId 是原归属证据，切换 owner/hub 不把旧会话变成普通会话；runtimeEpoch 是另行校验的运行代次，重启不清除会话用途。创建前先落认领意图，新 sessionId 返回后先提交用途记录并写回 `discussion.create` 的 journal 结果，再允许任何发现/流/写入口发布或使用该会话。当该 agent 存在在途或未决的 `discussion.create` 认领意图时，周期 `list/sync` 扫描必须与创建屏障串行化或暂扣期间新出现的未分类原生会话，禁止在用途落盘前将其作为普通 `foreign-unknown` 会话广播出去。原生创建成功但 ID 尚未落盘时崩溃，须凭已验证的原生标记或隔离存储范围完成识别；无法识别时隔离受影响的发现/控制范围并进入恢复，不把可疑会话当普通历史。平台无法提供该恢复边界时 D1 不开放。

用途检查在公共 node 路由统一执行，hub 同时过滤：普通 list/sync 不枚举讨论会话；普通 history/follow/inputs 以及 acquire/prompt/steer/interrupt/configure/fork/answer/cancel/decide 均对该会话拒绝（`session-purpose-conflict`）。原生增量也按用途进入讨论通道，不能先生成普通事件再只在 UI 隐藏。只有匹配 run/member 的 discussion 操作可控制专用会话；无正文 command.status 仍可用于恢复。猜中 sessionId、绕过 UI 或在 runtime 重启后重新扫描，都不能打开普通入口。

用途记录及已退役会话的隔离墓碑不随 15 分钟正文清理、24 小时命令键回收或 dispose 删除；只在证明原生会话/历史已删除且不会再被发现后才能回收。记录损坏/丢失时关闭受影响范围的发现与控制，不能将未知用途默认为普通。源端原生日志仍由平台管理；本规则约束 marshal 的入口，不宣称删除原生记录。用途存储复用 node journal 的完整性/锁机制，独立定义保留类别与容量；容量满拒绝新建，不能驱逐墓碑开放旧历史。停用 D1 也保留用途检查；回滚到不识别用途的旧版本前必须隔离讨论原生历史的发现范围，否则不能重开对应普通入口。

## 5. 调度、身份与预算

`roomId` 是持久元数据身份；每次显式运行生成 `runId`，绑定当前 `hubEpoch`、材料来源设备及各成员的 `(deviceId, agent, sessionId, runtimeEpoch)`。每条调度命令绑定 `runId/roundId/memberId/turnId/idempotencyKey`；`discussion.create` 尚无 `sessionId` 时沿用公共契约 `create` 的 `sessionId: null` target 语义，由 node journal 持久化新生成的专用 `sessionId`。hub 签发 `messageId` 及其独占的 `roomSeq`，node 仅分配成员来源 `memberSeq`（§3）；保存 `replyTo/sourceMessageIds`，来源不可由模型伪造。

`discussion.submit` 与普通 `prompt` 使用同一写权门槛：只有该专用会话处于 `ours-idle`、由当前 `runtimeEpoch` 持有排他控制，且原生控制器在同一次受理步骤完成“当前 idle + 本次写者取得/互斥”时才可接收；不能沿用先 list 再 submit、忙时排队或 hub 固定调度时序来证明。无法验证原子受理的平台不开放讨论成员（`discussion-unavailable`）。`interrupt` 仍需匹配 `activeTurnId/runtimeEpoch`，`dispose` 只释放本 run 的专用会话，不得作用于其它会话。

房间状态为 `draft → preparing → running → summarizing → completed`；任何活跃状态可转 `pausing → paused`、`stopping → stopped` 或 `failed`。`preparing` 阶段只要任一成员会话创建明确失败，即请求销毁本 run 已创建的专用会话；确认清理后进入 `failed`，清理/创建结果 `outcome-unknown` 则进入 `paused` 等待查询对账，绝不退回 `draft` 复用同一 `runId`。停止/暂停先原子关闭新分发，再取消已接纳调用；直到源端确认不再运行才进入相应终态，否则显示结果未知。`paused/outcome-unknown` 只表示调度暂停，不能作为资源已终止或配额可回收的证据。`completed` 只表示讨论及汇总完成，不表示建议已经执行。

首版固定轮次：一轮内各成员最多发言一次，可并行；下一轮只消费上一轮封存的同一份记录，不能边输出边无限触发其它成员。一个原生会话最多一条在途调用；busy 不进入延迟队列。成员超时/错误留出缺席项，不自动重试或由另一模型冒名补位。只有已确认终止的失败成员可跳过后继续；取消/结果未知则 run 暂停，不能边猜测边启动下一轮。第一轮若有效封存发言数为 0，直接进入 `failed` 且不发起汇总；若第一轮仅 1 名成员完成有效发言（无交叉评论对象）或后续某轮无新有效发言，则跳过剩余讨论轮次（已确认无未知在途调用时可按规则进入 `summarizing` 或结束）。

| 预算 | 首版上限与达到后的行为 |
|---|---|
| 成员/轮次 | 2–4 名成员；1–3 轮，由 owner 开始前选择；首版不得扩大 |
| 推理调用 | 仅 `discussion.submit`（轮次发言与汇总）计入推理配额，最多成员数 × 轮数 + 1 次汇总（最多 13 次）；失败和超时也消耗名额，不补发。`discussion.create`（已证明零推理）与 `interrupt/dispose` 不占推理名额，但同样受命令幂等与速率约束 |
| 并发 | 每 run 最多成员数个在途调用；hub 最多 4 个占额 run（含 preparing、取消中及 paused/unknown 尚未确认终止者）；每成员专用会话仅属于一个 run，恢复时从持久记录重建占额 |
| 时间 | 单次调用最多 120s，整个 run 自进入 preparing 起最多 15min；hub 与 node 独立用单调时钟执行 §5.1，源端超限不依赖 hub 在线即可请求取消 |
| 正文 | 单次模型调用组装后的完整输入（含议题、共享材料、前序轮次封存发言与固定提示词框架）≤ 64 KiB、单次输出 ≤ 16 KiB UTF-8；初始议题+共享材料+框架本身超过 64 KiB 在预览/启动时直接以 `size-limit` 拒绝（零创建/零推理），预览同时按所选成员/轮次估算最坏累积并提示可能触达上限的组合，运行时每轮/汇总分发前按实际封存发言再次校验；单房间总计 ≤ 4 MiB，所有房间合计 ≤ 16 MiB，并共享公共契约的 hub 内容 64 MiB 总预算；超限停止、标不完整，不静默截断后宣称完整结论 |
| 正文保留 | 仅 hub RAM；结束/暂停后最多 15min，活跃期亦受整体期限和字节上限；到期、关闭或撤权清理，不落磁盘/IndexedDB/正文日志；该期限不适用于无正文恢复记录、占额证据或用途墓碑 |

首次分发前原子预留调用名额；`discussion.create`、轮次 `submit` 与汇总 `submit` 使用稳定的写命令键并通过 node journal。ACK accepted、完整原生 turn 结束、消息被选入下一轮是三个不同状态。只有完整且已校验的最终输出进入封存记录；未完成增量仅供预览，不当作已完成意见。

时间/调用数限制不等于硬金额/token 限制。适配器如有已验证的输出 token 上限可叠加；无用量回读时显示“用量未知”，不能用字符数冒充真实 token/费用。取消请求发出后 provider 可能仍产生费用；源端不可达或无法确认取消时必须保留未知状态。

### 5.1 node 独立执行期限

hub 在进入 preparing 前持久化不可延长的 `runExpiresAt`（UTC 毫秒，至多当前时刻 + 15min），随 discussion.create 及后续 submit 下发；submit 另带 `turnExpiresAt ≤ min(issuedAt + 120000, runExpiresAt)`。这些字段属于 op args，参与幂等载荷摘要，不替代公共命令的 30s 受理 TTL。node 校验后续 submit 的 runExpiresAt 与该 run 创建时持久绑定的值一致，并检查 turnExpiresAt 上限；换新命令键也不能延长原 run。node 依公共契约 §5 的时钟偏差/不确定度规则保守换算为本地单调截止点，在原生调用前校验并登记本地到期任务；无法可靠换算时拒绝，重连、重复帧或墙钟回拨均不续期。

hub 和 node 均可提前请求取消；到期时 node 自行禁止该 run 新 submit，并向匹配 runtimeEpoch/turnId 的原生调用发起取消，不等待 hub 的 interrupt/dispose。创建尚未完成时也受 run 截止点约束，迟到的创建结果先登记用途，再清理，零后续推理。到期取消及 hub 发起的 `discussion.interrupt / dispose` 复用已登记的会话/run 恢复槽位（不因新写 journal 满而拒绝安全取消），经过相同的原生身份与原子结算检查；本地状态持久化失败时仍尝试安全取消，同时进入恢复，不能因此继续推理。

源端 timer 不因 hub 断线、重启或浏览器退出而撤销；仅在已确认原生终止/已完成安全释放后清理。无法确认取消时保持 unknown 和必要的无正文对账状态，不能以 timer 触发、句柄释放或连接关闭推断实际终止；也不能杀共享 runtime 来误伤工作会话。node 自身重建不自动续跑旧 run，只按监督器核对遗留工作单元并恢复未知记录。独立期限保证按期发起源端取消，不承诺 provider 立即停止计费。

## 6. 恢复、汇总与生命周期

房间元数据 journal 只保存 owner、成员与材料来源设备绑定、run/round/命令 ID、期限、预算预留、状态和材料的带密钥摘要，不存议题/材料/发言/汇总正文。启动/分发前先持久化相关元数据，再调用现有 node journal；单 hub 实例对该状态持有排他锁，多实例不竞跑同一房间。该 journal 是 hub 本地受限文件，默认 `$HOME/.dsh-marshal/discussions.json`，显式覆盖使用绝对路径、不展开字面 `~`，目录/文件权限与完整性规则等同公共契约；启动时校验可解析、版本和 operatorId 绑定。HMAC 密钥持久稳定，不因 hub 重启或文件缺失重新生成。

D1 初始化标记存于 hub 安装身份状态中，与 discussions.json 及其 HMAC 密钥分离，绑定 operatorId、状态文件/密钥位置及初始化版本。首次启用由本地初始化步骤显式执行：标记、journal 和密钥均不存在时才可建立新 D1 状态；复用公共契约 §4 的“持久 initializing 意图 → 配套提交 → ready”流程，不改变既有 operatorId。只凭匹配的未完成意图继续同一次初始化。ready 后任一必需文件缺失，或发现无合法意图的残留文件、损坏、已检测到回滚、身份/密钥不匹配，均进入 recovery-required、拒绝新草稿/run，不自动建空表或新密钥。既有 v1 安装首次启用 D1 与已初始化 D1 丢文件必须可区分；仅可展示已验证的元数据/只读查询结果，不能把损坏文件当可信摘要。

hub 重启不恢复自动调度；旧 run 标 `paused/outcome-unknown`，查询原命令状态但不重发。没有正文就不能重建原讨论或自动重新汇总。用户必须核对未知调用，再显式以材料重新预览启动新 run；清除旧未知不作为启动的捷径。node/runtime 重启、设备离线或协议版本改变同样撤销原成员绑定，不偷偷创建替代会话。普通页面重连在 hub RAM 仍有效时用快照+游标恢复展示，不能再次发起讨论。

正常汇总由预先选定成员额外调用一次，继续无工具限制和剩余预算；只能引用本 run 的封存 `messageId`。若进入 `summarizing` 时预先选定的汇总成员已失败、离线、`runtimeEpoch` 失效或处于结果未知，**不自动替换为其它成员或模型**，也不增加预算重试；直接保留带缺席标记的原封存发言列表并标记“汇总未完成（summary-unavailable）”。汇总中引用不存在的 ID 标无效；意见内容是否准确仍需用户判断，不能把 ID 校验包装成事实验证。

run 结束、到期、撤权或卸载时 hub 请求 discussion.dispose，node 也按 §5.1 独立执行到期取消。清理分成三个生命周期，不以统一 TTL 删除：

| 类别 | 回收条件 |
|---|---|
| 正文与展示缓存 | 按 15min/字节预算、关闭或撤权清理；源端不可达不妨碍 hub 清正文 |
| 原生运行资源及并发占额 | 立即取消和释放不再需要的展示订阅；到期任务/取消关联保留到已确认原生终止，或转为持久 unknown 对账。只有各成员经 `discussion.status`、`command.status`（回带成员原生工作单元状态）或 `discussion.dispose` ACK 确认无未决创建、无活跃/未知调用且已清理时才释放 run 槽位；仅命令 `accepted`、请求停止、断线、15min 到期均不足以释放占额 |
| 无正文恢复记录及用途隔离 | admitted/pending-confirmation/outcome-unknown 和关联键、成员绑定、预算预留、取消状态不按 TTL/LRU 驱逐；确认结束后恢复记录至少保留 24h；用途墓碑另按 §4.1 保留至原生历史删除证据成立 |

恢复记录有显式本地容量上限；满时拒绝新 run，已有状态查询/安全取消仍可用。hub 重启先恢复占额再允许新 run，不能靠重启或更换 runId 绕过 4 个占额 run 上限。人工对账必须记录源端工作单元已终止/不存在等可验证证据，再结算未知与占额；仅点击清除或确认已知风险不算终止证据。允许释放不再有效的内存句柄，但持久关联不能一起抹除；所有未决记录保持可追溯。

任何清理均不得删除原生用户工作会话。专用会话的原生持久历史依平台自身规则处理，在启动预览中披露；marshal 不承诺清除其记录，普通入口仍按用途隔离。浏览器普通登出仅断开该登录会话展示，已授权的有界 run 继续；若要终止，使用明确的“停止讨论”。设备撤权则按 §4 暂停。

## 7. 验收标准

沿用公共验收的 U/I/R 分层，全部用例当前 **NOT RUN**。至少一个 R 组合为两个不同原生平台、分布在两台目标机器；未覆盖的平台/版本不得宣称支持。各故障测试检查原生调用次数、最终状态、正文出口与资源释放。

| ID | 层 | 场景 | 通过条件 |
|---|---|---|---|
| G01 | R | 固定 DSH/Codex/Claude 候选版本，验证专用会话和禁用工具 | 至少两个原生平台通过；不能禁用工具/hook 的平台 unavailable；同 DSH 多 provider 不算跨平台；记录准确版本及隔离证据 |
| G02 | U/I/R | 新建讨论、现有工作会话运行中、恶意发言要求执行/扩权 | 专用新会话；工作会话无 resume/fork/写入；终端/文件/网络工具、MCP、子 agent 调用均为零；原生交互卡为零（提问/审批按无通道拒绝并记缺席）；原有全局配置不变 |
| G03 | U/I | 成员或材料来源设备的 allowDiscussion/content 各自缺一、参与方未确认、临时更换模型/provider | 任一缺失零正文分发/零推理；共享预览与实际成员/来源设备/模型一致；启动摘要不匹配零调用；更换须新 run 确认，不能自动降级或换人 |
| G04 | U/I | 并发开始、重复 HTTP、丢 ACK、preparing 部分创建失败/未知、hub 在登记/发送/落结果边界崩溃 | 浏览器与 hub/node 稳定键协作，一个 run/命令最多一次原生调用；preparing 失败请求清理已建会话，确认后 failed，创建/清理未知进入 paused 并保留占额且不退回 draft；重启只查询不自动重发/重建会话 |
| G05 | U/I | 消息伪造作者、旧 run/成员 epoch 迟到、重复输出与乱序增量 | 作者来自认证绑定；旧代次不进入当前讨论；一个完成发言一次入封存记录，下一轮所有成员读取同一记录 |
| G06 | U/I/R | 第三轮结束、调用额用尽、长回合、多轮累积输入逼近 64 KiB、超长输出、多个房间满额 | 名额/时间/单次组装输入 64 KiB/单次输出 16 KiB/全 hub 预算均不超界；停止新调度；无无限互相唤醒；不静默截断，不把字符数或请求取消当硬费用/执行停止证明 |
| G07 | I/R | 成员掉线、busy、超时，首轮 0/1 人有效回复，取消确认与未确认分别注入 | busy 不排队，故障不自动重试；已终止成员可标缺席，首轮 0 有效回复直接 failed、仅 1 人有效回复跳过后续交叉轮次；未知则暂停、不发下一轮；其它 agent 的非讨论会话不受影响 |
| G08 | I/R | 用户停止、成员或材料来源设备撤权、策略/runtime 变化、插件卸载 | 原子禁新分发，旧回复不污染后续 run；取消未确认仍未知，确认后停止并释放专用会话；任一参与/来源设备授权收紧清理相关正文，资源释放且无后台重启 |
| G09 | U/I | 合成秘密/原生审批和答案藏在 history/tool 派生材料；模型指令注入；脚本文本；检查 EventBuffer/离线队列 | 已知交互正文不进入材料/磁盘/日志；讨论正文不进入 EventBuffer 或 node 离线队列；非白名单阻断；正文纯文本，不能改权限、成员或调度；明确无法撤回已送达模型的内容 |
| G10 | I | 浏览器重载/游标丢失、hub 重启、RAM 过期、元数据状态损坏 | 页面恢复不触发调用；重启无正文不伪造原记录，旧 run 暂停/未知且零自动汇总；损坏拒绝新运行、人工恢复 |
| G11 | U/I/R | 意见冲突、成员缺席、汇总者自身失败/未知、汇总错误引用/额度耗尽 | 共识/分歧/未知分列；引用仅限存在且可见的封存消息；缺席不算赞成，错误引用标无效；汇总者失效不自动换人冒充，标汇总未完成并保留原发言；无虚假完整汇总、无执行任务产生 |
| G12 | I/R | 完整运行后停用插件，重复装载；检查持久化与依赖影响 | 已确认结束的 timer/listener/worker/专用会话句柄无泄漏，未知状态的必要对账资源按 G16 留证；marshal 磁盘无正文；原生保留行为已披露；未挂载会改变全局控制的 profile，许可证及固定版本依赖有记录 |
| G13 | U/I | 既有 v1 安装首次启用 D1；初始化每个落盘边界崩溃；ready 后删除 journal/密钥但保留标记；移除标记但残留文件 | 初次启用与丢失可区分，匹配意图只完成原初始化；异常组合 recovery-required、零新草稿/run/推理或会话创建、不生成空表/新密钥，已有查询/安全取消仍可用；正常重启保留原幂等域与占额 |
| G14 | U/I/R | 讨论会话直接访问普通 list/history/follow/inputs/command；创建后落用途前崩溃；runtime 重启、重新扫描、停用 D1、切换 owner、撤权及命令记录过保留期 | 用途先于发现发布持久化；普通入口不暴露会话或正文、所有普通控制零原生调用，猜中 ID 同样拒绝；用途不明隔离并恢复，不降为普通；原生历史未删除时墓碑仍在；不操作其它工作会话，用途不明仅封锁受影响范围 |
| G15 | U/I/R | 原生受理后杀 hub 或单向断网，node 仍运行；墙钟回拨/重连；创建结果晚于 run 期限；写 journal 满/失败 | node 不等 hub 即在保守单调截止点请求匹配回合取消，重连不续期；过期 submit 零调用、迟到创建登记用途后清理；取消失败/未确认仍 unknown，写失败进入恢复、不报成功；不误杀共享 runtime、不承诺停止计费 |
| G16 | U/I | unknown 超过 15min/24h；断线期间点击停止；4 个占额 run 全部未知后重启；恢复存储满；人工对账 | 正文到期清除，原命令关联与未决/用途记录仍可查；未知不驱逐、不释放槽位，第 5 个 run 拒绝；状态查询/安全取消仍可用，持久化失败则恢复；确认源端终止的证据才结算占额，已确认记录至少留 24h |
| G17 | U/I | 两节点/成员各发送 memberSeq=1；乱序/重复/同键不同载荷；node 伪造 roomSeq；普通重连与代次更换 | 来源按完整成员/实例键去重，互不吞消息；hub 独占分配 roomSeq，重复只接纳一次、冲突/缺口暂停对账；node 自报 roomSeq 拒绝；重连不重置来源序号，换代不续旧 run，浏览器按 hubEpoch reset、零 submit 重发 |

关闭条件：设计、实施计划、适配器能力报告和 G01–G17 证据对应；真实禁用工具、跨平台链路和恢复门槛缺一则不发布跨平台讨论能力。文档通过不等于功能已经可用。
