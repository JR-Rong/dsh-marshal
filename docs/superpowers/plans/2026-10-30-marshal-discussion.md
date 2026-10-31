# dsh-marshal 讨论组 D1 实施计划

日期：2026-10-30
状态：待执行，仅完善设计；本轮不创建实现代码、不安装参考插件
规模：中大型，先验证隔离与复用，再按依赖实现
依据：[D1 设计与 G01–G17 验收](../specs/2026-10-30-marshal-discussion.md) · [参考调查](../spikes/2026-10-30-orchestration-references.md)

## 1. 依赖与交付方式

先完成 v0 P1 与 v1 公共基础和至少两个原生平台的控制门槛。D1 不修改 v0/v1 发布定义，不以社区插件可安装替代本项目验收。流程为 D1-T00 → D1-T01 → D1-T02 → D1-T03 → D1-T04 → D1-T05；组件证据逐步给出，跨层 I/R 分别由 T04/T05 收口。所有任务与用例均 NOT RUN。

以下路径均为未来候选，实施前先读实际代码并复用现有模块；不用计划文本直接生成整套框架。执行涉及真实模型费用、部署或发布时依届时用户授权，本次授权仅覆盖文档修改与 PR 更新。

## D1-T00：固定参考版本与隔离证据

**文件**：增补参考调查；未来新增讨论适配器版本报告与脱敏 fixture。
**依赖**：v1 公共基础，已授权的目标测试环境。

- [ ] 固定 dsh-agent-teams、官方 Agent Team/workflow 与 DSH/SDK/CLI 版本，核对依赖/许可证；不直接挂载完整 profile。
- [ ] 逐平台验证无隐式推理的新建、工具/hook/MCP/子 agent 禁用、只读观察、原子受理、取消与 dispose；原子受理须覆盖真实配置回读与条件比较，不能只验证 idle；专用会话不触及工作会话。验证持久用途标记/隔离存储能跨创建崩溃识别会话，以及 hub 不在线时 node 仍能取消；不能证明则该平台 unavailable。
- [ ] 核对消息接纳与模型完成的证据、输出大小/用量、原生日志保留，不能用 prompt 自律或包可加载充当隔离。
- [ ] 决定使用原生窄接口、参考状态机自建最小协调层或暂不支持；不复制内部模块造成不可升级的宿主耦合。

**验证/完成**：G01/G02/G03/G12/G14/G15 的原生接缝证据；完整装配故障测试留 T04/T05。至少两个不同原生平台通过才继续跨平台交付，否则报告受限范围，不预填支持。

## D1-T01：房间契约、授权与元数据

**文件**：未来扩展 wire/commands、config、src/bin/device.ts、hub/devices/identity、node/runner/privacy/journal；新增 hub/discussions 的类型/状态存储最小模块。
**依赖**：D1-T00。

- [ ] 定义 room/run/member/round/message 身份、状态机和 `discussion.create / submit / interrupt / dispose` 判别操作；独立 discussion.output/status 帧按 device/run/member/nodeEpoch/runtimeEpoch/memberSeq 去重，绑定真实 agent/session/turn，不借普通 event 的 seq；status/command.status 共用公共契约 §5 无正文白名单，回带实际 provider/model 安全标识、D1 capabilityRevision、settingsRevision、回读有效性/原生版本及工作单元状态，禁止原始配置/URL/凭据。只有 hub 接纳后分配 roomSeq，node 自报拒绝；不入 EventBuffer/离线队列。未协商 discussion 的双方都拒绝讨论帧，不让旧 node 接收房间写入。
- [ ] 定义不可延长的 runExpiresAt、submit 的 turnExpiresAt，以及 previewDigest、预期策略/配置，均参与 args 幂等摘要；传输层时间与连接代次不参与摘要但仍独立校验。node 用保守时钟转换建立执行期限，独立于普通命令 30s 受理 TTL。
- [ ] 实现双侧 allowDiscussion 默认 off（含本地 CLI 经进程间写锁更新设备表 `allowDiscussion` 与 `policyRevision`）、既有 content 双授权及服务端生成的单次 run 预览绑定；成员及历史来源设备均纳入 hub policyRevision 与 nodeEpoch/localDiscussionRevision 检查。历史仅从源端核验非讨论会话、本地授权并按 §10 投影拉取，回带当前修订，hub 拒收迟到旧策略片段；不从 EventBuffer/客户端文本冒充历史，粘贴标 owner-paste。create 绑定确认，后续每次 submit/汇总核验；授权依赖保留至正文清除，覆盖已结束 run 及非法 reload，不清未决元数据。
- [ ] 复用 hello/heartbeat/heartbeat.ack 承载 node 本地讨论策略及 localDiscussionRevision，不开新状态通道；源端每次本地授权变化递增并立即报告，来源设备即使没有成员会话也参加。hub 在有效新 nonce 应答后刷新策略有效期，5s 心跳/15s 无有效回读即仅使相关 D1 授权不可确认；普通心跳无策略不能续期，旧代次/冲突不复活旧预览。停止相关讨论正文/新推理并清活跃及已结束 run 缓存，保留健康普通连接及无正文状态/查询/安全收尾；privacy 收紧仍影响普通内容。预览、材料拉取及正文读取/转发均核验当前授权。
- [ ] 无正文元数据记录、进程间排他锁、浏览器 `(publicOrigin, operatorId)` 持久幂等键、hub→node 稳定写键和预留推理调用名额（仅 `submit` 占推理配额，`create/interrupt/dispose` 不占推理配额）；执行仍由 node journal 去重，查状态不重发。
- [ ] 在 hub 安装身份状态持久保存独立 D1 初始化标记，复用 initializing 意图/配套提交/ready 流程；既有 v1 首次启用与 D1 丢文件分别处理。ready 后 journal/密钥缺失、异常残留或不匹配均 recovery-required，零新草稿/run，不自动换密钥或建空表。
- [ ] 为恢复元数据设置容量及保留类别：未决不驱逐，已确认结束至少留 24h；node 用途墓碑保留至原生历史删除证据成立。正文 TTL 不清这些记录；恢复时先重建占额，满时拒绝新 run，保留查询/安全取消。
- [ ] 将模型输入/输出纳入统一隐私/字节预算；预览按成员/轮次与材料估算最坏累积并提示触顶组合，运行时分发前按实际封存发言再次校验单次组装输入 ≤ 64 KiB；结构化交互正文不得从历史选择绕过过滤，讨论正文不进入 v1 `EventBuffer` 或 node 离线事件队列。

**验证/完成**：G03/G04/G05/G08/G09/G13/G16/G17 的 U/可运行 I 层；身份、迁移与恢复路径明确，组件失败零模型调用。

## D1-T02：专用讨论会话端口

**文件**：未来新增 src/agents/discussion.ts，最小扩展现有 DSH/Codex/Claude adapter 和 AgentHost。
**依赖**：D1-T00、D1-T01。

- [ ] 创建隔离、无工具新会话（`discussion.create` 使用 `target.sessionId: null`），创建前记录认领意图，在途创建期间阻塞/暂扣该 agent 周期 `list/sync` 对新出现的未分类原生会话的广播，并阻断直接传入该 ID 的普通读取/控制及原生事件出口；真实 nativeSessionId 返回后先持久化用途/run/member 归属并写回 journal，再允许状态发布，不能以显示别名作键；崩溃后无法归类则隔离并恢复，原生边界不成立则 unavailable。
- [ ] 公共路由统一用途校验：普通 list/sync 隐藏讨论会话，history/follow/inputs 及普通控制即使直传 sessionId 也拒绝；原生事件仅走讨论通道。重启、重新扫描、停用 D1、身份变化和命令键回收均不清用途墓碑。
- [ ] `discussion.create / submit / interrupt / dispose` 经现有 runner/journal/supervisor（节点内部观察原生流以生成 `discussion.output / status`，不开放远端 `observe`）；不新增直连 provider 旁路；`submit` 复用公共契约 §7 的写权与原子 idle 受理，同一原生屏障核验 provider/model、能力/设置修订、工具隔离和当前授权。创建拿到 `nativeSessionId` 先落用途再回读配置：匹配预览才绑定新会话修订；若配置不符/不可读，确认销毁后才可报 `rejected`（保留必要墓碑），销毁未确认则报 `outcome-unknown` 并保留占额。请求值/旧 status 不算回读，配置变化又恢复仍作废绑定，正常忙闲变化不算配置变更。原生交互一律拒绝且不生成远端卡，无法满足即标 unavailable。
- [ ] 返回接纳、最终输出、原生取消确认与未知状态；busy 零排队，超时不自行重试。
- [ ] 原生调用前预留恢复槽位/收尾键、登记回合取消关联和 node 单调到期任务；预留失败不启动。hub 失联/重启仍独立取消，重连/换新键不续期，过期 submit 零调用，迟到创建先登记用途再清理；本地到期取消及 `discussion.interrupt / dispose` 复用已登记槽位和稳定收尾状态，journal 满/写失败/正文撤权不能挡住合法安全取消，禁止任意新键无限扩容；写失败进入恢复，不报持久成功或释放未知占额，不杀共享 runtime。
- [ ] 按设计 §6 分开正文、原生资源及无正文恢复记录。command.status 的原命令结果与实际工作单元状态分开；只在取得绑定原 run/member/session/runtime/turn 的可靠原生终止及清理证据时释放占额，旧回合终态、accepted 或未知回读均不足；配置不可读也不抹除已验证终止证据。未知保留必要对账关联，15min 不清未决或墓碑；原生历史保留如实报告，不触及工作会话。

**验证/完成**：G01/G02/G03/G07/G08/G09/G12/G14/G15/G16；首版支持报告逐版本填写，任何依赖 prompt 自律的路径不得开放。

## D1-T03：有限轮次与汇总

**文件**：未来新增 hub/discussions/coordinator.ts 及必要的状态机/调度测试。
**依赖**：D1-T01、D1-T02。

- [ ] `preparing` 阶段任一成员创建失败即请求清理本 run 已建专用会话，确认清理后转 failed；创建/清理 unknown 转 paused 并保留占额待核对，不退回 draft 复用 runId。
- [ ] 第一轮独立分析，至少 2 名成员完成有效封存发言才进入后续交叉轮次；首轮 0 有效发言直接 `failed`（不调用汇总），仅 1 名有效发言或后续轮次无新有效发言则跳过剩余交叉轮次；一次完整发言只接纳一次，旧代次排除。
- [ ] 实施成员/轮次/推理调用/并发/时间/正文预算（含每轮组装后完整输入 ≤ 64 KiB 校验）；预留后再分发，失败亦消耗名额，禁止自动重试/扩容。
- [ ] hub 按完整成员/实例来源键接纳后分配 roomSeq；两个成员 memberSeq=1 不冲突，重复不再封存，冲突/缺口暂停查询，不重新 submit；浏览器游标绑定 hubEpoch。
- [ ] 停止/暂停先关调度入口，再取消在途调用；未知不前进，已确认失败可作为缺席处理。
- [ ] 每次创建/分发/汇总重验预览绑定与全部成员/来源授权；离线/失同步/配置变化或失效即暂停，不以延迟 status 代替源端原子门槛；旧帧/旧终态不能复活 run 或提前释放占额。
- [ ] 汇总者固定一次额外调用；若预先选定的汇总成员已失败/离线/未知，不自动换人或换模型冒充，直接标记“汇总未完成（summary-unavailable）”并保留带缺席标记的原发言记录；出处校验、分歧/未知/缺席分列，不产生执行任务。
- [ ] hub 重启先恢复包括 paused/unknown 在内的占额并查询旧键，不恢复推理；4 个占额 run 未结算时拒绝第 5 个，不以停止请求/正文到期释放额度。人工对账需源端终止证据；无正文不自动重新汇总。

**验证/完成**：G03 至 G08、G10/G11/G15/G16/G17 的 U/I；故障注入检查调用次数、预算及资源，不只断言 UI 文案。

## D1-T04：预览、房间页面与正式装配

**文件**：未来最小扩展 hub/api.ts、page.ts、index.ts，新增讨论装配/浏览器测试。
**依赖**：D1-T01 至 D1-T03。

- [ ] 预览成员设备/平台/provider/model、共享文本、预算及原生保留；启动回带预览版本/摘要并校验，变化须重新确认；开始/停止为独立明确操作。
- [ ] 复用 cookie/CSRF/Origin、SSE 快照屏障/背压；讨论端点拒绝 x-marshal-token 与混合凭据，合法 cookie 也必须提供有效的服务端预览绑定，不能把 cookie 当人工确认的证明；页面重载、重复请求不新开 run。
- [ ] 显示作者、原生完成/未知、分歧与引用；内容纯文本，没有执行建议的自动调用入口。
- [ ] 撤权/到期清正文，覆盖已结束 run 的派生汇总、分页缓存和 SSE 待发队列，阻止延迟帧填回；恢复授权不恢复旧预览/正文，终态元数据仍可看。当前 RAM 不可用时提示材料缺失；不往浏览器持久存储写讨论正文。
- [ ] 经实际 HTTP/WSS/runner/适配器装配执行 G01–G17 的适用 I 层与公共 P1 回归；直调普通 history/command 验证讨论隔离，不只测试房间 UI；展示正文已清除与调用结果未知的不同状态。

**完成**：所有可支持路径有装配证据，真实浏览器完成预览→运行→汇总/停止→重连，未运行的 R 项仍待验。

## D1-T05：两机真实验收与能力报告

**文件**：未来新增目标机报告，验收后再更新 README 的可用能力声明。
**依赖**：D1-T04、目标环境与推理费用授权。

- [ ] 两台目标机器、至少两个不同原生平台执行 G01–G17 的适用 R 层；第三平台未测则不宣称覆盖。
- [ ] 故障注入覆盖半开网络、ACK 丢失、hub/node 重启、撤权、配额、停止与卸载；与模拟结果分开报告。
- [ ] 核对没有实现代码修改、文件/终端操作、外部工具、自动执行任务或全局配置变化由讨论触发。
- [ ] 检查 marshal 无正文落盘，报告原生保留及费用/取消未知边界；所有来源、版本和许可证可追溯。
- [ ] Reuse 检查公共认证/幂等/隐私/监督复用；Quality 检查单一状态权威；Efficiency 检查事件驱动、有界分发、无重复 follower 或忙轮询。

**完成**：满足 D1 发布门槛；分别报告支持/不可用/未验证平台，不以文档、fixture 或安装成功代替真实讨论验收。
