# dsh-marshal v1 设计

日期：2026-10-29
状态：P1 评审修订；目标能力待实测
上游：[总体设计](2026-10-29-marshal-design.md) · [公共契约](2026-10-29-marshal-contract.md)
配套：[v1 架构](2026-10-29-marshal-v1-architecture.md) · [v1 计划](../plans/2026-10-29-marshal-v1.md) · [验收矩阵](2026-10-29-marshal-acceptance.md)

## 1. 目标与交付边界

v1 在 v0 基础上增加 Codex/Claude；前提是完成 [v0 P1 增量计划](../plans/2026-10-29-marshal-v0-p1.md) 的认证、持久幂等、隐私、同步及 wire v2 迁移。当前 `feat/v0@702ef24` 已有 v0 实现，这些新增保障尚未全部具备。交付重点是真实协议、可证明的控制权、单次审批与实际回读，不以可点击的按钮数量作为完成标准。

- 真流：使用原生事件；外部进程没有可订阅的实时通道时，仅显示历史。
- 真续跑：有可靠写权时恢复原会话，不隐式复制上下文或 fork。
- 真审批：仅在显式 remote 策略下对当前原生请求作单次决定；超时绝不自动允许。
- 真设置：已确认 current 与 requested/pending 分开；无法回读的字段不开放编辑。
- 真恢复：hub、node 或浏览器分别重启时，各自按快照/游标/待答查询恢复，不靠重发写命令。

## 2. 能力矩阵

本表是目标与门槛，不是已验证支持列表。实施报告必须逐版本填写可用/只读/不可用及证据；README 在真实验收后才可标记已支持。

| 能力 | DSH（v0 延续） | Codex | Claude |
|---|---|---|---|
| 历史/清单 | 原生控制器 | app-server 只读分页接口 | SDK listSessions/getSessionMessages 等经验证接口 |
| 真流 | 原生 follow；若退化 poll 明示 | 当前受管 runtime 的通知 | 当前受管 Query 的流事件 |
| 外部 TUI 实时附着 | 按 DSH 边界验证 | 不承诺，不能从 thread/list 推断 | 不承诺，SDK query 不等于附着 TUI |
| prompt/interrupt | 原生 writer-held 边界 | 可靠控制证据 + activeTurnId | 可靠控制证据 + 自有 Query |
| acquire | 不另造原生写者 | 外部 unknown 默认只读 | 外部 unknown 默认只读 |
| steer | 非 v0 必需 | 可选，原生 expectedTurnId 验证 | 默认不可用，未证明输入并入当前回合前不开放 |
| 审批 | v0/v1 不开放 | 单次决定交集 | canUseTool 单次 allow/deny |
| 普通提问 | waterfall | requestUserInput 子集 | AskUserQuestion 子集 |
| model/reasoning/permission/plan | v1 只读，留 v1.1 | 每项分别通过策略和回读验证 | 每项分别通过策略和回读验证 |
| goal | v1 只读 | 可选，set/get/clear 完整回读 | 无等价能力，不显示可编辑项 |
| skill/plugin | 只读 | 已验证目录只读 | 已验证目录只读 |
| create/fork | v0 不开放 | 可选，显式操作 | 可选，显式操作 |
| 内容补看 | 按 v1 公共缓冲规则 | 同左 | 同左 |

“没有原生等价物”和“当前版本尚未验证”必须给不同 reason，不能合成假功能。最低兼容版本由 V1-T00 的真实样本确定；原稿所称 0.153.x/0.3.x/2.1.x 是调查候选，不作为支持声明。

若外部 acquire 无法通过门槛，必须另有经过验证的独立受管新会话路径，才能达到 v1 的控制交付标准；如果也没有该路径，只能报告“观察预览”，不能把两个 agent 均只读当作 v1 控制功能已交付。create/fork 对已有安全控制路径的适配器仍是可选能力。

## 3. 所有权与观察

会话唯一键为 deviceId/agent/sessionId。底层 Codex 的 thread id 用作此处 sessionId；不要从原生 session tree root id 推导唯一 thread 身份。

发现到但没有可靠控制证据的会话为 foreign-unknown。浏览器点击仅 observe，不 resume、不创建 Query、不启动推理。显式 acquire 使用上游排他能力或经过验证的单一宿主控制边界；仅 resume 成功不够。

acquiring 期间第二个控制请求失败。ours-running 不接受普通 prompt/configure，不排队；steer 只在明确验证原生语义后开放。原生锁丢失、runtimeEpoch 改变或崩溃时立刻撤销写权，旧审批/打断失效。

没有可用排他机制时，保留外部历史只读。可提供独立受管环境内的新会话或显式 fork，但必须报告它是新身份，不是接管原会话；该环境本身仍需证明单写者边界。

## 4. 审批与提问

统一配置为 off/notify/remote，默认 off；Codex、Claude 都必须接收两项中继策略。远端普通问题、执行审批及 plan-review 分别分类。不能将 CLI/SDK 的默认行为当作已存在的本地 UI。

允许远端的决策只有原生支持的单次 allow、decline、cancel。去除“本会话允许”、持久权限更新及策略 amendment。Claude suggestions 不返回为 updatedPermissions，不管其 destination 是 session 还是全局；范围扩展请求不授权。

原生请求 id、item id、会话 id 分开保存；每张卡有随机 requestId、runtimeEpoch、原生 `nativeExpiresAt`（若提供）和本卡允许集合。服务端校验隐藏/伪造决定，合法首答才结算；无效决定不消耗请求。只有源端确认成功才显示已处理。

交互正文统一为公共契约的嵌套判别载荷。卡片超出 4096 UTF-8 字节或脱敏导致动作不完整，允许按钮禁用，可拒绝或在源端处理。不能用不完整命令授权完整动作。远端卡片需 node relay=remote 且 hub 设备记录 `allowInteractions=true`；单侧授权按 off 处理，等待期限按公共契约 §8 归一化原生时钟域后计算，不混用 hub 与源端偏差。

问题支持单选、多选、自由文本和稳定 ID；secret 默认不转发答案，明确无答案/需本机处理。DSH 超时仅原生请求仍有效时 next()，Codex/Claude 按已验证的无答案/拒绝路径结束；MCP elicitation v1 不接受授权。

## 5. 设置：范围、策略与回读

| 字段 | 修改规则 | 验证要求 |
|---|---|---|
| model | 只选支持目录；保持已确认 effort/权限限制 | 实际当前模型回读；模型变化引起的其他状态一并核验 |
| reasoning | 模型/版本明确等级定义内只沿阶梯下调（high→medium/low、medium→low） | permission 逻辑不得参与；不是按目录索引方向判断；任何上调拒绝 |
| permission | 真实权限集合只收紧；不可比较拒绝 | sandbox、批准策略、规则/目录/网络范围都参与 |
| plan | 映射到原生设置后执行完整权限检查 | Claude 从 plan 退出可能放宽，不能简单双向开放 |
| goal | 可选，支持 set/get/clear 且双重 content 授权才开放编辑 | 读取 agent 返回的完整实际对象，不能回显请求字符串；metadata 不透出 objective |
| skill/plugin | 只读目录 | 不写宿主配置、不远程启停 |

v1 只在 idle 时请求设置变化，目标是下一回合。立即生效的原生 setter 也不在活跃回合调用；不能为改 effort 直接结束进行中的 Query。

能力快照包含 current/confirmedAt/revision 和独立 pending。无回读渠道的字段 editable=false，并解释原因。setter 返回 void、supportedModels 目录、旧 init 或请求值都不能当作回读。

10 秒未确认显示 pending-confirmation/readback-timeout；保留旧 current，不自动回滚。实际值不同则先广播实际值再报 mismatch。确认事件必须有关联/版本依据；迟到旧值不得覆盖更高 revision。

需要在下一回合才能得到证据的设置，只有能建立“确认先于执行副作用”的已验证屏障时才可编辑；否则首版只读，不为凑齐“五项可改”牺牲真实回读。具体规则只定义在公共契约 §9。

## 6. 历史补看与当前待答

历史 EventBuffer 与 PendingInputs 是两种生命周期，必须分开：

| 数据 | 所在位置 | 获取方式 | 结束条件 |
|---|---|---|---|
| 已允许的历史事件 | hub 有界内存 | SSE 游标补看 | 时间、条数、字节任一到限 |
| 当前交互完整卡 | node 内存 | 即时推送或 inputs.snapshot | 已解决、到期、策略收紧、写权/进程失效 |
| 幂等与审计元数据 | node 受限持久文件 | 受控状态查询/本地审计 | 公共契约保留策略 |
| 原始会话历史 | agent 原位置 | 原生只读分页 | agent 自己管理 |

审批、提问、答案不进历史缓冲，也不因为断线进入离线正文队列。迟到或刷新页面重取源端当前有效卡；源端不可达时禁用决定。短暂断线仅保留原生等待至原期限，身份/策略/runtime 未变且同步完成后才恢复；明确撤权、策略修订变化或实例失效按公共契约 §8 一次结算原生等待，不能只清卡或在恢复授权后复活。历史到期清理同时发生在读取、计数、追加和定时器，无新事件也必须到期。

内容上限、双重授权、敏感字段投影及策略收紧清理见公共契约。浏览器已经看到的信息无法撤回，不能宣称清除缓存等于抹除披露。

## 7. 失效与用户可见状态

| 情况 | 行为与文案含义 |
|---|---|
| agent 缺失/版本不匹配 | 对应能力不可用，其余 agent 正常 |
| 进程崩溃 | 清理原请求、撤销写权，未决命令 unknown；重新握手探测后再上线 |
| 外部写权不明 | ownership-unverified，只读；不反复 resume |
| 审批无人回答 | 已按拒绝处理；不伪装成本地已回答 |
| DSH 普通问题回退 | 已交回本机；只在实际 next() 成功时显示 |
| 设置无回读 | 等待确认，旧 current 保留 |
| 内容回放缺口 | 显示缺口并重建状态，不伪造完整历史 |
| hub 重启 | node 全量同步；旧命令只查询，不重放 |

## 8. 验收与明确未决

通过条件全部引用验收矩阵 C01–C10、B01–B09，并执行全部 v0 回归。真实验收至少包括每个 agent 的可控会话 prompt/流/单次决定、默认关闭、同键并发、真实设置回读或明确只读降级、浏览器迟到、仅 hub 重启和子进程崩溃隔离。

仍待验证：跨进程排他机制、Codex 各字段/方法实际响应、Claude 设置读取/生效屏障、各平台子进程清理，以及支持的交互完整性。未知项必须记录到版本能力报告，不能把“没有报错”作为支持依据。
