# dsh-marshal v1 架构设计

日期：2026-10-29
状态：P1 评审修订；未实现
规范：[公共契约](2026-10-29-marshal-contract.md)
上游：[v1 设计](2026-10-29-marshal-v1-design.md) · [v0 架构](2026-10-29-marshal-architecture.md)
执行：[v1 计划](../plans/2026-10-29-marshal-v1.md) · [验收矩阵](2026-10-29-marshal-acceptance.md)

## 1. 运行时与模块

复用现有 v0 hub/node、runner；journal、统一隐私、原子同步和完整认证边界依赖 [v0 P1 增量计划](../plans/2026-10-29-marshal-v0-p1.md) 先交付，目前不能作为现成功能调用。新增 AgentHost 管理各 agent，不能由适配器直接绕过 node runner 接受远端写入。

| 模块 | 职责 |
|---|---|
| src/agents/types.ts、registry.ts | 适配器生命周期、探测结果、逐功能 capability 与不可用原因 |
| src/agents/host.ts | 路由只读/控制、逐 agent 健康与快照；一个失败不让全部 snapshot 失败 |
| src/agents/supervisor.ts | 子进程代次、stdio 传输、退出清理、退避与停止 |
| src/agents/ownership.ts | foreign-unknown/acquiring/ours 状态机、证据与租约、每会话互斥 |
| src/agents/codex/binary.ts、peer.ts、protocol.ts | 入口解析、目标版本协议生成子集、NDJSON 请求/响应/通知、原生请求 id |
| src/agents/codex/discover.ts、map.ts | 只读分页、原生事件映射，不在 observe 中 resume |
| src/agents/codex/session.ts、adapter.ts | 已取得写权后的原生 resume/turn 操作，activeTurnId |
| src/agents/codex/approvals.ts | 单次决定映射；公共输入策略为必需依赖 |
| src/agents/claude/runtime.ts、discover.ts | SDK 真实类型、会话只读发现与历史 |
| src/agents/claude/session.ts、adapter.ts、map.ts | Query 生命周期、流映射、运行态与控制证据 |
| src/agents/claude/permissions.ts | canUseTool/AskUserQuestion 的保守映射，不返回权限更新 |
| src/tunables/policy.ts、catalog.ts、readback.ts | field 分支、版本/模型语义、current/pending/revision |
| src/hub/buffer.ts | 允许事件白名单、TTL/字节预算、游标回放，不保存交互正文 |

PendingInputs、CommandJournal、privacy 和 sync 复用 v0；不要为每种 agent 再造一套期限、去重和认证逻辑。

## 2. AgentAdapter 边界

接口应分离以下操作，而非让一个 execute 隐式完成所有事：

| 类别 | 必须满足 |
|---|---|
| probe/start/stop/health | 精确版本和逐功能结果；启动失败隔离，stop 后不再重启 |
| list/history/observe | 只读；AbortSignal 可取消；无 acquire/resume 副作用 |
| acquire/release/ownership | 持续排他证据及 runtimeEpoch；unknown 不升级为 ours |
| prompt/steer/interrupt | 当前写者、idle/activeTurnId、操作幂等上下文；无隐式队列 |
| configure/readSettings | 真实回读与版本关联；请求值独立存储 |
| handleNativeInput | 两项中继策略、完整输入 schema、允许决定集合与原始到期 |
| frame | node 提供统一 epoch/seq；所有源端输出经过同一投影管道 |

能力是实际观测结果，不是方法名存在就设置 editable=true。方法缺失只关闭该能力；根本无法安全观察时 agent unavailable。隔离扫描用逐 adapter 结果汇总，不能 Promise.all 的一个异常使全部设备看板空白。

## 3. 子进程监督与重启

Codex 每 node 一个受管 app-server；Claude 每个受管活跃会话一个 Query。只读发现可以按需启动协议服务进程，但不能加载会话为可写、启动推理 Query 或取得控制；这些动作必须来自显式控制请求。

监督器和 peer 必须统一 generation：退出时拒绝旧 RPC pending、取消原生待答、撤销写权、使旧 follower 结束，并标记受影响命令 unknown。随后新进程建立新 peer，重新 initialize/initialized、探测、只读同步；不能把旧 peer 的 resumed 缓存留给新进程。

退避为 1/2/4/8/16/30 秒封顶，60 秒最多 5 次，进入 failed 后等待显式恢复或 5 分钟重试。认证/配置错误不循环重启。正常 stop 和插件卸载先禁用重启，再释放进程、timer、listener、队列和等待者。Windows/macOS/Linux 分别验证退出和进程树清理。

stderr 仅保留受限内存诊断，不向 hub 发原文，不写内容日志。空闲 10 分钟可回收 Claude Query，但仅在无活跃回合、无待答、无 pending 设置/命令时执行；不能按最后输入时间杀掉仍在工作的任务。

## 4. Codex 协议适配

### 4.1 版本证据

启动参数、初始化字段、方法、通知和响应形状从目标二进制的生成 schema/真实样本核验。可使用官方 app-server 文档作为导航，不将文档方法名或本机不同版本当作目标版本证明。

候选流程：app-server stdio → initialize → initialized → 只读探测。experimentalApi 仅在已确认需要且支持时开启；model/list 成功不证明 goal、settings 或提问可用。入站 NDJSON 按累积未完成行长度限制（8 MiB），不能等换行后才检查。

### 4.2 发现与控制

只读候选：thread/list、thread/read、thread/turns/list、thread/items/list。分页到完整范围后才完成快照；不能把第一页 50 条当作全部清单。不同历史格式支持情况分别记录；不直接依赖 state_*.sqlite 内部表结构。

thread/status、canAcceptDirectInput 或 thread/resume 成功都不是跨进程锁。取得可验证控制权后，session 端口才调用 thread/resume，确认后保存原生真实设置。prompt 使用 turn/start；interrupt/steer 使用真实 activeTurnId/expectedTurnId。外部 unknown 会话不进入此路径。

### 4.3 通知与交互

turn、item、delta、tool result 和 settings 通知按真实 fixture 映射；保留 item/turn ID、防重复完成事件、正确 UTF-8 字节计数。未识别通知计数但不外发 raw payload。

原生服务端请求用 JSON-RPC request id 回应，itemId 仅作关联。command/file-change 审批取原生可用集合与单次白名单交集；permissions 请求空授权；elicitation 保守拒绝；requestUserInput 按 question 策略处理。未知请求及时返回支持的错误/拒绝，不能静默挂起。

serverRequest/resolved、进程退出、所有权失效均作废对应待答。卡片生成和 settle 都经过公共策略；off 时没有审批正文出站，不能仅在 Claude 上实现开关。远端卡片需源端 relay=remote 且 hub 设备记录 `allowInteractions=true`，并取 min(approvalTimeoutMs, 原生 expiresAt) 作为等待上限；外部 unknown 会话不建立可答卡。

## 5. Claude SDK 适配

使用真实 SDK 类型及查询/历史 API。query 的创建是控制动作，不是 observe；已有索引而没有本地 Query 时为 foreign-unknown。对外部 TUI 不宣称可以附着。

受管 Query 使用经验证的流式输入模型。状态由原生 turn/result/system 事件驱动；普通 prompt 只在 idle 接受。未证明运行中输入属于 steer 而非下一回合排队时，steer 能力关闭。映射工具结果时保留真实输出或按隐私计数，不只给出 elapsedMs 就宣称完整工具输出。

canUseTool 区分普通 AskUserQuestion、plan-review 与其他工具审批。两项 relay 参数必传；off/notify 且无本地处理通道时返回经过验证的 deny/无答案。允许一次只返回必要原输入，禁止 updatedPermissions，忽略 suggestions 作为授权来源。未知工具输入 schema 不做“尽量 allow”。

setModel/setPermissionMode 等 void setter 不提供真实值；不能先改 session.settings 再等待 init。V1-T00 必须确定目标版本可用的有效设置读取渠道。需要重建 Query 的 effort 变更只发生在 idle 且具有完整确认屏障；无法安全确认则关闭编辑能力。

## 6. 所有权与命令上下文

acquire、prompt 和 configure 复用每会话状态机；抢占、队列和自动 fork 都禁止。可靠证据包含机制类型、持有者、runtimeEpoch、取得/失效条件；仅记录一个 boolean owned 不够。

节点 journal 记录公共命令生命周期；原生适配器不得因 transport timeout 自行重发 turn/start 或 query 输入。可选原生幂等能力只有在真实版本测试后才能用于恢复。重启恢复清单不等于恢复控制权，更不等于恢复原命令执行。

create/fork 若开放，必须显式操作、授权 cwd、捕获实际新 ID、建立其控制边界；默认不实现，未验证时 capability 关闭。

## 7. 设置端口

设置组件保存 confirmed snapshot、revision、pending request，不保存一个兼作请求和回读的 settings 对象。

流程：校验 expectedRevision/idle/写权 → field 策略与组合权限检查 → 注册回读观察 → 调用原生 setter → 关联实际响应/通知/get → 发布实际能力 → ACK confirmed/mismatch/pending。

一次 session 同时只允许一个设置请求。读不到 current 时不比较“收紧”；目录数组顺序仅用于显示，权限组合和 effort 等级各自显式定义。相同已确认值 no-op；unknown 值拒绝；plan/model 引起的间接权限变化同样检查。

10 秒超时移除请求等待资源但保留 pending 状态和长期状态观察。迟到通知能更新实际值，不得错误完成另一个设置请求。原生实际结果不同也必须发布，不做回滚。goal 读取实际 set/get/clear 返回，不从请求文本构造。

## 8. 历史、待答和浏览器

EventBuffer 只接受缓存白名单，并同时维护全局/会话条数与字节计数。过期队列按接收时间维护，append/read/size/周期清理都先 evict；避免每条事件全局 indexOf/splice 的平方级淘汰成本。淘汰后所有辅助索引也释放引用。

PendingInputs 保留在 node；hub 的输入路由只转发 owner 的按会话只读快照查询，不入历史。待答查询与 SSE 订阅有屏障，返回原始 expiresAt/runtimeEpoch；回答时再次校验，不能仅凭快照可答。

SSE 回放使用 hubEpoch + cursor；复用 v0 reset/sync。浏览器处理 snapshot、reset 和增量时按复合键去重；不因历史回放生成可批准旧卡。慢客户端有字节预算，断开后明确重取快照。

## 9. 安全与错误映射

沿用公共契约全部身份/期限/日志规则。requestId 不能只用 itemId 加本地计数器：跨设备/重启会冲突，使用随机 UUID 和完整复合键。

原生错误必须映射到受限 code；不把任意 Error.message 交给 ACK。不能以字符串包含 active/running 就确定 writer-busy：只有验证过的结构化错误能证明占用，否则返回 resume-failed/ownership-unverified，仍保持只读。

审批与设置不写 agent 全局配置。日志、待答、journal、历史缓冲分别管理；只记无内容审计不能替代拒绝持久权限更新。

## 10. 验证来源与 ADR

参考导航（实施时仍须固定目标版本并取证）：

- [Codex App Server](https://developers.openai.com/codex/app-server)：线程、事件、协议与生成 schema 入口。
- [Claude TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript)：Query、权限结果及 PermissionUpdateDestination。
- [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions)：恢复/分叉的历史语义，不作为跨进程排他保证。

决策：保留官方接口而非直接解析内部数据库；先完成 Codex 再接 Claude，复用同一 runner/策略；删除持续授权；能力基于实证逐项开放；计划用任务与验证契约取代大段自造协议实现。全部 P1 的实施/验收映射见验收矩阵。
