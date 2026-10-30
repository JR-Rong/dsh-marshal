# dsh-marshal（调度官）总体设计

日期：2026-10-29
状态：基于 `feat/v0@702ef24` 的 P1 目标修订；v0 已有实现，本次不改实现
规范：[公共契约](2026-10-29-marshal-contract.md) · [验收矩阵](2026-10-29-marshal-acceptance.md)
配套：[v0 架构](2026-10-29-marshal-architecture.md) · [v0 增量计划](../plans/2026-10-29-marshal-v0-p1.md)

本文描述后续加固目标。当前安装、wire v1 和已支持行为以 [README](../../../README.md) 为准；已有修复及剩余缺口见 [基线复核](2026-10-29-marshal-acceptance.md#0-评审基线与已有证据)。

## 1. 问题与目标

工作分散在 Windows、macOS、Linux 上的多个 agent 中，需要在一个浏览器中知道各会话是否在运行、等待输入或已经结束，并在有可靠控制边界时继续工作。

目标是多机器、多 agent 的观察与控制面。每台源机器安装同一个 Cordis 插件，node 主动连接 hub，浏览器只访问 hub。权威会话历史始终由源机器上的 agent 保存。

三个目标场景：

1. 列出各设备、agent 和会话，展示有时间戳的状态；离线、同步中和未知状态清楚区分。
2. 查看经隐私策略允许的历史或真实事件流；拥有有效写权时显式提交下一条提示词，取得受理结果及后续回合状态。
3. 显式开启交互中继后，在远端回答受支持的问题或单次审批；超时、竞争、断线均有明确终态。

“任意会话都能接管”“看见历史就能看见外部 TUI 实时流”不是当前承诺。是否可写、是否有真流，由已验证的适配器和写权证据决定。

## 2. 非目标与分期

- 不迁移会话、不在 hub 保存正文历史、不自动委派 agent。
- 不提供跨机命令队列，不在空闲后悄悄执行之前提交的请求。
- 不改 agent 全局配置，不远程启停 skill/plugin，不远程禁用 marshal。
- v0/v1 不做多用户共享、原生手机 App、DOM 点击审批或跨进程抢占。
- 多设备远端浏览器均是同一个 owner 的认证会话，不引入虚假的“操作者设备身份”。

| 版本 | 交付范围 | 开放门槛 |
|---|---|---|
| v0 | hub + node，DSH 列表、观察、提示词、打断、普通提问、页面、身份/幂等/隐私/重连 | DSH 接缝和完整传输链路通过；设置只读，审批不开放，内容补看不开放 |
| v1 | Codex/Claude 适配器、显式 acquire、单次审批、经回读验证的设置、有限历史补看 | 逐 agent/版本通过控制边界与回读验证；未知能力保持关闭 |
| v1.1 | DSH 会话设置 | 会话级接口与回读另行实测 |
| v2 | Hermes/OpenClaw 文件观察、Qoder 可选观察 | 单独设计，不沿用本稿未验证的路径与能力猜测 |
| v3+ | 多用户、移动增强、更多受控授权 | 新的威胁模型与协议设计 |

删除原来的适配器“约 +600 行”估算。协议适配、故障处理、真实契约样本与浏览器交互需分别估算，不能以示例行数承诺工作量。

## 3. 部署与拓扑

```text
浏览器 ── HTTPS / SSE ── hub（DSH web + marshal）
                              ▲
                              │ node 主动 WSS
                        node（DSH + marshal）
                              │ 进程内 / stdio
                         本机 agent runtime
```

hub 使用 DSH webServer 托管 /marshal 与 API，复用原有端口/TLS。node 没有跨机入站监听。hub 本机也要受管时，显式装配一个本地 node 身份，通过相同策略管道接入，不默认管理本机。

node 可支持 DSH web 或其他具备必需服务的宿主形态；Electron 是否具备相同服务必须实测，不能仅因“不需要外部 HTTP”就宣称已兼容。桌面浏览器为 v0 验收范围，手机浏览器布局在 v1 UI 任务中验证；PWA/推送不阻塞首版。

目标配置字段及默认值在公共契约 §3 定义，迁移见 §1.1；README 保留现有 v0 的可运行示例。稳定 deviceId 与显示 deviceName 分离；地址和认证信息无默认端点。

## 4. 使用流程

### 4.1 观察

登录 hub → 取得设备/会话快照 → 选择会话 → observe 只读历史与已支持的订阅。

选择会话不调用原生 resume，不启动推理，不取得写权。metadata 档显示计数与安全别名；content 需要源机器与 hub 两方允许。外部会话只有历史时，页面显示“历史观察”，不能伪装为实时跟随。

### 4.2 控制

DSH 当前委托原生 prompt/cancel；后续须补齐 writer-held 原子边界的并发验证，才能按目标契约声明写权保证。Codex/Claude 先显式 acquire，确认当前 runtimeEpoch 的控制证据后才开放 prompt/configure/interrupt。foreign-unknown 只读；无法证明排他控制时不能靠重试 resume 解决。

prompt 接受后显示“已受理”；turn.completed 才决定回合结果。ACK 丢失显示“执行结果未知”，提供只读状态查询，禁止自动换幂等键重新发送。

### 4.3 普通问题

DSH questionRelay=remote 时，waterfall 由 marshal 认领，原本本地卡片会延迟到 answerTimeoutMs 到期后才出现；此行为必须在部署文档中说明。off 不注册认领者。notify 仅在不改变本地语义的观察接缝已验证后可用，否则报告 unsupported。

普通问题与批准执行分开处理。plan-review 不因采用选择题 UI 就变成低权限问题。v0 不支持审批，因此不能借普通问答放行 plan-review。

Codex/Claude headless 没有可凭空接回的本地界面。它们的无答案/拒绝终态见 v1 设计，页面不能显示“已交回本机”误导操作者。

## 5. 复用与模块边界

| DSH 接缝 | 用途 | 实施前证据 |
|---|---|---|
| sessionController list/history/follow/events | 清单、历史、流 | 固定 DSH commit；进程内调用是否依赖 invocation/身份上下文 |
| sessionController prompt/cancel | 写入与打断 | writer-held 的原子边界、受理/完成语义、请求标识 |
| user-questions/request waterfall | 普通提问认领、超时回本地 | 处理器顺序、next()、取消及卸载语义 |
| userQuestions.answer | 已 continued 请求的可选补偿 | 不当作所有 live 请求通用入口；首版不依赖 |
| webServer register/registerUpgrade | 页面、API、WSS | 真实 Upgrade/鉴权链路；不能只用假 Duplex 推断成功 |

所有 DSH 特定调用集中于 surface 边界。优先复用原生会话、写者和交互机制，不复制 agent 历史，也不自建与原生状态冲突的会话模型。

## 6. 公共控制规则

协议、身份、期限与同步以公共契约为准，尤其：

- hub 明确处理 event、ACK、错误和连接关闭；成功 ACK 不得被事件回调吞掉。
- hub 合并进行中的同键请求，node 持久保存无正文的去重状态；无法确定是否执行时不自动重放。
- 每个事件、ACK 和同步分片绑定认证设备与连接代次。
- 输出、错误、结果、标题和快照都经过源端白名单投影，未知字段不外发。
- 重连必须重新同步完整索引；恢复清单与补回内容历史是不同能力。
- 控件由真实能力和 current/pending 渲染；设置未回读不能显示成功。

## 7. 页面与 HTTP 边界

页面保持自包含 HTML/CSS/JS，通过 SSE 收事件，不依赖 DSH 前端 bundle。简单部署不意味着跳过状态管理、鉴权、背压和交互测试。

端点职责：

| 端点 | 职责 |
|---|---|
| POST /marshal/login | 交换 dashboardToken，建立浏览器会话 |
| GET /marshal | 登录/控制面入口，无 token URL |
| GET /marshal/api/devices、/sessions | 带在线、stale、同步代次的清单 |
| POST /marshal/api/command | 操作、目标、幂等键和预期状态版本验证 |
| GET /marshal/api/command-status | 只读查原操作状态，不触发执行 |
| GET /marshal/api/inputs | 从 node 获取当前会话有效待答快照 |
| GET /marshal/api/stream | 带游标、reset 和背压的 SSE |
| /marshal/uplink | 仅设备 WSS 升级与握手 |

卡片按 device/agent/session/runtimeEpoch/requestId 定位；页面不把一个会话的能力更新到另一个当前选中会话。待答状态独立于时间线，切换会话、刷新和重复事件不造成重复提交。

## 8. 验收与风险

v0 完成以验收矩阵发布门槛为准。至少覆盖两台目标机器的 DSH 提示词闭环、真实工具流、远端问题与本地回退、断网恢复、单独重启 hub，以及同键并发只执行一次。

已有 [DSH 接缝记录](../spikes/2026-10-29-dsh-seams.md) 覆盖 Upgrade/跟随/路由核对。仍待补证的是 DSH 写者并发、真实宿主完整生命周期与两机链路，以及 Codex/Claude 控制权机制和原生设置回读能力。必须通过 spike 得到 OK/FAIL/UNKNOWN；UNKNOWN 不授予可写能力。本稿的修订是设计决策，不是部署或生产验收证明。
