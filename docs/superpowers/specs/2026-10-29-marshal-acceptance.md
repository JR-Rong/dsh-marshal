# dsh-marshal P1 与发布验收矩阵

日期：2026-10-29
状态：基于 feat/v0 的源码复核与目标验收设计；本轮未重跑运行测试。
规范：[公共契约](2026-10-29-marshal-contract.md)
计划：[v0 增量](../plans/2026-10-29-marshal-v0-p1.md)、[v1](../plans/2026-10-29-marshal-v1.md)

## 0. 评审基线与已有证据

基线：`feat/v0@702ef24308db10b3381ffcaff0f2746582842433`。该分支已有 v0 源码、构建配置、测试及接缝报告；v1 适配器尚未实现。本轮在 PR head `8c0062a` 上继续复核，`7390293` 为上一轮提交且其修订保留。下面的“已有”来自本轮源码/测试文件核对，不等于本轮执行 PASS。旧设计草稿的问题不能直接套为当前代码缺陷。

| P1 | 当前状态与证据 | 后续处理 |
|---|---|---|
| P1-01 ACK | **原装配缺口已修复**。[index](../../../src/index.ts) 的 onFrame 将 ack 送入 relay.settle；[e2e](../../../tests/e2e.spec.ts) 已覆盖正式 apply→HTTP→WS→node→ACK 和一次 prompt 调用（DSH 为替身） | 保留回归；扩展非法/丢失 ACK、受理与回合完成区分，不能再按“只有 event 分支”派工 |
| P1-02 幂等/期限 | **部分已有，仍有缺口**。[relay](../../../src/hub/relay.ts) 有 in-flight，[测试](../../../tests/relay.spec.ts) 有同键并发；[runner](../../../src/node/runner.ts) 已检查 deadline。现有去重域为 device/op/key，缺 session/payload 冲突校验；无 node 持久 journal | 扩展完整幂等域、node 持久状态和 outcome-unknown 查询；保留当前检查 |
| P1-03 策略 | **v1 设计风险**，当前没有 Codex/Claude adapter。[index](../../../src/index.ts) 仅在 DSH questionRelay=remote 时安装提问中继；approvalRelay 当前未接通审批 | v1 构造与执行必须统一强制策略；v0 补普通问题策略/待答恢复验收，不称已存在 Codex 默认审批漏洞 |
| P1-04 持续授权 | **v1 设计风险**，当前没有对应 SDK 权限更新实现 | 目标仅允许单次决定，排除持久权限更新；用 C04 验证 |
| P1-05 身份 | **事件绑定已修复，ACK/代次待补**。[server](../../../src/hub/server.ts) 校验 event.device/agent，detachIf 保护新连接；[测试](../../../tests/hub-server.spec.ts) 覆盖冒充与旧 close。relay.settle 仍仅按 ack.id 完成 pending | 所有帧检查当前连接，ACK 绑定认证设备与命令连接；事件/旧 close 作为回归保留 |
| P1-06 所有权 | **v1 设计风险及 DSH 待补证**。当前 marshal resume 仅在 [runner](../../../src/node/runner.ts) 启动 follow；[DSH surface](../../../src/adapters/dsh/surface.ts) 的 prompt 固定 mode=steer、cancel 仅带 sessionId，adapter 只查会话存在，没有忙时拒绝或回合绑定 | wire v2 重命名 observe；v1 的 acquire 单独验证排他证据；v0 普通 prompt 的原子 idle 受理、interrupt 回合比较及请求作答权分别补证/降级 |
| P1-07 收紧方向 | **v1 设计风险**。[DSH adapter](../../../src/adapters/dsh/adapter.ts) 七项设置均 editable=false，当前没有可执行的 reasoning setter | 按 field/模型版本定义策略，未知保持只读 |
| P1-08 真实回读 | **v1 设计风险**，当前 v0 设置不可编辑 | current/pending 分开，真实回读关联后才确认；无法回读保持只读 |
| P1-09 隐私/缓存 | **v0 隐私仍有缺口；历史缓存为 v1 设计风险**。[redact](../../../src/node/redact.ts) 已覆盖键名与超深对象，但默认规则为空，metadata 仅裁剪部分事件；[runner](../../../src/node/runner.ts) ACK 可含 raw Error.message。当前无 v1 EventBuffer | 补全通道投影；交互不入历史/离线正文队列与主动 TTL 清理由增量及 v1 任务验收 |
| P1-10 恢复 | **每次重连 snapshot 已接入，原子性待补**。[index](../../../src/index.ts) 的 onOnline→sendSnapshot 与 onAttach→clearDevice 已存在；[link 测试](../../../tests/node-link.spec.ts) 覆盖 hello ACK 前缓冲。当前是先清索引再逐条更新；surface 只读一次 list({})，无分页遍历/周期发现；map 忽略 snapshot，turn 事件不更新 relay 索引；无完整快照提交/epoch/待答重取 | 在已有重连路径上增加完整分页、持续状态归并、sync.ack、stale、公开序列游标及有效待答快照；不再宣称仅启动时 snapshot |

[DSH 接缝报告](../spikes/2026-10-29-dsh-seams.md) 已记录 DSH `f3803c9697` / 0.2.2-alpha.2、Node 24.22.2、ws 8.21.3：Upgrade Duplex 最小握手、follow 无 Remote 上下文、路由无冲突三项 OK。保留其源码与最小实验范围，不能扩大为真实宿主生命周期、writer-held 并发或两台真机验收。

下列 C/B/M 用例是 P1 **目标契约**的验收，包括已有行为的回归及新增要求。新增用例在本轮均 NOT RUN；历史测试结果如需引用须附原报告，不因文件存在就填写 PASS。当前安装配置见 README；目标 wire v2 不回写成当前 v1 能力。

## 1. 执行与证据规则

每条用例记录：用例 ID、实现 commit、精确 DSH/Codex/Claude SDK/CLI/Node 版本、OS、配置摘要、执行命令、预期/实际、PASS/FAIL/BLOCKED、脱敏证据路径。测试材料只用合成数据，不使用真实凭据或工作会话。

三层证据分开记录：

- U：纯逻辑/状态机，假时钟与合成输入；验证边界与竞争，不能证明原生协议成立。
- I：实际 HTTP + WebSocket/SSE + node runner + 适配器，原生 runtime 可由已录制契约样本替代；不得绕过装配直接调用 settle 冒充端到端成功。
- R：两台目标机器与真实指定版本 agent；覆盖权限、进程、恢复语义。需要付费推理或部署时在届时任务中按授权执行。

“模拟测试通过”不能改写为“真实 agent 通过”。无法取得跨进程锁/实际回读证据时，正确结果是对应能力只读且验证降级；若产品仍宣称该能力可写，发布结论必须 BLOCKED。所有异步测试都要检查调用次数、最终状态和资源释放，不能仅断言有事件或返回 200。

## 2. P1 闭环索引

| P1 | 问题与必须改变的行为 | 契约章节 | 实施任务 | 用例组 |
|---|---|---|---|---|
| P1-01 | ACK 完整回到发起者，受理与完成分开 | §6 | V0-T03、V0-T09 | C01 |
| P1-02 | in-flight 合并、node 去重、过期零执行、未知不重放 | §5–6 | V0-T03 | C02 |
| P1-03 | 策略、请求作答权、绝对期限与 abort 原子结算 | §8 | V0-T07、V1-T05 | C03 |
| P1-04 | 去除持续授权，绝不写全局权限 | §8 | V1-T05 | C04 |
| P1-05 | 设备身份与连接代次绑定每帧及 ACK | §4 | V0-T02 | C05 |
| P1-06 | 未知写权只读，查看与取得控制分离 | §7 | V0-T05、V1-T02 | C06 |
| P1-07 | permission/reasoning 分支与方向正确 | §9 | V1-T06 | C07 |
| P1-08 | 请求值与确认值分离，超时/不一致不伪装成功 | §9 | V1-T07 | C08 |
| P1-09 | 内容白名单、交互不入历史、静默到期清理 | §10 | V0-T04、V0-T07、V1-T08 | C09 |
| P1-10 | 每次重连全量同步、游标回放、待答恢复 | §11 | V0-T05、V0-T06、V0-T07、V0-T08、V1-T01、V1-T08 | C10 |

## 3. P1 用例

### C01：命令回执

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C01-01 | I/R | 浏览器提交 prompt，经实际 hub 路由、WSS 和 runner 返回成功 ACK | runtime 调用恰好一次；HTTP 在 TTL 内返回 accepted；回合尚未结束时不显示 completed |
| C01-02 | I | runtime 拒绝；另测 runtime 异常与非法 ACK | 正确分类返回发起请求；非法 ACK 不完成 pending；pending/timer 无泄漏 |
| C01-03 | I | agent 已受理后丢 ACK，再断开连接 | 页面显示 outcome-unknown；零自动重发；只读查询可恢复已记录状态 |
| C01-04 | I | 回合最终失败或被打断，先前 ACK 已成功 | 最终状态依据 turn 事件；不得把 accepted 永久当作任务成功 |

### C02：幂等与期限

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C02-01 | U/I | 100 个相同键和载荷并发，首次 ACK 延迟 | hub 只下发一次，node 只调用一次，所有等待者取得一致结果 |
| C02-02 | U/I | 同键不同 op/args；不同 target 或 operator 使用相同键；同 owner 重新登录/轮换 token；提交后刷新或重开标签页 | 同域不同载荷返回 idempotency-conflict；不同域不相互误命中；同 owner 的 operatorId 稳定，已执行键不因重新登录变成新请求；未决/未知键在重载后仍复用，不隐式换键重发 |
| C02-03 | U/I | 命令到达已过期；等待会话互斥期间过期；原 epoch 命令重连后到达 | agent 调用次数为零；分别返回 expired/stale；没有“迟到执行” |
| C02-04 | I | 分别在落 admitted 前、落 admitted 后调用前、调用后落结果前杀 node | admitted 前无调用，旧 epoch 请求拒绝且 UI 不重放；admitted 后未决记录为 outcome-unknown，同键不得重新调用；未决状态不推断副作用已发生或未发生 |
| C02-05 | U/I | 超过去重容量；未决项长时间保留；终态超过 24h | 未决项不被驱逐，容量满拒绝新写；终态仅按保留策略回收；UI 不承诺无限期 exactly-once |
| C02-06 | U/I | 时钟跳变、偏差/不确定度超过 5s | 期限不被延长；无法可靠校验时 clock-skew，零调用；修复时间后可重新同步 |
| C02-07 | I | 发命令后关闭标签页/浏览器、重新登录、多标签页打开；禁用存储/写失败/清空记录 | key 元数据跨重启恢复，先查状态且零自动重发；无 prompt/答案/token 落盘；存储写失败零下发，记录丢失提示人工核对 |
| C02-08 | U/I | 已初始化的 journal、HMAC 密钥或 operatorId 文件缺失/损坏；恢复旧备份 | recovery-required 且零新 agent 调用，不生成新身份/空 journal 绕开旧键；恢复按版本/完整性对账，正常重启保持原域 |

### C03：中继策略

矩阵覆盖 DSH、Codex、Claude 各自已支持的 question/approval；DSH 审批在 v0/v1 应始终报告 unsupported。同一套测试分别驱动直接构造和真实 node 装配，防止构造参数遗漏。远端卡片需 node relay=remote 与 hub `allowInteractions=true` 同时成立；四种组合都要验证，任一缺失不得发正文或注册可答卡。

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C03-01 | U/I/R | 默认配置及显式 off，触发原生请求并伪造远端 answer/decide | 不发正文或可答卡；远端决定返回 disabled；headless 无本地通道时安全结算，不挂死 |
| C03-02 | U/I/R | notify，包含命令、路径和敏感问题 | 仅等待类别；无正文/选项/可答按钮；远端决定仍拒绝 |
| C03-03 | U/I/R | remote，合法决定与无人作答分别执行 | 单次允许回到原请求；审批超时仅拒绝；DSH 普通问题按真实 waterfall 回本地 |
| C03-04 | I/R | 待答中在源端改 off；同请求随后 answer/decide | 原请求按保守路径结束；卡作废；恢复查询不再返回；迟到决定无效 |
| C03-05 | U/I | approval=off、question=remote，触发 plan-review/ExitPlanMode | 不得以普通提问获得执行授权；decision 通道按审批策略拒绝 |
| C03-06 | U/I | node relay=remote 但 hub allowInteractions=false；反向组合；原生 expiresAt 早于按本地 timeout 计算的截止时刻，或缺失原生期限 | 两种单侧授权均按 off 处理，零正文出站；等待在 min(createdAt+timeoutMs, nativeExpiresAt) 结束，超时审批拒绝、问题按已验证无答案路径结算 |
| C03-07 | U/I | 远端问题卡显式 cancel；审批卡显式 cancel；随后本地 TUI 再回答 | cancel 走已验证的拒绝/无答案路径，不提交空答案；卡作废且不复活；本地不出现重复 answer；审计只记操作与分类 |
| C03-08 | I/R | 本地 TUI 发起 DSH 普通问题，marshal 未取得会话写权但持有合法 waterfall；对比仅观察外部等待状态 | 双授权下前者可 answer/cancel 且只结算该请求；不取得 prompt/interrupt 权限。后者无请求作答权不可建卡；原生 abort 后不可答 |
| C03-09 | U/I | 假时钟从真实量级 UTC 毫秒开始，原生截止早于/晚于配置时长或缺失；源端与 node 时钟偏差接近/超过 5s；阻塞 timer 后提交；abort 与回答竞争 | expiresAt=min(createdAt+timeoutMs,nativeExpiresAt)，缺原生期限用本地期限；偏差不可信时取较早截止并提前回本地；到期/abort 后回答入口零回写，终态仅一次；next() 不误报本地已答 |

### C04：单次授权边界

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C04-01 | U/I | Codex 可用决定混合字符串和对象；伪造 acceptForSession/amendment | 只呈现已验证单次决定交集；隐藏值服务端也拒绝；对象不会导致请求永久等待 |
| C04-02 | U/I/R | Claude suggestions 包含 userSettings/projectSettings/session、setMode 或 addDirectories | allow 一次的返回值没有 updatedPermissions；权限范围和配置文件内容均不变化 |
| C04-03 | I/R | 同一动作连续两次需要批准 | 第一次允许不免除第二次审批；agent 原有本地规则另行记录，不误归因 marshal |
| C04-04 | U/I | 多浏览器同时决定，先非法后合法，过期/旧 runtimeEpoch 再答 | 只有一个合法决定进入原生回写；非法答案不永久抢占；无效代次零副作用 |

### C05：身份与连接

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C05-01 | I | A 的 token 发送 deviceId=B 的 session/input 事件 | B 索引、卡片、能力均不变；连接按策略拒绝，日志不含帧正文 |
| C05-02 | I | A 伪造发给 B 的 commandId ACK；旧连接发送正确 commandId ACK | 两者均无法完成 B/新连接 pending；只接受匹配认证身份与代次 |
| C05-03 | I | 同设备新连接替换旧连接后，旧连接触发 close | 新连接仍在线；只有当前连接可更新状态/收命令 |
| C05-04 | I | 撤销 token、未 hello 连接、错误 wire/契约修订、方向错误的帧 | 撤销在 5s 内关闭连接且不无限重连；握手有界；不泄露 token；无写入；分别返回 4401/4406/4400 等约定 close code，不以字符串推断 |
| C05-05 | I | 保持 SSE 打开时 logout、轮换 dashboardToken、绝对/空闲会话到期；logout 后复用旧 CSRF；页面重载 | 新 API 请求拒绝；旧 SSE ≤5s 关闭，不再收内容；心跳不续空闲期；登录响应提供 operatorId/CSRF，重载后可重读 CSRF，logout 后旧 CSRF 与 cookie 均不可复用；重新登录仍是同 operatorId |
| C05-06 | I | content/remote 正在传输时 hub 收紧授权，断连前后注入旧帧；非法设备表 reload | hub 先停止转发，node 断连撤销协商授权；重连新 policyRevision 前 metadata/off；旧帧/ACK 正文/卡不补发；非法 reload 不部分应用或继续允许写入 |

### C06：写权与观察

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C06-01 | U/I/R | 列表、查看历史、点击会话、刷新、SSE 重连 | 原生 thread/resume、thread/start、推理 Query 调用均为零；只读协议服务可启动，但订阅不更改写权 |
| C06-02 | R | 本地 TUI 正在同一会话运行；marshal 尚无 Query；再显式 acquire | 返回 writer-busy 或 ownership-unverified，不能因没有本地 Query 就声明 idle/ours |
| C06-03 | I/R | 两客户端同时 acquire/prompt；第一个获取过程延迟 | 只有一个获得有效控制；第二个立即 busy；不存在延迟执行队列 |
| C06-04 | R | 运行中失去上游写权/锁或 agent 崩溃，随后重启 | 原 runtimeEpoch 立即失效；旧批准/interrupt 不影响新回合；未验证重新获取前只读 |
| C06-05 | R | 无跨进程排他机制的目标版本，包含 resume 返回成功的情况 | 对外部会话可写能力保持关闭，明确记录支持边界；不得将本用例标为“接管成功” |
| C06-06 | I/R | DSH 已运行时远端普通 prompt；并发本地/远端从 idle 受理 | busy 时零原生输入注入、无 steer/排队；两方仅一方原子取得写入；不能用 list 预检查代替原生保证，能力不支持则关闭 |
| C06-07 | I/R | 回合 A 的 interrupt 延迟到 B 已运行；检查后立刻发生换回合 | B 不被取消；runtime/activeTurnId 由原生原子比较；只有 sessionId cancel 时目标 interrupt 关闭，不能报告此用例通过控制能力验收 |

### C07：设置收紧

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C07-01 | U/I | Codex、Claude 分别 high→medium/low、medium→low、low→medium/high、medium→high | 有真实等级定义时下调允许、任何上调拒绝；不会进入 permission 转移表 |
| C07-02 | U | 打乱目录显示顺序；未知 effort、缺目录、相同值 | 顺序不影响语义；未知值 fail closed；已确认同值 no-op 且零原生 setter 调用 |
| C07-03 | U/I/R | permission 收紧；关 plan；切模型使默认 effort/权限改变 | 比较完整最终状态；任何间接放宽拒绝；已有规则/网络/目录不被无意扩大 |
| C07-04 | I | 运行中 configure、revision 不匹配、两个配置同时到达 | busy/conflict，零隐式排队；不会关闭正在执行的 Claude Query |

### C08：实际回读

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C08-01 | U/I/R | setter 返回 void，10s 内无实际值 | 旧 current 保持；请求仅在 pending；显示未确认；不能回显请求为已生效 |
| C08-02 | U/I | 请求 m2，上游实际回 m3；goal set/get/clear 返回规范化或不同对象 | 广播上游实际值；返回 readback-mismatch；goal 不由请求 objective 拼装；不自动回滚 |
| C08-03 | I | 通知先于 RPC 响应；确认迟到；旧 revision 确认晚于新值 | 不丢确认；过时确认不覆盖新值；晚到结果可查询且不会触发第二次设置 |
| C08-04 | R | 目标 SDK 无 getter/重复 init；下一回合才有确认 | 没有可靠生效前回读时字段只读；若支持延迟确认则明确证明确认屏障，不以目录或缓存替代 |

### C09：隐私与缓冲

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C09-01 | U/I | metadata 输入正文、cwd、标题、goal/current/pending、深层对象、原生错误及 ACK result 中的合成秘密 | 出站所有通道只含允许元数据；内容型设置不能借能力快照泄露；未知字段/超深对象不原样保留；日志/审计无秘密 |
| C09-02 | U/I | 本地 content 与 hub allowContent 四种组合及重连前状态 | 仅双方允许时有内容；收紧清除相关队列/历史/缓存；不回放旧 content |
| C09-03 | U/I | input.requested/resolved、secret、答案经过 publish；随后查历史 | 历史条数与字节均不包含这些事件；不落正文磁盘；待答仅从有效源端表获取 |
| C09-04 | U/I | 放入事件，停止一切写入，时间超过保留窗 | read/size/定时清理均不再暴露过期内容；不需要 append 才回收 |
| C09-05 | U/I | 中文/多字节卡片超过 4096 字节，危险后缀被截断；脱敏使动作不完整 | 按字节限制；保留可解释拒绝状态；禁止批准不完整动作 |
| C09-06 | I | 大量会话、大帧、慢 SSE 客户端、离线队列满、同步暂存超预算 | 各条数/字节预算不超限；背压有界；丢失明确提示；ACK 不被事件淘汰；暂存超限放弃并标 stale，不半覆盖 |
| C09-07 | U/I | 中文/emoji 大文本跨越分片边界、分片丢失或乱序、重组后再渲染 | 只在完整 UTF-8 边界分片；重组后字节与原文一致；缺片不显示伪完整文本；seq 按会话键去重 |
| C09-08 | U/I/R | DSH 选项只有 label，显示文本脱敏；原始 label 重复/脱敏后歧义；伪造 option ID | ID 映射回正确原始选项；ID 不依赖显示文本；语义不清整卡不可远答并回本地/无答案；无效答案不抢占请求 |

### C10：重连与状态恢复

| ID | 层 | 操作/故障注入 | 通过条件 |
|---|---|---|---|
| C10-01 | I/R | 仅重启 hub，node 保持运行且所有会话空闲；人为拉长拨号间隔 | 网络恢复后 30s 内完整重建清单/能力；拨号退避封顶 10s 且带 jitter，不因 30s 封顶挤占同步预算；没有任何 prompt 重放 |
| C10-02 | I/R | node 断网 30s，期间新增/删除会话、结束回合、改变能力；队列故意淘汰 | 重连后 30s 内以全量快照对齐，旧项删除；内容缺口明确；同步完成前禁止写 |
| C10-03 | U/I | 快照缺片、乱序、重复、扫描中产生事件、agent 清单为空、暂存超过单设备/hub 预算 | 仅完整一致快照原子替换；无丢失窗口；失败保留 stale 状态，不出现半快照；超预算放弃暂存并释放内存 |
| C10-04 | I | node 重启 seq 从低值重新开始；旧 epoch 事件迟到；两个会话在同一 nodeEpoch 下出现相同 seq | 新 epoch 正确重建；旧事件不能覆盖新值；不拿跨 epoch seq 比大小；去重键包含 device/agent/session，跨会话同 seq 不互相吞掉 |
| C10-05 | I/R | 普通问题（v0/v1）或审批（v1）产生时页面关闭；到期前打开、刷新或换浏览器 | 从源端恢复仍有效的卡并可答；已解决/过期卡不复活；离线明确不可答 |
| C10-06 | I | SSE 在回放/订阅边界断开；Last-Event-ID 过旧或 hubEpoch 变化 | 游标去重无窗口；必要时 reset-required 并重取状态/待答；不伪装完整内容历史 |
| C10-07 | I | sync.end 已发但 hub 未提交；提交后 sync.ack 丢失/迟到/属于旧连接；期间提交写请求 | node 只认当前 sync.ack；双侧在屏障完成前拒绝写；超时重同步不重放命令，旧确认不能放开写入 |
| C10-08 | I/R | 多页清单、非第一页会话执行/提问；原生 list 无分页参数或只返回首屏；不断线时新增/删除/开始/结束回合；状态 patch 省略 running，旧 turn.end 迟到 | 所有页可见且可正确定位；原生无分页时须有显式全量/计数证据，否则报告完整性不可确认，不把首屏当全量；无增量时 10s 扫描，≤30s 反映变化；扫描超时 stale/禁写；省略字段不重置，旧终态不将新回合置闲 |
| C10-09 | U/I | 隐私过滤丢弃整条事件、未知 kind、队列在编号后丢事件、策略收紧后重同步 | 投影后分配 seq，正常过滤无假缺口；未知 kind 不呈现但推进游标；真实丢失触发同步，快照高水位与公开序列一致，无恢复循环 |

## 4. 基础功能与非功能验收

| ID | 层 | 场景 | 通过条件 |
|---|---|---|---|
| B01 | U/I | 配置、设备表与认证 | 缺必填项、未知键、错误枚举、负数/非有限上限、非法正则均启动失败且只打印键名；deviceId 与 deviceName 分离；设备表损坏/重复 ID/重复 token 摘要启动失败而非静默丢弃；设备表变更后 5s 内完成撤销或授权生效；URL token 拒绝；低熵 dashboardToken 拒绝；登录失败限速生效；浏览器登录、CSRF、SSE 授权生效 |
| B02 | I/R | DSH 普通问题 | remote 独占期间本地不出现；超时真实 next() 后本地可答；off 不改变本地行为；认领顺序有证据 |
| B03 | I/R | 交互卡保真与渲染安全 | 单选、多选、自由文本按 ID 提交；重复点击不重复计数；secret 无答案外泄；错误显示与实际终态一致；含 `<script>`/HTML 的问题、选项、消息按纯文本显示，不执行脚本也不注入属性 |
| B04 | I/R | 原生事件与历史 | 输出和工具顺序来自真实流，无假增量；历史读取分页；外部活跃会话不宣称有未实现的实时流 |
| B05 | I/R | 子进程隔离 | 杀 Codex 不影响 Claude/DSH；重新握手探测后再上线；旧请求全部结束或 unknown，timer/listener 不增长 |
| B06 | I/R | 可选 create/fork/steer | 显式触发、实际新会话 ID、cwd 白名单与 activeTurnId 均验证；未验证能力没有按钮且服务端拒绝 |
| B07 | I/R | 延迟与规模 | 在记录硬件/帧率的条件下，100 会话分页清单 1s 内返回；LAN 事件 p95≤500ms、公网测试 p95≤2s；50 node 用 I 层合成负载检验硬预算，不声称等于真实 50 机验收 |
| B08 | U/I | 审计与持久化 | 去重记录原子落盘、失败拒绝写；审计仅枚举/标识，不含内容；目录权限受限；崩溃恢复不重复调用 |
| B09 | I/R | hub 本机管理 | 未显式配置不管理本机；启用后仍经过相同身份、策略、去重、投影和同步路径 |

## 5. 兼容迁移验收

关联公共契约 §1.1 与 V0-T01/T02/T08/T10。只在合成配置、设备表副本和测试会话上先验证，所有输出使用合成 token。

| ID | 层 | 场景 | 通过条件 |
|---|---|---|---|
| M01 | U/I | 现有 deviceName 与设备表转换到稳定 deviceId/摘要表，修改显示名；轮换短 dashboardToken | 身份和授权映射保持；原表保留；新表权限受限；token 不进入日志；相同转换不制造重复设备；旧二进制维护窗口可用旧登录；新二进制启动前完成轮换，不能临时放宽新校验；旧 cookie/SSE 失效 |
| M02 | I | v1 node→v2 hub、v2 node→v1 hub、未知修订 | 明确不兼容、零 agent 调用、无静默协议降级；v2 节点遇协议错误停止；旧 v1 节点不识别新 close code 时由迁移步骤停止，不宣称旧代码有新退避行为 |
| M03 | I/R | 有 in-flight 时升级，分别在发送前/执行后丢 ACK；随后回滚 | 停止新写，已知结果保留，不明项为 unknown；新 journal 保留；旧版不能读取 journal，回滚前关闭写入口并对账当前撤销/轮换记录；未知旧命令或授权约束未消除前不重开写入，旧 token 不复活 |
| M04 | I/R | 同版本升级后验证登录、观察、问题与命令；恢复旧版配套配置 | v2 的 observe 保持只读；cookie/CSRF 与新 wire 闭环成立；旧版用法可按保留文件恢复；README 明确版本边界 |

## 6. 发布门槛

v0 后续加固目标（不是对现有分支的已通过声明）：M01–M04 及 C01、C02、C05、C09 的通用部分、C10、DSH 的 C03/C06、B01–B04/B07–B09 通过；v1 专属能力标 N/A 并说明范围，不伪造通过。v0 不提供历史 EventBuffer，C09 的历史缓存实现检查留 v1，但不缓存交互的约束从 v0 就成立。v0 仍要求源端历史读取（B04）；它与 hub EventBuffer 补看是两项能力，原生接口不可用须明确报告未交付。

适用性逐项记录：DSH 不执行 v1 acquire，但必须跑 C06-06/07 和 C03-08/09；C04-04 的普通问题首答竞争及 C10-05 的普通问题恢复属于 v0 必测，不能随“审批留 v1”一起跳过。C02-07/08、C05-05/06、C09-08、C10-07 至 C10-09 为通用门槛。关闭可选能力可以通过拒绝路径测试，但 v0 必需的 prompt/普通问题/完整清单不能全部降级后仍声称完整交付。

v1：全部 P1 用例通过或按能力明确降级；Codex/Claude 各至少有一条已验证控制边界内的 prompt→流→审批/问题→结算链路；其余能力按精确版本逐项开关。所有 v0 回归继续通过。计划不得用预写的“Expected: N passed”当作已执行证据。

P1 设计闭环的完成条件：规范有明确规则、架构有责任模块、计划有对应任务、矩阵有可执行判据。P1 实现关闭的完成条件另外要求实现与 U/I/R 证据；本次文档修订只达到前者。

## 7. 报告模板

每次验收报告包含：环境版本表、配置摘要、用例结果表、失败复现、能力降级清单、资源/延迟测量、遗留风险和最终 PASS/PARTIAL/BLOCKED。建议保存到 `docs/superpowers/spikes/`，目录及报告在执行相应任务时才创建。

本轮状态：仅做源码/文档静态复核，未运行 U/I/R 测试；新增目标用例 NOT RUN。已有 DSH 接缝证据见 §0；尚待补齐写者并发、目标机链路、跨进程排他及新 agent 的回读证据。
