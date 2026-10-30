# dsh-marshal

调度官：在一个浏览器中观察多台机器上的 DSH / Codex / Claude 会话，并在有可靠控制权时继续任务、回答问题或作单次审批。

**当前只有设计文档和实施计划，没有实现代码。** 2026-10-29 的 P1 评审修订已纳入文档；这不表示实现问题已关闭或真实 agent 验收通过。

- **单包双角色**：hub 路由与托管页面，node 观察和执行。
- **node 零跨机入站端口**：源机器主动 WSS 外连。
- **默认元数据、中继关闭**：正文需源机器与 hub 双重允许；问题和审批需分别显式启用。
- **观察与控制分开**：点击会话只读；外部写权不明则保持只读，resume 成功不等于取得排他控制。
- **单次授权、真实回读**：不开放“本会话允许”，不写 agent 全局配置；设置请求与确认值分开显示。
- **超时结果明确**：命令可能已执行时显示“结果未知”，只查询状态，不自动重发。

## 文档入口

| 文档 | 用途 |
|---|---|
| [公共契约](docs/superpowers/specs/2026-10-29-marshal-contract.md) | 配置默认值、身份、命令生命周期、写权、交互、隐私、恢复的唯一权威定义 |
| [P1 与发布验收矩阵](docs/superpowers/specs/2026-10-29-marshal-acceptance.md) | 10 个 P1 对应设计、实施任务、具体测试判据与证据要求 |
| [总体设计](docs/superpowers/specs/2026-10-29-marshal-design.md) | 产品目标、部署、分期和边界 |
| [v0 架构](docs/superpowers/specs/2026-10-29-marshal-architecture.md) | DSH 路径、公共模块与故障处理 |
| [v0 实施计划](docs/superpowers/plans/2026-10-29-marshal-v0.md) | 11 个待执行任务，先修公共基础链路 |
| [v1 设计](docs/superpowers/specs/2026-10-29-marshal-v1-design.md) | Codex/Claude 目标能力、单次审批、条件式设置支持 |
| [v1 架构](docs/superpowers/specs/2026-10-29-marshal-v1-architecture.md) | 适配器、所有权、进程监督、回读与缓冲 |
| [v1 实施计划](docs/superpowers/plans/2026-10-29-marshal-v1.md) | 11 个待执行任务，含真实协议 spike 和两机验收 |

原计划中的大段实现草稿已替换为任务、依赖、约束和通过条件；旧稿可从 Git 历史追溯，不应再复制为代码。版本能力报告将在真实验证后生成，目前的目标能力表位于 v1 设计中。

## 版本范围

- v0：DSH 的列表、真实观察/写入、普通问题，以及认证、幂等、隐私、重连的完整链路；设置只读，审批不开放。
- v1：逐步接入 Codex、Claude；单次审批和有限历史补看；设置逐字段验证回读后开放，无法验证则只读。
- v1.1：DSH 会话设置，另行验证。
- v2+：其他 agent、移动增强、多用户，不属于当前实施范围。

不承诺附着任意已运行的外部 TUI，也不承诺每种 agent 的五项设置都能修改。已有会话恢复、当前写权和实时观察是不同能力，需分别验证。

## 计划配置示例

以下是待实现配置。全部默认值和校验以公共契约为准。node 的地址、token 和稳定 deviceId 必填；deviceName 只是显示名，省略时取 hostname。

```yaml
- name: dsh-marshal
  config:
    role: node
    hubUrl: wss://<hub-host>/marshal/uplink
    token: <device-token>
    deviceId: <registered-device-id>
    deviceName: <display-name>
    privacy: metadata
    questionRelay: off       # off | notify | remote
    answerTimeoutMs: 300000
    approvalRelay: off       # off | notify | remote
    approvalTimeoutMs: 60000
    agents: [dsh]            # v1 可按验证结果增加 codex、claude
```

```yaml
- name: dsh-marshal
  config:
    role: hub
    dashboardToken: <owner-token>
    devicesFile: ~/.dsh-marshal/devices.json
    ringBufferMinutes: 15    # v1 有限内容补看；v0 不缓存内容历史
```

hub 使用 DSH webServer 的端口/TLS 或已有反代。设备 token 与 dashboardToken 不互通；浏览器通过登录表单建立会话，不使用 ?token= URL。设备注册记录中的 allowContent 默认 false，需 hub 本地明确设置；仅 node 改成 content 不足以发送正文。

DSH 开启 questionRelay=remote 后，marshal 先认领普通问题，本地卡片会延迟到无人远答且 answerTimeoutMs 到期之后才出现。Codex/Claude 独占 headless 没有自动可接回的本地 UI；关闭中继或超时按已验证的拒绝/无答案路径结束。

## 验证与状态

实施后将提供 pnpm 测试、类型检查和构建入口；当前尚无 package.json，不能将这些命令视为已经可运行。

验收分为纯逻辑 U、实际传输装配 I、两台目标机真实 agent R 三层。fake runtime 测试不证明原生接口、跨进程排他或设置回读有效。当前所有实施任务和运行验收均为 NOT RUN。

本轮重点已形成设计闭环：ACK 路由、node 去重与 TTL、审批策略、禁止持续授权、认证身份绑定、未知写权只读、正确的设置收紧、真实回读、交互不入历史，以及重连全量同步。具体可判定的用例见验收矩阵。
