# dsh-marshal plugin build

Self-contained installable build of the marshal plugin.

Install from the tarball in this directory:

- Desktop: Plugins -> Add plugin -> pick the .tgz;
- CLI: dsh plugin --profile desktop add /abs/path/dsh-marshal-0.2.0-agent-groups.10.tgz.

Required DSH plugins (install in the same profile first):

- @linxin666/dsh-agents (required for agents/groups/cross-device)
- @linxin666/dsh-client-ui-task-board (optional; full task board)

These are DSH plugins, not ordinary npm dependencies of marshal. Without
@linxin666/dsh-agents the health endpoint reports agents:false; without the
task-board plugin marshal uses its built-in lightweight board.

Do not install from the repository root. See INSTALL.md.

## 任务看板编排

在「调度官 → 任务看板」新建卡片，选择已绑定工作区的 Leader。可以指定模板、让 Leader 选择或跳过。Leader 从同工作区推荐人选。创建前可调整推荐分工，后续批次开跑前可用卡片上的「编辑分工」调整。

| 任务模板 | 建群模板 | 预填角色 |
| --- | --- | --- |
| 开发交付 | 分阶段交付 | Leader、Coder、Reviewer |
| PR 对抗审查 | 对抗复核 | Leader、DSH 审查员、Codex 审查员 |
| 报表与报告 | 分阶段交付 | Leader、报告撰写、校核 |
| 技术调研与选型 | 分阶段交付 | Leader、技术调研、校核 |
| 故障排查 | 自由协作 | Leader、协作者 |

开发时，Leader 负责设计与拆分。Coder 和 Reviewer 各有自己的 Codex 子 Agent 配置，可关闭或按需调用。自动编码从已登记工作区 Git 根目录的 HEAD 创建隔离工作树，独立审查以固定补丁为依据。设计和审查交接读取工作区公共记忆。每次子调用的结果、调用编号和完整补丁保存在本工单群的当前批次。验收后卡片展示开发交付报告，工单群里可下载补丁。自动审查的补丁上限为 48 KiB。

纯报表、调研和排查的分工交给 Leader 的常驻会话，默认关闭 Codex 子 Agent。为这些任务勾选「包含编码与代码审查」可加入开发阶段。

PR 审查支持 GitHub 和 Gitee PR 链接。节点需要启用工作区记忆、DSH 和已认证的 Codex，Codex 版本沿用 Agent 群聊的原生协议要求。私有仓库可在节点环境配置只读的 `DSH_MARSHAL_GITHUB_TOKEN` 或 `DSH_MARSHAL_GITEE_TOKEN`。选择运行后，节点按固定提交读取 PR 文本补丁，两位审查者各自审查并互相复核，Leader 汇总。交接和最终报告存进该工作区的 SQLite 记忆，卡片显示阶段、提交及报告。缺少完整补丁的文件会标出，文本补丁上限为 48 KiB。

## 工单群

在 Marshal 「任务看板」里选择工作区建单，卡片会固定关联一个工单群。点击「工单群」可查看群消息、关单归档和重开。重试和同工作区改派会在原群追加运行批次。工单群日志是完整对话，工作区公共记忆存阶段交接和报告引用。旧卡片可以在首次打开时补绑已有工作区。

本机运行时，群正文保存到原设备的 task-rooms.sqlite。选择同工作区的跨设备 Agent 后，原设备会将完整历史分页转存到 Hub。Hub 确认序号完整后接管正文，原设备只保留工单关联和位置。接入同一 Hub 的设备必须绑定同一个账号，并登记相同的工作区 ID。远端节点还需要启用群聊讨论策略。工单归档可在获准设备的「工单群」里查看。

跨设备联动需要同时更新节点插件和安装包中的 standalone Hub。云端服务可用该安装包的 marshal-hub 入口，或继续指向其 lib/src/bin/hub.js。工单群正文随 Hub 存储目录备份。

## Mnemon 私有记忆试点

在节点的 Marshal 插件配置中指定一个已登记 Agent 的成员 ID 和本机 Mnemon Native 可执行文件绝对路径。试点验证使用 Mnemon 0.2.13。配置保存后重启 DSH。

```yaml
mnemonPilot:
  agentId: "<dsh-agents 花名册的成员 ID>"
  executable: "/usr/local/bin/mnemon"
```

试点 Agent 的新私有条目保存到 Marshal 记忆目录下的本机 Mnemon Store，既有 SQLite 条目仍可检索。其他 Agent、工作区交接和全局审批沿用现有机制。新 Mnemon 条目仅保存在本机，现有 Hub 记忆同步覆盖 SQLite 数据。移除此配置可切回 SQLite，重新启用可查看已保存的 Mnemon 条目。

已登记会话可跨会话召回该 Agent 的记忆。记忆页显示所选 Agent 的后端。新建条目时可以单独授权本 Agent 在当前工作区的工单中使用，开发批次将召回数量和写入状态记到原工单群。验收经验进入该 Agent 的私有记忆。开发的工作区公共交接仍按记忆 ID 精确读取。

## 记忆页会话

DSH 桌面代理使用页面内的会话凭证，浏览器使用本地会话 Cookie。插件重启或会话过期时，页面会自动重建会话并重试一次。如果仍出现提示，请记录提示原文和 `/marshal/health` 的插件版本。
