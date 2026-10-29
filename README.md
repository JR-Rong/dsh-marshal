# dsh-marshal

调度官：让任意浏览器列出、观察并接管另一台机器上的 DSH / Codex / Claude 会话——看思考与工具流、续跑、在远端回答阻断式对话框。

- **单包双角色**：同一个 Cordis 插件，`role: hub` 负责扇出与路由，`role: node` 负责观察与执行。
- **零入站端口**：node 只做出站 WebSocket 连接，适合不允许端口外露的公司机器。
- **默认只发元数据**：`privacy: metadata` 下正文与命令输出被裁成计数；审批与提问是唯一的内容例外（4 KB 上限、脱敏、只发 owner、不落盘）。
- **设置只能收紧**：远端可以降模型、降思考强度、收紧权限；放宽必须在源机器上做。远端禁用 marshal 自身是禁止项。

## 文档

| 文档 | 内容 |
|---|---|
| [设计（v0）](docs/superpowers/specs/2026-10-29-marshal-design.md) | DSH 会话的跨机观察、续跑与提问 |
| [架构（v0）](docs/superpowers/specs/2026-10-29-marshal-architecture.md) | 模块、协议与失败路径 |
| [计划（v0）](docs/superpowers/plans/2026-10-29-marshal-v0.md) | 可分步执行的 v0 实施计划 |
| [设计（v1）](docs/superpowers/specs/2026-10-29-marshal-v1-design.md) | Codex / Claude 的审批、设置与所有权 |
| [架构（v1）](docs/superpowers/specs/2026-10-29-marshal-v1-architecture.md) | 适配器、状态机与兼容策略 |
| [计划（v1）](docs/superpowers/plans/2026-10-29-marshal-v1.md) | v1 实施计划 |
| [能力矩阵（v1）](docs/capabilities.md) | 三种 agent 各自支持到哪一步（实施时生成） |

## 状态

- 设计与 v0/v1 实施计划已完成；代码尚未开始。
- v0：hub + 1 台 node，DSH↔DSH 全链路。
- v1：Codex、Claude Code 适配器；五项设置可改且以回读值为准；`skill`/`plugin` 只读。
- v1.1：DSH 会话的设置切换与回读。

## 配置示例

hub 与 node 共用一份配置，靠 `role` 决定装配。地址、token、设备名都**没有默认值**，缺项即启动失败。

```yaml
- name: dsh-marshal
  config:
    role: node
    hubUrl: wss://<hub-host>/marshal/uplink
    token: <device-token>
    deviceName: <this-machine>
    privacy: metadata        # metadata | content
    questionRelay: remote    # off | notify | remote
    answerTimeoutMs: 300000
    approvalRelay: remote    # off | notify | remote
    approvalTimeoutMs: 60000
    agents: [dsh]            # v1: [dsh, codex, claude]
```

hub 侧使用同一套字段结构，但填 `role: hub`、`dashboardToken`、`devicesFile`，并监听本机或反代暴露的端口：

```yaml
- name: dsh-marshal
  config:
    role: hub
    dashboardToken: <dashboard-token>
    devicesFile: ~/.dsh-marshal/devices.json
    privacy: metadata
```

`<hub-host>`、`<device-token>`、`<this-machine>` 由部署者填写；文档与代码里不出现任何内网地址。

## 开发与验证

```bash
pnpm install
pnpm vitest run
pnpm typecheck
pnpm build
```

单元测试全部使用假传输与假 runtime，不需要安装真的 Codex 或 Claude。两台机器的联调与全部验收在目标机器上执行，不在开发工作站上做。
